// Throws random and extreme inputs at every calculator: they may refuse (throw an Error) but must never return NaN/Infinity.
// Run with:  node --test tests/fuzz.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Cnc = require("../static/js/cnc.js");
const Shop = require("../static/js/shop.js");
const Frc = require("../static/js/frc.js");

// small seeded PRNG so a failure can be reproduced
let seed = 20260101;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const POOL = [0, -1, 1e-9, 0.001, 0.05, 0.5, 1, 2, 3.175, 6.35, 12, 50, 100, 565, 1000, 24000, 1e6, 1e9];
const pick = a => a[Math.floor(rnd() * a.length)];
const num = () => (rnd() < 0.5 ? pick(POOL) : rnd() * pick([1, 10, 100, 1000]));

/** every number reachable in the value must be finite */
function finite(v, where, seen = new Set()) {
  if (typeof v === "number") { assert.ok(Number.isFinite(v), `${where} is ${v}`); return; }
  if (!v || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  for (const [k, x] of Object.entries(v)) finite(x, `${where}.${k}`, seen);
}
function attempt(name, fn) {
  try { return fn(); } catch (e) {
    assert.ok(e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError), `${name} crashed with ${e && e.stack}`);
    return undefined;
  }
}

test("Cnc.recommend never returns NaN or Infinity", () => {
  for (let i = 0; i < 4000; i++) {
    const material = pick(["aluminum", "polycarbonate", "spoilboard"]);
    const input = {
      material, op: pick(Object.keys(Cnc.OPS)), total_mm: num(), stick_mm: num(), cool: pick(["mist", "air", "none"]), agg: pick([0.8, 1, 1.15, num()]),
      stepover: num(),
      tool: { actual_mm: num(), nominal_mm: num(), flutes: pick([1, 2, 3, 4, 0, -1, 1.5, 50]), flute_len_mm: num(), overall_mm: num(), mat: pick(["carbide", "hss"]),
        kind: pick(["flat", "face"]), feed_factor: pick([1, 0.5, 2, 0, num()]) },
      machine: rnd() < 0.5 ? undefined : { min_rpm: 5000, max_rpm: 24000, max_feed_mm: pick([4000, 1, num()]), spindle_w: pick([2200, 1, num()]), defl_limit_mm: pick([0.02, num()]) },
      recipe: rnd() < 0.4 ? { rpm: num(), feed_mm: num(), plunge_mm: num(), ramp_mm: num(), doc_mm: num() } : null,
    };
    const r = attempt("recommend", () => Cnc.recommend(input));
    if (r) { finite({ rpm: r.rpm, feed: r.feed, doc: r.doc, docPass: r.docPass, passes: r.passes, plunge: r.plunge, ramp: r.ramp, fz: r.fz, sfm: r.sfm, ae: r.ae,
      mrr: r.mrr, power: r.power, defl: r.defl, rampLength: r.rampLength }, "recommend " + JSON.stringify(input)); assert.ok(Array.isArray(r.notes)); }
  }
});

test("Cnc.checkSettings never returns NaN or Infinity", () => {
  for (let i = 0; i < 3000; i++) {
    const r = attempt("check", () => Cnc.checkSettings({
      material: pick(["aluminum", "polycarbonate", "spoilboard", "x"]), rpm: num(), feed: num(), doc: num(), ae: num(), stick_mm: num(),
      tool: { actual_mm: num(), nominal_mm: num(), flutes: pick([1, 2, 0, 50]), flute_len_mm: num(), overall_mm: num(), mat: pick(["carbide", "hss"]), kind: "flat" },
      machine: rnd() < 0.5 ? undefined : { min_rpm: 5000, max_rpm: 24000, max_feed_mm: pick([4000, num()]), spindle_w: pick([2200, num()]), defl_limit_mm: pick([0.02, num()]) },
      recipe: rnd() < 0.3 ? { rpm: num(), feed_mm: num() } : null,
    }));
    if (r) finite({ fz: r.fz, ratio: r.ratio, feedHere: r.feedHere, refFeed: r.refFeed, sfm: r.sfm, power: r.power, defl: r.defl, mrr: r.mrr }, "check");
  }
});

test("spoilboard, hole and time helpers", () => {
  for (let i = 0; i < 2000; i++) {
    const p = attempt("plan", () => Cnc.spoilboardPlan({ diameter: num(), w: num(), l: num(), stepover: num(), margin: num(), feed: num(), depth: num(), docPerPass: num() }));
    if (p) finite(p, "plan");
    const h = attempt("hole", () => Cnc.holePath({ hole: num(), tool: num(), feed: num() }));
    if (h) finite(h, "hole");
    attempt("eff", () => finite(Cnc.effectiveDiameter({ slotWidth: num(), holeMeasured: num(), holeProgrammed: num(), camDia: num() }), "eff"));
    finite(Cnc.cutMinutes(num(), num(), num()), "minutes");
  }
});

test("Shop helpers", () => {
  for (let i = 0; i < 3000; i++) {
    const th = pick(Shop.ALL_THREADS);
    finite(Shop.tapDrill(th, pick([75, 65, num()]), rnd() < 0.5), "tap " + th.name);
    Shop.clearance(th); Shop.counterbore(th);
    finite(Shop.nearestDrills(num(), 3), "near");
    const ds = attempt("drill", () => Shop.drillSpeed(pick(["aluminum", "polycarbonate"]), pick(["hss", "carbide"]), num()));
    if (ds) finite(ds, "drill");
    const ms = attempt("mill", () => Shop.millSpeed({ material: pick(["aluminum", "polycarbonate"]), toolMat: pick(["hss", "carbide"]), dIn: num(), flutes: pick([1, 2, 4, 0]), sfm: pick([0, num()]), ipt: pick([0, num()]) }));
    if (ms) finite(ms, "mill");
    const t = attempt("saw", () => Shop.sawTpi(num(), pick([2, 3, 6, num()])));
    if (t) assert.ok(Number.isFinite(t.tpi));
    const shape = pick(["plate", "round", "roundtube", "recttube", "angle"]);
    const d = { width: num(), height: num(), thickness: num(), dia: num(), wall: num(), length: num() };
    const w = attempt("weight", () => Shop.weightOf(shape, d, num()));
    if (w) finite(w, "weight");
    finite(Shop.bend(num(), num(), pick([0, 45, 90, 179, num()]), num()), "bend");
    finite(Shop.toFraction(num(), pick([8, 16, 32, 64])).value, "fraction");
    const len = Shop.parseLength(pick(["1/2", "1-1/2", "x", "", "12mm", "1e9", "0/0", "-3/4", "99999999999999999999", String(num())]));
    assert.ok(Number.isNaN(len) || Number.isFinite(len));
    const cat = pick(Object.keys(Shop.UNITS)), us = Object.keys(Shop.UNITS[cat].units);
    finite(Shop.convert(cat, num(), pick(us), pick(us)), "convert");
  }
});

test("cut list never loses or overfills", () => {
  for (let i = 0; i < 800; i++) {
    const parts = Array.from({ length: Math.floor(rnd() * 8) }, () => ({ len: pick([0, -1, 3, 5.5, 12, 30, 71, 72, 73, 100]), qty: pick([0, 1, 2, 5, 3.7]) }));
    const stock = pick([72, 96, 10, 0.5]), kerf = pick([0, 0.0625, 0.5, 3]), trim = pick([0, 0.25, 40]);
    const r = Shop.cutList({ stock, kerf, trim, parts });
    finite(r.utilization, "util");
    const cap = stock - 2 * trim;
    let placed = 0;
    for (const bar of r.bars) {
      const sum = bar.parts.reduce((s, p) => s + p.len, 0) + Math.max(0, bar.parts.length - 1) * kerf;
      assert.ok(sum <= cap + 1e-9, `bar overfilled ${sum} > ${cap}`);
      placed += bar.parts.length;
    }
    const wanted = parts.filter(p => p.len > 0 && p.len <= cap + 1e-9).reduce((s, p) => s + Math.max(0, Math.floor(p.qty || 1)), 0);
    assert.equal(placed, wanted, "every placeable part is placed");
  }
});

test("FRC calculators", () => {
  const motors = Object.values(Frc.MOTORS);
  for (let i = 0; i < 400; i++) {
    const m = pick(motors), base = { motor: m, n: pick([1, 2, 4, 0, 12]), ratio: pick([1, 6.75, 100, num()]), volts: pick([12, 10, 6, num()]), ilim: pick([0, 40, num()]), eff: pick([0.5, 0.9, 1, num()]) };
    const d = attempt("drive", () => Frc.drivetrain({ ...base, wheelDia: pick([0.1, num()]), mass: pick([30, 60, num()]), mu: pick([1, 0.1, num()]) }));
    if (d) finite({ ...d, t90: d.t90 || 0, x90: d.x90 || 0 }, "drive");
    const e = attempt("elevator", () => Frc.elevator({ ...base, spoolDia: pick([0.04, num()]), mass: pick([5, 50, num()]), rig: pick([1, 2, 3]), travel: pick([1, num()]) }));
    if (e) finite({ ...e, time: e.time || 0 }, "elevator");
    const a = attempt("arm", () => Frc.arm({ ...base, length: pick([0.6, num()]), armMass: pick([2, num()]), loadMass: pick([1, num()]), a0: pick([0, 90, -45]), a1: pick([90, 0, 135]) }));
    if (a) finite({ ...a, time: a.time || 0 }, "arm");
    const f = attempt("flywheel", () => Frc.flywheel({ ...base, inertia: pick([0.004, num()]), targetRpm: pick([3000, num()]) }));
    if (f) finite({ ...f, time: f.time || 0 }, "flywheel");
  }
  for (let i = 0; i < 2000; i++) {
    const c = Frc.beltCenter(pick([6, 16, 20, num()]), pick([20, 40, 200, num()]), pick([50, 100, num()]), pick([3, 5, 9.525]));
    assert.ok(Number.isNaN(c) || Number.isFinite(c));
    const t = Frc.beltTeeth(pick([16, 20, num()]), pick([32, 40, num()]), pick([100, 250, num()]), pick([3, 5]));
    assert.ok(Number.isNaN(t) || Number.isFinite(t) || t === Infinity);
    const k = Frc.chainCenterPitches(pick([12, 16, num()]), pick([24, 32, num()]), pick([60, 100, num()]));
    assert.ok(Number.isNaN(k) || Number.isFinite(k));
    finite(Frc.wireDrop(pick(Object.keys(Frc.AWG).map(Number)), num(), num(), pick([12, num()])), "wire");
    finite(Frc.cylinder(pick([1.5, num()]), pick([0.5, num()]), pick([6, num()]), pick([60, num()])), "cyl");
  }
});
