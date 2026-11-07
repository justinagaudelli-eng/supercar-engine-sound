import { describe, it, expect } from 'vitest'
import { packCoverage, crossfadeWeights, loadWeights } from '../../src/audio/sampleLayer.js'

const loops = [2000, 4000, 6000, 8000].map((rpm) => ({ rpm }))
const nonZero = (w) => w.map((v, i) => [i, v]).filter(([, v]) => v > 1e-12).map(([i]) => i)

describe('crossfadeWeights', () => {
  it('is equal-power between the two nearest loops', () => {
    for (const rpm of [2000.5, 2500, 3000, 3999, 4500, 5100, 7777]) {
      const w = crossfadeWeights(rpm, loops)
      const idx = nonZero(w)
      expect(idx.length).toBeLessThanOrEqual(2)
      const p = idx.reduce((s, i) => s + w[i] * w[i], 0)
      expect(p).toBeCloseTo(1, 12)
    }
  })

  it('selects the two loops bracketing the rpm', () => {
    expect(nonZero(crossfadeWeights(3000, loops))).toEqual([0, 1])
    expect(nonZero(crossfadeWeights(5000, loops))).toEqual([1, 2])
    expect(nonZero(crossfadeWeights(7000, loops))).toEqual([2, 3])
    const mid = crossfadeWeights(3000, loops)
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('is exactly one loop at a loop rpm, and continuous across it', () => {
    expect(crossfadeWeights(4000, loops)).toEqual([0, 1, 0, 0])
    const below = crossfadeWeights(4000 - 1e-6, loops)
    const above = crossfadeWeights(4000 + 1e-6, loops)
    for (let i = 0; i < 4; i++) {
      expect(below[i]).toBeCloseTo(above[i], 5)
    }
  })

  it('clamps beyond the ends', () => {
    expect(crossfadeWeights(900, loops)).toEqual([1, 0, 0, 0])
    expect(crossfadeWeights(0, loops)).toEqual([1, 0, 0, 0])
    expect(crossfadeWeights(9500, loops)).toEqual([0, 0, 0, 1])
    expect(crossfadeWeights(NaN, loops)).toEqual([1, 0, 0, 0])
  })

  it('handles a single loop and no loops', () => {
    expect(crossfadeWeights(100, [{ rpm: 3000 }])).toEqual([1])
    expect(crossfadeWeights(9000, [{ rpm: 3000 }])).toEqual([1])
    expect(crossfadeWeights(3000, [])).toEqual([])
  })

  it('accepts plain rpm numbers', () => {
    expect(crossfadeWeights(3000, [2000, 4000])[0]).toBeCloseTo(Math.SQRT1_2, 12)
  })
})

describe('loadWeights', () => {
  it('blends on/off equal-power by load and clamps', () => {
    expect(loadWeights(1)).toEqual({ on: 1, off: Math.cos(Math.PI / 2) })
    expect(loadWeights(0)).toEqual({ on: 0, off: 1 })
    const h = loadWeights(0.5)
    expect(h.on ** 2 + h.off ** 2).toBeCloseTo(1, 12)
    expect(loadWeights(2).on).toBe(1)
    expect(loadWeights(-1).off).toBe(1)
  })
})

describe('packCoverage', () => {
  const loops = [{ rpm: 1000 }, { rpm: 4000 }, { rpm: 8000 }]
  it('is 1 inside the recorded range and a little beyond it', () => {
    for (const r of [1000, 900, 2500, 8000, 8600]) expect(packCoverage(r, loops)).toBe(1)
  })
  it('fades out well below the lowest and above the highest loop', () => {
    expect(packCoverage(600, loops)).toBe(0)
    expect(packCoverage(10500, loops)).toBe(0)
    const mid = packCoverage(780, loops)
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1)
    expect(packCoverage(9500, loops)).toBeLessThan(1)
  })
  it('is 1 for an empty pack or a bad rpm', () => {
    expect(packCoverage(3000, [])).toBe(1)
    expect(packCoverage(NaN, loops)).toBe(1)
  })
})
