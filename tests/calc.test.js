// Run with:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Cnc = require("../static/js/cnc.js");
const Shop = require("../static/js/shop.js");
const Frc = require("../static/js/frc.js");

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ""} expected ${expected} +/- ${tol}, got ${actual}`);
const within = (actual, expected, pct, msg) => near(actual, expected, Math.abs(expected) * pct, msg);

// ------------------------------------------------------------------ CNC model
const MACHINE = { min_rpm: 5000, max_rpm: 24000, max_feed_mm: 4000, spindle_w: 2200, defl_limit_mm: 0.02 };
const tool = (o) => Object.assign({ nominal_mm: 5, actual_mm: 4.6, flutes: 1, flute_len_mm: 12, overall_mm: 50, mat: "carbide", kind: "flat", feed_factor: 1 }, o);
const T5 = tool({});
const FACE = tool({ nominal_mm: 63.5, actual_mm: 63.5, flutes: 4, flute_len_mm: 12.7, mat: "hss", kind: "face" });
const rec = (o) => Cnc.recommend(Object.assign({ machine: MACHINE, op: "slot", total_mm: 3.175 }, o));

test("model reproduces the team's tested 5 mm settings", () => {
  const al = rec({ material: "aluminum", tool: T5 });
  assert.equal(al.rpm, 24000);
  within(al.feed, 1727.2, 0.01, "aluminum feed");
  near(al.doc, 1.5875, 0.001, "aluminum depth");
  assert.equal(al.passes, 2);
  within(al.plunge, 508, 0.01);
  const pc = rec({ material: "polycarbonate", tool: T5 });
  assert.equal(pc.rpm, 24000);
  within(pc.feed, 3937, 0.01, "poly feed");
  near(pc.doc, 3.175, 0.001);
  assert.equal(pc.passes, 1);
  assert.equal(al.source, "model");
});

test("model is close to the other tested tools", () => {
  const al4 = rec({ material: "aluminum", tool: tool({ actual_mm: 3.7, nominal_mm: 4 }) });
  within(al4.feed, 1320.8, 0.1, "4 mm aluminum feed (tested at 20,000 rpm; model runs 24,000)");
  const hss = rec({ material: "aluminum", tool: tool({ actual_mm: 2.845, nominal_mm: 3.175, mat: "hss", flute_len_mm: 20 }) });
  within(hss.rpm, 9500, 0.03);
  within(hss.feed, 254, 0.05, "1/8 HSS aluminum");
  const pc6 = rec({ material: "polycarbonate", tool: tool({ actual_mm: 6, nominal_mm: 6, flute_len_mm: 20 }) });
  within(pc6.rpm, 22000, 0.06);
  assert.ok(pc6.feed <= 4000 && pc6.feed > 3500);
});

test("a tested setting is returned exactly and wins over the model", () => {
  const recipe = { rpm: 24000, feed_mm: 1727.2, plunge_mm: 508, ramp_mm: 1143, doc_mm: 1.5875 };
  const r = rec({ material: "aluminum", tool: T5, recipe });
  assert.equal(r.source, "tested");
  assert.equal(r.rpm, 24000);
  near(r.feed, 1727.2, 1e-6);
  near(r.plunge, 508, 1e-9);
  near(r.ramp, 1143, 1e-9);
  near(r.doc, 1.5875, 1e-9);
  assert.ok(r.model && r.model.feed > 0);
  assert.ok(r.notes.some((n) => n.level === "ok" && /tested/i.test(n.text)));
});

test("other operations scale from the tested slot", () => {
  const recipe = { rpm: 11000, feed_mm: 254, plunge_mm: 254, ramp_mm: 254 };
  const slot = rec({ material: "aluminum", tool: tool({ actual_mm: 6, nominal_mm: 6, flute_len_mm: 20 }), recipe });
  const pocket = rec({ material: "aluminum", tool: tool({ actual_mm: 6, nominal_mm: 6, flute_len_mm: 20 }), recipe, op: "pocket" });
  assert.equal(slot.source, "tested");
  assert.equal(pocket.source, "tested-scaled");
  assert.equal(pocket.rpm, 11000);
  assert.ok(pocket.feed >= slot.feed && pocket.feed < slot.feed * 1.5);
  const adaptive = rec({ material: "aluminum", tool: T5, op: "adaptive" });
  const slot5 = rec({ material: "aluminum", tool: T5 });
  assert.ok(adaptive.feed > slot5.feed * 1.5, "light radial engagement allows a higher feed");
  assert.ok(adaptive.ae < slot5.ae);
});

test("spoilboard facemill model equals the tested preset", () => {
  const r = rec({ material: "spoilboard", tool: FACE, total_mm: 0.5, op: "surface" });
  assert.equal(r.rpm, 5000);
  near(r.feed, 762, 0.5);
  near(r.fz, 0.0381, 1e-4);
  near(r.doc, 0.5, 1e-9, "limited by the 0.5 mm asked for");
  near(r.docPass, 0.5, 1e-9);
  assert.equal(r.passes, 1);
  near(rec({ material: "spoilboard", tool: FACE, total_mm: 3 }).doc, 0.508, 1e-9, "0.020 in skim limit");
  assert.equal(rec({ material: "spoilboard", tool: FACE, total_mm: 0.508 }).passes, 1, "0.020 in is one skim");
  const tested = rec({ material: "spoilboard", tool: FACE, total_mm: 1.2, recipe: { rpm: 5000, feed_mm: 762, plunge_mm: 338.7, ramp_mm: 338.7 } });
  assert.equal(tested.source, "tested");
  assert.equal(tested.passes, 3, "1.2 mm in 0.508 mm skims");
  const big = rec({ material: "spoilboard", tool: Object.assign({}, FACE, { actual_mm: 38.1 }), total_mm: 0.5 });
  within(big.rpm, 8333, 0.02, "smaller cutter spins faster, same rim speed");
  within(big.vc, r.vc, 0.02);
});

test("chip thinning and pass counting", () => {
  near(Cnc.chipThinning(0.5), 1, 1e-9);
  near(Cnc.chipThinning(1), 1, 1e-9);
  near(Cnc.chipThinning(0.1), 1 / (2 * Math.sqrt(0.09)), 1e-9);
  assert.equal(Cnc.chipThinning(0.001), 2, "capped at 2");
  assert.equal(rec({ material: "aluminum", tool: T5, total_mm: 6.35 }).passes, 4);
  assert.equal(rec({ material: "aluminum", tool: T5, total_mm: 1.5875 }).passes, 1);
  assert.equal(rec({ material: "aluminum", tool: T5, total_mm: 0 }).passes, 0);
  const r = rec({ material: "aluminum", tool: T5, total_mm: 6.35 });
  near(r.docPass * r.passes, 6.35, 1e-9);
  near(r.doc, 1.5875, 1e-3, "doc is the max stepdown to give CAM");
  const odd = rec({ material: "aluminum", tool: T5, total_mm: 5 });
  assert.equal(odd.passes, 4);
  near(odd.docPass, 1.25, 1e-9);
  near(odd.doc, 1.5875, 1e-3);
  const through = rec({ material: "aluminum", tool: T5, total_mm: 3.375 });
  assert.equal(through.passes, 3, "1/8 in plus 0.2 mm into the spoilboard is three passes, like CAM would do");
  near(through.doc, 1.5875, 1e-3);
});

test("machine limits cap rpm and feed", () => {
  const r = rec({ material: "polycarbonate", tool: T5, machine: Object.assign({}, MACHINE, { max_feed_mm: 1000, max_rpm: 18000 }) });
  assert.equal(r.rpm, 18000);
  assert.equal(r.feed, 1000);
  assert.ok(r.feedCapped);
  assert.ok(r.notes.some((n) => /maximum/i.test(n.text)));
});

test("advice flags the real mistakes", () => {
  const lvl = (r, level, re) => r.notes.some((n) => n.level === level && re.test(n.text));
  assert.ok(lvl(rec({ material: "aluminum", tool: T5, cool: "none" }), "bad", /weld/i));
  assert.ok(lvl(rec({ material: "aluminum", tool: tool({ mat: "hss" }) }), "warn", /HSS/));
  assert.ok(lvl(rec({ material: "aluminum", tool: tool({ flutes: 2 }) }), "warn", /Single flute/i));
  assert.ok(lvl(rec({ material: "aluminum", tool: T5, total_mm: 15 }), "bad", /flute length/i));
  assert.ok(lvl(rec({ material: "aluminum", tool: FACE }), "bad", /facemill/i));
  assert.ok(lvl(rec({ material: "spoilboard", tool: T5 }), "warn", /facemill/i));
  assert.ok(lvl(rec({ material: "polycarbonate", tool: T5 }), "info", /air blast|coolant/i));
  assert.ok(lvl(rec({ material: "aluminum", tool: T5 }), "ok", /No red flags/));
  assert.ok(lvl(rec({ material: "spoilboard", tool: FACE, total_mm: 0.5 }), "warn", /respirator/i));
});

test("rejects bad input", () => {
  assert.throws(() => rec({ material: "steel", tool: T5 }), /Unknown material/);
  assert.throws(() => rec({ material: "aluminum", tool: tool({ actual_mm: 0 }) }), /diameter/);
  assert.throws(() => rec({ material: "aluminum", tool: T5, op: "laser" }), /operation/);
});

test("aggressiveness scales feed and depth", () => {
  const base = rec({ material: "aluminum", tool: T5, total_mm: 0 });
  const careful = rec({ material: "aluminum", tool: T5, total_mm: 0, agg: 0.8 });
  within(careful.feed, base.feed * 0.8, 0.001);
  within(careful.doc, base.doc * 0.8, 0.001);
});

test("loads stay sane for the tested cuts", () => {
  const r = rec({ material: "polycarbonate", tool: T5, recipe: { rpm: 24000, feed_mm: 3937, plunge_mm: 1016, ramp_mm: 3048, doc_mm: 3.175 } });
  assert.ok(r.power < r.availW * 0.3, "a tested cut should be well inside the spindle's power");
  assert.ok(r.defl < 0.02);
  assert.ok(r.torque > 0);
  assert.equal(r.rampAngle, 2);
  near(r.rampLength, 3.175 / Math.tan((2 * Math.PI) / 180), 1e-6);
});

test("spoilboard plan covers the whole board", () => {
  const p = Cnc.spoilboardPlan({ diameter: 63.5, w: 565, l: 770, stepover: 0.7, feed: 762, depth: 0.5, docPerPass: 0.5, margin: 3 });
  assert.equal(p.lines, 13);
  near(p.layerPath, 13 * 776 + 12 * p.spacing, 1e-6);
  near(p.layerMin, p.layerPath / 762, 1e-9);
  assert.equal(p.layers, 1);
  assert.ok(p.layerMin > 12 && p.layerMin < 16);
  const two = Cnc.spoilboardPlan({ diameter: 63.5, w: 565, l: 770, feed: 762, depth: 1, docPerPass: 0.5 });
  assert.equal(two.layers, 2);
  near(two.totalMin, two.layerMin * 2, 1e-9);
  // property: every y in [0, w] is covered by some line, for many sizes
  for (const D of [25.4, 50.8, 63.5, 76.2]) for (const so of [0.4, 0.7, 0.9]) for (const w of [10, 40, 63.5, 100, 565, 1000]) {
    const plan = Cnc.spoilboardPlan({ diameter: D, w, l: 300, stepover: so, feed: 500, depth: 0.5, margin: 3 });
    const centres = Array.from({ length: plan.lines }, (_, i) => plan.firstLine + i * plan.spacing);
    for (let y = 0; y <= w; y += w / 200) {
      assert.ok(centres.some((c) => Math.abs(y - c) <= D / 2 + 1e-9), `y=${y} uncovered (D=${D}, so=${so}, w=${w})`);
    }
    assert.ok(plan.spacing <= so * D + 1e-9, "never steps over more than asked");
  }
  assert.throws(() => Cnc.spoilboardPlan({ diameter: 0, w: 1, l: 1 }));
});

test("hole sizing and tool calibration", () => {
  const h = Cnc.holePath({ hole: 12.7, tool: 4.6, feed: 1000 });
  near(h.pathDia, 8.1, 1e-9);
  near(h.feedCentre, (1000 * 8.1) / 12.7, 1e-9);
  assert.ok(h.ok);
  assert.equal(Cnc.holePath({ hole: 4.6, tool: 4.6 }).ok, false);
  assert.equal(Cnc.effectiveDiameter({ slotWidth: 4.62 }), 4.62);
  // programmed 12.7 mm hole with a 5 mm CAM tool measured 12.3: the real tool is 0.4 mm smaller than the CAM tool
  near(Cnc.effectiveDiameter({ holeMeasured: 12.3, holeProgrammed: 12.7, camDia: 5 }), 4.6, 1e-9);
  assert.throws(() => Cnc.effectiveDiameter({}));
  assert.equal(Cnc.cutMinutes(1000, 2, 500), 4);
  assert.equal(Cnc.cutMinutes(1000, 2, 0), 0);
});

// ------------------------------------------------------------------ drills, threads, hardware
test("number and letter drill tables are in order", () => {
  for (let n = 1; n < 80; n++) assert.ok(Shop.NUMBER_DRILLS[n] > Shop.NUMBER_DRILLS[n + 1], `#${n} must be bigger than #${n + 1}`);
  const letters = Object.values(Shop.LETTER_DRILLS);
  for (let i = 1; i < letters.length; i++) assert.ok(letters[i] > letters[i - 1]);
  assert.ok(Shop.NUMBER_DRILLS[1] < Shop.LETTER_DRILLS.A, "#1 is just under A");
  near(Shop.NUMBER_DRILLS[7], 0.201, 1e-9);
  near(Shop.LETTER_DRILLS.F, 0.257, 1e-9);
  for (const [n, v] of Object.entries(Shop.NUMBER_DRILLS)) near(v, v, 0, n); // all finite numbers
});

test("tap drills match the standard charts", () => {
  const first = (name, pct, forming) => {
    const th = Shop.ALL_THREADS.find((t) => t.name === name);
    assert.ok(th, name);
    return Shop.tapDrill(th, pct, forming).drills[0].label;
  };
  const expect = {
    "#4-40": "#43", "#6-32": "#36", "#8-32": "#29", "#10-24": "#25", "#10-32": "#21", "1/4-20": "#7", "1/4-28": "#3", "5/16-18": "F",
    "5/16-24": "I", "3/8-16": '5/16"', "3/8-24": "Q", "1/2-13": '27/64"', "M2x0.4": "1.6 mm", "M3x0.5": "2.5 mm", "M4x0.7": "3.3 mm",
    "M5x0.8": "4.2 mm", "M6x1": "5 mm", "M8x1.25": "6.8 mm", "M10x1.5": "8.5 mm", "M12x1.75": "10.2 mm",
  };
  for (const [name, label] of Object.entries(expect)) assert.equal(first(name), label, name);
  assert.equal(first("#10-32", 65, true), "#16", "forming tap hole for 10-32");
  assert.equal(first("M5x0.8", 65, true), "4.6 mm", "forming tap hole for M5");
  const th = Shop.ALL_THREADS.find((t) => t.name === "#10-32");
  const d = Shop.tapDrill(th);
  near(d.ideal, 0.1596, 0.0005);
  near(d.drills[0].percent, 76.4, 0.5);
  assert.ok(d.drills.every((x) => x.percent > 60 && x.percent < 90));
});

test("clearance holes and counterbores", () => {
  const th = (n) => Shop.ALL_THREADS.find((t) => t.name === n);
  const c = Shop.clearance(th("#10-32"));
  assert.deepEqual([c.close, c.free, c.closeDrill, c.freeDrill], [0.196, 0.201, "#9", "#7"]);
  const q = Shop.clearance(th("1/4-20"));
  assert.deepEqual([q.close, q.free, q.closeDrill, q.freeDrill], [0.257, 0.266, "F", "H"]);
  const m = Shop.clearance(th("M5x0.8"));
  assert.deepEqual([m.fine, m.medium, m.coarse], [5.3, 5.5, 5.8]);
  assert.equal(Shop.clearance(th("M5x0.5")).medium, 5.5, "fine pitch shares the clearance of its size");
  const cb = Shop.counterbore(th("1/4-20"));
  assert.equal(cb.head, 0.375);
  assert.equal(cb.height, 0.25);
  assert.ok(cb.dia >= cb.head + 0.029 && cb.dia < cb.head + 0.05);
  const cm = Shop.counterbore(th("M4x0.7"));
  assert.deepEqual([cm.head, cm.height], [7, 4]);
  assert.ok(cm.dia >= 7.5 && cm.depth >= 4.2);
  for (const t of Shop.ALL_THREADS) { Shop.tapDrill(t); Shop.clearance(t); Shop.counterbore(t); }
});

test("nearest drill search", () => {
  assert.equal(Shop.nearestDrills(0.2, 3, ["number", "letter", "fraction"])[0].label, "#8");
  assert.equal(Shop.nearestDrills(0.2, 1)[0].label, "5.1 mm", "across every set, 5.1 mm is closest to 0.200 in");
  assert.equal(Shop.nearestDrills(0.2, 3).length, 3);
  assert.equal(Shop.nearestDrills(0.25, 1, ["fraction"])[0].label, '1/4"');
  assert.equal(Shop.nearestDrills(6 / 25.4, 1, ["metric"])[0].label, "6 mm");
  assert.equal(Shop.fracLabel(6, 64), "3/32");
  assert.equal(Shop.fracLabel(72, 64), "1-1/8");
});

test("drilling and milling speeds", () => {
  const d = Shop.drillSpeed("aluminum", "hss", 0.25);
  near(d.rpm, (250 * 12) / (Math.PI * 0.25), 1e-6);
  assert.ok(d.ipr > 0.003 && d.ipr <= 0.008);
  assert.ok(Shop.drillSpeed("polycarbonate", "hss", 0.25).rpm < d.rpm, "plastic drills run slower");
  near(Shop.sfmFromRpm(Shop.rpmFromSfm(300, 0.5), 0.5), 300, 1e-9);
  const m = Shop.millSpeed({ material: "aluminum", toolMat: "hss", dIn: 0.25, flutes: 2 });
  assert.equal(m.sfm, 250);
  near(m.ipt, 0.003, 1e-9);
  near(m.ipm, m.rpm * 2 * 0.003, 1e-9);
  assert.equal(Shop.drillFeedPerRev(0.1), 0.0015);
  assert.equal(Shop.drillFeedPerRev(2), 0.016);
});

test("saw blade selection", () => {
  const thin = Shop.sawTpi(0.0625, 3);
  near(thin.need, 48, 1e-9);
  assert.equal(thin.tpi, 32);
  assert.ok(thin.tooFine);
  const thick = Shop.sawTpi(0.25, 3);
  assert.equal(thick.tpi, 12);
  assert.equal(thick.tooFine, false);
  assert.equal(Shop.sawTpi(1, 3).tpi, 3);
  near(Shop.bladeSfpm(14, 100), (Math.PI * 14 * 100) / 12, 1e-9);
});

// ------------------------------------------------------------------ weight, cut list, bending
test("weights of common FRC stock", () => {
  const rho = Shop.DENSITY.aluminum.rho;
  const tubeFt = Shop.weightOf("recttube", { width: 25.4, height: 25.4, wall: 1.5875, length: 304.8 }, rho);
  within(tubeFt.lb, 0.274, 0.01, "1x1x1/16 tube per foot");
  const plate = Shop.weightOf("plate", { width: 304.8, thickness: 3.175, length: 304.8 }, rho);
  within(plate.lb, 1.756, 0.005, "12x12x1/8 plate");
  const poly = Shop.weightOf("plate", { width: 304.8, thickness: 6.35, length: 304.8 }, Shop.DENSITY.polycarbonate.rho);
  within(poly.lb, 1.56, 0.02, "12x12x1/4 polycarbonate");
  const rod = Shop.weightOf("round", { dia: 12.7, length: 304.8 }, rho);
  within(rod.lb, 0.2298, 0.01, "1/2 in round bar per foot");
  const rt = Shop.weightOf("roundtube", { dia: 25.4, wall: 1.5875, length: 304.8 }, rho);
  assert.ok(rt.lb < rod.lb * 1.5 && rt.lb > 0.1);
  const ang = Shop.weightOf("angle", { width: 25.4, height: 25.4, wall: 3.175, length: 304.8 }, rho);
  within(ang.lb, 0.2743, 0.005, "1x1x1/8 angle per foot");
  assert.match(Shop.shapeError("recttube", { width: 25.4, height: 25.4, wall: 13 }), /thicker/);
  assert.equal(Shop.shapeError("recttube", { width: 25.4, height: 25.4, wall: 2 }), "");
  assert.throws(() => Shop.shapeVolume("blob", {}));
});

test("cut list optimiser", () => {
  const r = Shop.cutList({ stock: 72, kerf: 0.0625, trim: 0, parts: [{ len: 30, qty: 2 }, { len: 20, qty: 3 }, { len: 11.9, qty: 1 }] });
  assert.equal(r.count, 3);
  assert.deepEqual(r.errors, []);
  for (const bar of r.bars) {
    const sum = bar.parts.reduce((s, p) => s + p.len, 0) + Math.max(0, bar.parts.length - 1) * 0.0625;
    assert.ok(sum <= 72 + 1e-9, "no bar overfilled");
  }
  assert.equal(r.bars.reduce((s, b) => s + b.parts.length, 0), 6, "every part placed");
  const perfect = Shop.cutList({ stock: 96, kerf: 0, trim: 0, parts: [{ len: 48, qty: 4 }] });
  assert.equal(perfect.count, 2);
  near(perfect.utilization, 1, 1e-9);
  const trimmed = Shop.cutList({ stock: 96, kerf: 0, trim: 1, parts: [{ len: 48, qty: 2 }] });
  assert.equal(trimmed.count, 2, "trim makes a bar too short for two 48s");
  const bad = Shop.cutList({ stock: 72, kerf: 0.1, parts: [{ len: 80, qty: 1 }, { len: 0, qty: 1 }, { len: 10, qty: 2 }] });
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.count, 1);
  // a harder set must not be worse than the trivial lower bound + a bar or two
  const parts = [{ len: 34, qty: 4 }, { len: 22, qty: 6 }, { len: 18, qty: 5 }, { len: 9.5, qty: 8 }, { len: 5, qty: 10 }];
  const hard = Shop.cutList({ stock: 72, kerf: 0.0625, parts });
  const total = parts.reduce((s, p) => s + p.len * p.qty, 0);
  assert.ok(hard.count <= Math.ceil(total / 72) + 1, `${hard.count} bars for ${total} in`);
  for (const bar of hard.bars) assert.ok(bar.offcut >= -1e-9);
});

test("sheet bend math", () => {
  const b = Shop.bend(1.5875, 1.5875, 90, 0.4);
  near(b.allowance, (Math.PI / 2) * (1.5875 + 0.4 * 1.5875), 1e-9);
  near(b.setback, 1.5875 + 1.5875, 1e-9);
  near(b.deduction, 2 * b.setback - b.allowance, 1e-9);
  near(Shop.flatLength(25, 25, b.deduction), 50 - b.deduction, 1e-9);
  const flat = Shop.bend(2, 2, 0, 0.4);
  near(flat.allowance, 0, 1e-12);
  near(flat.deduction, 0, 1e-12);
  assert.ok(Shop.BEND["6061-T6"].minR > Shop.BEND["5052-H32"].minR);
  assert.equal(Shop.POLY_COLD_BEND_RADIUS, 100);
});

test("fractions and unit conversion", () => {
  assert.equal(Shop.toFraction(0.375).text, "3/8");
  assert.equal(Shop.toFraction(1.5).text, "1-1/2");
  assert.equal(Shop.toFraction(0).text, "0");
  assert.equal(Shop.toFraction(0.126).text, "1/8");
  near(Shop.toFraction(0.126).error, 0.001, 1e-9);
  assert.equal(Shop.toFraction(-0.25).text, "-1/4");
  assert.equal(Shop.parseLength("1-1/2"), 1.5);
  assert.equal(Shop.parseLength("1 1/2"), 1.5);
  assert.equal(Shop.parseLength("3/8"), 0.375);
  assert.equal(Shop.parseLength('.375"'), 0.375);
  assert.equal(Shop.parseLength("2 in"), 2);
  near(Shop.parseLength("12mm"), 12 / 25.4, 1e-12);
  assert.ok(Number.isNaN(Shop.parseLength("abc")));
  assert.ok(Number.isNaN(Shop.parseLength("1/0")));
  assert.ok(Number.isNaN(Shop.parseLength("")));
  near(Shop.convert("length", 1, "in", "mm"), 25.4, 1e-9);
  near(Shop.convert("length", 25.4, "mm", "thou"), 1000, 1e-9);
  near(Shop.convert("mass", 1, "lb", "kg"), 0.45359237, 1e-12);
  near(Shop.convert("torque", 1, "N·m", "in·lb"), 8.85075, 1e-3);
  near(Shop.convert("speed", 1, "ft/s", "m/s"), 0.3048, 1e-9);
  near(Shop.convert("speed", 60, "in/min", "mm/min"), 1524, 0.01);
  near(Shop.convert("pressure", 60, "psi", "kPa"), 413.685, 1e-2);
  assert.throws(() => Shop.convert("length", 1, "in", "lb"));
  for (const [cat, def] of Object.entries(Shop.UNITS)) for (const u of Object.keys(def.units)) near(Shop.convert(cat, 1, u, def.base), def.units[u], 1e-12);
});

// ------------------------------------------------------------------ FRC
test("motor model hits its published corners", () => {
  for (const [id, m] of Object.entries(Frc.MOTORS)) {
    near(Frc.currentAtTorque(m, 0, 12), m.freeA, 1e-9, id);
    near(Frc.currentAtTorque(m, m.stallNm, 12), m.stallA, 1e-9, id);
    near(Frc.speedAtTorque(m, 0, 12), Frc.rpmToRad(m.freeRpm), 1e-9, id);
    near(Frc.speedAtTorque(m, m.stallNm, 12), 0, 1e-9, id);
    near(Frc.torqueAtCurrent(m, m.stallA, 12), m.stallNm, 1e-9, id);
    near(Frc.torqueAtCurrent(m, m.freeA, 12), 0, 1e-9, id);
    near(Frc.torqueAtCurrent(m, 40, 12), m.stallNm * (40 - m.freeA) / (m.stallA - m.freeA), 1e-9, id);
  }
  const x60 = Frc.MOTORS.kraken_x60;
  near(Frc.motorAt(x60, 6).stallNm, x60.stallNm / 2, 1e-12);
  near(Frc.peakPower(x60, 12).watts, (x60.stallNm * Frc.rpmToRad(x60.freeRpm)) / 4, 1e-9);
  near(Frc.radToRpm(Frc.rpmToRad(123)), 123, 1e-9);
  // the linear model lands within about 5% of the published peak power (NEO 406 W, Kraken X60 1,108 W)
  within(Frc.peakPower(Frc.MOTORS.neo, 12).watts, 406, 0.06, "NEO");
  within(Frc.peakPower(Frc.MOTORS.kraken_x60, 12).watts, 1108, 0.02, "Kraken X60");
});

test("gear trains", () => {
  near(Frc.gearTrain([{ driver: 12, driven: 60 }, { driver: 20, driven: 40 }]), 10, 1e-12);
  assert.throws(() => Frc.gearTrain([{ driver: 0, driven: 4 }]));
});

test("drivetrain", () => {
  const p = { motor: Frc.MOTORS.kraken_x60, n: 4, ratio: 6.75, wheelDia: 0.1016, mass: 55, eff: 0.9, mu: 1, volts: 12, ilim: 0 };
  const d = Frc.drivetrain(p);
  near(d.freeSpeed, ((6000 * 2 * Math.PI) / 60 / 6.75) * 0.0508, 1e-9);
  near(d.traction, 55 * 9.80665, 1e-9);
  assert.ok(d.tractionLimited);
  near(d.accel, 9.80665, 1e-9);
  assert.ok(d.t90 > 0.2 && d.t90 < 2);
  const limited = Frc.drivetrain(Object.assign({}, p, { ilim: 40 }));
  assert.ok(limited.motorForceMax < d.motorForceMax);
  assert.ok(limited.t90 >= d.t90);
  const slick = Frc.drivetrain(Object.assign({}, p, { mu: 0.3 }));
  near(slick.pushForce, 0.3 * 55 * 9.80665, 1e-6);
  const lowV = Frc.drivetrain(Object.assign({}, p, { volts: 10 }));
  near(lowV.freeSpeed, d.freeSpeed * (10 / 12), 1e-9);
  // weak gearbox that is not traction limited
  const weak = Frc.drivetrain({ motor: Frc.MOTORS.neo550, n: 1, ratio: 10, wheelDia: 0.1016, mass: 55, eff: 0.9, mu: 1, volts: 12 });
  assert.equal(weak.tractionLimited, false);
  assert.ok(weak.pushForce < weak.traction);
});

test("elevator", () => {
  const p = { motor: Frc.MOTORS.neo, n: 2, ratio: 10, spoolDia: 0.04, mass: 10, rig: 1, eff: 0.85, volts: 12, travel: 1 };
  const e = Frc.elevator(p);
  assert.ok(e.canLift);
  near(e.cableForce, 10 * 9.80665, 1e-9);
  near(e.tauPerMotor, (10 * 9.80665 * 0.02) / (10 * 0.85 * 2), 1e-9);
  assert.ok(e.loadedSpeed < e.freeSpeed && e.loadedSpeed > 0);
  assert.ok(e.time > 1 / e.freeSpeed, "can't beat the free speed");
  assert.ok(e.time < 3 / e.loadedSpeed);
  // a 2-stage cascade doubles carriage speed and halves cable force
  const cascade = Frc.elevator(Object.assign({}, p, { rig: 2 }));
  near(cascade.cableForce, e.cableForce / 2, 1e-9);
  near(cascade.freeSpeed, e.freeSpeed * 2, 1e-9);
  // the maximum load it can hold really is at the limit
  const edge = Frc.elevator(Object.assign({}, p, { mass: e.maxMassKg * 0.999 }));
  assert.ok(edge.canLift);
  assert.equal(Frc.elevator(Object.assign({}, p, { mass: e.maxMassKg * 1.01 })).canLift, false);
  const limited = Frc.elevator(Object.assign({}, p, { ilim: 20 }));
  assert.ok(limited.maxMassKg < e.maxMassKg);
  const heavy = Frc.elevator(Object.assign({}, p, { mass: 500 }));
  assert.equal(heavy.canLift, false);
  assert.equal(heavy.time, null);
});

test("arm", () => {
  const p = { motor: Frc.MOTORS.kraken_x60, n: 1, ratio: 100, length: 0.6, armMass: 3, loadMass: 1.5, a0: 0, a1: 90, eff: 0.85, volts: 12 };
  const a = Frc.arm(p);
  near(a.inertia, (3 * 0.36) / 3 + 1.5 * 0.36, 1e-12);
  near(a.holdTorque, (3 * 0.3 + 1.5 * 0.6) * 9.80665, 1e-9);
  assert.ok(a.canHold);
  assert.ok(a.time > 0.25 && a.time < 1.5, "can't beat the motor's free speed (quarter turn at 60 rpm = 0.25 s)");
  const weak = Frc.arm(Object.assign({}, p, { motor: Frc.MOTORS.neo550, ratio: 5, loadMass: 8 }));
  assert.equal(weak.canHold, false);
  assert.equal(weak.time, null, "it never gets there");
  const down = Frc.arm(Object.assign({}, p, { a0: 90, a1: 0 }));
  assert.ok(down.time > 0);
});

test("flywheel spin-up: closed form equals the numeric simulation", () => {
  const base = { motor: Frc.MOTORS.kraken_x60, n: 2, ratio: 1.5, inertia: 0.004, targetRpm: 3500, volts: 12, eff: 0.95 };
  const closed = Frc.flywheel(base);
  const sim = Frc.flywheel(Object.assign({}, base, { ilim: 100000 }));
  assert.ok(closed.ok);
  near(closed.time, sim.time, 0.002);
  near(closed.energy, 0.5 * 0.004 * Math.pow((3500 * 2 * Math.PI) / 60, 2), 1e-9);
  const limited = Frc.flywheel(Object.assign({}, base, { ilim: 40 }));
  assert.ok(limited.time > closed.time, "a current limit slows the spin-up");
  const tooFast = Frc.flywheel(Object.assign({}, base, { targetRpm: 5000 }));
  assert.equal(tooFast.ok, false);
  near(closed.freeWheelRpm, 6000 / 1.5, 1e-9);
  assert.ok(Frc.flywheel(Object.assign({}, base, { inertia: 0.008 })).time > closed.time * 1.9);
});

test("belts and chain", () => {
  const c = Frc.beltCenter(20, 40, 100, 5);
  near(Frc.beltTeeth(20, 40, c, 5), 100, 1e-9, "round trip");
  assert.ok(Number.isNaN(Frc.beltCenter(20, 200, 40, 5)), "belt too short to span the pulleys");
  near(Frc.beltCenter(20, 20, 100, 5), (100 * 5 - (20 * 5)) / 2, 1e-9, "equal pulleys: C = (L - pi*d)/2 where pi*d = N*p");
  const links = Frc.chainLinks(16, 32, 40);
  near(Frc.chainCenterPitches(16, 32, links), 40, 1e-9, "round trip");
  near(Frc.chainCenterPitches(20, 20, 100), 40, 1e-9, "equal sprockets: C = (L - N)/2");
  assert.ok(Number.isNaN(Frc.chainCenterPitches(10, 100, 20)));
  assert.equal(Frc.CHAIN_PITCH_IN["#35"], 0.375);
  assert.equal(Frc.BELT_PITCH["5 mm (HTD)"], 5);
});

test("wiring", () => {
  assert.deepEqual([40, 31, 30, 21, 20, 6, 5, 1].map(Frc.minAwgForBreaker), [12, 12, 14, 14, 18, 18, 22, 22]);
  assert.equal(Frc.minAwgForBreaker(120), 6);
  assert.equal(Frc.minAwgForBreaker(200), null);
  const w = Frc.wireDrop(12, 10, 40, 12);
  near(w.ohms, 0.03176, 1e-9);
  near(w.drop, 1.2704, 1e-9);
  near(w.watts, 50.816, 1e-6);
  near(w.percent, 10.5867, 1e-3);
  assert.ok(Frc.wireDrop(10, 10, 40, 12).drop < w.drop, "thicker wire drops less");
  for (let g = 4; g < 24; g += 2) assert.ok(Frc.AWG[g] < Frc.AWG[g + 2], "resistance rises as wire gets thinner");
  near(Frc.batterySag(12.6, 0.015, 100), 11.1, 1e-9);
});

test("pneumatics", () => {
  const c = Frc.cylinder(1.5, 0.5, 6, 60);
  near(c.area, Math.PI / 4 * 2.25, 1e-9);
  near(c.extendLbf, 60 * Math.PI / 4 * 2.25, 1e-9);
  near(c.retractLbf, 60 * Math.PI / 4 * (2.25 - 0.25), 1e-9);
  assert.ok(c.extendLbf > c.retractLbf);
  near(c.freeAirCycle, c.volCycleWorking * (60 + 14.7) / 14.7, 1e-9);
  const drop = Frc.tankDrop(c.volCycleWorking, 60, 100);
  near(drop, (74.7 * c.volCycleWorking) / 100, 1e-9);
});
