/* Shop calculators: drill/tap/hardware, manual machine speeds, weight, cut list, bending, converter. */
(function () {
  "use strict";
  const { html, $, $$, U, fmt, group, tile, tiles, note, table, kvTable, calcPage, copyText, store, toast } = App;
  const IN = 25.4;
  const inch = mm => fmt(mm / IN, 4) + " in";

  // ================================================================== Drill, tap & hardware
  const RIVETS = [["3/32 in", "#40", 0.098], ["1/8 in", "#30", 0.1285], ["5/32 in", "#20", 0.161], ["3/16 in", "#11", 0.191], ["1/4 in", "F", 0.257]];
  const threadOpts = Shop.ALL_THREADS.map(t => [t.name, t.name + (t.fine ? " (fine)" : "")]);
  calcPage({
    id: "drilltap", title: "Drill, Tap & Hardware", keywords: "tap drill clearance counterbore screw thread 10-32 1/4-20 m5 m4 shcs socket head bolt hole",
    intro: "Pick a screw. Get the tap drill, clearance hole and counterbore.",
    fields: [
      { id: "thread", label: "Screw / thread", type: "select", def: "#10-32", options: threadOpts },
      { id: "tap", label: "Tap type", type: "seg", def: "cut", options: [["cut", "Cutting tap"], ["form", "Thread-forming tap"]] },
      { id: "pct", label: "Thread depth", type: "seg", number: true, def: 75, options: [[75, "75% (standard)"], [65, "65% (easier to tap)"]], show: v => v.tap === "cut" },
    ],
    compute(v) {
      const th = Shop.ALL_THREADS.find(t => t.name === v.thread) || Shop.ALL_THREADS[0];
      const forming = v.tap === "form";
      const td = Shop.tapDrill(th, forming ? 65 : v.pct, forming);
      const dia = d => (th.system === "imperial" ? `${fmt(d, 4)} in (${fmt(d * IN, 2)} mm)` : `${fmt(d, 2)} mm (${fmt(d / IN, 4)} in)`);
      const best = td.drills[0];
      const cl = Shop.clearance(th), cb = Shop.counterbore(th);
      const thread = th.system === "imperial" ? `${fmt(th.major, 4)} in major, ${th.tpi} threads/in` : `${fmt(th.major, 2)} mm major, ${fmt(th.pitch, 2)} mm pitch`;
      return html`
        <h2>${th.name}</h2><p class="mut small">${thread}</p>
        ${tiles([
          tile(forming ? "Hole for forming tap" : "Tap drill", best.label, dia(best.dia) + (best.percent != null ? ` · ${fmt(best.percent, 0)}% thread` : ""), "main"),
          ...(cl ? (cl.system === "imperial" ? [
            tile("Clearance, free fit", cl.freeDrill, dia(cl.free), "main"), tile("Clearance, close fit", cl.closeDrill, dia(cl.close), "main")] : [
            tile("Clearance, normal", fmt(cl.medium, 1) + " mm", `${inch(cl.medium)} · fine ${fmt(cl.fine, 1)}, loose ${fmt(cl.coarse, 1)}`, "main")]) : []),
          ...(cb ? [tile("Socket head counterbore", cb.system === "imperial" ? `Ø${fmt(cb.dia, 4)} in` : `Ø${fmt(cb.dia, 1)} mm`,
            cb.system === "imperial" ? `${fmt(cb.depth, 3)} in deep · head Ø${fmt(cb.head, 3)} × ${fmt(cb.height, 3)} in` : `${fmt(cb.depth, 2)} mm deep · head Ø${fmt(cb.head, 1)} × ${fmt(cb.height, 1)} mm`, "main")] : []),
        ])}
        ${td.drills.length > 1 ? html`<details class="more"><summary>Other drills that work</summary>${table(["Drill", "Size", forming ? "" : "Thread"], td.drills.map(d => [d.label, dia(d.dia), d.percent != null ? fmt(d.percent, 0) + "%" : ""]))}</details>` : ""}
        <div class="notes">
          ${note("info", forming ? "Thread-forming (roll) taps push the metal instead of cutting it, so no chips. Good in aluminum. Use lubricant, and don't use them in polycarbonate." : "Aluminum: use cutting fluid and back the tap out every half turn to break the chip. Blind holes: drill a few threads deeper than you tap.")}
          ${note("info", "Polycarbonate is a poor thing to tap and cracks easily. Use a through-hole with a bolt and nut, or a rivet.")}
          ${cb ? note("info", "Counterbore = head diameter plus a little clearance, and a bit deeper than the head is tall. Cut a test hole if a part has to fit tight.") : ""}
          ${cl && cl.system === "imperial" ? note("info", "Clearance sizes are the standard close-fit and free-fit drills (Machinery's Handbook).") : note("info", "Metric clearance holes follow ISO 273 (fine / normal / loose).")}
        </div>
        <details class="more"><summary>Pop (blind) rivet holes</summary>
          ${table(["Rivet", "Drill", "Hole"], RIVETS.map(([r, d, dia]) => [r, d, `${fmt(dia, 4)} in (${fmt(dia * IN, 2)} mm)`]))}
          <p class="mut small">Standard hole sizes from rivet suppliers. Aluminum rivets in aluminum plate are the usual FRC combination.</p>
        </details>`;
    },
  });

  // ================================================================== Mill / drill / lathe / saw speeds
  const MAT2 = [["aluminum", "Aluminum 6061"], ["polycarbonate", "Polycarbonate"]];
  calcPage({
    id: "manual", title: "Mill, Drill, Lathe & Saw", keywords: "manual mill drill press lathe bandsaw sfm rpm tpi blade speed feed chip load surface speed",
    intro: "Speeds and feeds for the mill, drill press, lathe and bandsaw. Starting points: adjust by sound.",
    fields: [
      { id: "tab", label: "Machine", type: "seg", def: "mill", options: [["mill", "Mill (end mill)"], ["drill", "Drill"], ["lathe", "Lathe"], ["saw", "Saw blade"]] },
      { id: "mat", label: "Material", type: "select", def: "aluminum", options: MAT2, show: v => v.tab !== "saw" },
      { id: "toolMat", label: "Tool material", type: "select", def: "hss", options: [["hss", "HSS"], ["carbide", "Carbide"]], show: v => v.tab !== "saw" },
      { id: "dia", label: "Tool diameter", type: "len", def: 6.35, show: v => v.tab === "mill" || v.tab === "drill" },
      { id: "flutes", label: "Flutes", type: "int", def: 2, min: 1, max: 12, dp: 0, show: v => v.tab === "mill" },
      { id: "workDia", label: "Work diameter", type: "len", def: 25.4, show: v => v.tab === "lathe" },
      { id: "fpr", label: "Feed per revolution", type: "num", unit: "in/rev", def: 0.005, show: v => v.tab === "lathe", hint: "0.005 in/rev roughing, 0.002 finishing." },
      { id: "sfm", adv: true, label: "Surface speed override", type: "num", unit: "SFM", def: 0, show: v => v.tab !== "saw", hint: "0 = use the recommended value." },
      { id: "ipt", adv: true, label: "Chipload override", type: "num", unit: "in/tooth", def: 0, show: v => v.tab === "mill", hint: "0 = use the recommended value." },
      { id: "maxRpm", adv: true, label: "Machine's top speed", type: "num", unit: "rpm", def: 0, dp: 0, show: v => v.tab !== "saw", hint: "0 = no limit. If the machine can't spin fast enough, feed is scaled down with it." },
      { id: "thk", label: "Thickness at the cut", type: "len", def: 1.5875, show: v => v.tab === "saw", hint: "Tube wall, or the plate thickness you're cutting through." },
      { id: "teeth", label: "Teeth in the cut at once", type: "int", def: 3, min: 2, max: 8, dp: 0, show: v => v.tab === "saw", hint: "At least 3 is the usual rule; fewer teeth can snag on thin wall." },
      { id: "wheel", adv: true, label: "Bandsaw wheel diameter", type: "len", def: 0, show: v => v.tab === "saw" },
      { id: "bsRpm", adv: true, label: "Bandsaw wheel rpm", type: "num", unit: "rpm", def: 0, show: v => v.tab === "saw" },
    ],
    compute(v) {
      const capSpeed = (rpm) => (v.maxRpm > 0 && rpm > v.maxRpm ? { rpm: v.maxRpm, capped: true } : { rpm, capped: false });
      if (v.tab === "mill") {
        if (!(v.dia > 0)) return note("bad", "Enter the tool diameter.");
        const dIn = v.dia / IN;
        const r = Shop.millSpeed({ material: v.mat, toolMat: v.toolMat, dIn, flutes: v.flutes || 2, sfm: v.sfm, ipt: v.ipt });
        const c = capSpeed(r.rpm);
        const feedIpm = c.rpm * (v.flutes || 2) * r.ipt;
        const sfmNow = Shop.sfmFromRpm(c.rpm, dIn);
        return html`<h2>End mill</h2>${tiles([
          tile("Spindle speed", group(c.rpm) + " rpm", `${Math.round(sfmNow)} SFM`, "main"),
          tile("Feed", ...[U.both("feed", feedIpm * IN)[0], U.both("feed", feedIpm * IN)[1]], "main"),
          tile("Chipload", `${fmt(r.ipt, 4)} in/tooth`, `${fmt(r.ipt * IN, 3)} mm/tooth`),
        ])}<div class="notes">
          ${c.capped ? note("warn", `Your machine tops out at ${group(v.maxRpm)} rpm, so the surface speed is ${Math.round(sfmNow)} SFM (target ${Math.round(r.sfm)}). Feed is held to the chipload.`) : ""}
          ${note("info", `Depth of cut: up to about ${inch(v.dia * 0.5)} when slotting, up to ${inch(v.dia)} for side cuts with a light width. Use lubricant on aluminum, air on polycarbonate.`)}
          ${v.toolMat === "hss" && v.mat === "aluminum" ? note("info", "Small cutters in aluminum clog easily: use 2 flutes, take light cuts, and flood or mist.") : ""}
          ${note("info", "Starting numbers from typical handbook values. If it chatters, change the speed 10–20% before touching the feed.")}</div>`;
      }
      if (v.tab === "drill") {
        if (!(v.dia > 0)) return note("bad", "Enter the drill diameter.");
        const dIn = v.dia / IN;
        const d = Shop.drillSpeed(v.mat, v.toolMat, dIn);
        const sfm = v.sfm > 0 ? v.sfm : d.sfm;
        const rpm0 = Shop.rpmFromSfm(sfm, dIn);
        const c = capSpeed(rpm0);
        const ipm = c.rpm * d.ipr;
        return html`<h2>Drill</h2>${tiles([
          tile("Spindle speed", group(c.rpm) + " rpm", `${Math.round(Shop.sfmFromRpm(c.rpm, dIn))} SFM`, "main"),
          tile("Feed", `${fmt(d.ipr, 4)} in/rev`, `about ${U.both("feed", ipm * IN)[0]}`, "main"),
        ])}<div class="notes">
          ${c.capped ? note("warn", `Held to your machine's ${group(v.maxRpm)} rpm.`) : ""}
          ${v.mat === "aluminum" ? note("info", "Aluminum: use cutting fluid, clear the chips often (peck on deep holes), and keep the speed up so it doesn't build up on the bit.") : note("info", "Polycarbonate: sharp bit, moderate speed, steady feed (don't let it rub and melt). Back the part with scrap and ease off as it breaks through.")}
          ${note("info", "Feed per revolution follows typical handbook ranges for 2-flute drills of this size.")}</div>`;
      }
      if (v.tab === "lathe") {
        if (!(v.workDia > 0)) return note("bad", "Enter the diameter of the work.");
        const dIn = v.workDia / IN;
        const sfm = v.sfm > 0 ? v.sfm : Shop.SPEED_PRESETS[v.mat].sfm[v.toolMat];
        const c = capSpeed(Shop.rpmFromSfm(sfm, dIn));
        const ipm = c.rpm * (v.fpr || 0);
        return html`<h2>Lathe</h2>${tiles([
          tile("Spindle speed", group(c.rpm) + " rpm", `${Math.round(Shop.sfmFromRpm(c.rpm, dIn))} SFM`, "main"),
          tile("Feed", `${fmt(v.fpr, 4)} in/rev`, `${fmt(ipm, 2)} in/min`, "main"),
        ])}<div class="notes">${c.capped ? note("warn", `Held to your machine's ${group(v.maxRpm)} rpm.`) : ""}
          ${note("info", "Speed drops as the work gets bigger: recalculate for each diameter. Keep tool stick-out short.")}</div>`;
      }
      if (!(v.thk > 0)) return note("bad", "Enter the thickness at the cut.");
      const t = Shop.sawTpi(v.thk / IN, v.teeth);
      const sfpm = v.wheel > 0 && v.bsRpm > 0 ? Shop.bladeSfpm(v.wheel / IN, v.bsRpm) : 0;
      return html`<h2>Saw blade</h2>${tiles([
        tile("Teeth per inch (minimum)", fmt(t.need, 0), `for ${v.teeth} teeth in ${inch(v.thk)}`, "main"),
        tile("Blade to buy", `${t.tpi} TPI${t.tooFine ? " (finest common)" : ""}`, t.tooFine ? "thin wall: feed gently" : "fine pitch for thin stock", "main"),
        ...(sfpm ? [tile("Blade speed", `${Math.round(sfpm)} SFPM`, "from wheel size and rpm")] : []),
      ])}<div class="notes">
        ${t.tooFine ? note("warn", "No common blade is fine enough for 3 teeth in a wall this thin. Use the finest blade you have, cut slowly, and support the tube so it can't grab.") : ""}
        ${note("info", "Bandsaws cut aluminum best around 200–350 SFPM with a coarse-to-medium blade; thin tube wants a fine one (14–32 TPI).")}
        ${note("info", "A blade with too few teeth in the cut grabs and tears the wall; too many fills the gullets and gums up.")}
        ${note("info", "Bi-metal blades last longest. Use a little cutting wax or lubricant on aluminum.")}</div>`;
    },
  });

  // ================================================================== Weight & stock
  const SHAPES = [["recttube", "Rectangular / square tube"], ["plate", "Plate or sheet"], ["roundtube", "Round tube"], ["round", "Round bar / rod"], ["angle", "Angle (L)"]];
  const STOCK = [
    ["1x1x1/16", "1 × 1 × 1/16 in aluminum tube", { shape: "recttube", width: 25.4, height: 25.4, wall: 1.5875, mat: "aluminum" }],
    ["1x2x1/16", "1 × 2 × 1/16 in aluminum tube", { shape: "recttube", width: 25.4, height: 50.8, wall: 1.5875, mat: "aluminum" }],
    ["1x1x1/8", "1 × 1 × 1/8 in aluminum tube", { shape: "recttube", width: 25.4, height: 25.4, wall: 3.175, mat: "aluminum" }],
    ["2x1x1/8", "2 × 1 × 1/8 in aluminum tube", { shape: "recttube", width: 25.4, height: 50.8, wall: 3.175, mat: "aluminum" }],
    ["2x2x1/8", "2 × 2 × 1/8 in aluminum tube", { shape: "recttube", width: 50.8, height: 50.8, wall: 3.175, mat: "aluminum" }],
    ["p1/16", "1/16 in aluminum sheet", { shape: "plate", thickness: 1.5875, mat: "aluminum" }],
    ["p1/8", "1/8 in aluminum plate", { shape: "plate", thickness: 3.175, mat: "aluminum" }],
    ["p1/4", "1/4 in aluminum plate", { shape: "plate", thickness: 6.35, mat: "aluminum" }],
    ["pc1/8", "1/8 in polycarbonate", { shape: "plate", thickness: 3.175, mat: "polycarbonate" }],
    ["pc1/4", "1/4 in polycarbonate", { shape: "plate", thickness: 6.35, mat: "polycarbonate" }],
  ];
  calcPage({
    id: "weight", title: "Part Weight", keywords: "weight mass tube plate sheet aluminum polycarbonate density pounds kg budget rod angle",
    intro: "How much does that piece weigh? Add it to the robot weight budget as you design.",
    fields: [
      { id: "preset", label: "Common stock", type: "select", wide: true, def: "", options: [["", "Pick one, or enter sizes below…"], ...STOCK.map(s => [s[0], s[1]])] },
      { id: "shape", label: "Shape", type: "select", wide: true, def: "recttube", options: SHAPES },
      { id: "width", label: "Width", type: "len", def: 25.4, show: v => ["recttube", "plate", "angle"].includes(v.shape) },
      { id: "height", label: "Height", type: "len", def: 25.4, show: v => ["recttube", "angle"].includes(v.shape) },
      { id: "thickness", label: "Thickness", type: "len", def: 3.175, show: v => v.shape === "plate" },
      { id: "dia", label: "Diameter", type: "len", def: 12.7, show: v => ["round", "roundtube"].includes(v.shape) },
      { id: "wall", label: "Wall thickness", type: "len", def: 1.5875, show: v => ["recttube", "roundtube", "angle"].includes(v.shape) },
      { id: "length", label: "Length", type: "len", def: 304.8 },
      { id: "qty", label: "How many", type: "int", def: 1, min: 1, max: 1000, dp: 0 },
      { id: "mat", label: "Material", type: "select", def: "aluminum", options: [...Object.entries(Shop.DENSITY).map(([k, d]) => [k, d.label]), ["custom", "Other (enter density)"]] },
      { id: "rho", label: "Density", type: "num", unit: "g/cm³", def: 2.7, show: v => v.mat === "custom" },
    ],
    onChange(id, v) {
      if (id === "preset" && v.preset) { Object.assign(v, STOCK.find(s => s[0] === v.preset)[2]); return "redraw"; }
      if (id === "shape" || id === "mat") { v.preset = ""; return "redraw"; }
    },
    compute(v) {
      const d = { width: v.width, height: v.height, thickness: v.thickness, dia: v.dia, wall: v.wall, length: v.length };
      const need = { recttube: ["width", "height", "wall", "length"], plate: ["width", "thickness", "length"], roundtube: ["dia", "wall", "length"], round: ["dia", "length"], angle: ["width", "height", "wall", "length"] }[v.shape];
      if (need.some(k => !(d[k] > 0))) return note("bad", "Fill in every size.");
      const err = Shop.shapeError(v.shape, d);
      if (err) return note("bad", err);
      const rho = v.mat === "custom" ? v.rho : Shop.DENSITY[v.mat].rho;
      if (!(rho > 0)) return note("bad", "Enter a density.");
      const w = Shop.weightOf(v.shape, d, rho);
      const qty = Math.max(1, v.qty || 1);
      const perFt = (w.kg / v.length) * 304.8, perM = (w.kg / v.length) * 1000;
      return html`<h2>Weight</h2>${tiles([
        tile("Each", U.fmt("mass", w.kg), U.isImp() ? `${fmt(w.kg, 3)} kg` : `${fmt(w.lb, 3)} lb`, "main"),
        ...(qty > 1 ? [tile(`${qty} pieces`, U.fmt("mass", w.kg * qty), U.isImp() ? `${fmt(w.kg * qty, 3)} kg` : `${fmt(w.lb * qty, 3)} lb`, "main")] : []),
        tile(U.isImp() ? "Per foot" : "Per metre", U.isImp() ? fmt(perFt * Shop.LB_PER_KG, 3) + " lb" : fmt(perM, 3) + " kg", U.isImp() ? `${fmt(perM, 3)} kg/m` : `${fmt(perFt * Shop.LB_PER_KG, 3)} lb/ft`),
      ])}
      <div class="notes">${note("info", "Calculated from the sizes you enter (sharp inside corners), so it reads very slightly high for real extrusions with rounded corners. Density: " + fmt(rho, 2) + " g/cm³.")}${v.mat === "mdf" ? note("info", "MDF density varies a lot (about 0.6–0.8 g/cm³). Weigh the real board if it matters.") : ""}</div>
      <div class="bar actions"><button class="btn pri" id="addBudget">Add ${qty > 1 ? qty + " pieces " : ""}to weight budget</button><a class="btn" href="#/budget">Open budget</a></div>`;
    },
    after(out, v) {
      const b = $("#addBudget", out);
      if (!b) return;
      b.onclick = () => {
        const d = { width: v.width, height: v.height, thickness: v.thickness, dia: v.dia, wall: v.wall, length: v.length };
        const rho = v.mat === "custom" ? v.rho : Shop.DENSITY[v.mat].rho;
        const w = Shop.weightOf(v.shape, d, rho);
        const label = (STOCK.find(s => s[0] === v.preset) || [0, SHAPES.find(s => s[0] === v.shape)[1]])[1];
        const list = store.get("budget", []);
        list.push({ name: `${label}, ${U.fmt("len", v.length, 2)}`, kg: w.kg, qty: Math.max(1, v.qty || 1) });
        store.set("budget", list.slice(-300));
        toast("Added to the weight budget");
      };
    },
  });

  // ================================================================== Cut list
  const unitName = v => (v.units === "mm" ? "mm" : "in");
  function parseParts(text, units) {
    const parts = [], errors = [];
    text.split(/\r?\n/).slice(0, 300).forEach((line, i) => {
      const s = line.trim();
      if (!s) return;
      const m = /^(.+?)\s*(?:[x×*]\s*(\d+))?\s*(?:[,;]\s*(.*))?$/i.exec(s);
      let len = NaN, qty = 1, name = "";
      if (m) {
        const hasUnit = /(mm|in|")\s*$/i.test(m[1].trim());
        len = Shop.parseLength(hasUnit ? m[1] : units === "mm" ? m[1] + " mm" : m[1]);
        qty = m[2] ? parseInt(m[2], 10) : 1;
        name = (m[3] || "").trim();
      }
      if (!isFinite(len) || len <= 0 || !(qty >= 1) || qty > 1000) errors.push(`Line ${i + 1}: couldn't read “${s}”` + (qty > 1000 ? " (at most 1000 of one piece)" : ""));
      else parts.push({ len: len * IN, qty, name });
    });
    return { parts, errors };
  }
  calcPage({
    id: "cutlist", title: "Cut List", keywords: "cut list stock bars tube length optimizer nesting kerf waste saw plan 1d",
    intro: "List the pieces you need. Get the fewest stock bars and the cuts for each.",
    fields: [
      { id: "units", type: "text", def: "in", hidden: true },   // remembers which unit the numbers below are in
      { id: "stock", label: "Stock bar length", type: "num", unit: v => unitName(v), def: 72, hint: v => (v.units === "mm" ? "1830 mm (6 ft) and 2440 mm (8 ft) are common." : "72 in (6 ft) and 96 in (8 ft) are common.") },
      { id: "parts", label: v => `Pieces needed (lengths in ${v.units === "mm" ? "millimetres" : "inches"})`, type: "textarea", rows: 8, max: 4000, wide: true, def: "30 x 2\n20 x 3\n11-1/2 x 4, brace", hint: "One per line: length × quantity, then an optional name. Fractions are fine: 12-1/2 x 4. Change units with the in/mm switch at the top." },
      { id: "kerf", adv: true, label: "Saw cut width (kerf)", type: "num", unit: v => unitName(v), def: 0.0625 },
      { id: "trim", adv: true, label: "Squaring cut at each end", type: "num", unit: v => unitName(v), def: 0.25, hint: "Waste from squaring each end of a bar. 0 if the ends are already good." },
    ],
    init(v) {   // the in/mm switch at the top decides the units; swap the starting numbers when it changes
      const want = U.isImp() ? "in" : "mm";
      if (v.units !== want) { v.units = want; Object.assign(v, want === "mm" ? { stock: 1830, kerf: 1.6, trim: 6 } : { stock: 72, kerf: 0.0625, trim: 0.25 }); }
    },
    compute(v) {
      const k = v.units === "mm" ? 1 : IN;      // typed unit -> mm
      if (!(v.stock > 0)) return note("bad", "Enter the stock length.");
      const { parts, errors } = parseParts(v.parts || "", v.units);
      const r = Shop.cutList({ stock: (v.stock * k) / IN, kerf: ((v.kerf || 0) * k) / IN, trim: ((v.trim || 0) * k) / IN, parts: parts.map(p => ({ len: p.len / IN, qty: p.qty, name: p.name })) });
      const show = inchVal => (v.units === "mm" ? fmt(inchVal * IN, 1) : fmt(inchVal, 3));
      if (!parts.length && !errors.length) return note("info", "List your pieces on the left.");
      const bars = r.bars.map((bar, i) => html`<div class="barrow"><div class="barlabel">Bar ${i + 1}</div><div class="stockbar" aria-label="Bar ${i + 1}">${bar.parts.map(p => html`<span class="seg-part" data-w="${(p.len / (v.stock * k / IN)) * 100}" title="${show(p.len)}${p.name ? " " + p.name : ""}">${show(p.len)}</span>`)}<span class="seg-waste" data-w="${(bar.waste / (v.stock * k / IN)) * 100}"></span></div>
        <div class="barnote mut small">${bar.parts.map(p => show(p.len) + (p.name ? " " + p.name : "")).join(" + ")} — leftover ${show(bar.offcut)}</div></div>`);
      return html`<h2>Result</h2>${tiles([
        tile("Bars to buy", String(r.count), `${show(v.stock * k / IN)} ${unitName(v)} each`, "main"),
        tile("Used", fmt(r.utilization * 100, 0) + "%", `${show(r.waste)} ${unitName(v)} waste in total`, "main"),
      ])}
      ${errors.map(e => note("bad", e))}${r.errors.map(e => note("bad", e))}
      <div class="bars">${bars}</div>
      <div class="bar actions"><button class="btn pri" id="copyCuts">Copy cut list</button><button class="btn" id="printCuts">Print</button></div>`;
    },
    after(out, v) {
      $$("[data-w]", out).forEach(el => { el.style.width = Math.max(0, Math.min(100, +el.dataset.w)) + "%"; });
      const k = v.units === "mm" ? 1 : IN;
      const { parts } = parseParts(v.parts || "", v.units);
      const r = Shop.cutList({ stock: (v.stock * k) / IN, kerf: ((v.kerf || 0) * k) / IN, trim: ((v.trim || 0) * k) / IN, parts: parts.map(p => ({ len: p.len / IN, qty: p.qty, name: p.name })) });
      const show = x => (v.units === "mm" ? fmt(x * IN, 1) : fmt(x, 3));
      const c = $("#copyCuts", out);
      if (c) c.onclick = () => copyText(r.bars.map((b, i) => `Bar ${i + 1} (${show(v.stock * k / IN)}): ${b.parts.map(p => show(p.len) + (p.name ? " " + p.name : "")).join(", ")}  [leftover ${show(b.offcut)}]`).join("\n") + `\n${r.count} bars, ${fmt(r.utilization * 100, 0)}% used`);
      const p = $("#printCuts", out);
      if (p) p.onclick = () => window.print();
    },
  });

  // ================================================================== Sheet bending
  calcPage({
    id: "bend", title: "Sheet Bending", keywords: "bend allowance deduction k-factor flat pattern radius brake aluminum 5052 6061 polycarbonate",
    intro: "Flat length for a part bent on the brake, and a warning if the radius is too tight.",
    fields: [
      { id: "alloy", label: "Alloy", type: "select", wide: true, def: "5052-H32", options: [["5052-H32", "5052-H32 (bends well)"], ["6061-T6", "6061-T6 (cracks easily)"], ["other", "Other aluminum"]] },
      { id: "t", label: "Thickness", type: "len", def: 1.5875 },
      { id: "r", label: "Inside bend radius", type: "len", def: 1.5875, hint: "What the tooling gives you. For air bending it's roughly the die opening divided by 6." },
      { id: "angle", label: "Bend angle", type: "num", unit: "°", def: 90, min: 1, max: 179, dp: 0, hint: "How far the metal turns: 90 for a square corner." },
      { id: "k", adv: true, label: "K-factor", type: "num", def: 0.4, min: 0.2, max: 0.6, hint: "Where the neutral line sits. 0.40 for 5052 and 0.42 for 6061 are typical for air bending." },
      { id: "bends", label: "Number of bends", type: "seg", number: true, def: 1, options: [[1, "1 (L shape)"], [2, "2 (U channel)"]] },
      { id: "a", label: "Leg A (outside)", type: "len", def: 25.4 },
      { id: "b", label: "Leg B (outside)", type: "len", def: 50.8 },
      { id: "c", label: "Leg C (outside)", type: "len", def: 25.4, show: v => v.bends === 2 },
    ],
    onChange(id, v) { if (id === "alloy") { v.k = Shop.BEND[v.alloy].k; v.r = Math.max(v.t, v.t * Shop.BEND[v.alloy].minR); return "redraw"; } },
    compute(v) {
      if (!(v.t > 0) || !(v.r >= 0) || !(v.angle > 0)) return note("bad", "Enter thickness, radius and angle.");
      const b = Shop.bend(v.t, v.r, v.angle, v.k);
      const legs = v.bends === 2 ? [v.a, v.b, v.c] : [v.a, v.b];
      const flat = legs.reduce((s, x) => s + (x || 0), 0) - b.deduction * v.bends;
      const spec = Shop.BEND[v.alloy];
      const ratio = v.r / v.t;
      return html`<h2>Result</h2>${tiles([
        tile("Flat length", U.fmt("len", flat, 4), `${legs.map(x => U.fmt("len", x, 3)).join(" + ")} − ${v.bends} × ${U.fmt("len", b.deduction, 3)}`, "main"),
        tile("Bend allowance", U.fmt("len", b.allowance, 4), "arc length of the bend"),
        tile("Bend deduction", U.fmt("len", b.deduction, 4), "subtract per bend from outside legs"),
        tile("Setback", U.fmt("len", b.setback, 4), "from the tangent line to the outside corner"),
      ])}<div class="notes">
        ${ratio < spec.minR - 1e-9 ? note("bad", `Radius is ${fmt(ratio, 2)} × thickness. ${v.alloy} wants at least ${spec.minR} ×: expect cracking on the outside of the bend.`) : note("ok", `Radius is ${fmt(ratio, 2)} × thickness, fine for ${v.alloy}.`)}
        ${spec.note && v.alloy !== "5052-H32" ? note("info", spec.note) : ""}
        ${note("info", "Bend across the grain when you can. Always test on a scrap of the same sheet: K-factor depends on the tooling and the lot.")}
        ${note("info", `Polycarbonate sheet: cold-bend only with a radius of at least ${Shop.POLY_COLD_BEND_RADIUS} × its thickness (${U.fmt("len", v.t * Shop.POLY_COLD_BEND_RADIUS, 1)} here), or heat-form it. Tight cold bends crack.`)}</div>`;
    },
  });

  // ================================================================== Converter & finder
  const catOpts = Object.entries(Shop.UNITS).map(([k, d]) => [k, d.label]);
  calcPage({
    id: "convert", title: "Converter & Fractions", keywords: "convert units inches mm fraction decimal drill size nearest torque speed pressure",
    intro: "Convert units, or type a size (3/8, 1-1/2, .375, 12mm) to see it every way plus the closest drill.",
    fields: [
      { id: "tab", label: "What do you need?", type: "seg", def: "size", options: [["size", "Size finder"], ["units", "Unit converter"]] },
      { id: "text", label: "Size", type: "text", def: "5/16", max: 30, placeholder: "e.g. 5/16, 1-1/2, .375, 12mm", show: v => v.tab === "size", hint: "Inches by default. Add mm for metric." },
      { id: "cat", label: "Kind of unit", type: "select", def: "length", options: catOpts, show: v => v.tab === "units" },
      { id: "value", label: "Value", type: "num", def: 1, show: v => v.tab === "units" },
      { id: "from", label: "From", type: "select", def: "in", options: v => Object.keys(Shop.UNITS[v.cat].units).map(u => [u, u]), show: v => v.tab === "units" },
      { id: "to", label: "To", type: "select", def: "mm", options: v => Object.keys(Shop.UNITS[v.cat].units).map(u => [u, u]), show: v => v.tab === "units" },
    ],
    onChange(id, v) {
      if (id === "cat") { const u = Object.keys(Shop.UNITS[v.cat].units); v.from = u[0]; v.to = u[1] || u[0]; return "redraw"; }
    },
    compute(v) {
      if (v.tab === "units") {
        const u = Shop.UNITS[v.cat].units;
        if (!(v.from in u) || !(v.to in u)) return "";
        if (v.value == null) return note("info", "Enter a value.");
        const r = Shop.convert(v.cat, v.value, v.from, v.to);
        return html`<h2>${fmt(v.value, 6)} ${v.from} =</h2>${tiles([tile(v.to, fmt(r, 6), "", "main")])}
          ${table(["Unit", "Value"], Object.keys(u).map(x => [x, fmt(Shop.convert(v.cat, v.value, v.from, x), 6)]))}`;
      }
      const inches = Shop.parseLength(v.text || "");
      if (!isFinite(inches) || inches <= 0) return note("info", "Type a size like 5/16, 1-1/2, .375 or 12mm.");
      const f = Shop.toFraction(inches, 64);
      const sets = [["number", "letter", "fraction"], ["metric"]];
      const near = Shop.nearestDrills(inches, 3, sets[0]), nearM = Shop.nearestDrills(inches, 3, sets[1]);
      const frac = [8, 16, 32, 64].map(d => { const x = Shop.toFraction(inches, d); return [`1/${d}"`, x.text + '"', (x.error >= 0 ? "+" : "") + fmt(x.error, 4) + " in"]; });
      return html`<h2>${v.text}</h2>${tiles([
        tile("Inches", fmt(inches, 5), `${fmt(inches * 1000, 1)} thou`, "main"), tile("Millimetres", fmt(inches * IN, 3), "", "main"),
        tile("Nearest 1/64", f.text + '"', `${f.error >= 0 ? "+" : ""}${fmt(f.error, 4)} in`),
      ])}
      <h3>Closest drills</h3>${table(["Drill", "Size", "Off by"], [...near, ...nearM].map(d => [d.label, d.set === "metric" ? `${fmt(d.mm, 2)} mm` : `${fmt(d.inch, 4)} in`, `${(d.inch - inches >= 0 ? "+" : "") + fmt(d.inch - inches, 4)} in`]))}
      <h3>As a fraction</h3>${table(["Precision", "Nearest", "Error"], frac)}`;
    },
  });
})();
