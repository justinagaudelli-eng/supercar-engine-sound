import { describe, it, expect } from 'vitest'
import { parseManifest } from '../../src/audio/manifest.js'

const BASE = 'https://example.test/app/samples/manifest.json'
const loop = (o = {}) => ({ file: 'on_3000.wav', rpm: 3000, layer: 'on', loopStart: 0, loopEnd: 0.42, ...o })

describe('parseManifest', () => {
  it('parses the documented example, sorts by rpm and resolves URLs', () => {
    const m = parseManifest({
      version: 1,
      name: 'my-gt3rs',
      loops: [
        loop({ file: 'on_6000.wav', rpm: 6000 }),
        loop(),
        { file: 'off_3000.wav', rpm: 3000, layer: 'off', loopStart: 0, loopEnd: 0.4 },
      ],
    }, BASE)
    expect(m.version).toBe(1)
    expect(m.name).toBe('my-gt3rs')
    expect(m.loops.map((l) => l.rpm)).toEqual([3000, 3000, 6000])
    expect(m.layers.on.map((l) => l.rpm)).toEqual([3000, 6000])
    expect(m.layers.off.map((l) => l.file)).toEqual(['off_3000.wav'])
    expect(m.layers.on[0].url).toBe('https://example.test/app/samples/on_3000.wav')
    expect(m.hasOn && m.hasOff).toBe(true)
  })

  it('accepts a JSON string and applies defaults (layer on, whole file, gain 1)', () => {
    const m = parseManifest(JSON.stringify({ version: 1, loops: [{ file: 'a.wav', rpm: 2000 }] }), BASE)
    expect(m.loops[0]).toMatchObject({ layer: 'on', loopStart: 0, loopEnd: null, gain: 1 })
    expect(m.name).toBe('')
  })

  it('resolves nested relative paths against the manifest URL', () => {
    const m = parseManifest({ version: 1, loops: [loop({ file: 'loops/x y.wav' })] }, BASE)
    expect(m.loops[0].url).toBe('https://example.test/app/samples/loops/x%20y.wav')
  })

  it('uses the other layer for both when one is missing', () => {
    const onlyOff = parseManifest({ version: 1, loops: [loop({ layer: 'off' })] }, BASE)
    expect(onlyOff.hasOn).toBe(false)
    expect(onlyOff.layers.on).toBe(onlyOff.layers.off)
    const onlyOn = parseManifest({ version: 1, loops: [loop()] }, BASE)
    expect(onlyOn.layers.off).toBe(onlyOn.layers.on)
  })

  it('throws descriptive errors', () => {
    const bad = (json, re) => expect(() => parseManifest(json, BASE)).toThrow(re)
    bad('{nope', /not valid JSON/)
    bad([], /root must be an object/)
    bad({ version: 2, loops: [loop()] }, /version is unsupported/)
    bad({ version: 1 }, /loops must be an array/)
    bad({ version: 1, loops: [] }, /at least one loop/)
    bad({ version: 1, loops: [loop({ file: '' })] }, /loops\[0\]\.file must be a non-empty string/)
    bad({ version: 1, loops: [loop({ rpm: -5 })] }, /loops\[0\]\.rpm must be a positive number \(got -5\)/)
    bad({ version: 1, loops: [loop({ rpm: '3000' })] }, /rpm must be a positive number/)
    bad({ version: 1, loops: [loop({ layer: 'idle' })] }, /layer must be "on" or "off"/)
    bad({ version: 1, loops: [loop({ loopStart: -1 })] }, /loopStart must be a number/)
    bad({ version: 1, loops: [loop({ loopStart: 0.5, loopEnd: 0.2 })] }, /loopEnd must be greater than loopStart/)
    bad({ version: 1, loops: [loop({ gain: -1 })] }, /gain must be a number ≥ 0/)
    bad({ version: 1, loops: [loop(), loop({ file: 'dup.wav' })] }, /two "on" loops at the same rpm 3000/)
    bad({ version: 1, loops: [null] }, /loops\[0\] must be an object/)
  })

  it('requires a base URL outside the browser', () => {
    expect(() => parseManifest({ version: 1, loops: [loop()] })).toThrow(/baseUrl is required/)
  })
})
