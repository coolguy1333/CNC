/* Shop calculators and reference tables (pure functions, no DOM). Imperial tables are in inches, metric in mm,
 * unless a name says otherwise. Everything here is unit-tested in Node (tests/calc.test.js). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Shop = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const IN = 25.4;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  // ------------------------------------------------------------------ drill index
  const NUMBER_DRILLS = {
    1: 0.2280, 2: 0.2210, 3: 0.2130, 4: 0.2090, 5: 0.2055, 6: 0.2040, 7: 0.2010, 8: 0.1990, 9: 0.1960, 10: 0.1935,
    11: 0.1910, 12: 0.1890, 13: 0.1850, 14: 0.1820, 15: 0.1800, 16: 0.1770, 17: 0.1730, 18: 0.1695, 19: 0.1660, 20: 0.1610,
    21: 0.1590, 22: 0.1570, 23: 0.1540, 24: 0.1520, 25: 0.1495, 26: 0.1470, 27: 0.1440, 28: 0.1405, 29: 0.1360, 30: 0.1285,
    31: 0.1200, 32: 0.1160, 33: 0.1130, 34: 0.1110, 35: 0.1100, 36: 0.1065, 37: 0.1040, 38: 0.1015, 39: 0.0995, 40: 0.0980,
    41: 0.0960, 42: 0.0935, 43: 0.0890, 44: 0.0860, 45: 0.0820, 46: 0.0810, 47: 0.0785, 48: 0.0760, 49: 0.0730, 50: 0.0700,
    51: 0.0670, 52: 0.0635, 53: 0.0595, 54: 0.0550, 55: 0.0520, 56: 0.0465, 57: 0.0430, 58: 0.0420, 59: 0.0410, 60: 0.0400,
    61: 0.0390, 62: 0.0380, 63: 0.0370, 64: 0.0360, 65: 0.0350, 66: 0.0330, 67: 0.0320, 68: 0.0310, 69: 0.0292, 70: 0.0280,
    71: 0.0260, 72: 0.0250, 73: 0.0240, 74: 0.0225, 75: 0.0210, 76: 0.0200, 77: 0.0180, 78: 0.0160, 79: 0.0145, 80: 0.0135,
  };
  const LETTER_DRILLS = {
    A: 0.234, B: 0.238, C: 0.242, D: 0.246, E: 0.250, F: 0.257, G: 0.261, H: 0.266, I: 0.272, J: 0.277, K: 0.281, L: 0.290,
    M: 0.295, N: 0.302, O: 0.316, P: 0.323, Q: 0.332, R: 0.339, S: 0.348, T: 0.358, U: 0.368, V: 0.377, W: 0.386, X: 0.397,
    Y: 0.404, Z: 0.413,
  };

  function fracLabel(num, den) {
    const g = gcd(num, den);
    num /= g; den /= g;
    if (den === 1) return String(num);
    const whole = Math.floor(num / den), rem = num - whole * den;
    return whole ? `${whole}-${rem}/${den}` : `${rem}/${den}`;
  }

  /** Every standard drill as {label, inch, mm, set}. */
  function drillList() {
    const out = [];
    for (let n = 1; n <= 96; n++) out.push({ label: fracLabel(n, 64) + '"', inch: n / 64, set: "fraction" });
    for (const [k, v] of Object.entries(NUMBER_DRILLS)) out.push({ label: "#" + k, inch: v, set: "number" });
    for (const [k, v] of Object.entries(LETTER_DRILLS)) out.push({ label: k, inch: v, set: "letter" });
    const metric = [];
    for (let m = 0.5; m < 1.0; m += 0.1) metric.push(m);
    for (let m = 1.0; m < 3.0; m += 0.05) metric.push(m);
    for (let m = 3.0; m < 10.0; m += 0.1) metric.push(m);
    metric.push(10, 10.2, 10.5, 10.8, 11, 11.5, 12, 12.5, 13, 13.5, 14);
    for (let m = 14.5; m <= 25; m += 0.5) metric.push(m);
    for (const m of metric) out.push({ label: (Math.round(m * 100) / 100) + " mm", inch: m / IN, set: "metric", mm: Math.round(m * 100) / 100 });
    for (const d of out) d.mm = d.mm || d.inch * IN;
    return out.sort((a, b) => a.inch - b.inch);
  }
  const DRILLS = drillList();

  /** The `n` drills closest to a diameter (inches). `sets` limits which index to search. */
  function nearestDrills(inch, n, sets) {
    const pool = sets ? DRILLS.filter(d => sets.includes(d.set)) : DRILLS;
    return pool.slice().sort((a, b) => Math.abs(a.inch - inch) - Math.abs(b.inch - inch)).slice(0, n || 4);
  }

  // ------------------------------------------------------------------ threads
  const num = n => 0.060 + 0.013 * n; // major diameter of a numbered screw
  const THREADS = [
    ["#0-80", num(0), 80], ["#1-64", num(1), 64], ["#2-56", num(2), 56], ["#3-48", num(3), 48], ["#4-40", num(4), 40],
    ["#5-40", num(5), 40], ["#6-32", num(6), 32], ["#8-32", num(8), 32], ["#10-24", num(10), 24], ["#10-32", num(10), 32],
    ["#12-24", num(12), 24], ["1/4-20", 0.25, 20], ["1/4-28", 0.25, 28], ["5/16-18", 0.3125, 18], ["5/16-24", 0.3125, 24],
    ["3/8-16", 0.375, 16], ["3/8-24", 0.375, 24], ["7/16-14", 0.4375, 14], ["1/2-13", 0.5, 13], ["1/2-20", 0.5, 20],
    ["9/16-12", 0.5625, 12], ["5/8-11", 0.625, 11], ["3/4-10", 0.75, 10],
  ].map(([name, major, tpi]) => ({ name, system: "imperial", major, pitch: 1 / tpi, tpi, sizeKey: name.split("-")[0] }));
  const METRIC = [
    ["M1.6", 1.6, 0.35], ["M2", 2, 0.4], ["M2.5", 2.5, 0.45], ["M3", 3, 0.5], ["M3.5", 3.5, 0.6], ["M4", 4, 0.7], ["M5", 5, 0.8],
    ["M6", 6, 1], ["M8", 8, 1.25], ["M10", 10, 1.5], ["M12", 12, 1.75],
    ["M4", 4, 0.5, "fine"], ["M5", 5, 0.5, "fine"], ["M6", 6, 0.75, "fine"], ["M8", 8, 1, "fine"], ["M10", 10, 1.25, "fine"], ["M12", 12, 1.25, "fine"],
  ].map(([name, major, pitch, fine]) => ({ name: `${name}x${pitch}`, system: "metric", major, pitch, sizeKey: name, fine: !!fine }));
  const ALL_THREADS = THREADS.concat(METRIC);

  /** Percent of full thread depth a given hole diameter leaves (same units as major/pitch). */
  const threadPercent = (th, hole) => ((th.major - hole) / (1.299 * th.pitch)) * 100;

  /**
   * Tap drill for a thread. Cutting tap at `percent` thread (75 is the usual), or a thread-forming (roll) tap.
   * Returns the ideal hole size and the closest standard drills with the thread % each would give.
   */
  function tapDrill(th, percent, forming) {
    const pct = percent || (forming ? 65 : 75);
    const ideal = forming ? th.major - 0.0068 * pct * th.pitch : th.major - (pct / 100) * 1.299 * th.pitch;
    const inchIdeal = th.system === "metric" ? ideal / IN : ideal;
    const cands = nearestDrills(inchIdeal, 3, th.system === "metric" ? ["metric"] : ["number", "letter", "fraction"]);
    return {
      ideal, percent: pct,
      drills: cands.map(d => {
        const dia = th.system === "metric" ? d.mm : d.inch;
        return { label: d.label, dia, percent: forming ? null : threadPercent(th, dia) };
      }),
    };
  }

  // Clearance holes: [close fit, free fit] in inches for screws; [fine, medium, coarse] in mm for metric (ISO 273)
  const CLEARANCE_IN = {
    "#0": [0.0635, 0.0670], "#1": [0.0760, 0.0810], "#2": [0.0890, 0.0935], "#3": [0.1015, 0.1040], "#4": [0.1130, 0.1160],
    "#5": [0.1285, 0.1360], "#6": [0.1440, 0.1495], "#8": [0.1695, 0.1770], "#10": [0.1960, 0.2010],
    "1/4": [0.2570, 0.2660], "5/16": [0.3230, 0.3320], "3/8": [0.3860, 0.3970], "7/16": [0.4531, 0.4688], "1/2": [0.5156, 0.5312],
    "9/16": [0.5781, 0.5938], "5/8": [0.6406, 0.6562], "3/4": [0.7656, 0.7812],
  };
  const CLEARANCE_MM = {
    M1_6: [1.7, 1.8, 2.0], M2: [2.2, 2.4, 2.6], M2_5: [2.7, 2.9, 3.1], M3: [3.2, 3.4, 3.6], M4: [4.3, 4.5, 4.8], M5: [5.3, 5.5, 5.8],
    M6: [6.4, 6.6, 7.0], M8: [8.4, 9.0, 10.0], M10: [10.5, 11.0, 12.0], M12: [13.0, 13.5, 14.5],
  };
  const clearanceKey = th => th.system === "metric" ? th.sizeKey.replace(".", "_") : th.sizeKey;
  function clearance(th) {
    if (th.system === "metric") {
      const c = CLEARANCE_MM[clearanceKey(th)];
      return c ? { system: "metric", fine: c[0], medium: c[1], coarse: c[2] } : null;
    }
    const c = CLEARANCE_IN[th.sizeKey];
    if (!c) return null;
    const near = v => nearestDrills(v, 1, ["number", "letter", "fraction"])[0];
    return { system: "imperial", close: c[0], free: c[1], closeDrill: near(c[0]).label, freeDrill: near(c[1]).label };
  }

  // Socket head cap screw head size [head diameter, head height]: ASME B18.3 (in) and ISO 4762 (mm)
  const SHCS_IN = {
    "#0": [0.096, 0.060], "#1": [0.118, 0.073], "#2": [0.140, 0.086], "#3": [0.161, 0.099], "#4": [0.183, 0.112], "#5": [0.205, 0.125],
    "#6": [0.226, 0.138], "#8": [0.270, 0.164], "#10": [0.312, 0.190], "1/4": [0.375, 0.250], "5/16": [0.469, 0.3125],
    "3/8": [0.562, 0.375], "7/16": [0.656, 0.4375], "1/2": [0.750, 0.500],
  };
  const SHCS_MM = {
    M1_6: [3.0, 1.6], M2: [3.8, 2], M2_5: [4.5, 2.5], M3: [5.5, 3], M4: [7, 4], M5: [8.5, 5], M6: [10, 6], M8: [13, 8], M10: [16, 10], M12: [18, 12],
  };
  /** Counterbore for a socket head cap screw: head + a little clearance, a bit deeper than the head is tall. */
  function counterbore(th) {
    const h = th.system === "metric" ? SHCS_MM[clearanceKey(th)] : SHCS_IN[th.sizeKey];
    if (!h) return null;
    if (th.system === "metric") return { system: "metric", head: h[0], height: h[1], dia: Math.ceil((h[0] + 0.5) * 10) / 10, depth: h[1] + 0.25 };
    return { system: "imperial", head: h[0], height: h[1], dia: Math.ceil((h[0] + 0.030) * 64) / 64, depth: Math.round((h[1] + 0.010) * 1000) / 1000 };
  }

  // ------------------------------------------------------------------ speeds
  /** SFM <-> RPM for a diameter in inches */
  const posDia = d => { if (!(d > 0) || !isFinite(d)) throw new Error("The diameter must be a positive number"); return d; };
  const rpmFromSfm = (sfm, dIn) => (sfm * 12) / (Math.PI * posDia(dIn));
  const sfmFromRpm = (rpm, dIn) => (rpm * Math.PI * posDia(dIn)) / 12;
  const SPEED_PRESETS = {
    aluminum: { label: "Aluminum 6061", sfm: { hss: 250, carbide: 600 }, ipt: d => clampN(0.012 * d, 0.001, 0.005), ipr: 0.005 },
    polycarbonate: { label: "Polycarbonate", sfm: { hss: 300, carbide: 500 }, ipt: d => clampN(0.016 * d, 0.002, 0.008), ipr: 0.005 },
  };
  const clampN = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Drill feed per revolution (in/rev) for 2-flute drills by diameter (inches): typical handbook ranges, midpoint
  function drillFeedPerRev(dIn) {
    if (dIn < 0.125) return 0.0015;
    if (dIn < 0.25) return 0.003;
    if (dIn < 0.5) return 0.006;
    if (dIn < 1) return 0.010;
    return 0.016;
  }
  const DRILL_SFM = { aluminum: { hss: 250, carbide: 600 }, polycarbonate: { hss: 100, carbide: 200 } };
  function drillSpeed(material, toolMat, dIn) {
    posDia(dIn);
    const sfm = DRILL_SFM[material][toolMat];
    const rpm = rpmFromSfm(sfm, dIn);
    const ipr = drillFeedPerRev(dIn);
    return { sfm, rpm, ipr, ipm: rpm * ipr };
  }
  /** End-mill speed on a manual mill/lathe etc: rpm and feed from SFM and chip load per tooth. */
  function millSpeed(p) {
    const preset = SPEED_PRESETS[p.material];
    const sfm = p.sfm || preset.sfm[p.toolMat];
    const rpm = rpmFromSfm(sfm, p.dIn);
    const ipt = p.ipt || preset.ipt(p.dIn);
    return { sfm, rpm, ipt, ipm: rpm * (p.flutes || 2) * ipt };
  }

  /** Bandsaw/hacksaw: teeth per inch so at least `minTeeth` teeth are in the cut. */
  const STANDARD_TPI = [3, 4, 6, 8, 10, 12, 14, 18, 24, 32];
  function sawTpi(thicknessIn, minTeeth) {
    if (!(thicknessIn > 0) || !isFinite(thicknessIn)) throw new Error("The thickness must be a positive number");
    const need = (minTeeth || 3) / thicknessIn;
    const pick = STANDARD_TPI.find(t => t >= need - 1e-9);
    return { need, tpi: pick || STANDARD_TPI[STANDARD_TPI.length - 1], tooFine: !pick };
  }
  const bladeSfpm = (wheelDiaIn, rpm) => (Math.PI * wheelDiaIn * rpm) / 12;

  // ------------------------------------------------------------------ weight
  const DENSITY = { // g/cm^3
    aluminum: { label: "Aluminum 6061", rho: 2.70 },
    polycarbonate: { label: "Polycarbonate", rho: 1.20 },
    mdf: { label: "MDF (approx.)", rho: 0.75 },
  };
  const LB_PER_KG = 2.2046226218;
  /** Volume in mm^3 for a shape; dims in mm. */
  function shapeVolume(shape, d) {
    const L = d.length;
    switch (shape) {
      case "plate": return d.width * d.thickness * L;
      case "round": return (Math.PI / 4) * d.dia * d.dia * L;
      case "roundtube": return (Math.PI / 4) * (d.dia * d.dia - Math.pow(d.dia - 2 * d.wall, 2)) * L;
      case "recttube": return (d.width * d.height - (d.width - 2 * d.wall) * (d.height - 2 * d.wall)) * L;
      case "angle": return (d.width + d.height - d.wall) * d.wall * L;
      default: throw new Error("Unknown shape " + shape);
    }
  }
  function weightOf(shape, d, rhoGcc) {
    const mm3 = shapeVolume(shape, d);
    const kg = (mm3 / 1000) * rhoGcc / 1000; // mm^3 -> cm^3 -> g -> kg
    return { volumeMm3: mm3, kg, lb: kg * LB_PER_KG };
  }
  /** Wall must leave material: returns an error string or "". */
  function shapeError(shape, d) {
    if (shape === "roundtube" && d.wall * 2 >= d.dia) return "Wall is thicker than the tube radius.";
    if (shape === "recttube" && (d.wall * 2 >= d.width || d.wall * 2 >= d.height)) return "Wall is thicker than half the tube.";
    if (shape === "angle" && (d.wall >= d.width || d.wall >= d.height)) return "Wall is thicker than the legs.";
    return "";
  }

  // ------------------------------------------------------------------ cut list (1-D stock)
  const MAX_PIECES = 3000;
  /**
   * Fit parts onto stock bars. Each cut costs `kerf`; `trim` is squared off each end of a bar and wasted.
   * parts: [{len, qty, name}]. Returns {bars, count, used, waste, utilization, errors}.
   */
  function cutList(p) {
    const cap = p.stock - 2 * (p.trim || 0);
    const kerf = p.kerf || 0;
    const errors = [];
    const items = [];
    const wanted = p.parts.reduce((n, part) => n + Math.max(0, Math.floor(part.qty || 1)), 0);
    if (wanted > MAX_PIECES) return { bars: [], count: 0, used: 0, waste: 0, utilization: 0, cap, errors: [`That is ${wanted} pieces; the limit is ${MAX_PIECES}. Split the job up.`] };
    for (const part of p.parts) {
      const qty = Math.max(0, Math.floor(part.qty || 1));
      if (!(part.len > 0)) { errors.push("A part has no length."); continue; }
      if (part.len > cap + 1e-9) { errors.push(`${part.name || part.len} (${part.len}) is longer than a usable bar (${cap.toFixed(3)}).`); continue; }
      for (let i = 0; i < qty; i++) items.push({ len: part.len, name: part.name || "" });
    }
    items.sort((a, b) => b.len - a.len);
    const pack = bestFit => {
      const bars = [];
      for (const it of items) {
        let target = null, best = Infinity;
        for (const b of bars) {
          const need = it.len + (b.parts.length ? kerf : 0);
          const room = cap - b.used;
          if (need <= room + 1e-9) {
            if (!bestFit) { target = b; break; }
            if (room - need < best) { best = room - need; target = b; }
          }
        }
        if (!target) { target = { parts: [], used: 0 }; bars.push(target); }
        target.used += it.len + (target.parts.length ? kerf : 0);
        target.parts.push(it);
      }
      return bars;
    };
    const a = pack(false), b = pack(true);
    const bars = b.length < a.length ? b : a;
    for (const bar of bars) { bar.offcut = cap - bar.used; bar.waste = p.stock - bar.used; } // waste includes both end trims
    const used = items.reduce((s, x) => s + x.len, 0);
    const total = bars.length * p.stock;
    return { bars, count: bars.length, used, waste: total - used, utilization: total ? used / total : 0, errors, cap };
  }

  // ------------------------------------------------------------------ sheet bending
  const BEND = {
    "5052-H32": { k: 0.40, minR: 1.0, note: "Bends well. Inside radius of 1x thickness is fine." },
    "6061-T6": { k: 0.42, minR: 3.0, note: "Hard temper: tends to crack. Use at least 3x thickness, bend across the grain, or use 6061-T4/5052." },
    other: { k: 0.40, minR: 2.0, note: "" },
  };
  /** Bend allowance, setback and deduction for a bend. angle = degrees the metal turns (90 for a square corner). */
  function bend(t, r, angleDeg, k) {
    const a = (angleDeg * Math.PI) / 180;
    const ba = a * (r + k * t);
    const setback = Math.tan(a / 2) * (r + t);
    return { allowance: ba, setback, deduction: 2 * setback - ba };
  }
  /** Flat length of a one-bend part from the two outside leg lengths. */
  const flatLength = (outsideA, outsideB, deduction) => outsideA + outsideB - deduction;
  const POLY_COLD_BEND_RADIUS = 100; // x thickness, minimum for cold bending polycarbonate sheet

  // ------------------------------------------------------------------ fractions and units
  /** Nearest fraction of an inch (denominator 64 by default). */
  function toFraction(value, den) {
    den = den || 64;
    const neg = value < 0;
    const v = Math.abs(value);
    let n = Math.round(v * den);
    const g = gcd(n, den) || den;
    const reduced = n === 0 ? { num: 0, den: 1 } : { num: n / g, den: den / g };
    return { text: (neg && n ? "-" : "") + fracLabel(reduced.num, reduced.den), value: (neg ? -1 : 1) * n / den, error: value - (neg ? -1 : 1) * n / den, num: reduced.num, den: reduced.den };
  }
  /** Parse 1-1/2, 1 1/2, 3/8, .375, 0.375", 12mm -> inches. Returns NaN when it can't. */
  function parseLength(text) {
    let s = String(text).trim().toLowerCase().replace(/"/g, "").replace(/\s*in(ch(es)?)?$/, "");
    let mm = false;
    if (/mm$/.test(s)) { mm = true; s = s.replace(/\s*mm$/, ""); }
    s = s.trim();
    let val = NaN;
    let m;
    if ((m = s.match(/^(-?\d+)[\s-]+(\d+)\/(\d+)$/))) val = Math.sign(+m[1] || 1) * (Math.abs(+m[1]) + +m[2] / +m[3]);
    else if ((m = s.match(/^(-?\d+)\/(\d+)$/))) val = +m[1] / +m[2];
    else if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) val = parseFloat(s);
    if (!isFinite(val) || /\/0$/.test(s)) return NaN;
    return mm ? val / IN : val;
  }

  const UNITS = {
    length: { label: "Length", base: "mm", units: { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, thou: 0.0254 } },
    mass: { label: "Mass", base: "kg", units: { g: 0.001, kg: 1, oz: 0.028349523125, lb: 0.45359237 } },
    force: { label: "Force", base: "N", units: { N: 1, lbf: 4.4482216152605, kgf: 9.80665, ozf: 0.27801385 } },
    torque: { label: "Torque", base: "N·m", units: { "N·m": 1, "in·lb": 0.1129848290276, "ft·lb": 1.3558179483314, "kgf·cm": 0.0980665, "N·cm": 0.01, "oz·in": 0.00706155 } },
    speed: { label: "Speed", base: "m/s", units: { "m/s": 1, "ft/s": 0.3048, mph: 0.44704, "km/h": 0.2777777778, "in/min": 0.000423333, "mm/min": 1 / 60000 } },
    pressure: { label: "Pressure", base: "kPa", units: { psi: 6.894757293168, kPa: 1, bar: 100, atm: 101.325 } },
    power: { label: "Power", base: "W", units: { W: 1, kW: 1000, hp: 745.69987158 } },
    angle: { label: "Angle / speed", base: "rpm", units: { rpm: 1, "rad/s": 9.549296586, "deg/s": 0.1666666667 } },
  };
  function convert(cat, value, from, to) {
    const u = UNITS[cat].units;
    if (!(from in u) || !(to in u)) throw new Error("Unknown unit");
    return (value * u[from]) / u[to];
  }

  // Starting allowances for CNC-cut holes in aluminum (inches added to the nominal diameter). Test on scrap and adjust.
  const FITS = [
    { id: "press", label: "Press fit (bearings)", add: 0.000, note: "Cut at nominal and test. Router accuracy is a few thousandths, so check on scrap and nudge by 0.001 in." },
    { id: "snug", label: "Snug / light tap-in", add: 0.002, note: "Slides in with a light tap." },
    { id: "slip", label: "Slip fit (shafts, pins)", add: 0.004, note: "Turns freely without much play." },
    { id: "loose", label: "Loose clearance", add: 0.010, note: "For hardware that just has to pass through." },
  ];

  return {
    NUMBER_DRILLS, LETTER_DRILLS, DRILLS, nearestDrills, fracLabel, THREADS, METRIC, ALL_THREADS, threadPercent, tapDrill,
    clearance, counterbore, CLEARANCE_IN, CLEARANCE_MM, SHCS_IN, SHCS_MM, rpmFromSfm, sfmFromRpm, SPEED_PRESETS, drillSpeed, millSpeed,
    drillFeedPerRev, sawTpi, STANDARD_TPI, bladeSfpm, DENSITY, LB_PER_KG, shapeVolume, weightOf, shapeError, cutList, BEND, bend,
    flatLength, POLY_COLD_BEND_RADIUS, toFraction, parseLength, UNITS, convert, FITS,
  };
});
