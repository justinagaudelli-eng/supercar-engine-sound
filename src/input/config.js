// All tunables for the input pipeline (GPS processing, filtering, load estimate).
// Units: metres, seconds, milliseconds where the name says Ms.

export const inputConfig = {
  gps: {
    watchOptions: { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    maxAccuracyM: 50,           // reject fixes reporting worse horizontal accuracy than this
    maxSpeedMps: 100,           // ~224 mph; anything faster is a bad fix
    maxAccelMps2: 15,           // implied |dv/dt| above this between fixes = impossible jump
    dopplerSpeedSigma: 0.5,     // m/s, 1-sigma for coords.speed (Doppler) measurements
    dopplerLatencyMs: 0,        // how stale coords.speed is when it arrives (tune after a real drive)
    minDerivedSpeedSigma: 0.8,  // m/s, floor for haversine-derived speed sigma
    derivedSigmaFactor: 0.25,   // fraction of combined fix accuracy that shows up as speed error
    maxDerivedDtMs: 5000,       // don't derive speed from positions further apart than this
    reanchorAfterRejects: 3,    // accept a "jump" after this many consecutive position rejects
    pollAfterMs: 3000,          // no fix for this long → also poll getCurrentPosition...
    pollEveryMs: 1500,          // ...at most this often
  },

  filter: {
    // Constant-acceleration Kalman filter on [speed, accel].
    jerkPsd: 4.0,               // process noise spectral density on jerk ((m/s^3)^2 / Hz)
    initialSpeedVar: 4,         // (m/s)^2
    initialAccelVar: 4,         // (m/s^2)^2
    accelMeasSigma: 0.3,        // m/s^2, when a source reports accel directly (simulator)
    maxAccelMps2: 12,           // clamp on the filtered acceleration
    // Between fixes we extrapolate; the accel term fades out so a stale estimate can't run away.
    extrapAccelTauS: 1.2,
    // When a new fix arrives, the visible estimate glides onto the new track instead of stepping.
    blendTauS: 0.35,
    maxGlideAccelMps2: 6,       // ...but never faster than this (initial glide rate)
  },

  dropout: {
    staleMs: 2500,              // no fix for this long → 'stale' (hold current speed)
    lostMs: 6000,               // no fix for this long → 'lost' (decay toward zero / idle)
    decayTauS: 4.0,             // time constant of the decay to zero once lost
    updateRateWindow: 8,        // fixes used for the update-rate (Hz) display
  },

  load: {
    // Estimated throttle load from longitudinal acceleration.
    fullAccelLowSpeed: 3.2,     // m/s^2 that counts as full throttle near standstill
    fullAccelHighSpeed: 1.4,    // m/s^2 that counts as full throttle at highSpeedRef
    highSpeedRefMps: 35,
    cruiseBase: 0.12,           // load needed to just hold speed at low speed
    cruiseAtRef: 0.32,          // load needed to hold speed at highSpeedRef (aero drag)
    deadbandMps2: 0.12,         // |accel| below this is treated as steady cruise
    liftOffAccelMps2: -0.9,     // at or below this decel the load is zero (overrun)
  },
}
