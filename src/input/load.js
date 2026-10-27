// Estimate engine load (0..1, ~throttle position) from speed and longitudinal acceleration.
// Strong positive accel = full load, steady = light cruise load, decel = lift-off (0).

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const lerp = (a, b, t) => a + (b - a) * t

export function estimateLoad(speedMps, accelMps2, cfg) {
  const s = clamp01(speedMps / cfg.highSpeedRefMps)
  const fullAccel = lerp(cfg.fullAccelLowSpeed, cfg.fullAccelHighSpeed, s)
  // Aero drag grows with v^2, so holding speed needs more throttle at speed.
  const cruise = speedMps < 0.5 ? 0 : lerp(cfg.cruiseBase, cfg.cruiseAtRef, s * s)
  const a = accelMps2 ?? 0

  if (a >= cfg.deadbandMps2) {
    return clamp01(cruise + (1 - cruise) * clamp01((a - cfg.deadbandMps2) / (fullAccel - cfg.deadbandMps2)))
  }
  if (a > -cfg.deadbandMps2) return cruise
  // Decelerating: fade cruise load out to zero at liftOffAccel.
  const t = clamp01((a + cfg.deadbandMps2) / (cfg.liftOffAccelMps2 + cfg.deadbandMps2))
  return cruise * (1 - t)
}
