// Tiny store-only (no compression) ZIP writer. WAV data barely compresses anyway, and this
// keeps the slicer dependency-free.

let crcTable = null

function table() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

/** CRC-32 (IEEE 802.3, as used by ZIP/PNG/gzip). Accepts bytes or a string (UTF-8). */
export function crc32(data, crc = 0) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const t = table()
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * files: [{ name, data: Uint8Array | string, date? }] → Uint8Array (a complete .zip).
 * Names are stored as UTF-8 (general-purpose flag bit 11).
 */
export function createZip(files, { date = new Date() } = {}) {
  const enc = new TextEncoder()
  const entries = files.map((f) => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data
    return { name: enc.encode(f.name), data, crc: crc32(data), ...dosDateTime(f.date ?? date) }
  })

  let localSize = 0
  let centralSize = 0
  for (const e of entries) {
    localSize += 30 + e.name.length + e.data.length
    centralSize += 46 + e.name.length
  }
  const out = new Uint8Array(localSize + centralSize + 22)
  const v = new DataView(out.buffer)
  let o = 0

  for (const e of entries) {
    e.offset = o
    v.setUint32(o, 0x04034b50, true)
    v.setUint16(o + 4, 20, true)          // version needed
    v.setUint16(o + 6, 0x0800, true)      // UTF-8 names
    v.setUint16(o + 8, 0, true)           // stored
    v.setUint16(o + 10, e.time, true)
    v.setUint16(o + 12, e.date, true)
    v.setUint32(o + 14, e.crc, true)
    v.setUint32(o + 18, e.data.length, true)
    v.setUint32(o + 22, e.data.length, true)
    v.setUint16(o + 26, e.name.length, true)
    v.setUint16(o + 28, 0, true)
    out.set(e.name, o + 30)
    out.set(e.data, o + 30 + e.name.length)
    o += 30 + e.name.length + e.data.length
  }

  const centralStart = o
  for (const e of entries) {
    v.setUint32(o, 0x02014b50, true)
    v.setUint16(o + 4, 20, true)          // version made by
    v.setUint16(o + 6, 20, true)
    v.setUint16(o + 8, 0x0800, true)
    v.setUint16(o + 10, 0, true)
    v.setUint16(o + 12, e.time, true)
    v.setUint16(o + 14, e.date, true)
    v.setUint32(o + 16, e.crc, true)
    v.setUint32(o + 20, e.data.length, true)
    v.setUint32(o + 24, e.data.length, true)
    v.setUint16(o + 28, e.name.length, true)
    // extra len, comment len, disk start, internal attrs, external attrs: all zero
    v.setUint32(o + 42, e.offset, true)
    out.set(e.name, o + 46)
    o += 46 + e.name.length
  }

  v.setUint32(o, 0x06054b50, true)
  v.setUint16(o + 8, entries.length, true)
  v.setUint16(o + 10, entries.length, true)
  v.setUint32(o + 12, o - centralStart, true)
  v.setUint32(o + 16, centralStart, true)
  return out
}
