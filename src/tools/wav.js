// Minimal RIFF/WAVE support: 16-bit PCM encoder, header parser, PCM decoder (8/16/24/32-bit
// int and 32-bit float). Used by the slicer to write loops and to detect a file's sample rate.

/**
 * channels: Float32Array (mono) or Float32Array[] (one per channel, equal lengths).
 * Returns a Uint8Array holding a complete 16-bit PCM WAV file.
 */
export function encodeWav(channels, sampleRate) {
  const chans = Array.isArray(channels) ? channels : [channels]
  const numCh = chans.length
  const frames = chans[0]?.length ?? 0
  const blockAlign = numCh * 2
  const dataBytes = frames * blockAlign
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)

  writeAscii(v, 0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  writeAscii(v, 8, 'WAVE')
  writeAscii(v, 12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)                      // PCM
  v.setUint16(22, numCh, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 16, true)
  writeAscii(v, 36, 'data')
  v.setUint32(40, dataBytes, true)

  let o = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      v.setInt16(o, floatToInt16(chans[c][i]), true)
      o += 2
    }
  }
  return new Uint8Array(buf)
}

export function floatToInt16(x) {
  const s = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

/** Parses the RIFF header. Throws on anything that isn't a WAV with fmt + data chunks. */
export function decodeWavHeader(bytes) {
  const u8 = toU8(bytes)
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (u8.byteLength < 12 || readAscii(v, 0, 4) !== 'RIFF' || readAscii(v, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= u8.byteLength) {
    const id = readAscii(v, off, 4)
    const size = v.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      let format = v.getUint16(body, true)
      const bitsPerSample = v.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bitsPerSample,
      }
    } else if (id === 'data') {
      data = { dataOffset: body, dataLength: Math.min(size, u8.byteLength - body) }
      if (fmt) break
    }
    off = body + size + (size & 1)
  }
  if (!fmt) throw new Error('WAV has no fmt chunk')
  if (!data) throw new Error('WAV has no data chunk')
  return { ...fmt, ...data, frames: Math.floor(data.dataLength / fmt.blockAlign) }
}

/** Decodes PCM/float WAV into Float32Array channels. */
export function decodeWav(bytes) {
  const u8 = toU8(bytes)
  const h = decodeWavHeader(u8)
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const bytesPer = h.bitsPerSample / 8
  const read = sampleReader(v, h.format, h.bitsPerSample)
  const channels = Array.from({ length: h.channels }, () => new Float32Array(h.frames))
  for (let i = 0; i < h.frames; i++) {
    const base = h.dataOffset + i * h.blockAlign
    for (let c = 0; c < h.channels; c++) channels[c][i] = read(base + c * bytesPer)
  }
  return { sampleRate: h.sampleRate, channels }
}

function sampleReader(v, format, bits) {
  if (format === 3 && bits === 32) return (o) => v.getFloat32(o, true)
  if (format !== 1) throw new Error(`Unsupported WAV format ${format}`)
  if (bits === 16) return (o) => v.getInt16(o, true) / 0x8000
  if (bits === 8) return (o) => (v.getUint8(o) - 128) / 128
  if (bits === 24) {
    return (o) => {
      let x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)
      if (x & 0x800000) x |= ~0xffffff
      return x / 0x800000
    }
  }
  if (bits === 32) return (o) => v.getInt32(o, true) / 0x80000000
  throw new Error(`Unsupported WAV bit depth ${bits}`)
}

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  throw new Error('Expected bytes')
}

function writeAscii(v, off, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
}

function readAscii(v, off, n) {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(off + i))
  return s
}
