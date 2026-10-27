import { describe, it, expect } from 'vitest'
import { vehicleConfig } from '../../src/vehicle/config.js'
import { createRpmModel } from '../../src/vehicle/rpmModel.js'
import { coupledRpm, speedAtRpm } from '../../src/vehicle/gearbox.js'

const cfg = vehicleConfig
const DT = 1 / 120

function running(seed = 1) {
  const m = createRpmModel(cfg, { seed })
  m.forceRunning()
  return m
}

/** Drive the model with a function of time returning {speedMps, accelMps2, load}. */
function drive(m, seconds, inputAt) {
  const frames = []
  for (let i = 0; i < seconds / DT; i++) {
    const t = i * DT
    frames.push({ t, ...m.step(DT, inputAt(t)) })
  }
  return frames
}

const events = (frames, type) => frames.flatMap((f) => f.events.filter((e) => e.type === type).map((e) => ({ ...e, t: f.t })))

describe('idle', () => {
  it('idles around 900 rpm with a subtle wobble when stopped', () => {
    const frames = drive(running(), 6, () => ({ speedMps: 0, accelMps2: 0, load: 0 })).slice(240)
    const rpms = frames.map((f) => f.rpm)
    const min = Math.min(...rpms), max = Math.max(...rpms)
    expect(min).toBeGreaterThan(850)
    expect(max).toBeLessThan(950)
    expect(max - min).toBeGreaterThan(5) // it does wobble
    expect(frames.every((f) => f.gear === 1)).toBe(true)
  })
})

describe('startup and shutdown', () => {
  it('cranks, catches, flares to ~2500 then settles to idle', () => {
    const m = createRpmModel(cfg)
    m.start()
    const frames = drive(m, 5, () => ({ speedMps: 0, load: 0 }))
    expect(events(frames, 'startup')).toHaveLength(1)
    const caught = events(frames, 'catch')
    expect(caught).toHaveLength(1)
    expect(caught[0].t).toBeCloseTo(cfg.startup.crankS, 1)
    const cranking = frames.filter((f) => f.t < cfg.startup.crankS - 0.05)
    expect(cranking.every((f) => f.starter === 1 && f.combustion === 0 && f.rpm < 300)).toBe(true)
    const peak = Math.max(...frames.map((f) => f.rpm))
    expect(peak).toBeGreaterThan(2300)
    expect(peak).toBeLessThan(2700)
    expect(frames.at(-1).rpm).toBeLessThan(1000)
    expect(frames.at(-1).engineState).toBe('running')
  })

  it('shuts down to zero rpm', () => {
    const m = running()
    drive(m, 1, () => ({ speedMps: 0, load: 0 }))
    m.stop()
    const frames = drive(m, 2, () => ({ speedMps: 0, load: 0 }))
    expect(events(frames, 'shutdown')).toHaveLength(1)
    expect(frames.at(-1).rpm).toBe(0)
    expect(frames.at(-1).engineState).toBe('off')
    // rpm falls monotonically
    for (let i = 1; i < frames.length; i++) expect(frames[i].rpm).toBeLessThanOrEqual(frames[i - 1].rpm + 1e-9)
  })
})

describe('shift logic', () => {
  it('full throttle upshifts near 8800–9000 rpm', () => {
    const m = running()
    const accel = 7
    const frames = drive(m, 9, (t) => ({ speedMps: accel * t, accelMps2: accel, load: 1 }))
    const ups = events(frames, 'upshift')
    expect(ups.length).toBeGreaterThanOrEqual(3)
    for (const u of ups) {
      const f = frames.find((x) => x.t === u.t)
      const rpmBefore = coupledRpm(f.speedMps, u.from, cfg.gearbox)
      expect(rpmBefore).toBeGreaterThan(8600)
      expect(rpmBefore).toBeLessThanOrEqual(9050)
    }
  })

  it('light throttle upshifts early (3000–4000 rpm)', () => {
    const m = running()
    const accel = 1.0
    const frames = drive(m, 25, (t) => ({ speedMps: 2 + accel * t, accelMps2: accel, load: 0.25 }))
    const ups = events(frames, 'upshift')
    expect(ups.length).toBeGreaterThanOrEqual(3)
    for (const u of ups) {
      const f = frames.find((x) => x.t === u.t)
      const rpmBefore = coupledRpm(f.speedMps, u.from, cfg.gearbox)
      expect(rpmBefore).toBeGreaterThan(2900)
      expect(rpmBefore).toBeLessThan(4100)
    }
  })

  it('upshifts take ~100 ms with a smooth rpm drop, not an instant jump', () => {
    const m = running()
    const frames = drive(m, 4, (t) => ({ speedMps: 7 * t, accelMps2: 7, load: 1 }))
    const u = events(frames, 'upshift')[0]
    const during = frames.filter((f) => f.t >= u.t && f.t <= u.t + cfg.shift.upshiftTimeS)
    expect(during.length).toBeGreaterThan(8)
    // No single step should carry more than ~35% of the total drop.
    const drop = during[0].rpm - during.at(-1).rpm
    expect(drop).toBeGreaterThan(1500)
    for (let i = 1; i < during.length; i++) {
      expect(during[i - 1].rpm - during[i].rpm).toBeLessThan(drop * 0.35)
    }
    // Loaded upshift cuts ignition briefly.
    expect(during.some((f) => f.cut === 1)).toBe(true)
    expect(frames.filter((f) => f.t > u.t + 0.2 && f.t < u.t + 0.5).every((f) => f.cut === 0)).toBe(true)
  })

  it('downshifts under braking with rev-matched blips', () => {
    const m = running()
    const v0 = 30, decel = -7
    // Settle in a high gear at cruise first.
    drive(m, 3, () => ({ speedMps: v0, accelMps2: 0, load: 0.2 }))
    const frames = drive(m, 4.5, (t) => {
      const v = Math.max(0, v0 + decel * t)
      return { speedMps: v, accelMps2: v > 0 ? decel : 0, load: 0 }
    })
    const downs = events(frames, 'downshift')
    expect(downs.length).toBeGreaterThanOrEqual(3)
    // A blip raises rpm above the new gear's coupled rpm and adds load.
    const d = downs[0]
    const blip = frames.filter((f) => f.t > d.t && f.t < d.t + cfg.shift.downshiftTimeS)
    expect(Math.max(...blip.map((f) => f.load))).toBeGreaterThan(0.3)
    const peak = Math.max(...blip.map((f) => f.rpm))
    const target = coupledRpm(blip[0].speedMps, d.to, cfg.gearbox)
    expect(peak).toBeGreaterThan(target)
    // Ends in 1st at idle.
    expect(frames.at(-1).gear).toBe(1)
    expect(frames.at(-1).rpm).toBeLessThan(1000)
  })

  it('never hunts between gears at steady speed (hysteresis)', () => {
    for (const mph of [15, 25, 35, 45, 55, 65, 75]) {
      for (const load of [0.15, 0.3, 0.5]) {
        const m = running()
        const v = mph * 0.44704
        // Small speed wobble like real cruising.
        const frames = drive(m, 20, (t) => ({ speedMps: v + 0.4 * Math.sin(t), accelMps2: 0.4 * Math.cos(t), load }))
        const shifts = [...events(frames, 'upshift'), ...events(frames, 'downshift')].filter((e) => e.t > 2)
        expect(shifts.length, `${mph} mph load ${load}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('kicks down when the throttle is floored at cruise', () => {
    const m = running()
    const v = 60 * 0.44704
    drive(m, 3, () => ({ speedMps: v, accelMps2: 0, load: 0.2 }))
    const gearBefore = drive(m, 0.1, () => ({ speedMps: v, accelMps2: 0, load: 0.2 })).at(-1).gear
    const frames = drive(m, 1.5, (t) => ({ speedMps: v + 2 * t, accelMps2: 3, load: 1 }))
    expect(events(frames, 'downshift').length).toBeGreaterThanOrEqual(1)
    expect(frames.at(-1).gear).toBeLessThan(gearBefore)
    expect(frames.at(-1).rpm).toBeGreaterThan(5000)
  })
})

describe('rev limiter', () => {
  it('bounces off the limiter when held at redline under load', () => {
    const m = running()
    // 7th gear at a speed beyond 9000 rpm is impossible on the road; use free-rev instead.
    const frames = drive(m, 3, () => ({ speedMps: 0, load: 1, freeRev: true })).slice(120)
    expect(events(frames, 'limiter').length).toBeGreaterThanOrEqual(1)
    const rpms = frames.map((f) => f.rpm)
    expect(Math.max(...rpms)).toBeLessThanOrEqual(cfg.engine.limiterRpm)
    expect(Math.min(...rpms)).toBeLessThan(cfg.engine.limiterRpm - 100)
    expect(frames.some((f) => f.cut === 1)).toBe(true)
    expect(frames[0].gear).toBe(0)
  })

  it('never exceeds the limiter on the road', () => {
    const m = running()
    const v = speedAtRpm(9500, 7, cfg.gearbox) // faster than possible
    const frames = drive(m, 2, () => ({ speedMps: v, accelMps2: 0, load: 1 }))
    expect(Math.max(...frames.map((f) => f.rpm))).toBeLessThanOrEqual(cfg.engine.limiterRpm)
  })
})

describe('launch', () => {
  it('slips the clutch on a full-throttle launch instead of bogging at idle', () => {
    const m = running()
    const frames = drive(m, 1, (t) => ({ speedMps: 4 * t, accelMps2: 4, load: 1 }))
    const late = frames.filter((f) => f.t > 0.4)
    expect(Math.min(...late.map((f) => f.rpm))).toBeGreaterThan(3500)
  })

  it('is deterministic for a given seed', () => {
    const a = drive(running(42), 2, () => ({ speedMps: 0, load: 0 })).map((f) => f.rpm)
    const b = drive(running(42), 2, () => ({ speedMps: 0, load: 0 })).map((f) => f.rpm)
    expect(a).toEqual(b)
  })
})
