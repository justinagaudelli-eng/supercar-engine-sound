// Sample manifest parser (format: ARCHITECTURE.md "Sample manifest").
//
// parseManifest(json, baseUrl) → {
//   version, name,
//   loops: [...all loops sorted by rpm],
//   layers: { on: [...], off: [...] },   // each sorted by rpm; a missing layer reuses the other
//   hasOn, hasOff,
// }
// Each loop: { file, url, rpm, layer, loopStart, loopEnd /* null = whole file */, gain }.
// Throws Error with a descriptive message (path + offending value) on invalid input.

const LAYERS = ['on', 'off']

function fail(path, msg, value) {
  const got = value === undefined ? '' : ` (got ${JSON.stringify(value)})`
  throw new Error(`sample manifest: ${path} ${msg}${got}`)
}

function resolveBase(baseUrl) {
  if (baseUrl == null || baseUrl === '') {
    if (typeof location !== 'undefined') return location.href
    fail('baseUrl', 'is required outside a browser')
  }
  try {
    return new URL(baseUrl, typeof location !== 'undefined' ? location.href : undefined).href
  } catch {
    return fail('baseUrl', 'is not a valid URL', baseUrl)
  }
}

export function parseManifest(json, baseUrl) {
  let m = json
  if (typeof m === 'string') {
    try { m = JSON.parse(m) } catch (e) { fail('', `is not valid JSON: ${e.message}`) }
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) fail('root', 'must be an object', m)
  const version = m.version === undefined ? 1 : m.version
  if (version !== 1) fail('version', 'is unsupported (expected 1)', m.version)
  if (m.name !== undefined && typeof m.name !== 'string') fail('name', 'must be a string', m.name)
  if (!Array.isArray(m.loops)) fail('loops', 'must be an array', m.loops)
  if (m.loops.length === 0) fail('loops', 'must contain at least one loop')

  const base = resolveBase(baseUrl)
  const loops = m.loops.map((raw, i) => {
    const p = `loops[${i}]`
    if (raw === null || typeof raw !== 'object') fail(p, 'must be an object', raw)
    if (typeof raw.file !== 'string' || raw.file.trim() === '') fail(`${p}.file`, 'must be a non-empty string', raw.file)
    if (typeof raw.rpm !== 'number' || !Number.isFinite(raw.rpm) || raw.rpm <= 0) {
      fail(`${p}.rpm`, 'must be a positive number', raw.rpm)
    }
    const layer = raw.layer === undefined ? 'on' : raw.layer
    if (!LAYERS.includes(layer)) fail(`${p}.layer`, 'must be "on" or "off"', raw.layer)
    const loopStart = raw.loopStart === undefined ? 0 : raw.loopStart
    if (typeof loopStart !== 'number' || !Number.isFinite(loopStart) || loopStart < 0) {
      fail(`${p}.loopStart`, 'must be a number ≥ 0 (seconds)', raw.loopStart)
    }
    let loopEnd = raw.loopEnd === undefined ? null : raw.loopEnd
    if (loopEnd !== null) {
      if (typeof loopEnd !== 'number' || !Number.isFinite(loopEnd)) fail(`${p}.loopEnd`, 'must be a number (seconds)', raw.loopEnd)
      if (loopEnd <= loopStart) fail(`${p}.loopEnd`, `must be greater than loopStart (${loopStart})`, raw.loopEnd)
    }
    const gain = raw.gain === undefined ? 1 : raw.gain
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0) fail(`${p}.gain`, 'must be a number ≥ 0', raw.gain)
    let url
    try { url = new URL(raw.file, base).href } catch { fail(`${p}.file`, 'cannot be resolved to a URL', raw.file) }
    return { file: raw.file, url, rpm: raw.rpm, layer, loopStart, loopEnd, gain }
  })

  loops.sort((a, b) => a.rpm - b.rpm)
  const layers = {}
  for (const name of LAYERS) {
    layers[name] = loops.filter((l) => l.layer === name)
    for (let i = 1; i < layers[name].length; i++) {
      if (layers[name][i].rpm === layers[name][i - 1].rpm) {
        fail('loops', `has two "${name}" loops at the same rpm ${layers[name][i].rpm}`)
      }
    }
  }
  const hasOn = layers.on.length > 0
  const hasOff = layers.off.length > 0
  if (!hasOn) layers.on = layers.off
  if (!hasOff) layers.off = layers.on

  const credits = Array.isArray(m.credits) ? m.credits.filter((c) => c && typeof c === 'object') : []
  return { version, name: m.name ?? '', loops, layers, hasOn, hasOff, credits }
}
