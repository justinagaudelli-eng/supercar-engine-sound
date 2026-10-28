// Offline audio verification of the procedural flat-six (SPEC.md §8.2).
// Renders through the real engine (worklet + mixer + limiter) in headless Chromium with
// OfflineAudioContext (tests/audio/harness.html), then analyses in Node (analysis.js).
// Outputs: reports/audio-metrics.json, reports/spectrogram-*.png, reports/audio/*.wav.
//
// Definitions used by the assertions (also written into the metrics JSON):
// - Firing peak: strongest bin in [0.5, 1.5] × (rpm/20 Hz) of a Welch spectrum (32768-pt Hann,
//   1.46 Hz bins, parabolic interpolation) over the steady part; must be within ±3 % of rpm/20.
// - Dominance: "tonal peaks" are local maxima ≥ 10 dB above the median of the surrounding
//   ±60 Hz, in 20 Hz–8 kHz. The firing line must be within 3 dB of the strongest tonal peak
//   (it is in fact the strongest at full and light load — see `o3MinusStrongestDb`).
// - Clicks: analysis.detectClicks (3rd-difference residual vs local RMS, ratio 12). Each
//   scenario also injects synthetic steps to prove the detector would have caught a click
//   at the given level in that very signal.
// - On/off: RMS of full load (1.0) vs off-load (0.0) at the same rpm, ≥ 6 dB.

import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as A from './analysis.js'
import * as TL from './timelines.js'
import { writeSampleFixtures } from './fixtures.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORTS = join(ROOT, 'reports')
const METRICS = join(REPORTS, 'audio-metrics.json')
const HARNESS = 'http://localhost:5173/tests/audio/harness.html'
const SR = 48000
const RPMS = [900, 2000, 3500, 5000, 7000, 8500]
const CLICK = { method: 'hp', hpHz: 16000, ratio: 9, windowMs: 10 }
// Production renders also apply an audibility floor: a >16 kHz residual spike more than
// 40 dB below the simultaneous local peak (±10 ms) is masked (it's saturation of a loud,
// band-limited transient — e.g. a limiter blat through rasp + drive — not a discontinuity).
const PROD_MASK_DB = 40
// Linear diagnostic render: every noise source off and every nonlinear stage neutral (rasp
// clipper off, waveshaper drive 1, compressor/limiter ratio 1). What remains is the linear
// synthesis itself — crank phase, parameter smoothing, envelopes, cut/limiter logic, pipe
// combs, filters, crossfades — so any energy spike above 16 kHz is a genuine discontinuity.
// (Nonlinear stages are memoryless-smooth or native and are covered by the production render.)
const LINEAR_DIAG = {
  worklet: {
    pulse: { turbulence: 0, turbulenceOffLoad: 0 },
    intake: { noise: 0 },
    mech: { tick: { levelLo: 0, levelHi: 0 } },
    exhaust: { hollow: 0 },
    overrun: { noiseMix: 0 },
    cut: { blatNoise: 0 },
    starter: { whineNoise: 0 },
    rasp: { level: 0 },
  },
  mixer: {
    drive: { amount: 0 },
    compressor: { threshold: 0, ratio: 1, knee: 0 },
    limiter: { threshold: 0, ratio: 1, knee: 0 },
  },
}
const CEILING_DB = -1           // after the limiter at maximum volume

mkdirSync(join(REPORTS, 'audio'), { recursive: true })

function updateMetrics(section, data) {
  let m = {}
  if (existsSync(METRICS)) { try { m = JSON.parse(readFileSync(METRICS, 'utf8')) } catch { m = {} } }
  m.generatedAt = new Date().toISOString()
  m.sampleRate = SR
  m.definitions = {
    firingPeak: 'strongest bin in [0.5,1.5]×rpm/20 Hz, Welch 32768 Hann, parabolic interp; |err| ≤ 3%',
    dominance: 'tonal peak = local max ≥10 dB above ±60 Hz median, 20 Hz–8 kHz; firing line within 3 dB of strongest',
    clicks: 'residual r = 4th-order Butterworth HP @16 kHz (above the engine model content); flag |r| > 9 × local RMS(r) (±10 ms, ±8 sample guard) and > 1e-4 (production renders: and within 40 dB of the local ±10 ms peak — audibility floor); sensitivity = smallest injected step (dBFS) found 8/8. Production render: 0 flags and must catch a step at its own RMS level. Linear diagnostic render (noise off, rasp/drive/dynamics neutral): 0 flags and must catch ≤ −40 dBFS steps',
    centroid: 'magnitude-weighted spectral centroid 20 Hz–20 kHz',
    levels: 'rendered at volume 1.0 (maximum, = volume cap); Street preset unless noted. Stereo render; analyses use the mono sum (L+R)/2, peakDb is the per-channel peak',
  }
  m[section] = data
  writeFileSync(METRICS, JSON.stringify(m, null, 2))
}

let page
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  page.on('pageerror', (e) => console.error('[harness]', e.message))
  await page.goto(HARNESS)
  await page.waitForFunction(() => window.harnessReady === true)
})
test.afterAll(async () => { await page?.close() })

async function render(opts) {
  const r = await page.evaluate((o) => window.renderTimeline(o), { sampleRate: SR, ...opts })
  // x = mono sum (L+R)/2: all spectral/click analysis runs on what a mono speaker would get.
  // The clipping ceiling applies per channel: x.channelPeakDb carries the stereo peak.
  const x = A.decodeFloat32(r.data)
  x.channelPeakDb = r.channelPeakDb
  expect(A.hasNonFinite(x), 'rendered samples must be finite').toBe(false)
  return { ...r, x }
}

// Peak used for the ceiling checks: per-channel peak of the stereo render when available.
const stereoPeakDb = (x, start = 0) => +(x.channelPeakDb ?? A.peakDb(x, start)).toFixed(2)

/** Click scan (+ optional detector sensitivity via injected steps) for a rendered signal. */
function clickReport(x, startS = 0.05, { calibrate = true, maskDb = PROD_MASK_DB } = {}) {
  const start = Math.round(startS * SR)
  const opts = { ...CLICK, maskDb }
  const det = A.detectClicks(x, SR, { ...opts, start })
  let sensitivityDb = null
  if (calibrate) {
    for (const stepDb of [-66, -60, -54, -48, -42, -36, -30, -24, -18, -12]) {
      const c = A.calibrateClicks(x, SR, stepDb, { ...opts, start, count: 8 })
      if (c.found === c.injected) { sensitivityDb = stepDb; break }
    }
  }
  const md = A.maxDelta(x, start)
  return {
    clicks: det.flags.length,
    clickTimesS: det.flags.slice(0, 10).map((f) => +f.timeS.toFixed(4)),
    worstRatio: +det.worstRatio.toFixed(2),
    worstAtS: +det.worstTimeS.toFixed(4),
    detectorSensitivityDb: sensitivityDb,
    maxSampleDelta: +md.value.toFixed(5),
    peakDb: stereoPeakDb(x, start),
    monoPeakDb: +A.peakDb(x, start).toFixed(2),
    rmsDb: +A.rmsDb(x, start).toFixed(2),
  }
}

/**
 * Production render: no flags; the detector must at least catch a step at the signal's own
 * RMS level (smaller steps are masked by the synth's deliberate broadband texture — that is
 * what the linear diagnostic render is for). Diagnostic render: no flags, and steps of
 * −40 dBFS or smaller must be detectable.
 */
function expectClean(name, rep, { diagnostic = false } = {}) {
  expect(rep.clicks, `${name}: clicks at ${rep.clickTimesS.join(', ')} s`).toBe(0)
  const need = diagnostic ? -40 : rep.rmsDb
  expect(rep.detectorSensitivityDb, `${name}: detector sensitivity`).not.toBeNull()
  expect(rep.detectorSensitivityDb, `${name}: detector sensitivity`).toBeLessThanOrEqual(need)
  expect(rep.peakDb, `${name}: peak`).toBeLessThanOrEqual(CEILING_DB + 0.05)
}

function analyseSteady(x, rpm) {
  const sp = A.spectrum(x, SR, { start: SR, nfft: 32768 })
  const f0 = rpm / 20
  const pk = A.findPeak(sp, 0.5 * f0, 1.5 * f0)
  const tones = A.tonalPeaks(sp, { fLo: 20, fHi: 8000, prominenceDb: 10 })
  const strongest = tones[0]
  const line3 = A.lineLevel(sp, f0, 0.03)
  const orderOf = (f) => +(f / (rpm / 60)).toFixed(2)
  const orders = {}
  for (const o of [0.5, 1, 1.5, 3, 4.5, 6, 7.5, 9, 12, 15, 18]) {
    orders[o] = +(A.lineLevel(sp, o * rpm / 60, 0.01).db - line3.db).toFixed(1)
  }
  return {
    rpm,
    firingHz: f0,
    peakHz: +pk.freq.toFixed(2),
    errorPct: +(100 * (pk.freq / f0 - 1)).toFixed(3),
    o3Db: +line3.db.toFixed(2),
    strongestTonal: strongest ? { hz: +strongest.freq.toFixed(1), order: orderOf(strongest.freq), db: +strongest.db.toFixed(2) } : null,
    o3MinusStrongestDb: strongest ? +(line3.db - strongest.db).toFixed(2) : 0,
    topTonalOrders: tones.slice(0, 6).map((p) => orderOf(p.freq)),
    ordersRelO3Db: orders,
    centroidHz: Math.round(A.spectralCentroid(sp)),
    rmsDb: +A.rmsDb(x, SR).toFixed(2),
    peakDb: stereoPeakDb(x),
  }
}

test('fixed rpm: firing frequency, dominance, centroid, on/off level, ceiling', async () => {
  const loads = { full: 1, light: 0.2, off: 0 }
  const res = { full: [], light: [], off: [] }
  for (const [name, load] of Object.entries(loads)) {
    for (const rpm of RPMS) {
      const r = await render({ timeline: TL.constant(rpm, load, 2.5), duration: 2.5 })
      const a = analyseSteady(r.x, rpm)
      a.clicks = clickReport(r.x, 0.3, { calibrate: false })
      res[name].push(a)
      if (name === 'full') {
        A.writeSpectrogram(r.x, SR, join(REPORTS, `spectrogram-fixed-${rpm}.png`), { hop: 256 })
      }
    }
  }
  const onOff = RPMS.map((rpm, i) => ({
    rpm,
    fullRmsDb: res.full[i].rmsDb,
    lightRmsDb: res.light[i].rmsDb,
    offRmsDb: res.off[i].rmsDb,
    onMinusOffDb: +(res.full[i].rmsDb - res.off[i].rmsDb).toFixed(2),
    onMinusLightDb: +(res.full[i].rmsDb - res.light[i].rmsDb).toFixed(2),
  }))
  const mono = (arr) => arr.every((a, i) => i === 0 || a.centroidHz > arr[i - 1].centroidHz)
  updateMetrics('fixedRpm', {
    ...res,
    onOff,
    centroidMonotonic: { full: mono(res.full), light: mono(res.light), off: mono(res.off) },
  })

  for (const name of ['full', 'light']) {
    for (const a of res[name]) {
      expect(Math.abs(a.errorPct), `${name} ${a.rpm} rpm firing peak ${a.peakHz} Hz vs ${a.firingHz}`).toBeLessThanOrEqual(3)
      expect(a.o3MinusStrongestDb, `${name} ${a.rpm}: firing line vs strongest tonal peak`).toBeGreaterThanOrEqual(-3)
    }
    expect(mono(res[name]), `${name}-load centroid must rise with rpm: ${res[name].map((a) => a.centroidHz)}`).toBe(true)
  }
  for (const o of onOff) expect(o.onMinusOffDb, `${o.rpm} rpm on vs off`).toBeGreaterThanOrEqual(6)
  for (const name of Object.keys(res)) {
    for (const a of res[name]) {
      expect(a.peakDb, `${name} ${a.rpm} peak`).toBeLessThanOrEqual(CEILING_DB + 0.05)
      expect(a.clicks.clicks, `${name} ${a.rpm} clicks`).toBe(0)
    }
  }
})

// Firing-frequency tracking along a sweep: per STFT frame (8192 pt, ~170 ms), strongest peak
// in [0.5,1.5]×f0 vs the expected f0 at the frame centre.
function trackFiring(x, rpmAt, { from = 0.3, to = Infinity, minHz = 60 } = {}) {
  const nfft = 8192, hop = 2048
  let n = 0, ok = 0, worst = 0
  for (let s = Math.round(from * SR); s + nfft <= Math.min(x.length, to * SR); s += hop) {
    const f0 = rpmAt((s + nfft / 2) / SR) / 20
    if (f0 < minHz) continue
    const sp = A.spectrum(x, SR, { nfft, start: s, end: s + nfft })
    const pk = A.findPeak(sp, 0.5 * f0, 1.5 * f0)
    const err = Math.abs(pk.freq / f0 - 1)
    n++
    if (err <= 0.03) ok++
    worst = Math.max(worst, err)
  }
  return { frames: n, within3pct: n ? +(ok / n).toFixed(3) : 0, worstErrPct: +(100 * worst).toFixed(2) }
}

const SCENARIOS = {
  sweep: () => TL.sweep(),
  upshifts: () => TL.upshifts(),
  downshiftBlips: () => TL.downshiftBlips(),
  limiter: () => TL.limiter(),
  overrunPops: () => TL.overrun(),
  startStop: () => TL.startStop(),
}

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`scenario ${name}: no clicks, no clipping`, async () => {
    const { timeline, duration, rpmAt } = make()
    const r = await render({ timeline, duration })
    const rep = clickReport(r.x)
    rep.renderMs = Math.round(r.renderMs)
    rep.realtimeFactor = +(r.renderMs / 1000 / duration).toFixed(4)
    if (name === 'sweep') {
      rep.tracking = trackFiring(r.x, rpmAt, { to: 8 })
    }
    if (name === 'overrunPops') {
      // count pops as residual bursts in the off-load part (informational)
      rep.popsAfterLift = countPops(r.x, 1.25)
    }
    A.writeSpectrogram(r.x, SR, join(REPORTS, `spectrogram-${name === 'sweep' ? 'rpm-sweep' : name}.png`), {
      overlay: (t) => rpmAt(t) / 20,
    })
    writeFileSync(join(REPORTS, 'audio', `${name}.wav`), A.encodeWav16(r.x, SR))
    const diag = await render({ timeline, duration, config: LINEAR_DIAG })
    rep.linearDiagnostic = clickReport(diag.x, 0.05, { maskDb: null })
    updateMetrics(`scenario_${name}`, rep)
    expectClean(name, rep)
    expectClean(`${name} (linear diagnostic)`, rep.linearDiagnostic, { diagnostic: true })
    if (rep.tracking) expect(rep.tracking.within3pct, 'sweep firing tracking').toBeGreaterThanOrEqual(0.9)
  })
}

// Pops: 2 ms windows whose differentiated energy jumps > 9 dB above the ±24 ms median.
function countPops(x, fromS) {
  const w = 96, start = Math.round(fromS * SR)
  const e = []
  for (let s = start; s + w < x.length; s += w) {
    let a = 0
    for (let i = s + 1; i < s + w; i++) { const d = x[i] - x[i - 1]; a += d * d }
    e.push(a)
  }
  let pops = 0, last = -100
  for (let i = 12; i < e.length - 12; i++) {
    const nb = e.slice(i - 12, i + 12).sort((p, q) => p - q)[12]
    if (e[i] > 8 * nb && i - last > 10) { pops++; last = i }
  }
  return pops
}

test('presets: cabin darker than street, track brighter; all under the ceiling', async () => {
  const out = {}
  for (const preset of ['cabin', 'street', 'track']) {
    const r = await render({ timeline: TL.constant(6000, 1, 2), duration: 2, preset })
    const sp = A.spectrum(r.x, SR, { start: SR / 2, nfft: 32768 })
    out[preset] = { centroidHz: Math.round(A.spectralCentroid(sp)), rmsDb: +A.rmsDb(r.x, SR / 2).toFixed(2), peakDb: stereoPeakDb(r.x) }
    A.writeSpectrogram(r.x, SR, join(REPORTS, `spectrogram-preset-${preset}.png`), { hop: 256 })
  }
  updateMetrics('presets6000Full', out)
  expect(out.cabin.centroidHz).toBeLessThan(out.street.centroidHz)
  expect(out.track.centroidHz).toBeGreaterThan(out.street.centroidHz)
  for (const p of Object.values(out)) expect(p.peakDb).toBeLessThanOrEqual(CEILING_DB + 0.05)
})

test('sample layer: loads, pitches loops to rpm, crossfades and loops without clicks', async () => {
  const dir = join(ROOT, 'tests', 'audio', 'fixtures', 'samples')
  writeSampleFixtures(dir)
  const url = 'http://localhost:5173/tests/audio/fixtures/samples/manifest.json'

  // 1) pitch: at 3000 rpm (between the 2000 and 4000 loops) the firing line must be 150 Hz
  const steady = await render({ timeline: TL.constant(3000, 1, 2.5), duration: 2.5, mix: 1, samplesUrl: url })
  expect(steady.loaded.loaded, steady.loaded.error || 'samples should load').toBe(true)
  expect(steady.loaded.count).toBe(8)
  const st = analyseSteady(steady.x, 3000)

  // 2) loop points at exactly a loop's own rpm (rate 1) for several loop cycles
  const atLoop = await render({ timeline: TL.constant(4000, 1, 2.5), duration: 2.5, mix: 1, samplesUrl: url })
  const loopRep = clickReport(atLoop.x, 0.3, { maskDb: null })

  // 3) sweep with load toggling: rpm crossfades + on/off crossfades, samples only and 50/50
  const sw = TL.sampleSweep()
  const only = await render({ timeline: sw.timeline, duration: sw.duration, mix: 1, samplesUrl: url })
  const onlyRep = clickReport(only.x, 0.3, { maskDb: null })
  const half = await render({ timeline: sw.timeline, duration: sw.duration, mix: 0.5, samplesUrl: url })
  const halfRep = clickReport(half.x, 0.3)
  A.writeSpectrogram(only.x, SR, join(REPORTS, 'spectrogram-sample-layer-sweep.png'), { overlay: (t) => sw.rpmAt(t) / 20 })

  // 4) missing manifest → synth only, silently
  const missing = await render({ timeline: TL.constant(3000, 1, 1), duration: 1, mix: 1, samplesUrl: 'http://localhost:5173/tests/audio/fixtures/nope/manifest.json' })

  updateMetrics('sampleLayer', {
    steady3000: { peakHz: st.peakHz, errorPct: st.errorPct, peakDb: st.peakDb },
    loopPointsAt4000: loopRep,
    sweepSamplesOnly: onlyRep,
    sweepHalfMix: halfRep,
    missingManifest: { loaded: missing.loaded.loaded, rmsDb: +A.rmsDb(missing.x, SR / 2).toFixed(2) },
  })
  expect(Math.abs(st.errorPct)).toBeLessThanOrEqual(3)
  // samples only (mix = 1) contains no synth noise → hold it to the diagnostic standard
  expectClean('sample loop points', loopRep, { diagnostic: true })
  expectClean('sample sweep (samples only)', onlyRep, { diagnostic: true })
  expectClean('sample sweep (50/50)', halfRep)
  expect(missing.loaded.loaded).toBe(false)
  expect(A.rmsDb(missing.x, SR / 2), 'missing manifest must leave the synth playing').toBeGreaterThan(-40)
})

test('determinism and render speed', async () => {
  const a = await render({ timeline: TL.constant(4000, 0.7, 1), duration: 1, seed: 7 })
  const b = await render({ timeline: TL.constant(4000, 0.7, 1), duration: 1, seed: 7 })
  // Chromium's native nodes are not bit-exact across renders (~1e-7 float noise), so
  // "deterministic" = same length and max difference below −100 dBFS.
  let maxDiff = a.x.length === b.x.length ? 0 : Infinity
  for (let i = 0; i < a.x.length && maxDiff < Infinity; i++) maxDiff = Math.max(maxDiff, Math.abs(a.x[i] - b.x[i]))
  const identical = maxDiff < 1e-5

  // 10 s of busy material (full-load gear pulls), whole graph incl. compressor/limiter.
  const up = TL.upshifts({ duration: 9.7 })
  const runs = []
  for (let i = 0; i < 3; i++) runs.push((await render({ timeline: up.timeline, duration: 10 })).renderMs)
  const best = Math.min(...runs)
  const synthRuns = []
  for (let i = 0; i < 3; i++) synthRuns.push((await page.evaluate(() => window.renderWorkletOnly({ duration: 10 }))).renderMs)
  const synthBest = Math.min(...synthRuns)
  const perf = {
    audioSeconds: 10,
    renderMsRuns: runs.map(Math.round),
    renderSecondsBest: +(best / 1000).toFixed(3),
    realtimeFactor: +(best / 10000).toFixed(4),
    cpuPercentOfOneCore: +(best / 100).toFixed(2),
    synthOnlyRealtimeFactor: +(synthBest / 10000).toFixed(4),
    synthOnlyCpuPercentOfOneCore: +(synthBest / 100).toFixed(2),
    note: 'Offline render on the test machine (headless Chromium); full graph, not just the worklet. The Tesla CPU is slower: budget is <15% of a core.',
  }
  updateMetrics('performance', { ...perf, deterministic: identical, sameSeedMaxDiffDb: +A.db(maxDiff).toFixed(1) })
  expect(identical, 'same seed → identical render (within −100 dBFS)').toBe(true)
  expect(best).toBeLessThan(10000 * 0.15)
  expect(synthBest).toBeLessThan(10000 * 0.15)
})
