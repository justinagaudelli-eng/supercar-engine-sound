import { describe, it, expect } from 'vitest'
import {
  findRisingZeroCrossings, chooseLoopPoints, seamError, crossfadeLoop, targetRpmTimes,
  rpmTargets, commonGain, detectActiveRange,
} from '../../src/tools/loopMath.js'
import {
  estimateRpmCurve, refinePeriod, createPhaseMap, warpToConstantPitch, linearRpmCurve, fillCurveGaps,
} from '../../src/tools/pitch.js'
import { rng } from '../../src/util/math.js'

const SR = 48000

// Harmonic "engine-like" tone at a constant f0 with uneven harmonic phases.
function harmonic(f0, seconds, sr = SR) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  const amps = [1, 0.6, 0.45, 0.3, 0.2, 0.12]
  const phases = [0.3, 1.7, 2.9, 0.8, 4.1, 5.5]
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * i / sr + phases[h])
    out[i] = s * 0.3
  }
  return out
}

// Flat-six-ish rev sweep: firing frequency rpm/20 plus a weak half-order component.
function sweep(rpmStart, rpmEnd, seconds, sr = SR, noise = 0.01) {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  const rand = rng(7)
  let phase = 0
  const truth = (t) => rpmStart + (rpmEnd - rpmStart) * (t / seconds)
  for (let i = 0; i < n; i++) {
    const f = truth(i / sr) / 20
    phase += f / sr
    const p = 2 * Math.PI * phase
    out[i] = 0.4 * Math.sin(p) + 0.25 * Math.sin(2 * p + 1) + 0.15 * Math.sin(3 * p + 2)
      + 0.08 * Math.sin(0.5 * p) + noise * (rand() * 2 - 1)
  }
  return { samples: out, truth }
}

describe('findRisingZeroCrossings', () => {
  it('finds one rising crossing per period of a sine', () => {
    const x = new Float32Array(1000)
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * i / 100 - 0.01)
    const zc = findRisingZeroCrossings(x)
    expect(zc.length).toBe(10)
    for (const i of zc) {
      expect(x[i - 1]).toBeLessThan(0)
      expect(x[i]).toBeGreaterThanOrEqual(0)
    }
    for (let k = 1; k < zc.length; k++) expect(zc[k] - zc[k - 1]).toBe(100)
  })
})

describe('chooseLoopPoints', () => {
  for (const f0 of [61.7, 150, 333.3]) {
    it(`loops are integer periods on rising zero crossings with a tiny seam (f0=${f0} Hz)`, () => {
      const x = harmonic(f0, 1.5)
      const P = SR / f0
      const cycles = 12
      const { start, end, error, aligned } = chooseLoopPoints(x, SR, Math.round(0.75 * SR), P, cycles)
      expect(aligned).toBe(true)
      expect(x[start - 1]).toBeLessThan(0)
      expect(x[start]).toBeGreaterThanOrEqual(0)
      expect(x[end - 1]).toBeLessThan(0)
      expect(x[end]).toBeGreaterThanOrEqual(0)
      // Within one sample of an exact integer number of periods.
      expect(Math.abs(end - start - cycles * P)).toBeLessThanOrEqual(1)
      expect(Math.abs((end - start) / P - cycles)).toBeLessThan(0.02)
      // Seam: wrap-around jump is no bigger than an ordinary sample-to-sample step.
      expect(error).toBeLessThan(0.05)
      let maxStep = 0
      for (let i = start + 1; i < end; i++) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]))
      expect(Math.abs(x[start] - x[end - 1])).toBeLessThanOrEqual(maxStep * 1.05)
    })
  }

  it('seamError is large for a wrong loop length and small for the right one', () => {
    const x = harmonic(100, 1)
    const P = SR / 100
    expect(seamError(x, 4800, 4800 + 10 * P)).toBeLessThan(0.01)
    expect(seamError(x, 4800, 4800 + 10 * P + P / 3)).toBeGreaterThan(0.2)
  })

  it('crossfadeLoop repairs a bad seam', () => {
    const x = harmonic(100, 1)
    const P = SR / 100
    const start = 9600
    const end = start + Math.round(10.37 * P)  // deliberately not an integer number of periods
    const loop = crossfadeLoop(x, start, end, 240)
    expect(loop.length).toBe(end - start)
    // After the fade the loop's tail matches what preceded `start` in the original.
    const jumpRaw = Math.abs(x[end - 1] - x[start])
    const jumpFixed = Math.abs(loop[loop.length - 1] - loop[0])
    expect(jumpFixed).toBeLessThan(jumpRaw)
    expect(jumpFixed).toBeLessThan(0.03)
  })
})

describe('targetRpmTimes / rpmTargets', () => {
  const curve = [
    { t: 0, rpm: 1000 }, { t: 1, rpm: 3000 }, { t: 2, rpm: null }, { t: 3, rpm: 7000 },
    { t: 4, rpm: 9000 }, { t: 5, rpm: 5000 },
  ]
  it('interpolates rising crossings', () => {
    const r = targetRpmTimes(curve, [2000, 8000, 9500])
    expect(r[0].t).toBeCloseTo(0.5)
    expect(r[1].t).toBeCloseTo(3.5)
    expect(r[2].t).toBeNull()
  })
  it('finds falling crossings', () => {
    const r = targetRpmTimes(curve, [7000], { direction: 'down' })
    expect(r[0].t).toBeCloseTo(4.5)
  })
  it('builds step targets', () => {
    expect(rpmTargets(1200, 3100, 500)).toEqual([1500, 2000, 2500, 3000])
  })
})

describe('pitch tracking', () => {
  it('tracks a synthetic rev sweep within 3% rpm', () => {
    const { samples, truth } = sweep(1500, 8500, 4)
    const curve = estimateRpmCurve(samples, SR, { minRpm: 800, maxRpm: 10000 })
    const voiced = curve.filter((p) => p.rpm != null)
    expect(voiced.length).toBeGreaterThan(curve.length * 0.9)
    let worst = 0
    for (const p of voiced) worst = Math.max(worst, Math.abs(p.rpm - truth(p.t)) / truth(p.t))
    expect(worst).toBeLessThan(0.03)
  })

  it('order correction rescales rpm', () => {
    const { samples } = sweep(3000, 3000, 1)
    const a = estimateRpmCurve(samples, SR, { order: 3 }).filter((p) => p.rpm)
    const b = estimateRpmCurve(samples, SR, { order: 1.5 }).filter((p) => p.rpm)
    expect(b[5].rpm / a[5].rpm).toBeCloseTo(2, 3)
  })

  it('refinePeriod finds a fractional period', () => {
    const x = harmonic(173.3, 0.5)
    const p = refinePeriod(x, 12000, SR / 170)
    expect(Math.abs(p - SR / 173.3)).toBeLessThan(0.05)
  })

  it('warpToConstantPitch flattens a sweep', () => {
    const { samples } = sweep(2000, 6000, 2, SR, 0)
    const map = createPhaseMap(linearRpmCurve(0, 2, 2000, 6000))
    const [flat] = warpToConstantPitch([samples], SR, map, 1, 4000, Math.round(0.4 * SR))
    const P = SR / (4000 / 20)
    for (const at of [0.1, 0.2, 0.3]) {
      const p = refinePeriod(flat, Math.round(at * SR), P)
      expect(Math.abs(p - P) / P).toBeLessThan(0.002)
    }
  })

  it('fillCurveGaps interpolates holes', () => {
    const f = fillCurveGaps([{ t: 0, rpm: null }, { t: 1, rpm: 1000 }, { t: 2, rpm: null }, { t: 3, rpm: 3000 }])
    expect(f.map((p) => p.rpm)).toEqual([1000, 2000, 3000])
  })
})

describe('gain and trimming', () => {
  it('commonGain uses one gain for all loops', () => {
    const a = new Float32Array([0.1, -0.2])
    const b = new Float32Array([0.4, -0.05])
    expect(commonGain([[a], [b]], 0.8)).toBeCloseTo(2)
  })
  it('detectActiveRange trims leading and trailing silence', () => {
    const x = new Float32Array(SR * 3)
    x.set(harmonic(100, 1), SR)
    const r = detectActiveRange(x, SR)
    expect(r.start).toBeCloseTo(1, 1)
    expect(r.end).toBeCloseTo(2, 1)
  })
})
