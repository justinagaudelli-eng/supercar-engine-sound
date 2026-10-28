// Every audio tunable lives here. Nothing in src/audio/** should contain a magic number
// that changes how the engine sounds. Design rationale: RESEARCH.md §2 (synthesis) and §1
// (engine orders / character).
//
// Units: Hz, seconds (…S), dB (…Db), linear gains otherwise. "rpm-lo/hi" pairs interpolate
// between idle and redline.
//
// The `worklet` block is passed verbatim to the AudioWorkletProcessor through
// processorOptions (structured clone), so it must stay plain data.

export const audioConfig = {
  seed: 0x911,                   // deterministic PRNG seed for jitter / pops / noise

  // Time constants for engine.setFrame → AudioParam.setTargetAtTime (main thread side).
  // The worklet smooths again per sample (worklet.smoothing), so these only need to bridge
  // the control rate (~60 Hz frames, maybe jittery on the car).
  params: {
    // setFrame skips an AudioParam update when the value moved less than this (saves
    // automation events; cut/combustion/starter are constant most of the time).
    epsilon: { rpm: 0.5, load: 0.002, cut: 0.001, combustion: 0.001, starter: 0.001, twoStep: 0.01, drive: 0.003 },
    // A gap between frames longer than this (e.g. context suspended/resumed, tab hidden)
    // cancels pending automation and restarts it from the frame time.
    gapResetS: 0.5,
    rpmTauS: 0.012,
    loadTauS: 0.03,
    cutTauS: 0.004,
    combustionTauS: 0.015,
    starterTauS: 0.02,
    twoStepTauS: 0.008,          // short: upshift bangs only last ~0.1 s
  },

  worklet: {
    redlineRpm: 9000,

    // Per-sample one-pole smoothing inside the processor (removes k-rate steps).
    smoothing: { rpmTauS: 0.006, loadTauS: 0.02, cutTauS: 0.002, combustionTauS: 0.012, starterTauS: 0.02 },

    // Porsche flat-six: 1-6-2-4-3-5, cylinders 1-3 on bank A, 4-6 on bank B. Even 120° firing.
    firingOrder: [1, 6, 2, 4, 3, 5],
    bankBFirstCylinder: 4,

    // Fixed per-cylinder imbalance (seeded once per engine) → half orders, "mechanical" feel.
    // Gain spread is rpm-dependent: lumpy idle (±15 %) → tighter at speed (±8 %).
    imbalance: { timingDeg: 2.5, gainLo: 0.15, gainHi: 0.08 },
    // Bank-to-bank asymmetry (firing alternates banks, so this feeds orders 1.5 / 4.5 / 7.5).
    bankB: { gain: 0.86, timingDeg: 3 },
    // Per-cycle jitter, idle → redline (real engines smooth out as revs rise).
    jitter: { timingDegLo: 0.7, timingDegHi: 0.15, gainLo: 0.1, gainHi: 0.02 },
    // Slow cycle-to-cycle amplitude wander: AR(1) per firing (rho 0.85 ≈ one engine cycle of
    // memory), σ 10 % at idle fading to 2 % above ~3.5k. Makes idle lope instead of hum.
    lump: { rho: 0.85, sigmaLo: 0.1, sigmaHi: 0.02, fadeRpm: [1200, 3500] },

    // Combustion (exhaust blow-down) pulse:
    //   v(t) = (e^-t/τd − e^-t/τa) − u·(e^-t/τu − e^-t/τd),  τu = rarefactionTauMul·τd
    pulse: {
      attackS: 0.00022,          // τa, keep ≥ 0.15 ms (aliasing)
      decayFracLo: 0.3,          // τd = decayFrac × firing period (idle → redline: sharper
      decayFracHi: 0.2,          //   pulses at high rpm = richer upper orders), clamped:
      decayMinS: 0.00035,
      decayMaxS: 0.004,
      rarefaction: 0.35,         // u: negative post-blowdown tail (less DC)
      rarefactionTauMul: 2.5,
      turbulence: 0.3,           // gas-turbulence noise riding on the pulse (1 + k·n)
      turbulenceOffLoad: 0.3,    // extra turbulence when off-load (hollow, breathy)
      turbulenceLpHz: 3000,
      loadExponent: 0.7,         // pulse gain = max(load, minLoad)^loadExponent
      minLoad: 0.05,             // fuel-cut overrun floor (DFCO): engine still pumps air → hollow note
      idleLoad: 0.15,            // the engine still has to fire to idle: load floor near idle…
      idleLoadFadeRpm: [1500, 2300], // …fading out above this (DFCO allowed)
      rpmGainLo: 0.65,           // pulse amplitude vs rpm (idle → redline)
      rpmGainHi: 1.0,
    },

    // "Support sines" at engine orders 1.5 / 3 / 6, phase-locked to the crank angle AND to the
    // pulse train's own harmonic phase (computed analytically from the pulse shape), injected
    // before the exhaust pipes. They add weight and a stable pitch centre without ever
    // cancelling the pulse fundamental. Levels are relative to the pulse train's order-3 /
    // order-6 harmonic, so they track load/cut/limiter automatically via the energy follower.
    support: {
      order3Lo: 0.4,             // +x of the pulse fundamental at idle (≈ +2.9 dB; more = idle hum) …
      order3Hi: 0.3,             // … tapering at redline, where pulses already carry the pitch
      order6: 0.35,
      order1_5: 0.16,            // relative to the order-3 harmonic level
      followerPeriods: 0.8,      // energy follower time constant in firing periods
      followerMinS: 0.003,
    },

    // Exhaust: bank headers → collector/main pipe → muffler (flap) → tailpipe, as feedback
    // combs (fixed formants that don't track rpm, like real pipes). Delays ≈ 2L/c, c≈520 m/s.
    exhaust: {
      headerA: { delayS: 0.0024, feedback: 0.4, lpHz: 5000 },
      headerB: { delayS: 0.0026, feedback: 0.4, lpHz: 5000 },   // bank B 8% longer → half orders
      headerWet: 0.5,
      main: { delayS: 0.0062, feedback: 0.3, lpHz: 2500 },
      mainWet: 0.5,
      muffler1: { delayS: 0.001, feedback: -0.35, lpHz: 3000 },
      muffler2: { delayS: 0.00135, feedback: 0.3, lpHz: 3000 },
      // Exhaust flap: closed = more muffler, open (rpm × load) = drier, louder, rawer.
      flapMixClosed: 0.75,
      flapMixOpen: 0.25,
      flapOpenRpm: [3000, 5500],
      // Twin centre tailpipes (slightly different) → stereo: mid = mean, side = difference.
      tail: { delayS: 0.0008, feedback: 0.2, lpHz: 8000 },
      tail2: { delayS: 0.00113, feedback: 0.22, lpHz: 7000 },
      stereo: { tailSide: 1.0, bankSide: 0.25 },   // side = tailSide·(L−R)/2 + bankSide·(hdrA − hdrB)
      // Hot exhaust gas → higher speed of sound → header/main resonances move up with load ×
      // rpm (no static "flanger" on sweeps): delay × 1/(1 + amount·load·rpm/redline), smoothed.
      gasTemp: { amount: 0.15, tauS: 0.25 },
      // Brightness: fc = baseHz + perRpmHz·rpm·(loadMin + (1−loadMin)·load), clamped.
      lowpass: { baseHz: 700, perRpmHz: 0.55, loadMin: 0.35, maxHz: 7500, q: 0.7 },
      // Off-load pumping "whoosh-burble" (noise modulated at firing rate).
      hollow: 0.018,
      hollowRpm: [1500, 3000],
      gain: 1.0,
    },

    // Rasp: high-passed exhaust through a soft clipper, fading in above ~6.5k (the GT3 shriek).
    // cutGain: rasp × (1 + cutGain·cut) during ignition cut; negative = ducks (no combustion,
    // no combustion rasp — the cut is heard as the blats + the gap instead).
    rasp: { startRpm: 6200, fullRpm: 9000, hpHz: 1400, drive: 5, level: 0.32, loadMin: 0.35, lpHz: 8000, cutGain: -0.6 },

    // Intake (ITB induction howl): firing-rate pulses (slower decay) × (tone + noise) through
    // airbox/plenum and runner formants. Two resonance flaps switch near 3k and 5.5k rpm.
    intake: {
      decayMul: 1.6,             // envelope decay vs exhaust τd
      attackS: 0.0008,           // induction is softer than blow-down
      presenceRpm: [150, 600],   // spinning down / cranking: intake puffs fade out
      tonal: 1.0,
      noise: 0.35,               // × low-passed (3 kHz) unit-RMS noise, not raw white
      plenum: { hz: 420, q: 3, gain: 1.0 },
      runner: { hzLo: 1700, hzHi: 2150, q: 2.5, gain: 0.55 },
      howl: { hzLo: 950, hzHi: 1250, q: 2, gain: 0.7 },  // switched-resonance "howl" band (o6/o9 at high rpm)
      direct: 0.25,
      directLpHz: 2500,          // the un-formanted part of the intake stays dark
      side: { hz: 1200, q: 0.8, level: 0.5 },  // decorrelated induction air → slight width
      levelBase: 0.12,           // level = base + range·load·(rpm/redline)^exp
      levelRange: 0.88,
      levelExp: 1.2,
      flapBumps: [{ rpm: 3000, width: 300, gain: 0.25 }, { rpm: 5500, width: 300, gain: 0.35 }],
      gain: 0.6,
    },

    // Mechanical: higher engine orders + valvetrain tick (solid lifters) + starter motor.
    mech: {
      orders: [6, 9, 12, 18],
      ampLo: [0.006, 0.004, 0.003, 0.0015],
      ampHi: [0.02, 0.018, 0.014, 0.01],
      ampRpmExp: 1.5,
      presenceRpm: 150,          // everything mechanical fades in over 0..presenceRpm
      tick: { levelLo: 0.03, levelHi: 0.05, decayS: 0.0004, attackS: 0.0001, bpHz: 6200, q: 2.5, secondTickDeg: 60 },
      gain: 1.0,
    },

    // Overrun pops/crackles (DFCO + afterfire). Armed on lift-off; die away over windowS.
    overrun: {
      armLoad: 0.3,              // must have been above this…
      liftLoad: 0.08,            // …and drop below this to arm
      minRpm: 4200,
      fullRpm: 6000,             // probability ramps in between minRpm and fullRpm
      probBase: 0.006,           // per firing slot (~2–5 pops/s right after lift-off)
      probPerRpm: 0.02,          // × rpm/redline
      windowS: 1.8,              // probability decays linearly to 0 over this after lift-off
      gainMin: 0.45,             // pop amplitude vs a full-load pulse (GT3 = restrained)
      gainMax: 0.95,
      attackS: 0.0003,
      decayMinS: 0.005,
      decayMaxS: 0.014,
      noiseMix: 0.8,
      delayMinS: 0.002,
      delayMaxS: 0.015,
      burstProb: 0.2,            // crackle: 2–3 pops within ~40 ms
      burstGapMinS: 0.008,
      burstGapMaxS: 0.02,
      minBurstSpacingS: 0.12,
    },

    // Ignition cut (upshift, limiter): cut is the probability a firing is skipped. A skipped
    // firing under load may become a retarded-spark "blat".
    cut: { blatProb: 0.35, blatGain: 0.45, blatAttackS: 0.0008, blatDecayS: 0.004, blatNoise: 0.5 },

    // Launch control 2-step (twoStep param = 1): cut firings become hard blats and some
    // unburnt charges bang in the exhaust (via the pop voice).
    twoStep: {
      blatProb: 0.8,             // vs cut.blatProb normally
      blatGain: 0.9,             // vs cut.blatGain normally
      bangProb: 0.4,             // per cut firing: chance of an exhaust bang
      bangGain: 1.25,            // × an overrun pop
      burstProb: 0.35,           // bang followed by 1–2 crackles
      delayMinS: 0.004,
      delayMaxS: 0.03,
      minBangSpacingS: 0.05,
    },

    // Starter motor while cranking (combustion ≈ 0).
    starter: {
      whineOrder: 115,           // armature/pinion whine frequency = rpm × order / 60
      whineHarmonic2: 0.4,
      whineLevel: 0.05,
      whineNoise: 0.01,
      wobble: 0.18,              // crank speed dips on each compression stroke
      thumpGain: 0.45,           // compression thumps (through the exhaust path)
      thumpDecayS: 0.012,
      thumpAttackS: 0.0015,
    },

    dcR: 0.999,                  // in-worklet DC blockers (≈ 7.6 Hz at 48 kHz)
    pulseDcR: 0.998,
  },

  mixer: {
    synthTrim: 0.4,              // gain staging: keeps full-load synth ~6 dB under the compressor
    hpHz: 18,                    // DC blocker after the waveshaper (asymmetric curve → DC)
    // Waveshaper drive: d = 1 + amount·(rpm/redline)^exp·(loadMin + (1−loadMin)·load) × preset
    drive: { amount: 3, exp: 1.5, loadMin: 0.4, refLevel: 0.3, asymmetry: 0.12, range: 6,
      curveSize: 4096, oversample: '2x', tauS: 0.03, redlineRpm: 9000 },
    body: { hz: 150, q: 1, gainDb: 3 },     // body/boom formant
    compressor: { threshold: -16, knee: 6, ratio: 4, attack: 0.003, release: 0.15 },
    limiter: { threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.05 },
    // Final safety: a WaveShaper with a soft knee whose curve flattens at `ceiling`
    // (−1 dBFS). WaveShaper clamps out-of-range input to the curve's end values, so the peak
    // is mathematically bounded. oversample 'none' so no resampling filter overshoot.
    ceiling: 0.891,
    ceilingKnee: 0.75,
    analyserFftSize: 2048,
    mixTauS: 0.05,
    presetTauS: 0.15,
    volumeTauS: 0.05,
    testTone: { hz: 440, level: 0.12, rampS: 0.05 },
    events: 0.8,                 // one-shot event layer gain
    samples: 1.0,                // sample layer gain at mix = 1
  },

  // Sound character presets (mixer only).
  presets: {
    street: { exhaust: 1.0, intake: 0.85, mech: 0.8, drive: 1.0, width: 1.0,
      lowShelf: { hz: 120, gainDb: 2 }, highShelf: { hz: 3500, gainDb: 0 }, lowpassHz: 14000, lowpassQ: 0.7, outputGain: 1.0 },
    track: { exhaust: 1.25, intake: 0.85, mech: 1.0, drive: 1.4, width: 1.2,
      lowShelf: { hz: 120, gainDb: 1 }, highShelf: { hz: 3500, gainDb: 4 }, lowpassHz: 18000, lowpassQ: 0.7, outputGain: 1.0 },
    // Through the firewall: muffled exhaust, intake (right behind the seats) forward.
    cabin: { exhaust: 0.75, intake: 1.2, mech: 0.6, drive: 0.9, width: 0.6,
      lowShelf: { hz: 120, gainDb: 4 }, highShelf: { hz: 2500, gainDb: -6 }, lowpassHz: 1900, lowpassQ: 0.6, outputGain: 1.4 },
  },
  defaultPreset: 'street',

  // In-cabin safety: master gain = cap × volume^curve. Peak is already ≤ ceiling before this.
  volume: { default: 0.7, cap: 0.85, curve: 2 },

  // One-shot event sounds (events.js).
  events: {
    solenoidClick: { level: 0.25, lengthS: 0.035, bpHz: 2500, decayS: 0.006, secondDelayS: 0.012 },
    catchBark: { level: 0.55, lengthS: 0.22, thumpHz: 55, decayS: 0.06, noiseLpHz: 900, noiseLevel: 0.6 },
    shutdownClick: { level: 0.15, lengthS: 0.03, bpHz: 1800, decayS: 0.005 },
    shutdownThud: { level: 0.35, lengthS: 0.35, hz: 38, decayS: 0.09, delayS: 0.95 },
    shiftCrack: { level: 0.18, lengthS: 0.06, bpHz: 1600, decayS: 0.012, minLoad: 0.5 },
    fadeInS: 0.0005,
    fadeOutS: 0.005,
  },

  // Optional sample layer.
  samples: {
    tauS: 0.03,
    minRate: 0.25,
    maxRate: 4,
  },
}
