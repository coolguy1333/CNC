/* FRC engineering calculators (pure functions, SI units: metres, kg, N, N·m, seconds, volts, amps unless a name says otherwise).
 * Motor numbers are the published 12 V figures (manufacturer / WPILib). Real motors vary by several percent. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Frc = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const G = 9.80665;
  const rpmToRad = rpm => (rpm * 2 * Math.PI) / 60;
  const radToRpm = w => (w * 60) / (2 * Math.PI);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ------------------------------------------------------------------ motors (12 V): free speed rpm, stall torque N·m, stall current A, free current A
  const MOTORS = {
    kraken_x60: { name: "Kraken X60", freeRpm: 6000, stallNm: 7.09, stallA: 366, freeA: 2 },
    kraken_x44: { name: "Kraken X44", freeRpm: 7530, stallNm: 4.05, stallA: 275, freeA: 1.4 },
    falcon500: { name: "Falcon 500", freeRpm: 6380, stallNm: 4.69, stallA: 257, freeA: 1.5 },
    neo_vortex: { name: "NEO Vortex", freeRpm: 6784, stallNm: 3.6, stallA: 211, freeA: 3.6 },
    neo: { name: "NEO", freeRpm: 5676, stallNm: 2.6, stallA: 105, freeA: 1.8 },
    neo550: { name: "NEO 550", freeRpm: 11000, stallNm: 0.97, stallA: 100, freeA: 1.4 },
    cim: { name: "CIM", freeRpm: 5330, stallNm: 2.41, stallA: 131, freeA: 2.7 },
    minicim: { name: "miniCIM", freeRpm: 5840, stallNm: 1.41, stallA: 89, freeA: 3 },
    bag: { name: "BAG", freeRpm: 13180, stallNm: 0.43, stallA: 53, freeA: 1.8 },
    pro775: { name: "775pro", freeRpm: 18730, stallNm: 0.71, stallA: 134, freeA: 0.7 },
  };

  /** Motor limits at battery voltage V (torque and stall current scale with voltage; free current stays). */
  function motorAt(m, V) {
    const k = (V || 12) / 12;
    return { freeW: rpmToRad(m.freeRpm) * k, freeRpm: m.freeRpm * k, stallNm: m.stallNm * k, stallA: m.stallA * k, freeA: m.freeA };
  }

  /** Torque (N·m) produced when each motor draws `amps`. */
  function torqueAtCurrent(m, amps, V) {
    const a = motorAt(m, V);
    if (amps <= a.freeA) return 0;
    return a.stallNm * Math.min(1, (amps - a.freeA) / (a.stallA - a.freeA));
  }
  /** Current drawn (A) per motor delivering torque `tau` (N·m). */
  function currentAtTorque(m, tau, V) {
    const a = motorAt(m, V);
    return a.freeA + (a.stallA - a.freeA) * clamp(tau / a.stallNm, 0, 1);
  }
  /** Speed (rad/s) per motor delivering torque tau; 0 when stalled. */
  function speedAtTorque(m, tau, V) {
    const a = motorAt(m, V);
    return a.freeW * Math.max(0, 1 - tau / a.stallNm);
  }
  /** Torque a motor makes at shaft speed w (rad/s), optionally held to a current limit. */
  function torqueAtSpeed(m, w, V, ilim) {
    const a = motorAt(m, V);
    let tau = a.stallNm * (1 - w / a.freeW);
    if (ilim > 0) tau = Math.min(tau, torqueAtCurrent(m, ilim, V));
    return tau;
  }
  /** Peak mechanical power (W) and the speed it occurs at. */
  function peakPower(m, V) {
    const a = motorAt(m, V);
    return { watts: (a.stallNm * a.freeW) / 4, rpm: a.freeRpm / 2 };
  }

  // ------------------------------------------------------------------ gears
  /** stages: [{driver, driven}] tooth counts. Returns the overall reduction (>1 slows down). */
  function gearTrain(stages) {
    let ratio = 1;
    for (const s of stages) {
      if (!(s.driver > 0) || !(s.driven > 0)) throw new Error("Tooth counts must be positive");
      ratio *= s.driven / s.driver;
    }
    return ratio;
  }

  // ------------------------------------------------------------------ drivetrain
  /**
   * Straight-line performance of a drivetrain.
   * p: {motor, n (motors), ratio (motor:wheel), wheelDia (m), mass (kg), eff (0-1), mu, volts, ilim (A per motor, 0 = none)}
   */
  function drivetrain(p) {
    const m = p.motor, a = motorAt(m, p.volts), r = p.wheelDia / 2;
    const eff = p.eff || 0.9;
    const freeW = a.freeW / p.ratio;
    const freeSpeed = freeW * r; // m/s
    const traction = (p.mu || 1) * p.mass * G; // N, all weight on driven wheels
    const forcePerNm = (p.n * p.ratio * eff) / r; // wheel force per N·m of motor torque
    const ilimTorque = p.ilim > 0 ? torqueAtCurrent(m, p.ilim, p.volts) : a.stallNm;
    const motorForceMax = forcePerNm * Math.min(a.stallNm, ilimTorque);
    const pushForce = Math.min(traction, motorForceMax);
    const tauAtTraction = Math.min(traction / forcePerNm, a.stallNm);
    const ampsAtTraction = currentAtTorque(m, tauAtTraction, p.volts);
    // numeric launch from rest: m dv/dt = min(traction, motor force(v))
    let v = 0, t = 0, x = 0, t90 = null, x90 = null;
    const dt = 0.0005;
    for (let i = 0; i < 200000 && t < 30; i++) {
      const w = (v / r) * p.ratio;
      const tau = Math.max(0, torqueAtSpeed(m, w, p.volts, p.ilim));
      const F = Math.min(traction, forcePerNm * tau);
      v += (F / p.mass) * dt; x += v * dt; t += dt;
      if (t90 === null && v >= 0.9 * freeSpeed) { t90 = t; x90 = x; }
      if (v >= freeSpeed * 0.99) break;
    }
    return {
      freeSpeed, traction, motorForceMax, pushForce, tractionLimited: traction < motorForceMax,
      ampsAtTraction, totalAmpsAtTraction: ampsAtTraction * p.n, accel: pushForce / p.mass, t90, x90,
      wheelRpm: radToRpm(freeW),
    };
  }

  // ------------------------------------------------------------------ mechanisms
  /**
   * Elevator / linear lift lifting `mass` (kg) with a spool or pulley of radius r (m).
   * `rig` = how far the carriage moves per unit of cable travel (1 single stage, 2 for a two-stage cascade).
   * p: {motor, n, ratio, spoolDia, mass, rig, eff, volts, ilim, travel (m)}
   */
  function elevator(p) {
    const m = p.motor, r = p.spoolDia / 2, rig = p.rig || 1, eff = p.eff || 0.85, n = p.n;
    const a = motorAt(m, p.volts);
    const cableForce = (p.mass * G) / rig;                  // N in the cable
    const spoolTorque = cableForce * r;                      // N·m at the spool
    const tauPerMotor = spoolTorque / (p.ratio * eff * n);   // N·m each motor must make just to hold the load
    const ilimTau = p.ilim > 0 ? torqueAtCurrent(m, p.ilim, p.volts) : a.stallNm;
    const maxTau = Math.min(a.stallNm, ilimTau);
    const canLift = tauPerMotor < maxTau;
    const maxMassKg = ((maxTau * p.ratio * eff * n) / r) * rig / G; // heaviest load the motors can hold
    const amps = currentAtTorque(m, tauPerMotor, p.volts);
    const freeSpeed = ((a.freeW / p.ratio) * r) * rig;       // carriage m/s, no load
    const loadedSpeed = canLift ? ((speedAtTorque(m, tauPerMotor, p.volts) / p.ratio) * r) * rig : 0;
    // time to travel: integrate m*a = force from motors - gravity
    let time = null;
    if (canLift && p.travel > 0) {
      const dt = 0.0005;
      let v = 0, x = 0, t = 0;
      const Jeq = p.mass * Math.pow((rig * r) / p.ratio, 2) / n; // mass reflected to each motor shaft
      let w = 0;
      for (let i = 0; i < 400000 && x < p.travel; i++) {
        const tau = Math.max(0, torqueAtSpeed(m, w, p.volts, p.ilim)) * eff - tauPerMotor * eff; // surplus torque at motor shaft
        w += (tau / Jeq) * dt;
        v = (w / p.ratio) * r * rig;
        x += v * dt; t += dt;
        if (t > 60) break;
      }
      time = x >= p.travel ? t : null;
    }
    return { cableForce, spoolTorque, tauPerMotor, amps, totalAmps: amps * n, canLift, maxMassKg, freeSpeed, loadedSpeed, time,
             percentOfStall: tauPerMotor / a.stallNm };
  }

  /**
   * Arm swinging a uniform bar (mass armMass, length L, pivoting at one end) with an end load.
   * Angles are measured up from horizontal, in degrees. p: {motor, n, ratio, length, armMass, loadMass, a0, a1, eff, volts, ilim}
   */
  function arm(p) {
    const m = p.motor, n = p.n, eff = p.eff || 0.85, L = p.length;
    const J = (p.armMass * L * L) / 3 + p.loadMass * L * L;                 // kg·m^2 about the pivot
    const gravArm = (p.armMass * L) / 2 + p.loadMass * L;                    // kg·m, so torque = gravArm * g * cos(theta)
    const holdTorque = gravArm * G;                                          // worst case: arm horizontal
    const a = motorAt(m, p.volts);
    const tauHoldPerMotor = holdTorque / (p.ratio * eff * n);
    const ilimTau = p.ilim > 0 ? torqueAtCurrent(m, p.ilim, p.volts) : a.stallNm;
    const canHold = tauHoldPerMotor < Math.min(a.stallNm, ilimTau);
    const amps = currentAtTorque(m, tauHoldPerMotor, p.volts);
    let time = null;
    const t0 = ((p.a0 || 0) * Math.PI) / 180, t1 = ((p.a1 != null ? p.a1 : 90) * Math.PI) / 180;
    const dir = t1 >= t0 ? 1 : -1;
    let th = t0, w = 0, t = 0;
    const dt = 0.0005;
    for (let i = 0; i < 40000; i++) {
      const wm = Math.abs(w) * p.ratio;                                      // motor shaft speed
      const driveMotor = dir * torqueAtSpeed(m, wm, p.volts, p.ilim);
      const drive = driveMotor * p.ratio * eff * n;                          // N·m at the arm
      const grav = gravArm * G * Math.cos(th);
      w += ((drive - grav) / J) * dt;
      th += w * dt; t += dt;
      if ((dir > 0 && th >= t1) || (dir < 0 && th <= t1)) { time = t; break; }
    }
    return { inertia: J, holdTorque, tauHoldPerMotor, amps, totalAmps: amps * n, canHold, time, percentOfStall: tauHoldPerMotor / a.stallNm,
             freeArmRpm: a.freeRpm / p.ratio };
  }

  /**
   * Spin-up of a flywheel. J (kg·m^2) of the wheel; ratio motor:wheel; target wheel rpm.
   * Returns time to reach the target (s), closed-form for the unlimited-current case, and stored energy.
   */
  function flywheel(p) {
    const m = p.motor, n = p.n, eff = p.eff || 0.95;
    const a = motorAt(m, p.volts);
    const freeWheelRpm = a.freeRpm / p.ratio;
    const targetW = rpmToRad(p.targetRpm);
    const freeW = a.freeW / p.ratio;
    const Jm = p.inertia / (p.ratio * p.ratio) / n;                         // reflected to each motor shaft
    const energy = 0.5 * p.inertia * targetW * targetW;
    if (targetW >= freeW * 0.98) return { ok: false, freeWheelRpm, energy, time: null, jm: Jm };
    let time = null;
    if (!(p.ilim > 0)) { // linear torque-speed curve gives an exponential
      const T = (Jm * a.freeW) / (a.stallNm * eff);
      time = -T * Math.log(1 - (targetW * p.ratio) / a.freeW);
    } else {
      let w = 0, t = 0;
      const dt = 0.0002;
      for (let i = 0; i < 500000; i++) {
        w += (Math.max(0, torqueAtSpeed(m, w, p.volts, p.ilim)) * eff / Jm) * dt; t += dt;
        if (w / p.ratio >= targetW) { time = t; break; }
      }
    }
    return { ok: true, freeWheelRpm, energy, time, jm: Jm, peakAmps: Math.min(a.stallA, p.ilim > 0 ? p.ilim : a.stallA) };
  }

  // ------------------------------------------------------------------ belts and chain
  /** Belt of `teeth` teeth over pulleys of n1 and n2 teeth, pitch in mm: centre distance in mm (NaN if it can't reach). */
  function beltCenter(n1, n2, teeth, pitch) {
    const L = teeth * pitch, d1 = (n1 * pitch) / Math.PI, d2 = (n2 * pitch) / Math.PI;
    const b = 4 * L - 2 * Math.PI * (d1 + d2);
    const disc = b * b - 32 * Math.pow(d2 - d1, 2);
    return disc < 0 ? NaN : (b + Math.sqrt(disc)) / 16;
  }
  /** Belt length (teeth) needed for a centre distance (mm); not rounded. */
  function beltTeeth(n1, n2, center, pitch) {
    const d1 = (n1 * pitch) / Math.PI, d2 = (n2 * pitch) / Math.PI;
    const L = 2 * center + (Math.PI * (d1 + d2)) / 2 + Math.pow(d2 - d1, 2) / (4 * center);
    return L / pitch;
  }
  const BELT_PITCH = { "3 mm (HTD/GT2)": 3, "5 mm (HTD)": 5, "9.525 mm (3/8 in)": 9.525 };
  /** Chain: centre distance in `pitch` units for L links over n1/n2 tooth sprockets. */
  function chainCenterPitches(n1, n2, links) {
    const k = links - (n1 + n2) / 2;
    const disc = k * k - (8 * Math.pow(n2 - n1, 2)) / (4 * Math.PI * Math.PI);
    return disc < 0 ? NaN : (k + Math.sqrt(disc)) / 4;
  }
  /** Links needed for a centre distance given in pitches (not rounded). */
  function chainLinks(n1, n2, centerPitches) {
    return 2 * centerPitches + (n1 + n2) / 2 + Math.pow((n2 - n1) / (2 * Math.PI), 2) / centerPitches;
  }
  const CHAIN_PITCH_IN = { "#25": 0.25, "#35": 0.375, "#40": 0.5 };

  // ------------------------------------------------------------------ electrical
  // Copper wire resistance, ohms per 1000 ft at 20 C
  const AWG = { 4: 0.2485, 6: 0.3951, 8: 0.6282, 10: 0.9989, 12: 1.588, 14: 2.525, 16: 4.016, 18: 6.385, 20: 10.15, 22: 16.14, 24: 25.67 };
  /** FRC rule R622: smallest wire (AWG number, larger = thinner) allowed for a breaker rating. Check the current manual. */
  function minAwgForBreaker(amps) {
    if (amps > 120) return null;
    if (amps > 40) return 6;
    if (amps >= 31) return 12;
    if (amps >= 21) return 14;
    if (amps >= 6) return 18;
    return 22;
  }
  /** Round-trip wire loss. lengthFt is ONE way; both conductors carry the current. */
  function wireDrop(awg, lengthFt, amps, volts) {
    const r = (AWG[awg] / 1000) * lengthFt * 2;
    const drop = amps * r;
    return { ohms: r, drop, watts: amps * amps * r, percent: (drop / (volts || 12)) * 100 };
  }
  /** Battery terminal voltage under load. */
  const batterySag = (voc, rInt, amps) => voc - amps * rInt;

  // ------------------------------------------------------------------ pneumatics
  const ATM_PSI = 14.7;
  /** Double-acting cylinder: bore, rod diameters in inches, stroke in inches, working pressure psi. */
  function cylinder(bore, rod, stroke, psi) {
    const area = (Math.PI / 4) * bore * bore, rodArea = (Math.PI / 4) * rod * rod;
    const extendLbf = psi * area, retractLbf = psi * (area - rodArea);
    const volExtend = area * stroke, volRetract = (area - rodArea) * stroke; // in^3 at working pressure
    const free = ((volExtend + volRetract) * (psi + ATM_PSI)) / ATM_PSI;    // in^3 of free air per full cycle
    return { area, extendLbf, retractLbf, volExtend, volRetract, volCycleWorking: volExtend + volRetract, freeAirCycle: free };
  }
  /** Pressure the storage tank loses per cycle (psi), isothermal. Tank volume in^3, working pressure psi. */
  const tankDrop = (workingVolIn3, workingPsi, tankIn3) => ((workingPsi + ATM_PSI) * workingVolIn3) / tankIn3;

  return {
    G, MOTORS, rpmToRad, radToRpm, motorAt, torqueAtCurrent, currentAtTorque, speedAtTorque, torqueAtSpeed, peakPower, gearTrain,
    drivetrain, elevator, arm, flywheel, beltCenter, beltTeeth, BELT_PITCH, chainCenterPitches, chainLinks, CHAIN_PITCH_IN, AWG,
    minAwgForBreaker, wireDrop, batterySag, cylinder, tankDrop, ATM_PSI,
  };
});
