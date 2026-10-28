// Porsche 992 GT3 RS vehicle model. Every tunable number for gearing, shifting and the
// desk simulator lives here. Sources and confidence for each value: RESEARCH.md §1.

export const vehicleConfig = {
  engine: {
    idleRpm: 900,
    idleWobbleRpm: 14,          // subtle idle hunt amplitude
    redlineRpm: 9000,
    limiterRpm: 9000,           // fuel/ignition cut point
    limiterBounceRpm: 220,      // how far the revs fall on each limiter cut
    limiterHz: 11,              // limiter cut/recover cycles per second
    freeRevRiseRpmPerS: 14000,  // in neutral, revs climb this fast (light flywheel)
    freeRevFallRpmPerS: 7000,
    rpmTauS: 0.04,              // how tightly engine rpm follows the drivetrain target
    maxSlewRpmPerS: 16000,      // rpm can't move faster than this outside shifts (input glitches)
  },

  gearbox: {
    // 7-speed PDK, Porsche 992 GT3 RS data sheet (MY 08/2022). Reverse 3.42 (unused).
    ratios: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84],
    finalDrive: 4.27,
    // 335/30 ZR21 rear: D = 21 * 25.4 + 2 * 335 * 0.30 = 734.4 mm, C = 2.307 m;
    // loaded rolling circumference ~3% smaller.
    tireCircumferenceM: 2.238,
  },

  shift: {
    // Upshift point vs load: light throttle shifts early, full throttle near the limiter.
    upshiftLightRpm: 3200,
    upshiftFullRpm: 8850,
    upshiftLoadLo: 0.2,         // load at/below which the light shift point applies
    upshiftLoadHi: 0.92,        // load at/above which the full shift point applies
    upshiftCurve: 1.4,          // >1 keeps shift points low until you're really on it
    // Downshift when rpm in the current gear falls below this.
    downshiftLightRpm: 1400,
    downshiftFullRpm: 4800,
    downshiftCurve: 2,          // part throttle doesn't drag the downshift point up much
    brakingDownshiftRpm: 2900,  // under braking PDK downshifts early (with blips)
    brakingAccelMps2: -1.6,
    brakingUpshiftFloorRpm: 4600, // while braking, don't upshift (and allow downshifts) below this
    kickdownLoad: 0.85,         // load above which we drop gears for acceleration
    kickdownTargetRpm: 6500,    // ...as long as the lower gear lands at or below this
    hysteresisRpm: 900,         // a downshift must land this far below the upshift point
    minShiftIntervalS: 0.7,     // never shift again sooner than this (anti-hunt)
    kickdownIntervalS: 0.25,    // consecutive kickdowns can come faster
    brakingShiftIntervalS: 0.32, // consecutive downshifts under braking
    reverseShiftIntervalS: 1.6, // up-after-down or down-after-up needs this long (anti-hunt)
    kickdownHoldS: 1.5,         // after a kickdown, hold the gear this long (unless at redline)
    upshiftTimeS: 0.11,         // PDK upshift: rpm drop duration
    downshiftTimeS: 0.16,       // downshift: blip + settle
    blipOvershootRpm: 260,      // rev-match blip overshoots the target slightly
    blipLoad: 0.55,             // throttle stab during a downshift blip
    upshiftCutS: 0.07,          // ignition cut length at the start of a loaded upshift
    upshiftCutMinLoad: 0.45,    // only cut ignition on upshifts above this load
  },

  launch: {
    creepSpeedMps: 0.4,         // below this we're "stopped"
    clutchSlipRpmLight: 1250,   // slip rpm pulling away gently
    clutchSlipRpmFull: 4800,    // slip rpm on a full-throttle launch
  },

  load: {
    attackS: 0.12,              // load smoothing (rising)
    releaseS: 0.25,             // load smoothing (falling)
    shiftTauS: 0.8,             // slower load used for shift decisions (ignores accel noise)
  },

  startup: {
    crankS: 0.75,               // starter cranking time before the engine catches
    crankRpm: 230,
    flareRpm: 2500,             // catch → flare to this
    flareRiseS: 0.35,
    settleTauS: 0.7,            // decay from flare to idle
    shutdownS: 1.1,             // rpm decay to zero after stop
  },

  sim: {
    massKg: 1450 + 80,          // DIN weight 1450 kg + driver
    peakPowerW: 386000,         // 518 PS ≈ 386 kW
    drivelineEff: 0.88,
    tractionMu: 1.25,           // Cup 2 R tyres
    rearWeightFrac: 0.62,
    airDensity: 1.2,
    cdA: 0.39 * 2.21,           // Cd 0.39 x frontal area 2.21 m^2 (Porsche data sheet)
    rollingCoeff: 0.013,
    engineBrakeN: 900,
    maxBrakeG: 1.3,
  },
}
