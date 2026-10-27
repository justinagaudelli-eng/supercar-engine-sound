import { describe, it, expect } from 'vitest'
import { encodeWav, decodeWav, decodeWavHeader, floatToInt16 } from '../../src/tools/wav.js'
import { crc32, createZip } from '../../src/tools/zip.js'

describe('wav', () => {
  it('roundtrips mono 16-bit PCM within two LSB', () => {
    const x = new Float32Array(1000)
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.9
    const bytes = encodeWav(x, 44100)
    expect(bytes.length).toBe(44 + 2000)
    const h = decodeWavHeader(bytes)
    expect(h).toMatchObject({ format: 1, channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 1000, dataOffset: 44 })
    const { sampleRate, channels } = decodeWav(bytes)
    expect(sampleRate).toBe(44100)
    for (let i = 0; i < x.length; i++) expect(Math.abs(channels[0][i] - x[i])).toBeLessThan(2 / 32768)
  })

  it('roundtrips stereo and clamps out-of-range values', () => {
    const l = new Float32Array([0, 0.5, -0.5, 2, -2, NaN])
    const r = new Float32Array([1, -1, 0.25, 0, 0, 0])
    const { channels } = decodeWav(encodeWav([l, r], 48000))
    expect(channels.length).toBe(2)
    expect(channels[0][3]).toBeCloseTo(0x7fff / 0x8000, 6)
    expect(channels[0][4]).toBe(-1)
    expect(channels[0][5]).toBe(0)
    expect(channels[1][1]).toBe(-1)
    expect(floatToInt16(1)).toBe(32767)
    expect(floatToInt16(-1)).toBe(-32768)
  })

  it('skips unknown chunks before data', () => {
    const base = encodeWav(new Float32Array([0.5]), 8000)
    const extra = new Uint8Array(base.length + 12)
    extra.set(base.subarray(0, 36), 0)
    extra.set([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0], 36) // 'LIST', odd size + pad
    extra.set(base.subarray(36), 48)
    const h = decodeWavHeader(extra)
    expect(h.dataOffset).toBe(56)
    expect(decodeWav(extra).channels[0][0]).toBeCloseTo(0.5, 3)
  })

  it('rejects non-WAV data', () => {
    expect(() => decodeWavHeader(new Uint8Array(64))).toThrow()
  })
})

describe('zip', () => {
  it('crc32 matches known values', () => {
    expect(crc32('')).toBe(0)
    expect(crc32('123456789')).toBe(0xcbf43926)
    expect(crc32('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339)
    expect(crc32(new Uint8Array([0]))).toBe(0xd202ef8d)
  })

  it('writes a well-formed store-only archive', () => {
    const files = [
      { name: 'manifest.json', data: '{"version":1}' },
      { name: 'on_3000.wav', data: new Uint8Array([1, 2, 3, 4, 5]) },
    ]
    const zip = createZip(files, { date: new Date(2026, 9, 27, 12, 30, 10) })
    const v = new DataView(zip.buffer)
    expect(v.getUint32(0, true)).toBe(0x04034b50)
    const eocd = zip.length - 22
    expect(v.getUint32(eocd, true)).toBe(0x06054b50)
    expect(v.getUint16(eocd + 10, true)).toBe(2)
    let cd = v.getUint32(eocd + 16, true)
    const dec = new TextDecoder()
    for (const f of files) {
      expect(v.getUint32(cd, true)).toBe(0x02014b50)
      const nameLen = v.getUint16(cd + 28, true)
      expect(dec.decode(zip.subarray(cd + 46, cd + 46 + nameLen))).toBe(f.name)
      const size = v.getUint32(cd + 20, true)
      const local = v.getUint32(cd + 42, true)
      expect(v.getUint32(local, true)).toBe(0x04034b50)
      const data = zip.subarray(local + 30 + nameLen, local + 30 + nameLen + size)
      const expected = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data
      expect([...data]).toEqual([...expected])
      expect(v.getUint32(cd + 16, true)).toBe(crc32(expected))
      cd += 46 + nameLen
    }
  })
})
