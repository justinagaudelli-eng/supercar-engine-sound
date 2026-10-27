// Pitch tracking for rev-sweep recordings. A flat-six fires 3 times per revolution, so the
// firing frequency (engine order 3) is f = rpm / 20. The tracker runs YIN on a low-passed,
// decimated copy, then folds octave errors and median-filters the result.

export const FIRING_ORDER = 3

export const rpmFromFreq = (f, order = FIRING_ORDER) => (f * 60) / order
export const freqFromRpm = (rpm, order = FIRING_ORDER) => (rpm * order) / 60

// ---------- filtering ----------

function biquadLowpass(x, sampleRate, cutoff, q) {
  const w = (2 * Math.PI * cutoff) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0
  const b1 = (1 - cos) / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = xi; y2 = y1; y1 = yi
    y[i] = yi
  }
  return y
}

/** 4th-order Butterworth low-pass, then keep every `factor`-th sample. */
export function lowpassDecimate(samples, sampleRate, { cutoffHz = 1500, targetRate = 8000 } = {}) {
  const factor = Math.max(1, Math.floor(sampleRate / targetRate))
  const rate = sampleRate / factor
  const cutoff = Math.min(cutoffHz, rate * 0.4)
  let y = biquadLowpass(samples, sampleRate, cutoff, 0.5412)
  y = biquadLowpass(y, sampleRate, cutoff, 1.3066)
  if (factor === 1) return { data: y, rate, factor }
  const out = new Float32Array(Math.floor(y.length / factor))
  for (let i = 0; i < out.length; i++) out[i] = y[i * factor]
  return { data: out, rate, factor }
}

// ---------- YIN ----------

/**
 * One YIN analysis at x[offset .. offset + W + tauMax).
 * Returns { tau (fractional samples) | null, aperiodicity (0 = perfectly periodic) }.
 */
export function yinFrame(x, offset, W, tauMin, tauMax, threshold = 0.15, scratch) {
  const d = scratch && scratch.length > tauMax ? scratch : new Float64Array(tauMax + 2)
  d[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0
    for (let j = 0; j < W; j++) {
      const diff = x[offset + j] - x[offset + j + tau]
      sum += diff * diff
    }
    running += sum
    d[tau] = running > 0 ? (sum * tau) / running : 1   // cumulative mean normalized difference
  }
  let best = -1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++
      best = tau
      break
    }
  }
  if (best < 0) {
    // No dip under the threshold: take the global minimum, flagged by its aperiodicity.
    let min = Infinity
    for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < min) { min = d[tau]; best = tau }
  }
  if (best < 0) return { tau: null, aperiodicity: 1 }
  return { tau: best + parabolicOffset(d[best - 1], d[best], d[best + 1]), aperiodicity: d[best] }
}

function parabolicOffset(a, b, c) {
  const den = a - 2 * b + c
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return 0
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
}

/**
 * Pitch track of `samples` (already low-passed/decimated or not).
 * Returns [{ t (s, frame centre), f0 (Hz) | null, aperiodicity, rms }].
 */
export function trackPitch(samples, sampleRate, opts = {}) {
  const {
    minHz = 35, maxHz = 550, hopS = 0.01, threshold = 0.15, maxAperiodicity = 0.4,
    silenceDb = -45, startS = 0, endS = samples.length / sampleRate,
  } = opts
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const tauMax = Math.ceil(sampleRate / minHz)
  const W = Math.ceil(sampleRate * 2 / minHz)
  const hop = Math.max(1, Math.round(hopS * sampleRate))
  const scratch = new Float64Array(tauMax + 2)
  const first = Math.max(0, Math.floor(startS * sampleRate))
  const last = Math.min(samples.length, Math.ceil(endS * sampleRate)) - W - tauMax - 2

  let peakRms = 0
  const frames = []
  for (let off = first; off <= last; off += hop) {
    let e = 0
    for (let j = 0; j < W; j++) e += samples[off + j] * samples[off + j]
    const rms = Math.sqrt(e / W)
    peakRms = Math.max(peakRms, rms)
    const r = yinFrame(samples, off, W, tauMin, tauMax, threshold, scratch)
    const f0 = r.tau && r.aperiodicity <= maxAperiodicity ? sampleRate / r.tau : null
    frames.push({ t: (off + W / 2) / sampleRate, f0, aperiodicity: r.aperiodicity, rms })
  }
  const gate = peakRms * Math.pow(10, silenceDb / 20)
  for (const f of frames) if (f.rms < gate) f.f0 = null
  return frames
}

/** Folds single-octave jumps onto the local median, then median-filters. Returns new frames. */
export function cleanTrack(frames, { octaveWindow = 25, medianWindow = 5 } = {}) {
  const logs = frames.map((f) => (f.f0 ? Math.log2(f.f0) : null))
  const folded = logs.map((v, i) => {
    if (v == null) return null
    const ref = median(window(logs, i, octaveWindow))
    if (ref == null) return v
    const diff = v - ref
    if (Math.abs(diff - 1) < 0.2) return v - 1
    if (Math.abs(diff + 1) < 0.2) return v + 1
    return v
  })
  return frames.map((f, i) => {
    if (folded[i] == null) return { ...f, f0: null }
    const m = median(window(folded, i, medianWindow))
    return { ...f, f0: Math.pow(2, m) }
  })
}

function window(arr, i, size) {
  const h = Math.floor(size / 2)
  const out = []
  for (let k = Math.max(0, i - h); k <= Math.min(arr.length - 1, i + h); k++) {
    if (arr[k] != null) out.push(arr[k])
  }
  return out
}

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Full pipeline: low-pass + decimate, YIN, clean, convert to rpm.
 * `order` = which engine order the detected pitch is (3 = firing frequency; use 1.5 if the
 * recording's fundamental is half the firing frequency, 6 if double).
 * Returns [{ t, rpm | null, confidence (0..1) }].
 */
export function estimateRpmCurve(samples, sampleRate, opts = {}) {
  const { minRpm = 700, maxRpm = 10000, order = FIRING_ORDER, hopS = 0.01, startS, endS } = opts
  const { data, rate } = lowpassDecimate(samples, sampleRate, {
    cutoffHz: Math.max(400, freqFromRpm(maxRpm, FIRING_ORDER) * 2.5),
  })
  const raw = trackPitch(data, rate, {
    minHz: freqFromRpm(minRpm, FIRING_ORDER), maxHz: freqFromRpm(maxRpm, FIRING_ORDER) * 1.1,
    hopS, startS, endS,
  })
  return cleanTrack(raw).map((f) => ({
    t: f.t,
    rpm: f.f0 ? rpmFromFreq(f.f0, order) : null,
    confidence: Math.max(0, 1 - f.aperiodicity),
  }))
}

/** Linear rpm curve for manual mode: startRpm at startS to endRpm at endS. */
export function linearRpmCurve(startS, endS, startRpm, endRpm, stepS = 0.01) {
  const out = []
  const n = Math.max(1, Math.round((endS - startS) / stepS))
  for (let i = 0; i <= n; i++) {
    const a = i / n
    out.push({ t: startS + (endS - startS) * a, rpm: startRpm + (endRpm - startRpm) * a, confidence: 1 })
  }
  return out
}

/** Fills null rpm gaps by linear interpolation (edges held). Drops leading/trailing nulls. */
export function fillCurveGaps(curve) {
  const pts = curve.filter((p) => Number.isFinite(p.rpm))
  if (pts.length < 2) return pts
  const t0 = pts[0].t
  const t1 = pts[pts.length - 1].t
  const out = []
  let k = 0
  for (const p of curve) {
    if (p.t < t0 || p.t > t1) continue
    if (Number.isFinite(p.rpm)) { out.push({ t: p.t, rpm: p.rpm }); continue }
    while (k < pts.length - 2 && pts[k + 1].t < p.t) k++
    const a = pts[k], b = pts[k + 1]
    out.push({ t: p.t, rpm: a.rpm + ((b.rpm - a.rpm) * (p.t - a.t)) / (b.t - a.t) })
  }
  return out
}

/** Best local period (fractional samples) near approxPeriod, via normalized difference. */
export function refinePeriod(samples, centerIndex, approxPeriod, { range = 0.1, cycles = 4 } = {}) {
  const tauLo = Math.max(2, Math.floor(approxPeriod * (1 - range)))
  const tauHi = Math.ceil(approxPeriod * (1 + range))
  const W = Math.round(approxPeriod * cycles)
  const start = Math.max(0, Math.min(samples.length - W - tauHi - 2, Math.round(centerIndex - (W + tauHi) / 2)))
  if (start < 0) return approxPeriod
  const score = new Float64Array(tauHi + 2).fill(Infinity)
  for (let tau = tauLo - 1; tau <= tauHi + 1; tau++) {
    let num = 0, den = 0
    for (let j = 0; j < W; j++) {
      const a = samples[start + j], b = samples[start + j + tau]
      num += (a - b) * (a - b)
      den += a * a + b * b
    }
    score[tau] = den > 0 ? num / den : Infinity
  }
  let best = tauLo
  for (let tau = tauLo; tau <= tauHi; tau++) if (score[tau] < score[best]) best = tau
  return best + parabolicOffset(score[best - 1], score[best], score[best + 1])
}

// ---------- pitch flattening ----------

/**
 * Engine phase (in firing cycles, f = rpm/20) as a function of time, from an rpm curve.
 * Returns { phaseAt(t), timeAtPhase(p) }, both extrapolating linearly past the ends.
 */
export function createPhaseMap(curve) {
  const pts = fillCurveGaps(curve)
  if (pts.length < 2) throw new Error('rpm curve needs at least two points')
  const ts = pts.map((p) => p.t)
  const fs = pts.map((p) => freqFromRpm(p.rpm))
  const ph = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) ph[i] = ph[i - 1] + ((fs[i] + fs[i - 1]) / 2) * (ts[i] - ts[i - 1])
  const n = pts.length

  function phaseAt(t) {
    if (t <= ts[0]) return (t - ts[0]) * fs[0]
    if (t >= ts[n - 1]) return ph[n - 1] + (t - ts[n - 1]) * fs[n - 1]
    const i = upperBound(ts, t)
    const dt = t - ts[i - 1]
    const span = ts[i] - ts[i - 1]
    const fAt = fs[i - 1] + ((fs[i] - fs[i - 1]) * dt) / span
    return ph[i - 1] + ((fs[i - 1] + fAt) / 2) * dt
  }

  function timeAtPhase(p) {
    if (p <= 0) return ts[0] + p / fs[0]
    if (p >= ph[n - 1]) return ts[n - 1] + (p - ph[n - 1]) / fs[n - 1]
    const i = upperBound(ph, p)
    // Solve the quadratic segment: p - ph0 = f0*dt + 0.5*k*dt^2, k = df/dt.
    const f0 = fs[i - 1]
    const k = (fs[i] - fs[i - 1]) / (ts[i] - ts[i - 1])
    const dp = p - ph[i - 1]
    const dt = Math.abs(k) < 1e-9 ? dp / f0 : (-f0 + Math.sqrt(Math.max(0, f0 * f0 + 2 * k * dp))) / k
    return ts[i - 1] + dt
  }

  return { phaseAt, timeAtPhase }
}

function upperBound(arr, x) {
  let lo = 1, hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Resamples a stretch of audio around tCenter so its pitch is constant at targetRpm
 * (output sample rate = input). Output index `length/2` corresponds to tCenter.
 */
export function warpToConstantPitch(channels, sampleRate, phaseMap, tCenter, targetRpm, length) {
  const f = freqFromRpm(targetRpm)
  const p0 = phaseMap.phaseAt(tCenter)
  const half = length / 2
  return channels.map((src) => {
    const out = new Float32Array(length)
    for (let n = 0; n < length; n++) {
      const t = phaseMap.timeAtPhase(p0 + ((n - half) * f) / sampleRate)
      out[n] = hermite(src, t * sampleRate)
    }
    return out
  })
}

function hermite(x, pos) {
  const i = Math.floor(pos)
  const fr = pos - i
  const at = (k) => (k < 0 || k >= x.length ? 0 : x[k])
  const xm1 = at(i - 1), x0 = at(i), x1 = at(i + 1), x2 = at(i + 2)
  const c1 = 0.5 * (x1 - xm1)
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
  return ((c3 * fr + c2) * fr + c1) * fr + x0
}
