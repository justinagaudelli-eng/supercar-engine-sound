// Offline audio for every replay fixture, driven by the REAL pipeline (replay → GPS fix
// processor → Kalman bus → rpm model, incl. startup), rendered through the real engine.
// Asserts: finite, no clipping (≤ −1 dBFS), no clicks across shifts/blips/pops, and the firing
// line tracks rpm/20 within ±3 % wherever rpm is steady. Spectrograms → reports/.
import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as A from './analysis.js'
import { traceToTimeline } from '../../src/pipeline.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORTS = join(ROOT, 'reports')
const METRICS = join(REPORTS, 'replay-metrics.json')
const HARNESS = 'http://localhost:5173/tests/audio/harness.html'
const SR = 48000
const FPS = 100
const CEILING_DB = -1
const CLICK = { method: 'hp', hpHz: 16000, ratio: 9, windowMs: 10, maskDb: 40 } // same as engine.spec.js
const index = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'index.json'), 'utf8'))

mkdirSync(REPORTS, { recursive: true })

let page
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  page.on('pageerror', (e) => console.error('[harness]', e.message))
  await page.goto(HARNESS)
  await page.waitForFunction(() => window.harnessReady === true)
})
test.afterAll(async () => { await page?.close() })

function saveMetrics(name, data) {
  let m = {}
  if (existsSync(METRICS)) { try { m = JSON.parse(readFileSync(METRICS, 'utf8')) } catch { m = {} } }
  m.generatedAt = new Date().toISOString()
  m[name] = data
  writeFileSync(METRICS, JSON.stringify(m, null, 2))
}

/** Firing-line tracking over windows where rpm holds within ±1.5 % and no shift happens. */
function trackSteady(x, timeline) {
  const nfft = 32768, winS = nfft / SR
  const rpmAt = (t) => timeline[Math.min(timeline.length - 1, Math.max(0, Math.round(t * FPS)))].frame
  let windows = 0, ok = 0
  const misses = []
  for (let t0 = 3.2; t0 + winS < timeline.at(-1).t; t0 += winS / 2) {
    const fr = []
    for (let t = t0; t < t0 + winS; t += 0.02) fr.push(rpmAt(t))
    const rpms = fr.map((f) => f.rpm)
    const mean = rpms.reduce((a, b) => a + b, 0) / rpms.length
    const steady = Math.max(...rpms) <= mean * 1.015 && Math.min(...rpms) >= mean * 0.985 &&
      fr.every((f) => !f.shifting && f.cut === 0 && f.engineState === 'running')
    if (!steady) continue
    windows++
    const sp = A.spectrum(x, SR, { start: Math.round(t0 * SR), end: Math.round(t0 * SR) + nfft, nfft })
    const f0 = mean / 20
    const pk = A.findPeak(sp, 0.5 * f0, 1.5 * f0)
    const err = pk.freq / f0 - 1
    if (Math.abs(err) <= 0.03) ok++
    else misses.push({ t: +t0.toFixed(2), rpm: Math.round(mean), peakHz: +pk.freq.toFixed(1), expectHz: +f0.toFixed(1) })
  }
  return { windows, within3pct: windows ? ok / windows : 1, misses: misses.slice(0, 5) }
}

for (const { name, file } of index) {
  test(`replay fixture ${name}: clean, unclipped, firing tracks rpm`, async () => {
    const trace = JSON.parse(readFileSync(join(ROOT, 'fixtures', file), 'utf8'))
    const full = traceToTimeline(trace, { fps: FPS, withStartup: true, tailS: 1 })
    const timeline = full.map(({ t, frame }) => ({ t, frame }))
    const duration = timeline.at(-1).t + 0.2
    const r = await page.evaluate((o) => window.renderTimeline(o), { timeline, duration, sampleRate: SR })
    const x = A.decodeFloat32(r.data)
    expect(A.hasNonFinite(x), `${name}: finite samples`).toBe(false)

    const start = Math.round(0.05 * SR)
    const clicks = A.detectClicks(x, SR, { ...CLICK, start })
    const tracking = trackSteady(x, timeline)
    const shifts = full.flatMap((f) => f.frame.events).filter((e) => e.type === 'upshift' || e.type === 'downshift').length
    const report = {
      durationS: +duration.toFixed(2),
      renderMs: Math.round(r.renderMs),
      realtimeFactor: +(r.renderMs / 1000 / duration).toFixed(4),
      peakDb: +A.peakDb(x, start).toFixed(2),
      rmsDb: +A.rmsDb(x, start).toFixed(2),
      clicks: clicks.flags.length,
      clickTimesS: clicks.flags.slice(0, 10).map((f) => +f.timeS.toFixed(3)),
      shifts,
      maxRpm: Math.round(Math.max(...timeline.map((f) => f.frame.rpm))),
      tracking,
    }
    saveMetrics(name, report)
    A.writeSpectrogram(x, SR, join(REPORTS, `spectrogram-replay-${name}.png`), {
      overlay: (t) => timeline[Math.min(timeline.length - 1, Math.round(t * FPS))].frame.rpm / 20,
    })

    expect(report.peakDb, `${name}: peak`).toBeLessThanOrEqual(CEILING_DB + 0.05)
    expect(report.clicks, `${name}: clicks at ${report.clickTimesS.join(', ')} s`).toBe(0)
    expect(tracking.windows, `${name}: steady windows analysed`).toBeGreaterThan(0)
    expect(tracking.within3pct, `${name}: firing tracking ${JSON.stringify(tracking.misses)}`).toBeGreaterThanOrEqual(0.9)
  })
}
