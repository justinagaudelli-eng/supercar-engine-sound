// Two-state (speed, acceleration) constant-acceleration Kalman filter.
// Handles irregular update intervals, so it works for ~1 Hz GPS and 50 Hz simulator alike.

export function createSpeedFilter(cfg) {
  let v = 0, a = 0
  // Covariance P = [[p00, p01], [p01, p11]]
  let p00 = cfg.initialSpeedVar, p01 = 0, p11 = cfg.initialAccelVar
  let initialized = false
  let lastT = null // seconds

  function predict(dt) {
    if (dt <= 0) return
    v = v + a * dt
    const q = cfg.jerkPsd
    const dt2 = dt * dt, dt3 = dt2 * dt
    // P = F P F^T + Q, F = [[1, dt], [0, 1]]
    const n00 = p00 + 2 * dt * p01 + dt2 * p11 + q * dt3 / 3
    const n01 = p01 + dt * p11 + q * dt2 / 2
    const n11 = p11 + q * dt
    p00 = n00; p01 = n01; p11 = n11
  }

  function updateSpeed(z, sigma) {
    const r = sigma * sigma
    const s = p00 + r
    const k0 = p00 / s, k1 = p01 / s
    const y = z - v
    v += k0 * y
    a += k1 * y
    // P = (I - K H) P, H = [1, 0]
    const n00 = (1 - k0) * p00
    const n01 = (1 - k0) * p01
    const n11 = p11 - k1 * p01
    p00 = n00; p01 = n01; p11 = n11
  }

  function updateAccel(z, sigma) {
    const r = sigma * sigma
    const s = p11 + r
    const k0 = p01 / s, k1 = p11 / s
    const y = z - a
    v += k0 * y
    a += k1 * y
    const n00 = p00 - k0 * p01
    const n01 = p01 - k0 * p11
    const n11 = (1 - k1) * p11
    p00 = n00; p01 = n01; p11 = n11
  }

  return {
    /** tSec: measurement time in seconds. */
    update(tSec, speed, speedSigma, accel = null) {
      if (!initialized) {
        v = Math.max(0, speed); a = accel ?? 0
        p00 = speedSigma * speedSigma; p01 = 0; p11 = cfg.initialAccelVar
        initialized = true
        lastT = tSec
        return
      }
      predict(Math.max(0, tSec - lastT))
      lastT = Math.max(lastT, tSec)
      updateSpeed(speed, speedSigma)
      if (accel != null && Number.isFinite(accel)) updateAccel(accel, cfg.accelMeasSigma)
      if (v < 0) { v = 0; if (a < 0) a = 0 }
      a = Math.max(-cfg.maxAccelMps2, Math.min(cfg.maxAccelMps2, a))
    },
    get initialized() { return initialized },
    get lastT() { return lastT },
    get speed() { return v },
    get accel() { return a },
    get variance() { return { p00, p01, p11 } },
    reset() {
      v = 0; a = 0; p00 = cfg.initialSpeedVar; p01 = 0; p11 = cfg.initialAccelVar
      initialized = false; lastT = null
    },
  }
}
