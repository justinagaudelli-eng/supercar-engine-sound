// Desk simulator: throttle + brake sliders drive a simple longitudinal vehicle model.
// Emits samples in the same format as GPS (plus `throttle`, which the bus uses as load).

import { vehicleConfig } from '../vehicle/config.js'

export function createSimulator(cfg = vehicleConfig.sim) {
  let v = 0          // m/s
  let a = 0          // m/s^2
  let throttle = 0   // 0..1 (slider)
  let brake = 0      // 0..1 (slider)

  const g = 9.81

  function step(dtSec, timestampMs) {
    const dt = Math.min(0.1, Math.max(0, dtSec))
    // Drive force: power-limited at speed, traction-limited near standstill.
    const power = throttle * cfg.peakPowerW * cfg.drivelineEff
    const tractionMax = cfg.tractionMu * cfg.massKg * g * cfg.rearWeightFrac
    const drive = throttle > 0 ? Math.min(tractionMax * throttle, power / Math.max(v, 1)) : 0
    const drag = 0.5 * cfg.airDensity * cfg.cdA * v * v
    const roll = v > 0.05 ? cfg.rollingCoeff * cfg.massKg * g : 0
    // Engine braking when off throttle in gear (small, speed-dependent).
    const engineBrake = throttle < 0.02 && v > 1 ? cfg.engineBrakeN * Math.min(1, v / 10) : 0
    const brakeF = brake * cfg.maxBrakeG * cfg.massKg * g

    let net = drive - drag - roll - engineBrake - (v > 0 ? brakeF : 0)
    a = net / cfg.massKg
    v += a * dt
    if (v <= 0) { v = 0; a = Math.max(0, a) }

    return {
      speedMps: v,
      accelMps2: a,
      timestamp: timestampMs,
      source: 'sim',
      accuracy: 0.1,
      speedSigma: 0.05,
      throttle,
    }
  }

  return {
    step,
    setThrottle(x) { throttle = Math.max(0, Math.min(1, x)) },
    setBrake(x) { brake = Math.max(0, Math.min(1, x)) },
    get throttle() { return throttle },
    get brake() { return brake },
    get speed() { return v },
    reset() { v = 0; a = 0; throttle = 0; brake = 0 },
  }
}
