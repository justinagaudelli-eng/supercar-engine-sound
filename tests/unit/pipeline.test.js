import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { traceToTimeline } from '../../src/pipeline.js'
import { vehicleConfig } from '../../src/vehicle/config.js'
import { coupledRpm } from '../../src/vehicle/gearbox.js'

const index = JSON.parse(readFileSync(new URL('../../fixtures/index.json', import.meta.url)))
const load = (f) => JSON.parse(readFileSync(new URL(`../../fixtures/${f}`, import.meta.url)))
const E = vehicleConfig.engine

describe('every fixture through replay → filter → rpm model', () => {
  it('ships all seven required fixtures', () => {
    expect(index.map((f) => f.name).sort()).toEqual([
      'gps-dropout', 'hard-braking', 'highway-merge', 'launch-to-60', 'noisy-fixes', 'steady-cruise', 'stop-and-go',
    ])
  })

  for (const { name, file } of index) {
    describe(name, () => {
      const timeline = traceToTimeline(load(file), { fps: 100, withStartup: true })
      const running = timeline.filter((x) => x.t > 3)

      it('keeps rpm between idle and the limiter', () => {
        for (const { frame } of running) {
          expect(frame.rpm).toBeGreaterThan(E.idleRpm - 60)
          expect(frame.rpm).toBeLessThanOrEqual(E.limiterRpm)
        }
      })

      it('never moves rpm in steps outside shifts', () => {
        for (let i = 1; i < running.length; i++) {
          const a = running[i - 1].frame, b = running[i].frame
          if (a.shifting || b.shifting) continue
          // 100 fps: slew limit 16k rpm/s → ≤ 160 rpm per frame (+ idle-wobble slack)
          expect(Math.abs(b.rpm - a.rpm), `${name} @ ${running[i].t.toFixed(2)} s`).toBeLessThanOrEqual(200)
        }
      })

      it('does not hunt between gears', () => {
        const shifts = running.flatMap((x) => x.frame.events.filter((e) => e.type === 'upshift' || e.type === 'downshift')
          .map((e) => ({ ...e, t: x.t })))
        // An up immediately followed by a down (or vice versa) within 1.5 s = hunting.
        for (let i = 1; i < shifts.length; i++) {
          const a = shifts[i - 1], b = shifts[i]
          if (a.type !== b.type) expect(b.t - a.t, `${name}: ${a.type}@${a.t} then ${b.type}@${b.t}`).toBeGreaterThan(1.5)
        }
      })

      it('rpm agrees with speed and gear once settled', () => {
        let checked = 0
        // A trace that starts at speed sweeps the revs up (slew-limited) — skip that 0.5 s.
        const firstFix = running.find((x) => x.estimate.status !== 'waiting').t
        for (const { t, frame, estimate } of running) {
          if (t < firstFix + 0.5) continue
          if (frame.shifting || frame.gear < 2 || estimate.speedMps < 5) continue
          const expected = coupledRpm(estimate.speedMps, frame.gear, vehicleConfig.gearbox)
          if (expected < E.idleRpm * 1.1 || expected > E.limiterRpm) continue
          expect(Math.abs(frame.rpm - expected) / expected).toBeLessThan(0.08)
          checked++
        }
        if (name !== 'stop-and-go') expect(checked).toBeGreaterThan(50)
      })
    })
  }
})

// Older Teslas often give no Doppler speed: every fixture again with positions only.
describe('every fixture with coords.speed = null (positions only)', () => {
  for (const { name, file } of index) {
    it(`${name}: no hunting, rpm bounded`, () => {
      const trace = load(file)
      const stripped = { ...trace, fixes: trace.fixes.map((f) => ({ ...f, speed: null })) }
      const timeline = traceToTimeline(stripped, { fps: 100, withStartup: true })
      const running = timeline.filter((x) => x.t > 3)
      const shifts = running.flatMap((x) => x.frame.events.filter((e) => e.type === 'upshift' || e.type === 'downshift')
        .map((e) => ({ ...e, t: x.t })))
      for (let i = 1; i < shifts.length; i++) {
        const a = shifts[i - 1], b = shifts[i]
        if (a.type !== b.type) expect(b.t - a.t, `${name}: ${a.type}@${a.t.toFixed(2)} then ${b.type}@${b.t.toFixed(2)}`).toBeGreaterThan(1.5)
      }
      // No more shifts than the Doppler version needs, plus a small allowance.
      const withDoppler = traceToTimeline(trace, { fps: 100, withStartup: true })
        .flatMap((x) => x.frame.events).filter((e) => e.type === 'upshift' || e.type === 'downshift').length
      expect(shifts.length, `${name}: shift count`).toBeLessThanOrEqual(withDoppler + 4)
      for (const { frame } of running) expect(frame.rpm).toBeLessThanOrEqual(E.limiterRpm)
    })
  }
})

