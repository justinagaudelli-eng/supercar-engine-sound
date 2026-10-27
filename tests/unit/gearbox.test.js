import { describe, it, expect } from 'vitest'
import { vehicleConfig } from '../../src/vehicle/config.js'
import { wheelRpm, coupledRpm, speedAtRpm, bestGear } from '../../src/vehicle/gearbox.js'

const GB = vehicleConfig.gearbox
const KMH = 1 / 3.6

describe('gearbox ratios and rpm math', () => {
  it('uses the researched 992 GT3 RS gearing', () => {
    expect(GB.ratios).toEqual([3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84])
    expect(GB.finalDrive).toBe(4.27)
    // 335/30 ZR21: 734.4 mm diameter → 2.307 m, minus ~3% loaded
    expect(Math.PI * 0.7344).toBeCloseTo(2.307, 3)
    expect(GB.tireCircumferenceM).toBeGreaterThan(2.2)
    expect(GB.tireCircumferenceM).toBeLessThan(2.31)
  })

  it('computes wheel rpm from speed', () => {
    expect(wheelRpm(0, GB)).toBe(0)
    expect(wheelRpm(GB.tireCircumferenceM, GB)).toBeCloseTo(60, 9) // one rev per second
  })

  it('matches the RESEARCH.md speed-at-9000-rpm table', () => {
    const expectedKmh = [75.5, 118.9, 164.5, 211.2, 255.0, 294.8, 336.9]
    expectedKmh.forEach((kmh, i) => {
      expect(speedAtRpm(9000, i + 1, GB) / KMH).toBeCloseTo(kmh, 0)
    })
  })

  it('round-trips speed ↔ rpm in every gear', () => {
    for (let g = 1; g <= 7; g++) {
      for (const v of [3, 17.5, 40]) {
        expect(speedAtRpm(coupledRpm(v, g, GB), g, GB)).toBeCloseTo(v, 9)
      }
    }
  })

  it('returns 0 rpm for neutral / invalid gears', () => {
    expect(coupledRpm(20, 0, GB)).toBe(0)
    expect(coupledRpm(20, 8, GB)).toBe(0)
  })

  it('picks the highest gear inside the rpm window', () => {
    const v = 100 * KMH
    const g = bestGear(v, 2000, 4000, GB)
    const rpm = coupledRpm(v, g, GB)
    expect(rpm).toBeGreaterThanOrEqual(2000)
    expect(rpm).toBeLessThanOrEqual(4000)
    if (g < 7) expect(coupledRpm(v, g + 1, GB)).toBeLessThan(2000)
    expect(bestGear(0.1, 2000, 4000, GB)).toBe(1)
  })
})
