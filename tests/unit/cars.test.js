// Car profiles: configs are complete and sane, and the worklet synth (run directly in Node with
// a minimal AudioWorklet shim) fires at the right rate and drives the turbo voice.

import { describe, it, expect, beforeAll } from 'vitest'
import { CARS, buildCar, merge } from '../../src/cars.js'
import { speedAtRpm } from '../../src/vehicle/gearbox.js'
import { createRpmModel } from '../../src/vehicle/rpmModel.js'

const SR = 48000
let Processor = null

beforeAll(async () => {
  globalThis.sampleRate = SR
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = {} } }
  globalThis.registerProcessor = (name, cls) => { Processor = cls }
  await import('../../src/audio/flatSix.worklet.js')
})

function makeSynth(audio) {
  return new Processor({ processorOptions: { config: audio.worklet, seed: 7 } })
}

// Render `seconds` with params from fn(t) → { rpm, load, cut }; returns the 5 channels.
function render(proc, seconds, fn) {
  const n = Math.round(seconds * SR / 128)
  const chans = Array.from({ length: 5 }, () => new Float32Array(n * 128))
  const block = Array.from({ length: 5 }, () => new Float32Array(128))
  for (let b = 0; b < n; b++) {
    const p = fn((b * 128) / SR)
    proc.process([], [block], {
      rpm: [p.rpm], load: [p.load], cut: [p.cut ?? 0], combustion: [1], starter: [0], twoStep: [0],
    })
    for (let c = 0; c < 5; c++) chans[c].set(block[c], b * 128)
  }
  return chans
}

function goertzel(x, hz, from = 0) {
  const w = (2 * Math.PI * hz) / SR, k = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = from; i < x.length; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / (x.length - from)
}

describe('car profiles', () => {
  it('has unique ids and complete configs for every car', () => {
    expect(new Set(CARS.map((c) => c.id)).size).toBe(CARS.length)
    for (const c of CARS) {
      const { car, vehicle, audio } = buildCar(c.id)
      expect(car.id).toBe(c.id)
      expect(vehicle.engine.redlineRpm).toBe(c.redlineRpm)
      expect(audio.worklet.redlineRpm).toBe(c.redlineRpm)
      expect(audio.mixer.drive.redlineRpm).toBe(c.redlineRpm)
      expect([6, 8, 10, 12]).toContain(audio.worklet.firingOrder.length)
      const n = audio.worklet.firingOrder.length
      expect([...audio.worklet.firingOrder].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
      // ratios descending, idle well below the shift points
      const r = vehicle.gearbox.ratios
      for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1])
      expect(vehicle.shift.upshiftFullRpm).toBeLessThan(vehicle.engine.limiterRpm)
      expect(vehicle.shift.downshiftLightRpm).toBeGreaterThan(vehicle.engine.idleRpm)
      // 1st gear tops out at a believable speed (60–130 km/h)
      const v1 = speedAtRpm(c.redlineRpm, 1, vehicle.gearbox) * 3.6
      expect(v1).toBeGreaterThan(60); expect(v1).toBeLessThan(130)
    }
  })

  it('unknown id falls back to the GT3 RS; merge replaces arrays and nulls', () => {
    expect(buildCar('nope').car.id).toBe('gt3rs')
    expect(merge({ a: [1, 2], b: { c: 1, d: 2 }, t: { x: 1 } }, { a: [3], b: { c: 5 }, t: null }))
      .toEqual({ a: [3], b: { c: 5, d: 2 }, t: null })
  })

  it('every car upshifts through the gears at full throttle', () => {
    for (const c of CARS) {
      const { vehicle } = buildCar(c.id)
      const m = createRpmModel(vehicle, { seed: 1 })
      m.forceRunning()
      let v = 0, maxGear = 0, maxRpm = 0
      for (let i = 0; i < 60 * 30; i++) {
        v += 6 / 60                         // ~0.6 g, plenty to cycle through gears
        const f = m.step(1 / 60, { speedMps: Math.min(v, 85), accelMps2: 6, load: 1, status: 'ok' })
        maxGear = Math.max(maxGear, f.gear); maxRpm = Math.max(maxRpm, f.rpm)
      }
      expect(maxGear, c.id).toBeGreaterThanOrEqual(5)
      expect(maxRpm, c.id).toBeLessThanOrEqual(c.redlineRpm + 300)
    }
  })
})

describe('worklet synth per car', () => {
  for (const c of CARS) {
    it(`${c.id}: fires at rpm·N/120 and stays finite`, () => {
      const { audio } = buildCar(c.id)
      const N = audio.worklet.firingOrder.length
      const rpm = 4800
      const ch = render(makeSynth(audio), 1.0, () => ({ rpm, load: 0.7 }))
      const ex = ch[0]
      let peak = 0
      for (const ch1 of ch) for (const s of ch1) { expect(Number.isFinite(s)).toBe(true); peak = Math.max(peak, Math.abs(s)) }
      expect(peak).toBeGreaterThan(0.01)
      expect(peak).toBeLessThan(20)
      const f = (rpm * N) / 120
      const from = SR * 0.3
      const atF = goertzel(ex, f, from)
      // the firing frequency stands out against off-harmonic frequencies
      const off = (goertzel(ex, f * 0.77, from) + goertzel(ex, f * 1.23, from)) / 2
      expect(atF / off, `${c.id} firing ${f} Hz`).toBeGreaterThan(3)
    })
  }

  it('turbo cars spool boost under load and blow off on lift; NA cars never do', () => {
    for (const c of CARS) {
      const { audio } = buildCar(c.id)
      const proc = makeSynth(audio)
      const turbo = !!audio.worklet.turbo
      const rpm = c.redlineRpm * 0.7
      let boostAtLift = 0
      const ch = render(proc, 3, (t) => {
        if (t < 2) { boostAtLift = proc.boost; return { rpm, load: 1 } }
        return { rpm, load: 0 }
      })
      if (!turbo) { expect(proc.boost).toBe(0); continue }
      expect(boostAtLift, c.id).toBeGreaterThan(0.6)
      expect(proc.sinceBov, c.id).toBeLessThan(1)          // blow-off fired after the lift
      // the intake voice is louder right after the lift (blow-off) than before it
      const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)) }
      const before = rms(ch[2], SR * 1.7, SR * 1.95), after = rms(ch[2], SR * 2.02, SR * 2.2)
      expect(after, c.id).toBeGreaterThan(before * 0.8)
    }
  })
})
