import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { inputConfig } from '../../src/input/config.js'
import { createInputBus } from '../../src/input/inputBus.js'
import { createGpsFixProcessor, haversineM, createGpsSource } from '../../src/input/gps.js'
import { createReplay } from '../../src/input/replay.js'
import { createSpeedFilter } from '../../src/input/kalman.js'
import { estimateLoad } from '../../src/input/load.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url)))
const MPH = 0.44704
// The visible speed may change no faster than ~1.5 g between frames: a GT3 RS launch peaks
// around 1.2 g, so anything faster would be a step on fix arrival.
const MAX_STEP = (15 / 60)
function expectSmooth(out) {
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1].status === 'waiting') continue // the very first fix may start at speed
    expect(Math.abs(out[i].speedMps - out[i - 1].speedMps), `at ${out[i].now} ms`).toBeLessThan(MAX_STEP)
  }
}

/** Replay a fixture at 60 Hz; returns per-frame estimates with ground truth. */
function runFixture(name) {
  const trace = fixture(name)
  const bus = createInputBus(inputConfig)
  const rep = createReplay(trace, inputConfig.gps, { onSample: (s) => bus.push(s) })
  const out = []
  for (let i = 0; i <= trace.durationS * 60; i++) {
    const now = (i / 60) * 1000
    rep.step(now)
    const e = bus.estimate(now)
    const truth = trace.truth.reduce((best, x) => (Math.abs(x.t - now) < Math.abs(best.t - now) ? x : best))
    out.push({ now, ...e, truth: truth.speed })
  }
  return { out, rep, trace }
}

describe('haversine', () => {
  it('measures known distances', () => {
    expect(haversineM(0, 0, 0, 1)).toBeCloseTo(111195, -1)
    expect(haversineM(37.4, -122.1, 37.4, -122.1)).toBe(0)
  })
})

describe('kalman speed filter', () => {
  it('converges on a constant acceleration', () => {
    const f = createSpeedFilter(inputConfig.filter)
    for (let t = 0; t <= 10; t++) f.update(t, 2 * t, 0.5)
    expect(f.speed).toBeCloseTo(20, 0)
    expect(f.accel).toBeCloseTo(2, 0)
  })

  it('never reports negative speed', () => {
    const f = createSpeedFilter(inputConfig.filter)
    for (let t = 0; t <= 5; t++) f.update(t, Math.max(0, 5 - 3 * t), 0.5)
    expect(f.speed).toBeGreaterThanOrEqual(0)
  })
})

describe('fix processor', () => {
  const base = { lat: 37.4, lon: -122.1, accuracy: 5 }

  it('prefers Doppler speed', () => {
    const p = createGpsFixProcessor(inputConfig.gps)
    const r = p.process({ ...base, t: 0, speed: 12.3 }, 0)
    expect(r.sample.speedMps).toBe(12.3)
    expect(r.sample.derived).toBe(false)
  })

  it('derives speed from positions when Doppler is missing', () => {
    const p = createGpsFixProcessor(inputConfig.gps)
    expect(p.process({ ...base, t: 0, speed: null }, 0).sample).toBeNull() // anchor
    const dLat = 20 / 111320 // 20 m north in 1 s
    const r = p.process({ ...base, lat: base.lat + dLat, t: 1000, speed: null }, 1000)
    expect(r.sample.speedMps).toBeCloseTo(20, 0)
    expect(r.sample.derived).toBe(true)
    expect(r.sample.timestamp).toBe(500) // midpoint of the interval
  })

  it('rejects poor accuracy, duplicates, impossible speed and jumps', () => {
    const p = createGpsFixProcessor(inputConfig.gps)
    expect(p.process({ ...base, t: 0, speed: 10, accuracy: 500 }, 0).reason).toBe('accuracy')
    expect(p.process({ ...base, t: 0, speed: 10 }, 0).sample).not.toBeNull()
    expect(p.process({ ...base, t: 0, speed: 10 }, 0).reason).toBe('duplicate')
    expect(p.process({ ...base, t: 1000, speed: 150 }, 1000).reason).toBe('speed')
    expect(p.process({ ...base, t: 2000, speed: 50 }, 2000).reason).toBe('jump')
  })

  it('re-anchors after a streak of rejects (real change, not noise)', () => {
    const p = createGpsFixProcessor(inputConfig.gps)
    p.process({ ...base, t: 0, speed: 10 }, 0)
    const results = [1, 2, 3, 4].map((s) => p.process({ ...base, t: s * 1000, speed: 60 }, s * 1000))
    expect(results.slice(0, 3).every((r) => r.reason === 'jump')).toBe(true)
    expect(results[3].sample.speedMps).toBe(60)
  })
})

describe('input bus on fixtures', () => {
  it('tracks a clean launch closely and smoothly (no steps between fixes)', () => {
    const { out } = runFixture('launch-to-60')
    expectSmooth(out)
    const steady = out.filter((o) => o.now > 10000 && o.now < 13000)
    for (const o of steady) expect(Math.abs(o.speedMps - o.truth)).toBeLessThan(2.5 * MPH)
  })

  it('handles noisy, positions-only fixes with bounded error', () => {
    const { out, rep } = runFixture('noisy-fixes')
    expect(rep.processor.stats.rejected).toBeGreaterThan(0) // outliers caught
    const errs = out.filter((o) => o.now > 3000).map((o) => Math.abs(o.speedMps - o.truth)).sort((a, b) => a - b)
    const median = errs[Math.floor(errs.length / 2)]
    expect(median).toBeLessThan(4 * MPH)
    expect(errs.at(-1)).toBeLessThan(15 * MPH)
    expectSmooth(out)
  })

  it('holds speed through a short dropout, then decays, then recovers', () => {
    const { out } = runFixture('gps-dropout')
    const at = (ms) => out.find((o) => o.now >= ms)
    expect(at(7000).status).toBe('ok')
    // fixes stop after ~7 s (last at ≤ 8 s); stale after 2.5 s, lost after 6 s
    expect(at(11000).status).toBe('stale')
    expect(Math.abs(at(11000).speedMps - 50 * MPH)).toBeLessThan(2 * MPH)
    expect(at(17000).status).toBe('lost')
    expect(at(19500).speedMps).toBeLessThan(at(15000).speedMps)
    // Signal back at 20 s: ok again and gliding back to 50 mph without a step.
    expect(at(21500).status).toBe('ok')
    expect(Math.abs(at(26000).speedMps - 50 * MPH)).toBeLessThan(2.5 * MPH)
    expectSmooth(out)
  })

  it('reaches zero after hard braking and stays put', () => {
    const { out } = runFixture('hard-braking')
    expect(out.at(-1).speedMps).toBeLessThan(0.5)
    const braking = out.filter((o) => o.now > 6000 && o.now < 8000)
    expect(braking.some((o) => o.load === 0)).toBe(true) // lift-off detected
  })

  it('reports waiting before any sample', () => {
    const bus = createInputBus(inputConfig)
    expect(bus.estimate(0).status).toBe('waiting')
  })
})

describe('load estimate', () => {
  const L = inputConfig.load
  it('is full on hard acceleration, light at cruise, zero when braking', () => {
    expect(estimateLoad(10, 4, L)).toBe(1)
    const cruise = estimateLoad(25, 0, L)
    expect(cruise).toBeGreaterThan(0.1)
    expect(cruise).toBeLessThan(0.4)
    expect(estimateLoad(25, -2, L)).toBe(0)
    expect(estimateLoad(0, 0, L)).toBe(0)
  })
  it('rises monotonically with acceleration', () => {
    let prev = -1
    for (let a = -3; a <= 5; a += 0.25) {
      const l = estimateLoad(20, a, L)
      expect(l).toBeGreaterThanOrEqual(prev)
      prev = l
    }
  })
})

describe('live GPS source', () => {
  it('reports permission denied without throwing', () => {
    const statuses = []
    const geo = { watchPosition: (_ok, err) => { err({ code: 1, message: 'denied' }); return 1 }, clearWatch() {} }
    const src = createGpsSource(inputConfig.gps, { geolocation: geo, onStatus: (s) => statuses.push(s) })
    src.start()
    expect(statuses).toContain('denied')
  })

  it('reports unsupported when geolocation is missing', () => {
    const statuses = []
    const src = createGpsSource(inputConfig.gps, { geolocation: null, onStatus: (s) => statuses.push(s) })
    expect(src.start()).toBe(false)
    expect(statuses).toContain('unsupported')
  })

  it('records fixes into a replayable trace', () => {
    let cb
    const geo = { watchPosition: (ok) => { cb = ok; return 1 }, clearWatch() {} }
    const samples = []
    const src = createGpsSource(inputConfig.gps, { geolocation: geo, onSample: (s) => samples.push(s), now: () => 0 })
    src.start()
    src.startRecording()
    for (let i = 0; i < 5; i++) {
      cb({ timestamp: 1e6 + i * 1000, coords: { latitude: 37.4 + i * 1e-4, longitude: -122.1, speed: 11, accuracy: 4, heading: 0 } })
    }
    const trace = src.stopRecording()
    expect(trace.fixes).toHaveLength(5)
    expect(trace.fixes[0].t).toBe(0)
    expect(trace.fixes[4].t).toBe(4000)
    expect(samples).toHaveLength(5)
    // The recording replays through the same pipeline.
    const replayed = []
    const rep = createReplay(trace, inputConfig.gps, { onSample: (s) => replayed.push(s) })
    rep.step(0); rep.step(5000)
    expect(replayed.map((s) => s.speedMps)).toEqual(samples.map((s) => s.speedMps))
  })
})
