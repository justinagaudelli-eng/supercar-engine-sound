// Single funnel for every input source. Filters speed + acceleration, extrapolates
// between (slow) updates, glides onto new fixes without steps, and handles dropouts.

import { createSpeedFilter } from './kalman.js'
import { estimateLoad } from './load.js'

export function createInputBus(cfg) {
  const filter = createSpeedFilter(cfg.filter)
  let lastSample = null
  let lastSampleMs = null
  const arrivals = []      // recent sample timestamps for update-rate display
  let offsetV = 0          // visible-minus-model speed offset, decays after each fix
  let offsetMs = null
  let offsetTauS = cfg.filter.blendTauS
  let lastOut = null       // last estimate() output, for blending
  let lostFromMs = null    // when the 'lost' decay started
  let lostFromSpeed = 0

  // Speed/accel the model predicts at time tMs (no blending, no dropout handling).
  function modelAt(tMs) {
    const dt = Math.max(0, tMs / 1000 - filter.lastT)
    const tau = cfg.filter.extrapAccelTauS
    // Integrate an exponentially fading accel: v(dt) = v0 + a0 * tau * (1 - e^(-dt/tau))
    const fade = Math.exp(-dt / tau)
    const v = Math.max(0, filter.speed + filter.accel * tau * (1 - fade))
    return { v, a: v > 0 ? filter.accel * fade : Math.max(0, filter.accel * fade) }
  }

  const api = {
    push(sample) {
      if (!sample || !Number.isFinite(sample.speedMps)) return
      // `timestamp` is when the speed was true (may be in the past, e.g. a midpoint);
      // `receivedAt` is when it reached us — staleness and gliding run on arrival time.
      const tMs = sample.timestamp
      const arrival = Math.max(tMs, sample.receivedAt ?? tMs)
      if (filter.initialized && tMs / 1000 < filter.lastT) return // out of order
      if (lastSampleMs != null && arrival < lastSampleMs) return
      // Visible speed right now (before the update), so we can glide from it.
      const beforeOut = filter.initialized ? compute(arrival) : null
      const before = beforeOut ? beforeOut.speedMps : null
      const wasLost = beforeOut?.status === 'lost'

      const sigma = sample.speedSigma ?? Math.max(0.3, (sample.accuracy ?? 5) * 0.1)
      filter.update(tMs / 1000, sample.speedMps, sigma, sample.accelMps2)

      offsetMs = arrival
      if (before != null) {
        offsetV = before - modelAt(arrival).v
        // Big corrections (e.g. leaving a tunnel) glide no faster than maxGlideAccel.
        // After a lost signal, catch up faster (we already know we were wrong).
        const glide = wasLost ? cfg.filter.recoverGlideAccelMps2 : cfg.filter.maxGlideAccelMps2
        offsetTauS = Math.max(cfg.filter.blendTauS, Math.abs(offsetV) / glide)
      } else {
        offsetV = 0
      }
      lastSample = sample
      lastSampleMs = arrival
      lostFromMs = null
      arrivals.push(arrival)
      while (arrivals.length > cfg.dropout.updateRateWindow) arrivals.shift()
    },

    estimate(nowMs) { return compute(nowMs) },

    reset() {
      filter.reset()
      lastSample = null; lastSampleMs = null; arrivals.length = 0
      offsetV = 0; offsetMs = null; lastOut = null; lostFromMs = null
    },

    get filter() { return filter },
  }
  return api

  function compute(nowMs) {
      if (!filter.initialized) {
        lastOut = { speedMps: 0, accelMps2: 0, rawSpeedMps: null, load: 0, status: 'waiting',
          source: null, accuracy: null, ageMs: null, updateHz: 0 }
        return lastOut
      }
      const ageMs = Math.max(0, nowMs - lastSampleMs)
      let status = 'ok'
      let { v, a } = modelAt(nowMs)

      // Glide from the pre-update visible speed onto the new track.
      if (offsetMs != null && offsetV !== 0) {
        const k = Math.exp(-Math.max(0, nowMs - offsetMs) / 1000 / offsetTauS)
        v = Math.max(0, v + offsetV * k)
      }

      // At speed a dropout is almost always a tunnel or overpass: hold much longer.
      const heldSpeed = lastOut ? lastOut.speedMps : v
      const lostMs = heldSpeed >= cfg.dropout.highSpeedMps ? cfg.dropout.lostMsHighSpeed : cfg.dropout.lostMs
      if (ageMs >= lostMs) {
        status = 'lost'
        if (lostFromMs == null) {
          lostFromMs = nowMs
          lostFromSpeed = lastOut ? lastOut.speedMps : v
        }
        const k = Math.exp(-(nowMs - lostFromMs) / 1000 / cfg.dropout.decayTauS)
        v = lostFromSpeed * k
        a = -lostFromSpeed * k / cfg.dropout.decayTauS
        // Below walking pace just call it stopped.
        if (v < 0.3) { v = 0; a = 0 }
      } else if (ageMs >= cfg.dropout.staleMs) {
        status = 'stale'
        // Hold: freeze at the speed we were showing when the signal went stale.
        const held = modelAt(lastSampleMs + cfg.dropout.staleMs)
        v = held.v
        a = 0
      }

      // A sim/replay source may report throttle directly; otherwise estimate from accel.
      const load = lastSample.throttle != null && status === 'ok'
        ? lastSample.throttle
        : estimateLoad(v, a, cfg.load)

      let updateHz = 0
      if (arrivals.length >= 2) {
        const span = (arrivals[arrivals.length - 1] - arrivals[0]) / 1000
        if (span > 0) updateHz = (arrivals.length - 1) / span
      }

      lastOut = {
        speedMps: v,
        accelMps2: a,
        rawSpeedMps: lastSample.speedMps,
        load,
        status,
        source: lastSample.source,
        accuracy: lastSample.accuracy ?? null,
        ageMs,
        updateHz,
      }
      return lastOut
  }
}
