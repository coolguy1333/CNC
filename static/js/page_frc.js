/* FRC engineering pages: drivetrain, mechanisms, belts & chain, electrical, pneumatics, weight budget. */
(function () {
  "use strict";
  const { html, $, $$, U, fmt, group, tile, tiles, note, table, calcPage, copyText, store, toast, confirmDialog, download } = App;
  const IN = 25.4, FT = 304.8, G = 9.80665, LBF = 4.4482216152605;
  const motorOpts = Object.entries(Frc.MOTORS).map(([k, m]) => [k, m.name]);
  const motorFoot = html`<p class="mut small foot">Motor figures are the published 12 V numbers. A real robot comes out a little slower, so treat these as a best case.</p>`;

  // ================================================================== Drivetrain
  calcPage({
    id: "drive", title: "Drivetrain", keywords: "drive speed gear ratio swerve tank wheel traction acceleration current kraken neo falcon cim",
    intro: "Top speed, pushing force, acceleration and the current it costs.",
    fields: [
      { id: "motor", label: "Motor", type: "select", def: "kraken_x60", options: motorOpts },
      { id: "n", label: "Motors driving the wheels", type: "int", def: 4, min: 1, max: 12, dp: 0 },
      { id: "ratio", label: "Gear ratio (motor : wheel)", type: "num", def: 6.75, min: 0.1, hint: "6.75 means the motor turns 6.75 times per wheel turn." },
      { id: "wheel", label: "Wheel diameter", type: "len", def: 101.6 },
      { id: "mass", label: "Robot weight (with bumpers and battery)", type: "mass", def: 61.2349 },
      { id: "eff", adv: true, label: "Drivetrain efficiency", type: "num", def: 0.9, min: 0.3, max: 1, hint: "0.85–0.95 for good gearing." },
      { id: "mu", adv: true, label: "Wheel grip (friction coefficient)", type: "num", def: 1, min: 0.1, max: 2, hint: "About 1.0 on carpet with good tread. Lower on slick floors." },
      { id: "volts", adv: true, label: "Battery voltage under load", type: "num", unit: "V", def: 12, min: 6, max: 14 },
      { id: "ilim", adv: true, label: "Current limit per motor", type: "num", unit: "A", def: 0, hint: "0 = none. Software limits of 40–60 A are common." },
    ],
    compute(v) {
      if (!(v.mass > 0) || !(v.wheel > 0) || !(v.ratio > 0) || !(v.n >= 1)) return note("bad", "Fill in the motor count, ratio, wheel size and weight.");
      const m = Frc.MOTORS[v.motor];
      const r = Frc.drivetrain({ motor: m, n: v.n, ratio: v.ratio, wheelDia: v.wheel / 1000, mass: v.mass, eff: v.eff || 0.9, mu: v.mu || 1, volts: v.volts || 12, ilim: v.ilim || 0 });
      const gs = r.accel / G;
      return html`<h2>Result</h2>${tiles([
        tile("Free speed", U.fmt("speed", r.freeSpeed), U.both("speed", r.freeSpeed)[1] + " · wheel " + group(r.wheelRpm) + " rpm", "main"),
        tile("0 → 90% of free speed", r.t90 ? fmt(r.t90, 2) + " s" : "–", r.x90 ? "over " + (U.isImp() ? fmt(r.x90 / 0.3048, 1) + " ft" : fmt(r.x90, 1) + " m") : "", "main"),
        tile("Pushing force", U.fmt("force", r.pushForce, 0), r.tractionLimited ? "limited by wheel grip" : "limited by the motors", "main"),
        tile("Acceleration", fmt(r.accel, 1) + " m/s²", fmt(gs, 2) + " g"),
        tile("Current at that push", fmt(r.totalAmpsAtTraction, 0) + " A total", fmt(r.ampsAtTraction, 0) + " A per motor"),
      ])}<div class="notes">
        ${r.tractionLimited ? note("info", `The wheels slip before the motors run out of torque (grip limit ${U.fmt("force", r.traction, 0)}). More motors or a lower ratio won't help; a current limit would save battery.`) : note("info", "The motors, not the wheels, limit pushing force here. A lower ratio or more motors would push harder.")}
        ${r.totalAmpsAtTraction > 120 ? note("warn", `Pushing that hard draws ${fmt(r.totalAmpsAtTraction, 0)} A, more than the 120 A main breaker allows for long. Set a current limit.`) : ""}
        ${r.totalAmpsAtTraction > 60 && !(v.ilim > 0) ? note("info", "That much current also sags the battery and can brown the robot out. Many teams limit drive current to 40–60 A per motor.") : ""}
        ${note("info", "A good rule of thumb: real on-field top speed is about 80–85% of free speed.")}</div>${motorFoot}`;
    },
  });

  // ================================================================== Elevator, arm, flywheel
  const mechCommon = d => [
    { id: "motor", label: "Motor", type: "select", def: d.motor, options: motorOpts },
    { id: "n", label: "Number of motors", type: "int", def: d.n, min: 1, max: 8, dp: 0 },
    { id: "ratio", label: "Gear ratio (motor : mechanism)", type: "num", def: d.ratio, min: 0.1, hint: d.ratioHint },
    { id: "volts", adv: true, label: "Battery voltage", type: "num", unit: "V", def: 12, min: 6, max: 14 },
    { id: "ilim", adv: true, label: "Current limit per motor", type: "num", unit: "A", def: 0, hint: "0 = none." },
    { id: "eff", adv: true, label: "Efficiency", type: "num", def: d.eff || 0.85, min: 0.3, max: 1 },
  ];
  const baseOf = v => ({ motor: Frc.MOTORS[v.motor], n: v.n, ratio: v.ratio, volts: v.volts || 12, ilim: v.ilim || 0, eff: v.eff || 0.85 });
  const pctNote = p => (p > 0.5 ? note("warn", `The motors are working at ${fmt(p * 100, 0)}% of stall torque. That heats them up fast: add reduction or another motor.`) : p > 0.25 ? note("info", `The motors are at ${fmt(p * 100, 0)}% of stall torque.`) : "");
  const needMotors = v => (!(v.ratio > 0) || !(v.n >= 1) ? note("bad", "Enter the gear ratio and motor count.") : null);

  calcPage({
    id: "elevator", title: "Elevator", keywords: "elevator lift linear rigging cascade spool pulley motor current time gearing",
    intro: "Can the motors lift the load? How much current, and how long for the full travel?",
    fields: [...mechCommon({ motor: "neo", n: 2, ratio: 20, ratioHint: "Motor turns per spool turn." }),
      { id: "spool", label: "Spool or pulley diameter", type: "len", def: 38.1 },
      { id: "mass", label: "Load being lifted", type: "mass", def: 6.8 },
      { id: "rig", label: "Rigging", type: "select", wide: true, number: true, def: 1, options: [[1, "Direct / 1 stage"], [2, "2-stage cascade or continuous"], [3, "3-stage"]], hint: "How far the carriage moves for each unit of cable pulled." },
      { id: "travel", label: "Travel distance", type: "len", def: 1000 }],
    compute(v) {
      const bad = needMotors(v);
      if (bad) return bad;
      if (!(v.spool > 0) || !(v.mass > 0)) return note("bad", "Enter the spool diameter and the load.");
      const e = Frc.elevator(Object.assign(baseOf(v), { spoolDia: v.spool / 1000, mass: v.mass, rig: v.rig, travel: v.travel / 1000 }));
      return html`<h2>Result</h2>${tiles([
        tile("Can it lift the load?", e.canLift ? "Yes" : "No", e.canLift ? `holding takes ${fmt(e.percentOfStall * 100, 0)}% of stall` : `most it can hold: ${U.fmt("mass", e.maxMassKg, 1)}`, e.canLift ? "main" : "main bad"),
        tile("Current to hold", e.canLift ? fmt(e.totalAmps, 0) + " A total" : "–", e.canLift ? fmt(e.amps, 0) + " A per motor" : ""),
        tile("Speed with the load", e.canLift ? U.both("speed", e.loadedSpeed)[0] : "–", e.canLift ? "unloaded " + U.both("speed", e.freeSpeed)[0] : ""),
        tile("Time for the full travel", e.time ? fmt(e.time, 2) + " s" : "–", "at full voltage, no braking"),
        tile("Heaviest load it can hold", U.fmt("mass", e.maxMassKg, 1), "at stall or your current limit"),
      ])}<div class="notes">${e.canLift ? pctNote(e.percentOfStall) : note("bad", "The motors can't hold this load at this gearing. Add reduction, more motors, or a bigger rig factor.")}
        ${note("info", "Ignores friction, rope stretch and battery sag, and the moving stages' own weight. Add them to the load.")}</div>${motorFoot}`;
    },
  });

  calcPage({
    id: "arm", title: "Arm", keywords: "arm pivot shoulder wrist gravity torque holding swing time gearing motor current",
    intro: "Can the motor hold the arm level? How much current, and how long is a swing?",
    fields: [...mechCommon({ motor: "kraken_x60", n: 1, ratio: 100, ratioHint: "Motor turns per arm turn." }),
      { id: "length", label: "Arm length (pivot to end)", type: "len", def: 600 },
      { id: "armMass", label: "Arm weight", type: "mass", def: 2.7 },
      { id: "loadMass", label: "Weight at the end (gripper, game piece)", type: "mass", def: 1.4 },
      { id: "a0", label: "Start angle", type: "num", unit: "° above horizontal", def: 0, dp: 0, allowNegative: true, min: -90, max: 135 },
      { id: "a1", label: "End angle", type: "num", unit: "° above horizontal", def: 90, dp: 0, allowNegative: true, min: -90, max: 135 }],
    compute(v) {
      const bad = needMotors(v);
      if (bad) return bad;
      if (!(v.length > 0)) return note("bad", "Enter the arm length.");
      const a = Frc.arm(Object.assign(baseOf(v), { length: v.length / 1000, armMass: v.armMass, loadMass: v.loadMass, a0: v.a0, a1: v.a1 }));
      return html`<h2>Result</h2>${tiles([
        tile("Can it hold the arm level?", a.canHold ? "Yes" : "No", a.canHold ? `${fmt(a.percentOfStall * 100, 0)}% of stall` : "not enough torque", a.canHold ? "main" : "main bad"),
        tile("Holding torque (arm)", U.fmt("torque", a.holdTorque, 2), `${fmt(a.tauHoldPerMotor * 1000, 0)} mN·m per motor`),
        tile("Current to hold level", a.canHold ? fmt(a.totalAmps, 0) + " A total" : "–", a.canHold ? fmt(a.amps, 0) + " A per motor" : ""),
        tile("Time to swing", a.time ? fmt(a.time, 2) + " s" : "never gets there", `${fmt(v.a0, 0)}° → ${fmt(v.a1, 0)}°, full voltage, no braking`),
        tile("Arm inertia", fmt(a.inertia, 3) + " kg·m²", "about the pivot"),
      ])}<div class="notes">${a.canHold ? pctNote(a.percentOfStall) : note("bad", "The motors can't hold the arm level at this gearing. Add reduction or motors, or shorten and lighten the arm.")}
        ${note("info", "Gravity is worst when the arm is level and zero when it points straight up or down. Real swings are slower because you slow down to stop at the end.")}</div>${motorFoot}`;
    },
  });

  calcPage({
    id: "flywheel", title: "Flywheel", keywords: "flywheel shooter spin up wheel inertia rpm energy motor speed time rim speed",
    intro: "How long a shooter wheel takes to spin up, and how much energy it stores.",
    fields: [...mechCommon({ motor: "kraken_x60", n: 2, ratio: 1.5, ratioHint: "Motor turns per wheel turn. Below 1 spins the wheel faster than the motor.", eff: 0.95 }),
      { id: "wmass", label: "Wheel weight", type: "mass", def: 0.45 },
      { id: "wdia", label: "Wheel diameter", type: "len", def: 101.6 },
      { id: "jov", adv: true, label: "Inertia override", type: "num", unit: "kg·m²", def: 0, hint: "0 = treat the wheel as a solid disc (½ m r²). Use CAD's number for heavier or hollow wheels." },
      { id: "target", label: "Target speed", type: "num", unit: "wheel rpm", def: 3000, dp: 0 }],
    compute(v) {
      const bad = needMotors(v);
      if (bad) return bad;
      if (!(v.target > 0)) return note("bad", "Enter the target speed.");
      const J = v.jov > 0 ? v.jov : 0.5 * v.wmass * Math.pow(v.wdia / 2000, 2);
      if (!(J > 0)) return note("bad", "Enter the wheel's weight and diameter.");
      const f = Frc.flywheel(Object.assign(baseOf(v), { inertia: J, targetRpm: v.target }));
      const rim = ((v.target * 2 * Math.PI) / 60) * (v.wdia / 2000);
      return html`<h2>Result</h2>${tiles([
        tile("Spin-up time", f.ok && f.time ? fmt(f.time, 2) + " s" : "–", f.ok ? `to ${group(v.target)} rpm` : "can't reach that speed", f.ok ? "main" : "main bad"),
        tile("Free speed of this setup", group(f.freeWheelRpm) + " rpm", "no load, at this voltage"),
        tile("Stored energy", fmt(f.energy, 1) + " J", `inertia ${fmt(J, 4)} kg·m²`),
        tile("Rim speed", U.both("speed", rim)[0], U.both("speed", rim)[1]),
      ])}<div class="notes">${f.ok ? "" : note("bad", "The motors can't spin the wheel that fast at this ratio. Lower the ratio (spin it faster) or lower the target.")}
        ${f.ok && v.target > f.freeWheelRpm * 0.9 ? note("warn", "That's close to the motors' free speed, so the last bit takes forever and the speed will sag when a game piece hits it.") : ""}
        ${note("info", "More inertia holds speed better after a shot but takes longer to spin up. Efficiency here is the drive's, mostly belts and gears.")}</div>${motorFoot}`;
    },
  });

  // ================================================================== Belts & chain
  calcPage({
    id: "belts", title: "Belts & Chain", keywords: "belt chain center distance sprocket pulley teeth length links timing htd gt2 tension pitch",
    intro: "Centre distance for a belt or chain, or the belt or chain you need for a given spacing.",
    fields: [
      { id: "tab", label: "Drive type", type: "seg", def: "belt", options: [["belt", "Timing belt"], ["chain", "Chain"]] },
      { id: "pitchB", label: "Belt pitch", type: "select", number: true, def: 5, show: v => v.tab === "belt", options: Object.entries(Frc.BELT_PITCH).map(([k, p]) => [p, k]) },
      { id: "pitchC", label: "Chain size", type: "select", number: true, def: 0.375, show: v => v.tab === "chain", options: Object.entries(Frc.CHAIN_PITCH_IN).map(([k, p]) => [p, `${k} (${p} in pitch)`]) },
      { id: "n1", label: "Small pulley / sprocket teeth", type: "int", def: 16, min: 6, max: 200, dp: 0 },
      { id: "n2", label: "Large pulley / sprocket teeth", type: "int", def: 32, min: 6, max: 300, dp: 0 },
      { id: "mode", label: "I know the…", type: "seg", def: "length", options: [["length", "Belt / chain length"], ["center", "Centre distance"]] },
      { id: "count", label: "Teeth (belt) or links (chain)", type: "int", def: 100, min: 10, dp: 0, show: v => v.mode === "length" },
      { id: "cd", label: "Centre distance", type: "len", def: 250, show: v => v.mode === "center" },
    ],
    compute(v) {
      if (!(v.n1 > 0) || !(v.n2 > 0)) return note("bad", "Enter both tooth counts.");
      const [a, b] = v.n1 <= v.n2 ? [v.n1, v.n2] : [v.n2, v.n1];
      const ratio = b / a;
      if (v.tab === "belt") {
        const p = v.pitchB;
        const pd = n => (n * p) / Math.PI;
        let body;
        if (v.mode === "length") {
          const c = Frc.beltCenter(a, b, v.count, p);
          body = isFinite(c) ? tiles([tile("Centre distance", U.fmt("len", c, 3), `${fmt(c, 2)} mm`, "main"), tile("Belt", `${v.count} teeth`, `${fmt(v.count * p, 1)} mm long`)]) : note("bad", "That belt is too short to reach around both pulleys.");
        } else {
          if (!(v.cd > 0)) return note("bad", "Enter the centre distance.");
          const exact = Frc.beltTeeth(a, b, v.cd, p), lo = Math.floor(exact), hi = Math.ceil(exact);
          const row = t => { const c = Frc.beltCenter(a, b, t, p); return [`${t} teeth`, isFinite(c) ? `${U.fmt("len", c, 3)} (${fmt(c, 2)} mm)` : "too short", isFinite(c) ? `${c >= v.cd ? "+" : ""}${fmt(c - v.cd, 2)} mm` : ""]; };
          body = html`${tiles([tile("Belt length needed", fmt(exact, 2) + " teeth", `${fmt(exact * p, 1)} mm`, "main")])}${table(["Nearest belts", "Centre distance", "vs wanted"], lo === hi ? [row(lo)] : [row(lo), row(hi)])}${note("info", "Pick the belt whose centre distance you can reach by sliding a motor or tensioner. Sizes are whole teeth only.")}`;
        }
        return html`<h2>Timing belt, ${fmt(p, 3)} mm pitch</h2>${body}${tiles([tile("Ratio", fmt(ratio, 3) + " : 1", `${a}T → ${b}T`), tile("Pitch diameters", `${fmt(pd(a), 1)} / ${fmt(pd(b), 1)} mm`, `${fmt(pd(a) / IN, 3)} / ${fmt(pd(b) / IN, 3)} in`)])}`;
      }
      const p = v.pitchC * IN;
      let body;
      if (v.mode === "length") {
        const c = Frc.chainCenterPitches(a, b, v.count);
        body = isFinite(c) ? html`${tiles([tile("Centre distance", U.fmt("len", c * p, 3), `${fmt(c, 2)} pitches`, "main"), tile("Chain", `${v.count} links`, `${fmt(v.count * p, 1)} mm long`)])}${v.count % 2 ? note("warn", "Odd link counts need an offset link, which is weak. Use an even number of links.") : ""}` : note("bad", "That chain is too short to reach around both sprockets.");
      } else {
        if (!(v.cd > 0)) return note("bad", "Enter the centre distance.");
        const exact = Frc.chainLinks(a, b, v.cd / p);
        const even = Math.ceil(exact / 2) * 2, evenLo = even - 2;
        const row = L => { const c = Frc.chainCenterPitches(a, b, L); return [`${L} links`, isFinite(c) ? `${U.fmt("len", c * p, 3)} (${fmt(c * p, 2)} mm)` : "too short", isFinite(c) ? `${c * p >= v.cd ? "+" : ""}${fmt(c * p - v.cd, 2)} mm` : ""]; };
        body = html`${tiles([tile("Links needed", fmt(exact, 2), "round to an even number", "main")])}${table(["Nearest chains", "Centre distance", "vs wanted"], [row(evenLo), row(even)])}${note("info", "Use an even number of links. Leave some adjustment in the centre distance, because chain stretches.")}`;
      }
      return html`<h2>Chain, ${fmt(v.pitchC, 3)} in pitch</h2>${body}${tiles([tile("Ratio", fmt(ratio, 3) + " : 1", `${a}T → ${b}T`)])}`;
    },
  });

  // ================================================================== Electrical
  const awgOpts = Object.keys(Frc.AWG).map(Number).map(g => [g, g + " AWG"]);
  calcPage({
    id: "elec", title: "Wiring & Power", keywords: "wire gauge awg voltage drop breaker current battery sag resistance power distribution fuse",
    intro: "Voltage lost in a wire, the wire a breaker needs, and battery sag.",
    fields: [
      { id: "tab", label: "What do you need?", type: "seg", def: "drop", options: [["drop", "Wire drop"], ["breaker", "Breaker → wire"], ["battery", "Battery sag"]] },
      { id: "awg", label: "Wire gauge", type: "select", number: true, def: 12, options: awgOpts, show: v => v.tab === "drop" },
      { id: "len", label: "Wire length, one way", type: "len", def: 914.4, show: v => v.tab === "drop", hint: "The calculation counts the return wire too." },
      { id: "amps", label: "Current", type: "num", unit: "A", def: 40, show: v => v.tab === "drop" || v.tab === "battery" },
      { id: "volts", adv: true, label: "System voltage", type: "num", unit: "V", def: 12, show: v => v.tab === "drop" },
      { id: "maxDrop", adv: true, label: "Acceptable drop", type: "num", unit: "%", def: 3, show: v => v.tab === "drop" },
      { id: "breaker", label: "Breaker rating", type: "select", number: true, def: 40, show: v => v.tab === "breaker", options: [[120, "120 A (main)"], [40, "40 A"], [30, "30 A"], [20, "20 A"], [10, "10 A"], [5, "5 A or less"]] },
      { id: "voc", label: "Battery voltage, no load", type: "num", unit: "V", def: 12.6, show: v => v.tab === "battery", hint: "A rested, fully charged battery reads about 12.6–13 V." },
      { id: "rint", label: "Battery internal resistance", type: "num", unit: "Ω", def: 0.015, show: v => v.tab === "battery", hint: "Roughly 0.010–0.020 Ω for a healthy battery. Measure yours with a battery analyzer." },
    ],
    compute(v) {
      if (v.tab === "drop") {
        if (!(v.len > 0) || v.amps == null) return note("bad", "Enter the length and current.");
        const ft = v.len / FT;
        const w = Frc.wireDrop(v.awg, ft, v.amps, v.volts || 12);
        let best = null;
        for (const g of Object.keys(Frc.AWG).map(Number).sort((x, y) => y - x)) { if (Frc.wireDrop(g, ft, v.amps, v.volts || 12).percent <= v.maxDrop) { best = g; break; } }
        const br = Frc.minAwgForBreaker(Math.ceil(v.amps));
        return html`<h2>${v.awg} AWG, ${U.fmt("len", v.len, 1)} one way, ${fmt(v.amps, 1)} A</h2>${tiles([
          tile("Voltage lost", fmt(w.drop, 2) + " V", `${fmt(w.percent, 1)}% of ${fmt(v.volts, 1)} V`, w.percent > v.maxDrop ? "main bad" : "main"),
          tile("Power lost as heat", fmt(w.watts, 1) + " W", ""),
          tile("Wire resistance", fmt(w.ohms * 1000, 1) + " mΩ", "both directions"),
          tile(`Smallest wire under ${fmt(v.maxDrop, 1)}%`, best ? best + " AWG" : "heavier than 4 AWG", ""),
        ])}<div class="notes">${w.percent > v.maxDrop ? note("warn", `${v.awg} AWG drops more than ${fmt(v.maxDrop, 1)}% here. Use thicker wire or a shorter run.`) : note("ok", "Fine for this run.")}
          ${br && br > v.awg ? note("warn", `This current needs a breaker large enough that FRC rules require at least ${br} AWG wire.`) : ""}
          ${note("info", "Higher gauge numbers are thinner wire. Voltage drop adds to battery sag when everything pulls current at once.")}</div>`;
      }
      if (v.tab === "breaker") {
        const g = Frc.minAwgForBreaker(v.breaker);
        return html`<h2>${v.breaker} A breaker</h2>${tiles([tile("Smallest wire allowed", g + " AWG", "per the FRC robot construction rules", "main")])}
          ${table(["Breaker / fuse", "Smallest wire"], [["120 A main breaker", "6 AWG"], ["31–40 A", "12 AWG"], ["21–30 A", "14 AWG"], ["6–20 A", "18 AWG"], ["5 A or less", "22 AWG"]])}
          ${note("info", "From FRC rule R622 (2026 manual). Rules change from year to year, so check the current Robot Construction rules before wiring.")}`;
      }
      if (v.amps == null) return note("bad", "Enter the current.");
      const vt = Frc.batterySag(v.voc, v.rint, v.amps);
      return html`<h2>Battery under load</h2>${tiles([
        tile("Terminal voltage", fmt(vt, 2) + " V", `${fmt(v.voc - vt, 2)} V of sag at ${fmt(v.amps, 0)} A`, vt < 7 ? "main bad" : "main"),
        tile("Power lost inside the battery", fmt(v.amps * v.amps * v.rint, 0) + " W", ""),
      ])}<div class="notes">${vt < 7 ? note("bad", "That's low enough to brown out the controller (the roboRIO 2 browns out at 6.75 V by default, the roboRIO 1 at 6.3 V). Cut current with limits, or use a fresher battery.") : vt < 9 ? note("warn", "Sagging this far makes motors weaker and risks a brownout in a hard push.") : note("ok", "The battery holds up fine at this current.")}
        ${note("info", "An older or cold battery has more internal resistance. Add up the current of everything that can run at once, and compare.")}</div>`;
    },
  });

  // ================================================================== Pneumatics
  calcPage({
    id: "pneu", title: "Pneumatics", keywords: "pneumatic cylinder force air pressure psi tank compressor piston bore stroke",
    intro: "Cylinder force, and how much stored air each stroke uses.",
    fields: [
      { id: "bore", label: "Bore (cylinder inside diameter)", type: "len", def: 38.1 },
      { id: "rod", label: "Rod diameter", type: "len", def: 9.525 },
      { id: "stroke", label: "Stroke", type: "len", def: 152.4 },
      { id: "psi", label: "Working pressure", type: "press", def: 413.685, min: 0, hint: "FRC rules cap the working side at 60 psi." },
      { id: "tank", adv: true, label: "Storage tank volume", type: "num", unit: "in³", def: 0, hint: "0 = skip. Add up all tanks. Stored pressure is capped at 120 psi." },
      { id: "cycles", adv: true, label: "Strokes (out and back) per match", type: "int", def: 20, min: 0, dp: 0 },
    ],
    compute(v) {
      if (!(v.bore > 0) || !(v.stroke > 0) || !(v.rod >= 0) || v.rod >= v.bore) return note("bad", "Check the bore, rod and stroke.");
      const psi = v.psi / 6.894757293168;
      const c = Frc.cylinder(v.bore / IN, v.rod / IN, v.stroke / IN, psi);
      const per = v.tank > 0 ? Frc.tankDrop(c.volCycleWorking, psi, v.tank) : 0;
      return html`<h2>Result</h2>${tiles([
        tile("Pushing force (extend)", U.fmt("force", c.extendLbf * LBF, 1), `${fmt(c.extendLbf, 1)} lbf at ${fmt(psi, 0)} psi`, "main"),
        tile("Pulling force (retract)", U.fmt("force", c.retractLbf * LBF, 1), "less, because the rod takes up room", "main"),
        tile("Air per out-and-back stroke", fmt(c.freeAirCycle, 1) + " in³", "of free (atmospheric) air"),
        ...(v.tank > 0 ? [tile("Tank pressure used per stroke", fmt(per, 2) + " psi", `${fmt(per * v.cycles, 1)} psi over ${v.cycles} strokes`)] : []),
      ])}<div class="notes">
        ${psi > 60.5 ? note("bad", "FRC limits the working (regulated) side to 60 psi.") : ""}
        ${v.tank > 0 && per * v.cycles > 60 ? note("warn", "That uses a lot of the tank. Add storage, use smaller cylinders, or reduce strokes.") : ""}
        ${note("info", "Force is pressure × area, so a bigger bore pushes harder but uses air faster. Real force is a bit lower because of friction.")}</div>`;
    },
  });

  // ================================================================== Weight budget
  App.register({
    id: "budget", title: "Weight Budget", keywords: "robot weight limit 115 pounds parts list total remaining mass bumpers battery inspection",
    render(root) {
      const limitKg = (App.machine().weight_limit_lb || 115) * 0.45359237;
      const list = store.get("budget", []);
      const total = list.reduce((s, i) => s + i.kg * i.qty, 0);
      const pct = Math.min(100, (total / limitKg) * 100);
      root.innerHTML = html`
        <h1>Weight Budget</h1>
        <p class="mut lead">Add up the robot as you design it. The limit (${fmt(limitKg / 0.45359237, 0)} lb) is for the robot <b>without</b> bumpers and battery; change it in Settings &amp; Backups. This list is saved in this browser only.</p>
        <section class="card">
          ${tiles([tile("Total", U.fmt("mass", total, 2), U.isImp() ? `${fmt(total, 2)} kg` : `${fmt(total / 0.45359237, 2)} lb`, "main"),
            tile("Limit", U.fmt("mass", limitKg, 1), "", ""), tile(total > limitKg ? "Over by" : "Remaining", U.fmt("mass", Math.abs(limitKg - total), 2), "", total > limitKg ? "main bad" : "main")])}
          <div class="meter" role="img" aria-label="${fmt(pct, 0)} percent of the weight limit used"><span id="meterFill" data-w="${pct}" class="${total > limitKg ? "over" : pct > 90 ? "near" : ""}"></span></div>
          ${total > limitKg ? note("bad", "Over the limit. Time to lighten something.") : pct > 95 ? note("warn", "Within 5% of the limit. Leave room for wire, fasteners and tape.") : ""}
          <form id="addItem" class="inline" autocomplete="off">
            <div class="field grow"><label for="iname">Item</label><input id="iname" type="text" maxlength="80" placeholder="e.g. Swerve module ×4" required></div>
            <div class="field"><label for="iw">Weight each (${U.unit("mass")})</label><input id="iw" type="number" inputmode="decimal" step="any" min="0" required></div>
            <div class="field"><label for="iq">How many</label><input id="iq" type="number" inputmode="numeric" step="1" min="1" value="1"></div>
            <button class="btn pri" type="submit">Add</button>
          </form>
          ${list.length ? table(["Item", "Each", "Qty", "Total", ""], list.map((i, n) => [i.name, U.fmt("mass", i.kg, 3), i.qty, U.fmt("mass", i.kg * i.qty, 3), html`<button class="btn sm del" data-del="${n}" aria-label="Remove ${i.name}">Remove</button>`])) : html`<p class="mut">Nothing yet. Add items above, or use “Add to weight budget” on the Part Weight page.</p>`}
          <div class="bar actions"><button class="btn" id="copyB">Copy list</button><button class="btn" id="csvB">Download CSV</button><button class="btn del" id="clearB">Clear all</button></div>
          ${note("info", "Not counted toward the limit: the bumpers and the battery (and its half of the Anderson connector). Robot plus bumpers is also capped, at 135 lb in the 2025 and 2026 seasons. Always check the current manual.")}
        </section>`.s;
      $("#meterFill", root).style.width = pct + "%";
      const save = () => { store.set("budget", list); App.rerender(); };
      $("#addItem", root).onsubmit = e => {
        e.preventDefault();
        const name = $("#iname", root).value.trim(), w = parseFloat($("#iw", root).value), q = Math.max(1, parseInt($("#iq", root).value, 10) || 1);
        if (!name || !(w >= 0)) return;
        list.push({ name: name.slice(0, 80), kg: U.parse("mass", w), qty: q });
        save();
      };
      $$("[data-del]", root).forEach(b => b.onclick = () => { list.splice(+b.dataset.del, 1); save(); });
      $("#copyB", root).onclick = () => copyText(list.map(i => `${i.name}\t${fmt(U.show("mass", i.kg), 3)} ${U.unit("mass")}\t×${i.qty}`).join("\n") + `\nTotal\t${fmt(U.show("mass", total), 2)} ${U.unit("mass")}`);
      $("#csvB", root).onclick = () => download("weight-budget.csv", ["Item,Each kg,Qty,Total kg", ...list.map(i => `"${(/^[=+\-@\t\r]/.test(i.name) ? "'" + i.name : i.name).replace(/"/g, '""')}",${fmt(i.kg, 4)},${i.qty},${fmt(i.kg * i.qty, 4)}`)].join("\n"), "text/csv");
      $("#clearB", root).onclick = async () => { if (list.length && await confirmDialog("Remove every item from the budget?")) { store.set("budget", []); App.rerender(); } };
    },
  });
})();
