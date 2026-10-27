// Persisted user settings. Every storage access is wrapped: the Tesla browser (and private
// windows) can throw on localStorage, and a corrupt entry must never break startup.

export const SETTINGS_KEY = 'gt3rs-settings-v1'

export const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.7,
  mix: 0,                  // 0 = synth only, 1 = samples only
  preset: 'street',
  source: 'gps',
  units: 'mph',
  outputRoute: 'direct',
  debugOpen: false,
  releaseToZero: true,     // simulator throttle/brake spring back when released
  replayFixture: '',
})

const ENUMS = {
  preset: ['street', 'track', 'cabin'],
  source: ['gps', 'sim', 'replay'],
  units: ['mph', 'kmh'],
  outputRoute: ['direct', 'mediaElement'],
}

function unit(x, fallback) {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
}

/** Returns a complete, valid settings object built from anything (unknown keys dropped). */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULT_SETTINGS }
  out.volume = unit(src.volume, DEFAULT_SETTINGS.volume)
  out.mix = unit(src.mix, DEFAULT_SETTINGS.mix)
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(src[key])) out[key] = src[key]
  }
  if (typeof src.debugOpen === 'boolean') out.debugOpen = src.debugOpen
  if (typeof src.releaseToZero === 'boolean') out.releaseToZero = src.releaseToZero
  if (typeof src.replayFixture === 'string' && src.replayFixture.length < 200) {
    out.replayFixture = src.replayFixture
  }
  return out
}

function getStorage(storage) {
  if (storage !== undefined) return storage
  try { return globalThis.localStorage ?? null } catch { return null }
}

/** Never throws. Missing, unreadable or garbage data → defaults. */
export function loadSettings(storage) {
  try {
    const s = getStorage(storage)
    const text = s ? s.getItem(SETTINGS_KEY) : null
    return sanitizeSettings(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Never throws. Returns true if the write succeeded. */
export function saveSettings(settings, storage) {
  try {
    const s = getStorage(storage)
    if (!s) return false
    s.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)))
    return true
  } catch {
    return false
  }
}

/** Load, merge a partial patch, save. Safe for independent writers (e.g. debug panel). */
export function updateSettings(patch, storage) {
  const next = sanitizeSettings({ ...loadSettings(storage), ...patch })
  saveSettings(next, storage)
  return next
}
