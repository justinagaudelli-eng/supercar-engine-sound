// Offline audio analysis helpers (Node). No dependencies except pngjs for spectrograms.

import { PNG } from 'pngjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))

export function decodeFloat32(base64) {
  const buf = Buffer.from(base64, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/** In-place iterative radix-2 FFT. re/im: Float64Array of power-of-two length. */
export function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const hannCache = new Map()
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float64Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)
    hannCache.set(n, w)
  }
  return hannCache.get(n)
}

/**
 * Welch-averaged amplitude spectrum (Hann, 50% overlap) of x[start, end).
 * Returned magnitudes are scaled so a full-scale sine reads ≈ 1.0 (0 dB).
 */
export function spectrum(x, sampleRate, { nfft = 32768, start = 0, end = x.length } = {}) {
  const w = hann(nfft)
  let wsum = 0
  for (let i = 0; i < nfft; i++) wsum += w[i]
  const pow = new Float64Array(nfft / 2)
  const re = new Float64Array(nfft), im = new Float64Array(nfft)
  let frames = 0
  for (let s = start; s + nfft <= end; s += nfft / 2) {
    for (let i = 0; i < nfft; i++) { re[i] = x[s + i] * w[i]; im[i] = 0 }
    fft(re, im)
    for (let k = 0; k < nfft / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k]
    frames++
  }
  if (frames === 0) throw new Error(`spectrum: segment shorter than nfft (${end - start} < ${nfft})`)
  const mag = new Float64Array(nfft / 2)
  for (let k = 0; k < nfft / 2; k++) mag[k] = 2 * Math.sqrt(pow[k] / frames) / wsum
  return { mag, binHz: sampleRate / nfft, nfft, frames }
}

/** Parabolic interpolation of a peak at bin k (on dB values). */
function interpPeak(mag, k, binHz) {
  if (k <= 0 || k >= mag.length - 1) return { freq: k * binHz, db: db(mag[k]) }
  const a = db(mag[k - 1]), b = db(mag[k]), c = db(mag[k + 1])
  const den = a - 2 * b + c
  const p = den === 0 ? 0 : 0.5 * (a - c) / den
  return { freq: (k + p) * binHz, db: b - 0.25 * (a - c) * p }
}

/** Strongest bin in [fLo, fHi], interpolated. */
export function findPeak(spec, fLo, fHi) {
  const { mag, binHz } = spec
  const k0 = Math.max(1, Math.floor(fLo / binHz)), k1 = Math.min(mag.length - 2, Math.ceil(fHi / binHz))
  let best = k0
  for (let k = k0; k <= k1; k++) if (mag[k] > mag[best]) best = k
  return interpPeak(mag, best, binHz)
}

/** Level (dB, max bin) of the line nearest `freq` within ±tolFrac. */
export function lineLevel(spec, freq, tolFrac = 0.03) {
  return findPeak(spec, freq * (1 - tolFrac), freq * (1 + tolFrac))
}

/**
 * Tonal peaks: local maxima that stand at least `prominenceDb` above the median level of
 * the surrounding ±`floorHz` (the noise floor), within [fLo, fHi].
 */
export function tonalPeaks(spec, { fLo = 20, fHi = 8000, prominenceDb = 10, floorHz = 60 } = {}) {
  const { mag, binHz } = spec
  const k0 = Math.max(2, Math.floor(fLo / binHz)), k1 = Math.min(mag.length - 3, Math.ceil(fHi / binHz))
  const half = Math.max(4, Math.round(floorHz / binHz))
  const peaks = []
  for (let k = k0; k <= k1; k++) {
    if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2])) continue
    const win = []
    for (let j = Math.max(1, k - half); j <= Math.min(mag.length - 1, k + half); j += 1) win.push(mag[j])
    win.sort((a, b) => a - b)
    const floor = win[win.length >> 1]
    const prom = db(mag[k]) - db(floor)
    if (prom >= prominenceDb) peaks.push({ ...interpPeak(mag, k, binHz), prominence: prom })
  }
  return peaks.sort((a, b) => b.db - a.db)
}

/** Magnitude-weighted spectral centroid (Hz) between fLo and fHi. */
export function spectralCentroid(spec, fLo = 20, fHi = 20000) {
  const { mag, binHz } = spec
  let num = 0, den = 0
  for (let k = Math.ceil(fLo / binHz); k < Math.min(mag.length, fHi / binHz); k++) {
    num += k * binHz * mag[k]; den += mag[k]
  }
  return den > 0 ? num / den : 0
}

export function peakDb(x, start = 0, end = x.length) {
  let p = 0
  for (let i = start; i < end; i++) { const a = Math.abs(x[i]); if (a > p) p = a }
  return db(p)
}

export function rmsDb(x, start = 0, end = x.length) {
  let s = 0
  for (let i = start; i < end; i++) s += x[i] * x[i]
  return db(Math.sqrt(s / Math.max(1, end - start)))
}

export function hasNonFinite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return true
  return false
}

export function maxDelta(x, start = 1, end = x.length) {
  let m = 0, at = start
  for (let i = Math.max(1, start); i < end; i++) {
    const d = Math.abs(x[i] - x[i - 1])
    if (d > m) { m = d; at = i }
  }
  return { value: m, index: at }
}

/** In-place RBJ biquad high-pass. */
function highpassBiquad(x, sampleRate, hz, q) {
  const w = 2 * Math.PI * hz / sampleRate
  const alpha = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + alpha
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = v; y2 = y1; y1 = y
    x[i] = y
  }
  return x
}

/** 4th-order Butterworth high-pass residual of x[start, end). */
export function hpResidual(x, sampleRate, { hpHz = 12000, start = 0, end = x.length } = {}) {
  const r = new Float64Array(end - start)
  for (let i = 0; i < r.length; i++) r[i] = x[start + i]
  highpassBiquad(r, sampleRate, hpHz, 0.5412)
  highpassBiquad(r, sampleRate, hpHz, 1.3066)
  return r
}

/** Levinson-Durbin: autocorrelation r[0..p] → predictor a[1..p] (x̂[n] = −Σ a[k] x[n−k]). */
function levinson(r, p, a, tmp) {
  a.fill(0); a[0] = 1
  let err = r[0]
  if (err <= 0) return 0
  for (let i = 1; i <= p; i++) {
    let acc = r[i]
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
    const k = -acc / err
    for (let j = 0; j <= i; j++) tmp[j] = a[j]
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j]
    a[i] = k
    err *= 1 - k * k
    if (err <= 0) break
  }
  return err
}

/**
 * Linear-prediction residual: blockwise LPC (order `order`, Hann-windowed autocorrelation
 * over `block` samples, ridge 1e-9) applied to the samples of each hop. Band-limited engine
 * content (harmonics, filtered noise) is largely predictable; a step/click is not, and
 * appears in the residual with its full height h at the step sample.
 */
export function lpcResidual(x, { order = 32, block = 2048, hop = 512, start = 0, end = x.length } = {}) {
  const n = end - start
  const e = new Float64Array(n)
  const w = hann(block)
  const seg = new Float64Array(block)
  const r = new Float64Array(order + 1)
  const a = new Float64Array(order + 1), tmp = new Float64Array(order + 1)
  for (let h0 = 0; h0 < n; h0 += hop) {
    // analysis window centred on this hop
    const c = start + h0 + hop / 2 - block / 2
    for (let i = 0; i < block; i++) {
      const j = c + i
      seg[i] = j >= 0 && j < x.length ? x[j] * w[i] : 0
    }
    for (let k = 0; k <= order; k++) {
      let s = 0
      for (let i = k; i < block; i++) s += seg[i] * seg[i - k]
      r[k] = s
    }
    r[0] = r[0] * (1 + 1e-9) + 1e-20
    levinson(r, order, a, tmp)
    for (let i = h0; i < Math.min(n, h0 + hop); i++) {
      const j = start + i
      let v = x[j]
      for (let k = 1; k <= order; k++) v += a[k] * (j - k >= 0 ? x[j - k] : 0)
      e[i] = v
    }
  }
  return e
}

/**
 * Click / discontinuity detector. (Default residual: HP @16 kHz — see `method`; optional
 * `maskDb` audibility floor relative to the local ±windowMs peak.)
 *
 * Residual: the linear-prediction error of the signal (lpcResidual) — the standard click
 * detector in audio restoration (Vaseghi & Rayner; Godsill & Rayner). The threshold is
 * relative to the signal's own unpredictable (HF/noise) content: a sample is flagged when
 * |e[n]| > ratio × RMS(e) over ±windowMs (excluding ±guard samples so a click doesn't raise
 * its own baseline) and |e| > floor (ignores near-silence). For noise-like residuals ratio 12
 * is a >12σ event, which band-limited audio does not produce in millions of samples. A pop
 * (an enveloped 5–15 ms noise burst through the exhaust model) raises the local residual RMS
 * with its peaks, so it is not a "click", whereas a sample-level step is.
 * calibrateClicks() injects steps into each rendered signal to prove the sensitivity there,
 * and maxDelta (largest |x[n] − x[n−1]|) is reported alongside.
 */
export function detectClicks(x, sampleRate, { ratio = 12, windowMs = 10, guard = 8, floor = 1e-4, start = 0, end = x.length, method = 'hp', hpHz = 16000, maskDb = null } = {}) {
  const n = end - start
  const r = method === 'hp' ? hpResidual(x, sampleRate, { hpHz, start, end }) : lpcResidual(x, { start, end })
  const skip = 64
  const cum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + r[i] * r[i]
  const W = Math.round(windowMs * sampleRate / 1000)
  const flags = []
  let worst = { ratio: 0, index: start }
  for (let i = skip; i < n; i++) {
    const v = Math.abs(r[i])
    if (v <= floor) continue
    const a = Math.max(skip, i - W), b = Math.min(n, i + W)
    const ga = Math.max(a, i - guard), gb = Math.min(b, i + guard + 1)
    const e = (cum[b] - cum[a]) - (cum[gb] - cum[ga])
    const cnt = (b - a) - (gb - ga)
    const rms = Math.sqrt(e / Math.max(1, cnt))
    if (maskDb !== null) {
      // audibility floor: ignore residual spikes more than maskDb below the local signal peak
      let pk = 0
      for (let j = Math.max(start, start + i - W); j < Math.min(end, start + i + W); j++) { const m = Math.abs(x[j]); if (m > pk) pk = m }
      if (v < pk * Math.pow(10, -maskDb / 20)) continue
    }
    const q = v / Math.max(rms, 1e-12)
    if (q > worst.ratio) worst = { ratio: q, index: start + i }
    if (q > ratio && (flags.length === 0 || start + i - flags[flags.length - 1].index > W)) {
      flags.push({ index: start + i, timeS: (start + i) / sampleRate, ratio: q, residual: v })
    }
  }
  return { flags, worstRatio: worst.ratio, worstTimeS: worst.index / sampleRate }
}

/**
 * Sensitivity check: inject steps of height `stepDb` (dBFS) at `count` evenly spaced
 * positions into a copy of x and report how many the detector finds.
 */
export function calibrateClicks(x, sampleRate, stepDb, { count = 8, start = 0, end = x.length, ...opts } = {}) {
  const y = Float32Array.from(x)
  const h = Math.pow(10, stepDb / 20)
  const pos = []
  for (let k = 0; k < count; k++) {
    const p = Math.round(start + (k + 0.5) * (end - start) / count)
    pos.push(p)
    for (let i = p; i < end; i++) y[i] += (k % 2 ? -h : h) * 1     // a DC step from p on…
    // …(alternate signs so the steps don't accumulate into a big offset)
  }
  const { flags } = detectClicks(y, sampleRate, { start, end, ...opts })
  const W = Math.round(0.002 * sampleRate)
  const found = pos.filter((p) => flags.some((f) => Math.abs(f.index - p) < W)).length
  return { injected: count, found }
}

// ---------- spectrogram PNG ----------

// Perceptual-ish dark→bright colour map (black, purple, red, orange, yellow, white).
const STOPS = [[0, 0, 0], [40, 10, 90], [140, 20, 110], [220, 60, 50], [250, 160, 30], [255, 240, 150], [255, 255, 255]]
function colour(t) {
  t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i
  return STOPS[i].map((c, j) => Math.round(c + (STOPS[i + 1][j] - c) * f))
}

/**
 * Write a log-frequency spectrogram PNG. Returns { width, height }.
 * Optional `overlay`: function(timeS) → expected firing frequency (Hz), drawn as dots.
 */
export function writeSpectrogram(x, sampleRate, file, {
  nfft = 4096, hop = 512, fMin = 20, fMax = 12000, height = 480, dbMin = -100, dbMax = -15, overlay = null,
} = {}) {
  const frames = Math.max(1, Math.floor((x.length - nfft) / hop) + 1)
  const width = frames
  const png = new PNG({ width, height })
  const w = hann(nfft)
  let wsum = 0
  for (let i = 0; i < nfft; i++) wsum += w[i]
  const re = new Float64Array(nfft), im = new Float64Array(nfft)
  const binHz = sampleRate / nfft
  const lmin = Math.log(fMin), lmax = Math.log(fMax)
  for (let f = 0; f < frames; f++) {
    const s = f * hop
    for (let i = 0; i < nfft; i++) { re[i] = x[s + i] * w[i]; im[i] = 0 }
    fft(re, im)
    for (let y = 0; y < height; y++) {
      // rows: top = fMax; each row covers a log-frequency band, take max bin in it
      const fa = Math.exp(lmin + (lmax - lmin) * (height - 1 - y) / height)
      const fb = Math.exp(lmin + (lmax - lmin) * (height - y) / height)
      let k0 = Math.floor(fa / binHz), k1 = Math.max(k0, Math.floor(fb / binHz))
      let m = 0
      for (let k = k0; k <= k1 && k < nfft / 2; k++) m = Math.max(m, re[k] * re[k] + im[k] * im[k])
      const v = (db(2 * Math.sqrt(m) / wsum) - dbMin) / (dbMax - dbMin)
      const [r, g, b] = colour(v)
      const o = (y * width + f) * 4
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255
    }
    if (overlay && f % 4 === 0) {
      const ef = overlay((s + nfft / 2) / sampleRate)
      if (ef > fMin && ef < fMax) {
        const y = Math.round(height - 1 - (Math.log(ef) - lmin) / (lmax - lmin) * height)
        if (y >= 0 && y < height) {
          const o = (y * width + f) * 4
          png.data[o] = 0; png.data[o + 1] = 255; png.data[o + 2] = 255
        }
      }
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, PNG.sync.write(png))
  return { width, height }
}

// ---------- WAV (for fixtures / listening) ----------

export function encodeWav16(samples, sampleRate) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}
