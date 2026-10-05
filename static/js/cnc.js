/* CNC router feeds & speeds for the shop's OMIO X8. Pure functions (no DOM), so they are unit-tested in Node.
 * Lengths in mm, feeds in mm/min, speeds in rpm, forces in N, power in W.
 *
 * The model is calibrated to the team's tested settings (see tests/calc.test.js):
 *   5 mm Thrifty Bot (cuts 4.6 mm), aluminum slot: 24,000 rpm, 1,727 mm/min (68 in/min), 1.5875 mm (1/16") per pass
 *   same tool, polycarbonate slot:                  24,000 rpm, 3,937 mm/min (155 in/min), 3.175 mm (1/8") per pass
 *   2.5" facemill on the MDF spoilboard:            5,000 rpm, 762 mm/min (30 in/min, 0.0015"/tooth, 4 flutes)
 * When the tool library holds a tested setting for the chosen tool + material it wins; the model fills the gaps
 * (other sizes, other operations) and scales from the tested numbers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Cnc = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IN = 25.4;
  const FT = 0.3048; // metres per foot
  const RAMP_ANGLE = 2; // degrees, the team's standard ramp angle
  const HSS_FZ = 0.6; // HSS tools run a lighter chipload than carbide
  const MIN_DOC = 0.05;
  const PASS_SLACK = 0.02; // a pass up to 2% over the limit still counts as one: 0.508 mm is one 0.020" skim, not two

  const MATERIALS = {
    aluminum: {
      label: "Aluminum (6061)", short: "Aluminum", sfm: { carbide: 1150, hss: 280 },
      fz: 0.01565,  // chipload per tooth as a fraction of cutter diameter (full slot, carbide)
      doc: 1.5875 / 4.6, // slot depth per pass, x diameter (1/16" with the 4.6 mm tool)
      docCap: 1.0,  // never deeper than this x diameter
      plunge: 508,  // plunge feed for a 4.6 mm tool
      ramp: 0.66,   // ramp feed as a fraction of cutting feed
      kc: 700,      // specific cutting force, N/mm^2
    },
    polycarbonate: {
      label: "Polycarbonate", short: "Polycarbonate", sfm: { carbide: 1300, hss: 600 },
      fz: 0.0357, doc: 3.175 / 4.6, docCap: 1.5, plunge: 1016, ramp: 0.75, kc: 150,
    },
    spoilboard: { label: "Spoilboard (MDF)", short: "Spoilboard", kc: 50 },
  };

  // Facing the MDF spoilboard with the facemill, from the team's tested preset (63.5 mm, 5,000 rpm, 0.0381 mm/tooth).
  const FACE = { rimSpeed: 997, fz: 0.0381, doc: 0.508, docMax: 1.0, stepover: 0.7, plunge: 338.7 };

  const OPS = {
    slot:     { label: "Slot / through-cut (full width)", ae: 1,   docMul: 1,    hint: "Cutting parts out of plate or sheet. This is what your tested settings are." },
    pocket:   { label: "Pocket clearing",                 ae: 0.4, docMul: 1.25, hint: "Clearing material inside a shape." },
    profile:  { label: "Side cut (light width)",          ae: 0.2, docMul: 1.6,  hint: "Trimming a wall with a narrow bite." },
    adaptive: { label: "Adaptive (very light width)",     ae: 0.1, docMul: 2.5,  hint: "Deep, narrow bites for CAM adaptive/high-speed toolpaths." },
    finish:   { label: "Finish pass (0.2 mm skim)",       aeMm: 0.2, docMul: 2,   feedMul: 0.8, hint: "Last light pass on a wall for size and finish." },
  };

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const r100 = x => Math.round(x / 100) * 100;
  const defaultMachine = { min_rpm: 5000, max_rpm: 24000, max_feed_mm: 4000, spindle_w: 2200, defl_limit_mm: 0.02 };

  /** Chip-thinning multiplier: a narrow bite makes thinner chips, so the feed can rise to keep the same chip thickness. */
  function chipThinning(aeFrac) {
    if (aeFrac >= 0.5) return 1;
    return Math.min(2, 1 / (2 * Math.sqrt(aeFrac * (1 - aeFrac))));
  }

  /** Chip room is shared between flutes, so the chipload per tooth falls as flutes are added (total feed is only ~20% above a single flute). */
  const fluteFactor = z => (z > 1 ? 1.2 / z : 1);

  function modelBaseline(M, tool, machine) {
    const tm = tool.mat === "hss" ? "hss" : "carbide";
    const D = tool.actual_mm;
    const rpm = clamp(r100((M.sfm[tm] * FT * 1000) / (Math.PI * D)), machine.min_rpm, machine.max_rpm);
    const fz = M.fz * (tm === "hss" ? HSS_FZ : 1) * (tool.feed_factor || 1) * fluteFactor(tool.flutes || 1);
    return { source: "model", rpm, fzSlot: fz * D, docSlot: M.doc * D, plunge: M.plunge * clamp(D / 4.6, 0.5, 1.5), ramp: 0 };
  }

  function testedBaseline(recipe, tool, M) {
    const z = tool.flutes || 1;
    const mb = modelBaseline(M, tool, defaultMachine);
    return {
      source: "tested", rpm: recipe.rpm, fzSlot: recipe.feed_mm / (recipe.rpm * z),
      docSlot: recipe.doc_mm > 0 ? recipe.doc_mm : mb.docSlot,
      docKnown: recipe.doc_mm > 0, plunge: recipe.plunge_mm > 0 ? recipe.plunge_mm : mb.plunge, ramp: recipe.ramp_mm || 0,
    };
  }

  function solveEndmill(ctx, base) {
    const { M, tool, op, agg, machine, total_mm, cool } = ctx;
    const o = OPS[op];
    const D = tool.actual_mm, z = tool.flutes || 1;
    const rpm = base.rpm;
    const vc = (Math.PI * D * rpm) / 1000; // m/min
    const ae = o.aeMm ? Math.min(o.aeMm, D) : o.ae * D;
    const aeFrac = ae / D;
    const thin = chipThinning(aeFrac);
    const feedMul = o.feedMul || 1;
    let fz = base.fzSlot * thin * agg;
    let feed = rpm * z * fz * feedMul;
    let feedCapped = false;
    if (feed > machine.max_feed_mm) { feed = machine.max_feed_mm; fz = feed / (rpm * z * feedMul); feedCapped = true; }

    // depth of cut: start from the rule, then respect the tool, then the machine
    const proven = base.source === "tested" && op === "slot" && agg <= 1.0001 && base.docKnown;
    let doc = base.docSlot * o.docMul * agg;
    let docLimit = base.source === "tested" && base.docKnown && op === "slot" ? "tested" : "rule";
    const cap = ctx.M.docCap * D;
    if (!proven && doc > cap) { doc = cap; docLimit = "tool diameter"; }
    const fluteMax = tool.flute_len_mm * 0.9;
    if (doc > fluteMax) { doc = fluteMax; docLimit = "flute length"; }
    let tooLight = false;
    if (doc < MIN_DOC) { doc = MIN_DOC; tooLight = true; }
    if (total_mm > 0 && doc > total_mm) { doc = total_mm; docLimit = "stock thickness"; }

    const stick = ctx.stick_mm > 0 ? ctx.stick_mm : (total_mm || doc) + 3;
    const feedPerSec = feed / 60;
    const I = (Math.PI * Math.pow(D * 0.7, 4)) / 64;
    const E = tool.mat === "hss" ? 210e3 : 580e3; // N/mm^2
    const phi = aeFrac >= 1 ? Math.PI : Math.acos(1 - 2 * aeFrac);
    const engaged = Math.min(1, (z * phi) / (2 * Math.PI)) || 1;
    const availW = machine.spindle_w * Math.min(1, rpm / machine.max_rpm);
    const loads = d => {
      const mrr = feedPerSec * ae * d;                  // mm^3/s
      const power = (M.kc * mrr) / 1000;                // W
      const ft = power / (vc / 60 || 1);                // mean tangential force, N
      const fpeak = (ft / engaged) * 1.2;               // peak force, N
      return { mrr, power, fpeak, defl: (fpeak * Math.pow(stick, 3)) / (3 * E * I) };
    };
    let L = loads(doc);
    if (!proven) {
      if (L.defl > machine.defl_limit_mm) { doc *= machine.defl_limit_mm / L.defl; docLimit = "tool deflection"; L = loads(doc); }
      if (L.power > availW * 0.7) { doc *= (availW * 0.7) / L.power; docLimit = "spindle power"; L = loads(doc); }
      if (doc < MIN_DOC) { doc = MIN_DOC; tooLight = true; L = loads(doc); }
    }
    const docMax = doc;
    let passes = 0, docPass = doc;
    if (total_mm > 0) {
      passes = Math.max(1, Math.ceil(total_mm / doc - PASS_SLACK));
      docPass = total_mm / passes;
      L = loads(docPass);
    }

    const plunge = Math.min(feed, base.plunge);
    const ramp = base.ramp > 0 ? Math.min(base.ramp, feed) : feed * M.ramp;
    return {
      rpm, vc, sfm: vc / FT, feed, fz, plunge, ramp, rampAngle: RAMP_ANGLE, rampLength: docPass / Math.tan((RAMP_ANGLE * Math.PI) / 180),
      doc: docMax, docPass, passes, ae, aeFrac, thin, docLimit, feedCapped, tooLight, proven, stick,
      mrr: L.mrr * 60, power: L.power, availW, force: L.fpeak, defl: L.defl, torque: L.power > 0 ? L.power / ((2 * Math.PI * rpm) / 60) : 0,
    };
  }

  function solveFace(ctx, base) {
    const { tool, agg, machine } = ctx;
    const D = tool.actual_mm, z = tool.flutes || 1;
    const rpm = base.rpm;
    const stepFrac = clamp(ctx.stepover || FACE.stepover, 0.1, 0.95);
    let fz = base.fzSlot * agg;
    let feed = rpm * z * fz;
    let feedCapped = false;
    if (feed > machine.max_feed_mm) { feed = machine.max_feed_mm; fz = feed / (rpm * z); feedCapped = true; }
    let doc = Math.min(FACE.doc * agg, FACE.docMax);
    let docLimit = "skim depth";
    if (ctx.total_mm > 0 && doc > ctx.total_mm) { doc = ctx.total_mm; docLimit = "depth to remove"; }
    let passes = 0, docPass = doc;
    if (ctx.total_mm > 0) { passes = Math.max(1, Math.ceil(ctx.total_mm / doc - PASS_SLACK)); docPass = ctx.total_mm / passes; }
    const ae = stepFrac * D;
    const vc = (Math.PI * D * rpm) / 1000;
    const mrr = (feed / 60) * ae * docPass;
    return {
      rpm, vc, sfm: vc / FT, feed, fz, plunge: Math.min(feed, base.plunge || FACE.plunge), ramp: Math.min(feed, base.ramp || FACE.plunge),
      rampAngle: RAMP_ANGLE, rampLength: 0, doc, docPass, passes, ae, aeFrac: stepFrac, thin: 1, docLimit, feedCapped, tooLight: false,
      proven: base.source === "tested", stick: 0, mrr: mrr * 60, power: (MATERIALS.spoilboard.kc * mrr) / 1000,
      availW: machine.spindle_w * Math.min(1, rpm / machine.max_rpm), force: 0, defl: 0, torque: 0,
    };
  }

  function faceBaseline(tool, machine) {
    const D = tool.actual_mm;
    const rpm = clamp(r100((FACE.rimSpeed * 1000) / (Math.PI * D)), machine.min_rpm, machine.max_rpm);
    return { source: "model", rpm, fzSlot: FACE.fz * (tool.feed_factor || 1), docSlot: FACE.doc, plunge: FACE.plunge, ramp: 0 };
  }

  /**
   * recommend({material, tool, op, total_mm, stick_mm, cool, agg, machine, recipe, stepover})
   * tool: {actual_mm, flutes, flute_len_mm, overall_mm, mat: 'carbide'|'hss', kind, feed_factor, nominal_mm}
   * recipe: a tested setting {rpm, feed_mm, plunge_mm, ramp_mm, doc_mm} for this tool + material (optional)
   */
  function recommend(inp) {
    const M = MATERIALS[inp.material];
    if (!M) throw new Error("Unknown material " + inp.material);
    const t0 = inp.tool;
    if (!t0 || !(t0.actual_mm > 0) || !isFinite(t0.actual_mm)) throw new Error("Tool needs a diameter");
    const pos = (x, fallback) => (isFinite(x) && x > 0 ? x : fallback);
    const tool = Object.assign({}, t0, {
      flutes: Math.max(1, Math.round(pos(t0.flutes, 1))), flute_len_mm: pos(t0.flute_len_mm, t0.actual_mm * 3), overall_mm: pos(t0.overall_mm, 0),
      nominal_mm: pos(t0.nominal_mm, t0.actual_mm), feed_factor: pos(t0.feed_factor, 1),
    });
    const machine = Object.assign({}, defaultMachine, inp.machine);
    const ctx = {
      M, tool, machine, material: inp.material, op: inp.op || "slot", agg: clamp(pos(inp.agg, 1), 0.3, 2), total_mm: isFinite(inp.total_mm) ? Math.max(0, inp.total_mm) : 0,
      stick_mm: isFinite(inp.stick_mm) ? Math.max(0, inp.stick_mm) : 0, cool: inp.cool || "mist", stepover: inp.stepover,
    };
    const face = inp.material === "spoilboard";
    if (face) ctx.op = "surface";
    else if (!OPS[ctx.op]) throw new Error("Unknown operation " + ctx.op);
    const hasTested = !!(inp.recipe && inp.recipe.rpm > 0 && inp.recipe.feed_mm > 0 && isFinite(inp.recipe.rpm) && isFinite(inp.recipe.feed_mm));
    const modelBase = face ? faceBaseline(tool, machine) : modelBaseline(M, tool, machine);
    const solve = face ? solveFace : solveEndmill;
    const model = solve(ctx, modelBase);
    let base = modelBase, r = model;
    if (hasTested) {
      base = face ? { source: "tested", rpm: inp.recipe.rpm, fzSlot: inp.recipe.feed_mm / (inp.recipe.rpm * (tool.flutes || 1)),
                      docSlot: FACE.doc, plunge: inp.recipe.plunge_mm, ramp: inp.recipe.ramp_mm } : testedBaseline(inp.recipe, tool, M);
      r = solve(ctx, base);
    }
    // rpm outside the machine's range is the machine's problem, not the tested setting's: flag it, don't silently change it
    r.source = hasTested ? (ctx.op === "slot" || face ? "tested" : "tested-scaled") : "model";
    r.material = inp.material;
    r.op = ctx.op;
    r.model = hasTested ? { rpm: model.rpm, feed: model.feed, doc: model.doc, fz: model.fz } : null;
    r.recipe = hasTested ? inp.recipe : null;
    r.notes = advise(ctx, r, base, !!hasTested);
    return r;
  }

  function advise(ctx, r, base, hasTested) {
    const { tool, M, machine, op, material } = ctx;
    const D = tool.actual_mm, z = tool.flutes || 1;
    const notes = [];
    const add = (level, text) => notes.push({ level, text });
    const face = material === "spoilboard";
    const metal = material === "aluminum";

    if (face && tool.kind !== "face") add("warn", "Spoilboard surfacing is meant for the facemill. An endmill leaves ridges and takes forever.");
    if (!face && tool.kind === "face") add("bad", "The facemill is for surfacing the spoilboard only. Pick an endmill for aluminum or polycarbonate.");
    if (hasTested) {
      if (r.source === "tested") add("ok", "Using your team's tested setting for this tool. Change one thing at a time if you adjust it.");
      else add("info", "Calculated from your tested slot setting. Start about 20% lighter on the first part and work up.");
    } else {
      add("info", "No tested setting for this tool and material yet, so this is calculated and scaled from the team's tested cuts. Run a scrap test, then save what works.");
    }
    if (r.feedCapped) add("info", `Feed is held to the machine's maximum (${Math.round(machine.max_feed_mm)} mm/min), so chipload fell to ${(r.fz / IN).toFixed(4)} in/tooth.`);
    if (r.rpm < machine.min_rpm - 1 || r.rpm > machine.max_rpm + 1)
      add("warn", `${Math.round(r.rpm)} rpm is outside the machine range you set (${machine.min_rpm}-${machine.max_rpm}).`);
    else if (r.rpm < 8000 && !(face && hasTested))
      add("info", "Community advice (Chief Delphi) is to avoid running the OMIO spindle below about 8,000 rpm and to prefer 12,000+ when you can.");
    else if (r.rpm < 8000)
      add("info", "5,000 rpm is below the 8,000+ rpm the community suggests for this spindle, but it is your tested facemill setting.");

    if (face) {
      add("warn", "MDF dust is nasty: run the dust shoe/vacuum and wear a respirator.");
      add("info", "Check the bit's maximum rpm rating. Big surfacing bits are often rated 18,000-19,000 rpm or lower.");
      add("info", "Take light skims (0.25-0.5 mm / 0.010-0.020 in). Cut every layer in the same direction for a flat result.");
      return notes;
    }
    if (r.tooLight) add("bad", "Even a 0.05 mm pass is more than the tool or spindle should take here. Shorten the stick-out or use a bigger tool.");
    if (r.docLimit === "tool deflection") add("info", `Depth reduced so tool deflection stays under ${machine.defl_limit_mm} mm. Less stick-out allows deeper passes.`);
    if (r.docLimit === "spindle power") add("info", "Depth reduced to stay within about 70% of the spindle's power at this rpm.");
    if (r.docLimit === "flute length") add("info", `Depth held to 90% of the flute length (${tool.flute_len_mm} mm).`);
    if (ctx.total_mm > tool.flute_len_mm)
      add("bad", `Cutting ${ctx.total_mm.toFixed(1)} mm deep is more than the tool's ${tool.flute_len_mm} mm flute length. The shank would rub; use a longer tool or a thinner stock.`);
    if (tool.overall_mm > 0 && r.stick > tool.overall_mm * 0.8) add("warn", "Stick-out is close to the tool's overall length. Check the tool can reach and is held deep enough in the collet.");
    if (r.stick / D > 4) add(r.stick / D > 6 ? "bad" : "warn", `Stick-out is ${(r.stick / D).toFixed(1)} x the diameter, which invites chatter. Shorten it if you can.`);
    if (r.power > r.availW * 0.7) add("warn", `Predicted spindle load is ${Math.round((r.power / r.availW) * 100)}% of what is available at this rpm.`);
    if (r.defl > machine.defl_limit_mm) add("warn", `Predicted tool deflection is ${(r.defl * 1000).toFixed(0)} um, above your ${(machine.defl_limit_mm * 1000).toFixed(0)} um limit. Expect a taper or a poor wall.`);
    if (tool.mat === "hss" && metal) add("warn", "HSS wears quickly in aluminum on a router. Carbide is much better.");
    if (z > 1 && metal && D < 8) add("warn", "Multi-flute small tools pack with aluminum chips. Single flute clears them best.");
    if (metal && ctx.cool === "none") add("bad", "Aluminum with no lubricant or air: chips weld to the tool. Use mist or flood plus an air blast.");
    if (metal && ctx.cool === "air") add("info", "Air alone works for light cuts; a little mist (WD-40 style) keeps aluminum from welding to the flute.");
    if (!metal && ctx.cool === "none") add("warn", "Polycarbonate melts without chip evacuation. Use an air blast.");
    if (!metal) add("info", "Polycarbonate: air blast or water-based coolant only. Oils and solvents can craze it. Keep the tool moving; dwelling melts it.");
    if (metal && op === "slot") add("info", "Cutting a part out? Go about 0.2 mm into the spoilboard so it cuts all the way through, and tab small parts.");
    if (!metal && op === "slot") add("info", "Radius inside corners (at least the tool radius). Sharp corners crack polycarbonate later.");
    if (tool.actual_mm < tool.nominal_mm - 0.05)
      add("info", `Undersized tool: use ${tool.actual_mm} mm (not ${tool.nominal_mm} mm) as the CAM diameter. A slot with it is ${tool.actual_mm} mm wide.`);
    if (!hasTested && r.fz < D * 0.005) add("warn", "Chipload is very low. The tool will rub and heat up; raise the feed or lower the rpm.");
    if (!notes.some(n => n.level === "bad" || n.level === "warn")) add("ok", "No red flags. Adjust by sound and finish.");
    return notes;
  }

  /** Time to run `length_mm` of toolpath, in minutes. */
  function cutMinutes(length_mm, passes, feed) {
    if (!(feed > 0)) return 0;
    return (Math.max(0, length_mm) * Math.max(1, passes || 1)) / feed;
  }

  /**
   * Surfacing the spoilboard with the facemill in zig-zag lines.
   * area: {w, l} to flatten, cutter diameter, stepover fraction, margin past the edges, feed, depth to remove, depth per pass.
   * Lines run along `l`; the stepover is across `w`. The cutter centre only has to reach the board edge on the line direction, and
   * half a diameter inside it across the lines, because the cutter's own radius covers the rest.
   */
  function spoilboardPlan(p) {
    const D = p.diameter, w = p.w, l = p.l, step = clamp(p.stepover || 0.7, 0.1, 0.95) * D;
    if (!(D > 0) || !(w > 0) || !(l > 0) || ![D, w, l].every(isFinite)) throw new Error("Need a cutter diameter and an area");
    const m = clamp(isFinite(p.margin) ? p.margin : 3, 0, D);   // running past the edge by more than a cutter diameter is pointless
    const span = Math.max(0, w - D + 2 * m);            // distance the cutter centre must travel across the lines
    const lines = span === 0 ? 1 : Math.ceil(span / step - 1e-9) + 1;
    if (lines > 2000) throw new Error("That would be more than 2,000 lines. Check the board size and the cutter.");
    const spacing = lines > 1 ? span / (lines - 1) : 0;
    const lineLen = l + 2 * m;
    const layerPath = lines * lineLen + (lines - 1) * spacing;
    const doc = p.docPerPass > 0 ? p.docPerPass : FACE.doc;
    const layers = p.depth > 0 ? Math.max(1, Math.ceil(p.depth / doc - PASS_SLACK)) : 1;
    const layerMin = cutMinutes(layerPath, 1, p.feed);
    // centre of the first line, measured across the board from the edge, so the user can set up the toolpath
    const firstLine = w < D - 2 * m ? w / 2 : D / 2 - m;
    return {
      lines, spacing, lineLen, layerPath, layers, docPass: p.depth > 0 ? p.depth / layers : doc, layerMin, totalMin: layerMin * layers,
      removedCm3: (w * l * (p.depth > 0 ? p.depth : doc)) / 1000, firstLine, overlap: spacing > 0 ? 1 - spacing / D : 0,
      ok: spacing <= D + 1e-9,
    };
  }

  /** Where to put the tool centre for a round hole, and the feed to command so the cutting edge sees the intended feed. */
  function holePath(p) {
    const D = p.tool, H = p.hole;
    if (!(D > 0) || !(H > 0)) throw new Error("Need hole and tool diameters");
    const pathDia = H - D;
    const out = { pathDia, ok: pathDia > 0.05, feedCentre: null, leave: 0 };
    if (!out.ok) return out;
    out.feedCentre = p.feed ? (p.feed * pathDia) / H : null; // inside arc: the edge moves faster than the centre
    return out;
  }

  /** From a test cut, find the tool's real cutting diameter. Slot: width of a full-width slot. Hole: measured vs programmed hole. */
  function effectiveDiameter(p) {
    if (p.slotWidth > 0) return p.slotWidth;
    if (p.holeMeasured > 0 && p.holeProgrammed > 0 && p.camDia > 0) return p.camDia + (p.holeMeasured - p.holeProgrammed);
    throw new Error("Measure a slot width, or a hole you cut");
  }

  return {
    MATERIALS, OPS, FACE, RAMP_ANGLE, HSS_FZ, IN, chipThinning, recommend, cutMinutes, spoilboardPlan, holePath, effectiveDiameter,
    defaultMachine,
  };
});
