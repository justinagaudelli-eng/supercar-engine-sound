// Loop-point math for the slicer: zero crossings, integer-period loop selection, seam
// measurement and repair, rpm → time lookup, common gain, silence trimming.

/** Indices i where samples[i-1] < 0 <= samples[i], within [from, to). */
export function findRisingZeroCrossings(samples, from = 0, to = samples.length) {
  const out = []
  const a = Math.max(1, Math.floor(from))
  const b = Math.min(samples.length, Math.ceil(to))
  for (let i = a; i < b; i++) if (samples[i - 1] < 0 && samples[i] >= 0) out.push(i)
  return out
}

/**
 * Seam discontinuity for a loop [start, end): when playback wraps from end-1 to start, the
 * audio should look like the original continuing past end. Compares samples around `end`
 * with samples around `start`, as RMS difference relative to the loop's RMS (0 = perfect).
 */
export function seamError(samples, start, end, halfWindow = 8) {
  let diff = 0, n = 0
  for (let i = -halfWindow; i < halfWindow; i++) {
    const a = start + i, b = end + i
    if (a < 0 || b < 0 || a >= samples.length || b >= samples.length) continue
    const d = samples[b] - samples[a]
    diff += d * d
    n++
  }
  if (!n) return Infinity
  let e = 0
  const step = Math.max(1, Math.floor((end - start) / 2048))
  let m = 0
  for (let i = start; i < end; i += step) { e += samples[i] * samples[i]; m++ }
  const rms = Math.sqrt(e / Math.max(1, m))
  return rms > 0 ? Math.sqrt(diff / n) / rms : Math.sqrt(diff / n) > 0 ? Infinity : 0
}

/**
 * Picks loop points around centerIndex spanning `cycles` periods of `periodSamples`,
 * with start and end on rising zero crossings (each within half a period of nominal).
 * Among the candidates it keeps the pair with the smallest seam error.
 * Returns { start, end, error, aligned }.
 */
export function chooseLoopPoints(samples, sampleRate, centerIndex, periodSamples, cycles) {
  const P = periodSamples
  const L = cycles * P
  const nominalStart = Math.round(centerIndex - L / 2)
  const halfWin = Math.max(2, Math.round(sampleRate * 0.0004))
  const starts = findRisingZeroCrossings(samples, nominalStart - P / 2, nominalStart + P / 2 + 1)
  if (!starts.length) {
    const start = Math.max(0, nominalStart)
    const end = Math.min(samples.length, Math.round(start + L))
    return { start, end, error: seamError(samples, start, end, halfWin), aligned: false }
  }
  let best = null
  for (const s of starts) {
    const target = s + L
    const ends = findRisingZeroCrossings(samples, target - P / 2, target + P / 2 + 1)
    for (const e of ends) {
      const err = seamError(samples, s, e, halfWin)
      // Tiny tie-breakers: prefer exact length, then the start closest to nominal.
      const score = err + 0.02 * Math.abs(e - target) / P + 1e-4 * Math.abs(s - nominalStart) / P
      if (!best || score < best.score) best = { start: s, end: e, error: err, score }
    }
  }
  if (!best) {
    const s = starts.reduce((a, b) => (Math.abs(b - nominalStart) < Math.abs(a - nominalStart) ? b : a))
    const e = Math.min(samples.length, Math.round(s + L))
    return { start: s, end: e, error: seamError(samples, s, e, halfWin), aligned: false }
  }
  return { start: best.start, end: best.end, error: best.error, aligned: true }
}

/**
 * Copies samples[start, end) and equal-power crossfades the last `fadeLen` samples into
 * the audio that precedes `start`, so wrapping end → start continues seamlessly.
 */
export function crossfadeLoop(samples, start, end, fadeLen) {
  const out = samples.slice(start, end)
  const n = Math.min(Math.floor(fadeLen), start, out.length)
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n) * (Math.PI / 2)
    const k = out.length - n + i
    out[k] = out[k] * Math.cos(th) + samples[start - n + i] * Math.sin(th)
  }
  return out
}

/**
 * For each target rpm, the time where the curve crosses it (linear interpolation).
 * direction: 'up' (rising crossing), 'down' (falling) or 'any'. Optional fromS/toS window.
 * Returns [{ rpm, t | null }].
 */
export function targetRpmTimes(rpmCurve, targets, { direction = 'up', fromS = -Infinity, toS = Infinity } = {}) {
  const pts = rpmCurve.filter((p) => Number.isFinite(p.rpm) && p.t >= fromS && p.t <= toS)
  return targets.map((rpm) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      const up = a.rpm < rpm && b.rpm >= rpm
      const down = a.rpm > rpm && b.rpm <= rpm
      if ((direction === 'up' && up) || (direction === 'down' && down) || (direction === 'any' && (up || down))) {
        const t = a.t + ((rpm - a.rpm) / (b.rpm - a.rpm)) * (b.t - a.t)
        return { rpm, t }
      }
    }
    return { rpm, t: null }
  })
}

/** rpm targets that are multiples of step within [lo, hi]. */
export function rpmTargets(lo, hi, step) {
  const out = []
  if (!(step > 0)) return out
  for (let r = Math.ceil(lo / step) * step; r <= hi + 1e-9; r += step) out.push(r)
  return out
}

/** One gain for all loops so the loudest peak hits targetPeak (relative levels survive). */
export function commonGain(buffers, targetPeak = 0.891, maxGain = 32) {
  let peak = 0
  for (const b of buffers.flat()) for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs(b[i]))
  return peak > 0 ? Math.min(maxGain, targetPeak / peak) : 1
}

/** First/last time (s) the short-term RMS is within thresholdDb of the loudest window. */
export function detectActiveRange(samples, sampleRate, { thresholdDb = -35, windowS = 0.02 } = {}) {
  const W = Math.max(1, Math.round(windowS * sampleRate))
  const rms = []
  for (let off = 0; off + W <= samples.length; off += W) {
    let e = 0
    for (let j = 0; j < W; j++) e += samples[off + j] * samples[off + j]
    rms.push(Math.sqrt(e / W))
  }
  let peak = 0
  for (const r of rms) if (r > peak) peak = r
  if (!peak) return { start: 0, end: samples.length / sampleRate }
  const gate = peak * Math.pow(10, thresholdDb / 20)
  const first = rms.findIndex((r) => r >= gate)
  let last = rms.length - 1
  while (last > first && rms[last] < gate) last--
  return { start: (first * W) / sampleRate, end: Math.min(samples.length, (last + 1) * W) / sampleRate }
}
