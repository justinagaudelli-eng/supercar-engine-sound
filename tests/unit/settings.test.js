import { describe, it, expect } from 'vitest'
import {
  loadSettings, saveSettings, updateSettings, sanitizeSettings, DEFAULT_SETTINGS, SETTINGS_KEY,
} from '../../src/ui/settings.js'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    map,
  }
}

const throwing = {
  getItem() { throw new Error('SecurityError') },
  setItem() { throw new Error('QuotaExceededError') },
}

describe('settings', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      volume: 0.7, blend: 0.7, preset: 'street', source: 'gps', units: 'mph', outputRoute: 'direct', debugOpen: false,
    })
    expect(SETTINGS_KEY).toBe('gt3rs-settings-v1')
  })

  it('returns defaults when storage throws, and save reports failure', () => {
    expect(loadSettings(throwing)).toEqual({ ...DEFAULT_SETTINGS })
    expect(saveSettings({ volume: 0.2 }, throwing)).toBe(false)
    expect(updateSettings({ volume: 0.2 }, throwing).volume).toBe(0.2)
  })

  it('returns defaults when storage is missing', () => {
    expect(loadSettings(null)).toEqual({ ...DEFAULT_SETTINGS })
    expect(saveSettings(DEFAULT_SETTINGS, null)).toBe(false)
  })

  it('survives garbage JSON', () => {
    for (const junk of ['{not json', 'null', '42', '"str"', '[1,2]', '']) {
      expect(loadSettings(memoryStorage({ [SETTINGS_KEY]: junk }))).toEqual({ ...DEFAULT_SETTINGS })
    }
  })

  it('validates and clamps loaded values', () => {
    const s = loadSettings(memoryStorage({
      [SETTINGS_KEY]: JSON.stringify({
        volume: 7, blend: -1, preset: 'drift', source: 'sim', units: 'furlongs', outputRoute: 'mediaElement',
        debugOpen: 'yes', extra: 'dropped',
      }),
    }))
    expect(s).toMatchObject({ volume: 1, blend: 0, preset: 'street', source: 'sim', units: 'mph', outputRoute: 'mediaElement', debugOpen: false })
    expect(s).not.toHaveProperty('extra')
    expect(sanitizeSettings({ volume: NaN, blend: "0.25" })).toMatchObject({ volume: 0.7, blend: 0.25 })
  })

  it('roundtrips through storage and merges updates', () => {
    const store = memoryStorage()
    expect(saveSettings({ ...DEFAULT_SETTINGS, preset: 'track', volume: 0.4 }, store)).toBe(true)
    expect(loadSettings(store)).toMatchObject({ preset: 'track', volume: 0.4 })
    updateSettings({ debugOpen: true }, store)
    expect(loadSettings(store)).toMatchObject({ preset: 'track', volume: 0.4, debugOpen: true })
  })
})
