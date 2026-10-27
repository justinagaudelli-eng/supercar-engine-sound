// Collapsible debug readout. DOM writes are throttled to ~5 Hz and skipped entirely while
// collapsed, so leaving it open costs very little on the car's CPU.

import { loadSettings, updateSettings } from './settings.js'

const MIN_INTERVAL_MS = 200
const METERS = ['exhaust', 'intake', 'mech', 'sample', 'master']
const METER_FLOOR_DB = -60

// [key, label, formatter]. Unknown stats keys are appended generically.
const ROWS = [
  ['rawSpeedMps', 'Raw speed', speed],
  ['speedMps', 'Filtered speed', speed],
  ['accelMps2', 'Accel', (v) => num(v, 2, ' m/s²')],
  ['load', 'Load (est.)', pct],
  ['throttle', 'Throttle (model)', pct],
  ['rpm', 'RPM', (v) => num(v, 0)],
  ['gear', 'Gear', (v) => (v === 0 ? 'N' : v ?? '–')],
  ['engineState', 'Engine state', str],
  ['source', 'Input source', str],
  ['gpsStatus', 'GPS status', str],
  ['accuracy', 'GPS accuracy', (v) => num(v, 1, ' m')],
  ['updateHz', 'GPS update rate', (v) => num(v, 2, ' Hz')],
  ['fixAgeMs', 'Last fix age', (v) => num(v / 1000, 2, ' s')],
  ['tickMs', 'Tick time', (v) => num(v, 2, ' ms')],
  ['frameBudgetMs', 'Frame budget', (v) => num(v, 1, ' ms')],
  ['cpu', 'CPU estimate', pct],
  ['wakeLock', 'Wake lock', str],
  ['ctxState', 'AudioContext', str],
  ['sampleRate', 'Sample rate', (v) => num(v, 0, ' Hz')],
  ['baseLatency', 'Base latency', (v) => num(v * 1000, 1, ' ms')],
  ['outputLatency', 'Output latency', (v) => num(v * 1000, 1, ' ms')],
  ['outputRoute', 'Output route', str],
]
const KNOWN = new Set([...ROWS.map((r) => r[0]), 'levels'])

export function createDebugPanel(el, { open, onToggle } = {}) {
  let isOpen = open ?? loadSettings().debugOpen
  let latest = null
  let lastWrite = 0
  let timer = null
  const cells = new Map()   // key → value <span>
  const meters = new Map()  // name → { fill, text }

  el.textContent = ''
  const root = document.createElement('div')
  root.className = 'debug-panel'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'debug-toggle'
  const body = document.createElement('div')
  body.className = 'debug-body'
  body.id = 'debug-body'
  toggle.setAttribute('aria-controls', body.id)
  root.append(toggle, body)
  el.append(root)

  const meterBox = document.createElement('div')
  meterBox.className = 'debug-meters'
  for (const [key, label] of ROWS) addRow(key, label)
  for (const name of METERS) addMeter(name)
  body.append(meterBox)

  toggle.addEventListener('click', () => setOpen(!isOpen, true))
  setOpen(isOpen, false)

  function addRow(key, label) {
    const row = document.createElement('div')
    row.className = 'debug-row'
    const k = document.createElement('span')
    k.textContent = label
    const v = document.createElement('span')
    v.textContent = '–'
    row.append(k, v)
    // Rows go before the meters block once it exists.
    if (meterBox.parentNode === body) body.insertBefore(row, meterBox)
    else body.append(row)
    cells.set(key, v)
    return v
  }

  function addMeter(name) {
    const row = document.createElement('div')
    row.className = 'meter'
    const label = document.createElement('span')
    label.textContent = name
    const bar = document.createElement('div')
    bar.className = 'meter-bar'
    const fill = document.createElement('div')
    fill.className = 'meter-fill'
    bar.append(fill)
    const text = document.createElement('span')
    text.textContent = '–'
    row.append(label, bar, text)
    meterBox.append(row)
    meters.set(name, { fill, text })
  }

  function setOpen(next, persist) {
    isOpen = next
    body.hidden = !isOpen
    toggle.setAttribute('aria-expanded', String(isOpen))
    toggle.textContent = isOpen ? '▾ Debug' : '▸ Debug'
    if (persist) {
      if (onToggle) onToggle(isOpen)
      else updateSettings({ debugOpen: isOpen })
    }
    if (isOpen && latest) write()
  }

  function write() {
    lastWrite = performance.now()
    timer = null
    const s = latest
    if (!s) return
    for (const [key, , fmt] of ROWS) setText(cells.get(key), key in s ? fmt(s[key]) : '–')
    for (const key of Object.keys(s)) {
      if (KNOWN.has(key)) continue
      const cell = cells.get(key) || addRow(key, key)
      setText(cell, generic(s[key]))
    }
    const levels = s.levels || {}
    for (const [name, m] of meters) {
      const db = levels[name]
      const ok = Number.isFinite(db)
      const f = ok ? Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0
      m.fill.style.width = `${(f * 100).toFixed(1)}%`
      m.fill.dataset.hot = ok && db > -6 ? '1' : '0'
      m.fill.dataset.clip = ok && db > -0.5 ? '1' : '0'
      setText(m.text, ok ? `${db.toFixed(1)} dB` : '–')
    }
  }

  return {
    update(stats) {
      latest = stats
      if (!isOpen) return
      const since = performance.now() - lastWrite
      if (since >= MIN_INTERVAL_MS) write()
      else if (!timer) timer = setTimeout(write, MIN_INTERVAL_MS - since)
    },
    setOpen(next) { setOpen(!!next, true) },
    get open() { return isOpen },
  }
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text
}

function num(v, digits, suffix = '') {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : '–'
}
function pct(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–' }
function str(v) { return v == null || v === '' ? '–' : String(v) }
function speed(v) {
  return Number.isFinite(v) ? `${(v * 2.236936).toFixed(1)} mph (${v.toFixed(2)} m/s)` : '–'
}
function generic(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (v && typeof v === 'object') { try { return JSON.stringify(v) } catch { return '[object]' } }
  return str(v)
}
