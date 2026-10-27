// Pure gearing math: road speed <-> engine rpm for each PDK gear.

export function wheelRpm(speedMps, gb) {
  return (speedMps / gb.tireCircumferenceM) * 60
}

/** Engine rpm with the clutch fully engaged in `gear` (1-based). */
export function coupledRpm(speedMps, gear, gb) {
  if (gear < 1 || gear > gb.ratios.length) return 0
  return wheelRpm(speedMps, gb) * gb.ratios[gear - 1] * gb.finalDrive
}

/** Road speed (m/s) at `rpm` in `gear`. */
export function speedAtRpm(rpm, gear, gb) {
  return (rpm / (gb.ratios[gear - 1] * gb.finalDrive)) * gb.tireCircumferenceM / 60
}

/** Highest gear that keeps rpm at or above minRpm (falls back to 1st). */
export function bestGear(speedMps, minRpm, maxRpm, gb) {
  for (let g = gb.ratios.length; g >= 1; g--) {
    const rpm = coupledRpm(speedMps, g, gb)
    if (rpm >= minRpm && rpm <= maxRpm) return g
  }
  // Too slow for any gear above minRpm → 1st; too fast for every gear → top gear.
  return coupledRpm(speedMps, 1, gb) < minRpm ? 1 : gb.ratios.length
}
