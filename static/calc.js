// Feeds & speeds model. Pure functions, all lengths in mm, feeds in mm/min.
(function (root) {
  const OPS = {
    slot:     { label: "Slot (full width)",      ae: () => 1,                          fz: 0.80, doc: "doc_slot", docMul: 1.0 },
    profile:  { label: "Profile / side cut",     ae: m => m.woc,                       fz: 1.00, doc: "doc_side", docMul: 1.0 },
    pocket:   { label: "Pocket clearing",        ae: m => Math.max(m.woc, 0.4) * 0.9,  fz: 0.95, doc: "doc_slot", docMul: 1.3 },
    adaptive: { label: "Adaptive / high-speed",  ae: () => 0.10,                       fz: 1.00, doc: "doc_side", docMul: 1.5 },
    finish:   { label: "Finish wall (0.1 mm)",   ae: () => 0,                          fz: 0.80, doc: "doc_side", docMul: 2.0, aeMm: 0.1, feedMul: 0.8 },
  };
  const E_MOD = { carbide: 580e3, hss: 210e3 }; // N/mm^2

  const round = (x, step) => Math.round(x / step) * step;

  function compute(tool, mat, opKey, job, set) {
    const op = OPS[opKey];
    const D = tool.actual_mm;
    const z = tool.flutes;
    const agg = job.agg;
    const notes = []; // {level, text}
    const add = (level, text) => notes.push({ level, text });

    // --- spindle speed from surface speed -------------------------------
    const sfmTarget = tool.mat === "hss" ? mat.sfm_hss : mat.sfm_carbide; // speed is set by the material, not the aggressiveness slider
    const vcTarget = sfmTarget * 0.3048; // m/min
    let rpm = (vcTarget * 1000) / (Math.PI * D);
    let rpmLimited = false;
    if (rpm > set.max_rpm) { rpm = set.max_rpm; rpmLimited = true; }
    if (rpm < set.min_rpm) { rpm = set.min_rpm; rpmLimited = true; }
    rpm = Math.round(rpm / 100) * 100;
    const vc = (Math.PI * D * rpm) / 1000; // m/min actual

    // --- radial engagement and chip thinning ----------------------------
    const face = tool.kind === "face";
    // Facing cutters take light, narrow passes; end mills follow the operation's engagement.
    const faceAe = mat.heat === "metal" ? 0.1 : mat.heat === "plastic" ? 0.3 : 0.5;
    const ae = face ? faceAe * D : op.aeMm ? Math.min(op.aeMm, D) : Math.min(1, op.ae(mat)) * D;
    const aeFrac = ae / D;
    let thin = 1;
    if (aeFrac > 0 && aeFrac < 0.5) thin = Math.min(2, 1 / Math.sqrt(1 - Math.pow(1 - 2 * aeFrac, 2)));

    // --- chipload and feed ---------------------------------------------
    let fz = Math.min(D, 12) * mat.fz_ratio * op.fz * thin * agg * (tool.feed_factor || 1);
    if (face) fz = 0.035 * (mat.fz_ratio / 0.017) * Math.min(thin, 1.5) * agg * (tool.feed_factor || 1); // typical insert/HSS facing chipload, mm/tooth
    let feed = rpm * z * fz * (op.feedMul || 1);
    let feedCapped = false;
    if (feed > set.max_feed_mm) { feed = set.max_feed_mm; feedCapped = true; fz = feed / (rpm * z * (op.feedMul || 1)); }

    // --- depth of cut: start from material rule, then check the machine --
    let doc = D * mat[op.doc] * op.docMul * agg;
    if (face) doc = (mat.heat === "metal" ? 0.15 : mat.heat === "plastic" ? 0.5 : 1.5) * agg;
    let docLimit = "material";
    const maxByFlute = tool.flute_len_mm * 0.9;
    if (doc > maxByFlute) { doc = maxByFlute; docLimit = "flute length"; }
    if (job.total_mm > 0 && doc > job.total_mm) { doc = job.total_mm; docLimit = "total depth"; }

    const stick = job.stick_mm > 0 ? job.stick_mm : (job.total_mm || doc) + 3;
    const feedPerSec = feed / 60;
    const dCore = D * 0.7;
    const I = (Math.PI * Math.pow(dCore, 4)) / 64;
    const E = E_MOD[tool.mat] || E_MOD.carbide;
    const phi = aeFrac >= 1 ? Math.PI : Math.acos(1 - 2 * aeFrac);
    const engaged = Math.min(1, (z * phi) / (2 * Math.PI)) || 1;

    function loads(d) {
      const mrr = feedPerSec * ae * d;                    // mm^3/s
      const power = (mat.kc * mrr) / 1000;                 // W (N/mm^2 * mm^3/s = mW)
      const vcs = vc / 60 || 1;                            // m/s
      const ft = power / vcs;                              // mean tangential N
      const fpeak = (ft / engaged) * 1.2;                  // peak resultant N
      const defl = (fpeak * Math.pow(stick, 3)) / (3 * E * I); // mm
      return { mrr, power, ft, fpeak, defl };
    }
    const availW = set.spindle_w * Math.min(1, rpm / set.max_rpm);
    let L = loads(doc);
    if (L.defl > set.defl_limit_mm) {
      const k = set.defl_limit_mm / L.defl;
      doc *= k; docLimit = "tool deflection"; L = loads(doc);
    }
    if (L.power > availW * 0.7) {
      const k = (availW * 0.7) / L.power;
      doc *= k; docLimit = "spindle power"; L = loads(doc);
    }
    const minDoc = 0.05;
    let tooLight = false;
    if (doc < minDoc) { doc = minDoc; tooLight = true; L = loads(doc); }

    const passes = job.total_mm > 0 ? Math.max(1, Math.ceil(job.total_mm / doc - 1e-9)) : 0;
    const docPass = passes ? job.total_mm / passes : doc;
    if (passes) L = loads(docPass);

    const plunge = Math.min(feed, feed * mat.plunge / Math.sqrt(thin));
    const ramp = feed * 0.5;

    // --- advice ---------------------------------------------------------
    if (rpmLimited) add("info", `RPM held to your machine range. Surface speed is ${Math.round(vc / 0.3048)} SFM (target ${Math.round(sfmTarget)}).`);
    if (feedCapped) add("info", `Feed capped by your max feed, so chipload fell to ${fz.toFixed(4)} mm/tooth.`);
    if (docLimit === "tool deflection") add("info", `Depth reduced so predicted tool deflection stays under ${set.defl_limit_mm} mm. A shorter stick-out allows deeper cuts.`);
    if (docLimit === "spindle power") add("info", "Depth reduced to stay within ~70% of spindle power at this RPM.");
    if (tooLight) add("bad", "Even a 0.05 mm pass exceeds the deflection or power limit. Shorten the stick-out, use a bigger tool, or raise the limits.");
    if (face) add("info", "Face mill: using a light skim (narrow stepover, shallow depth). Keep the table rigid and use air blast.");
    if (job.total_mm > tool.flute_len_mm) add("bad", `Total depth ${job.total_mm.toFixed(1)} mm is deeper than the ${tool.flute_len_mm} mm flute length. The shank would rub; use a longer-flute tool.`);
    if (tool.overall_mm > 0 && stick > tool.overall_mm * 0.8) add("warn", "Stick-out is close to the tool's overall length; check you can reach this depth.");
    if (!face && fz < Math.min(D, 12) * 0.004) add("warn", "Chipload is very low; the tool may rub and overheat. Raise feed or lower RPM.");
    if (stick / D > 4) add(stick / D > 6 ? "bad" : "warn", `Stick-out is ${(stick / D).toFixed(1)}x the diameter; expect chatter. Shorten it if you can.`);
    if (tool.mat === "hss" && mat.heat === "metal") add("warn", "HSS wears quickly in metal on a router; carbide is strongly preferred.");
    if (mat.heat === "metal" && job.cool === "none") add("bad", "Metal with no coolant or air: chips will recut and weld to the tool. Use air blast at minimum.");
    if (mat.heat === "plastic" && job.cool === "none") add("warn", "Plastics melt without chip evacuation; use air blast.");
    if (mat.heat === "metal" && opKey === "slot") add("warn", "Full slotting in metal: keep air or mist on and listen for chatter.");
    if (z > 1 && mat.heat === "metal" && D < 6) add("warn", "Small multi-flute tools clog in aluminum; single flute clears chips better.");
    if (tool.actual_mm < tool.nominal_mm - 0.05)
      add("info", `Undersized tool: use ${tool.actual_mm} mm (not ${tool.nominal_mm} mm) as the CAM diameter. A slot cut with it is ${tool.actual_mm} mm wide.`);
    if (!notes.some(n => n.level !== "info")) add("ok", "No red flags. Treat as a starting point and adjust by sound and finish.");

    return {
      rpm, vc, sfm: vc / 0.3048, feed, plunge, ramp, fz, doc: docPass, passes, ae, aeFrac, thin, docLimit,
      mrr_mm3min: L.mrr * 60, power_w: L.power, avail_w: availW, force_n: L.fpeak, defl_mm: L.defl, stick_mm: stick,
      torque_nm: L.power > 0 ? L.power / ((2 * Math.PI * rpm) / 60) : 0, notes,
    };
  }

  const api = { OPS, compute };
  if (typeof module !== "undefined") module.exports = api; else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
