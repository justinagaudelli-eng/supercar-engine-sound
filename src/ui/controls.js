// Wires the static markup in index.html to callbacks and exposes setters for displayed
// state. Controls never own app state: main.js calls the setters to reflect reality.

const SOURCE_LABELS = { gps: 'GPS', sim: 'Simulator', replay: 'Replay' }

export function createControls(rootEl = document, handlers = {}) {
  const $ = (id) => rootEl.querySelector?.(`#${id}`) || document.getElementById(id)
  const call = (name, ...args) => {
    try { handlers[name]?.(...args) } catch (err) { console.error(`${name} handler failed`, err) }
  }

  const el = {
    engine: $('btn-engine'),
    volume: $('volume'), volumeOut: $('volume-value'),
    mix: $('mix'), mixOut: $('mix-value'),
    preset: $('preset'), source: $('source'), units: $('units'), route: $('output-route'),
    simPanel: $('sim-panel'), replayPanel: $('replay-panel'),
    throttle: $('sim-throttle'), brake: $('sim-brake'), freeRev: $('btn-free-rev'),
    releaseToZero: $('release-to-zero'),
    fixture: $('replay-fixture'), replayFile: $('replay-file'),
    replayPlay: $('btn-replay-play'), replayStop: $('btn-replay-stop'),
    record: $('btn-record'), recordLabel: $('record-label'), tone: $('btn-tone'),
    gps: $('gps-status'), gpsText: $('gps-status-text'),
    message: $('message'), overlay: $('resume-overlay'), resume: $('btn-resume'),
  }

  let engineState = 'off'
  let toneOn = false
  let releaseToZero = true
  let messageTimer = null
  let lastGpsText = ''

  // ---- engine ----
  // onStart must run synchronously inside the click so AudioContext.resume() counts as a gesture.
  el.engine?.addEventListener('click', () => {
    if (engineState === 'off' || engineState === 'stopping') call('onStart')
    else call('onStop')
  })

  // ---- sliders ----
  bindRange(el.volume, el.volumeOut, (v) => call('onVolume', v))
  bindRange(el.mix, el.mixOut, (v) => call('onMix', v))

  // ---- segmented groups ----
  const preset = bindSegmented(el.preset, (v) => call('onPreset', v))
  const source = bindSegmented(el.source, (v) => { showSourcePanels(v); call('onSource', v) })
  const units = bindSegmented(el.units, (v) => call('onUnits', v))
  const route = bindSegmented(el.route, (v) => call('onOutputRoute', v))

  function showSourcePanels(name) {
    if (el.simPanel) el.simPanel.hidden = name !== 'sim'
    if (el.replayPanel) el.replayPanel.hidden = name !== 'replay'
    if (name !== 'sim') { throttle.set(0, true); brake.set(0, true); setFreeRev(false) }
  }

  // ---- simulator ----
  const throttle = bindVSlider(el.throttle, (v) => call('onThrottle', v), () => releaseToZero)
  const brake = bindVSlider(el.brake, (v) => call('onBrake', v), () => releaseToZero)

  let freeRevOn = false
  function setFreeRev(on) {
    if (on === freeRevOn) return
    freeRevOn = on
    el.freeRev?.setAttribute('aria-pressed', String(on))
    call('onFreeRev', on)
  }
  if (el.freeRev) {
    const b = el.freeRev
    b.addEventListener('pointerdown', (e) => {
      try { b.setPointerCapture(e.pointerId) } catch { /* not capturable */ }
      setFreeRev(true)
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      b.addEventListener(type, () => setFreeRev(false))
    }
    b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFreeRev(true) } })
    b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setFreeRev(false) })
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  el.releaseToZero?.addEventListener('change', () => {
    releaseToZero = el.releaseToZero.checked
    if (releaseToZero) { throttle.set(0); brake.set(0) }
    call('onReleaseToZero', releaseToZero)
  })

  // ---- replay ----
  el.fixture?.addEventListener('change', () => call('onReplaySelect', el.fixture.value))
  el.replayFile?.addEventListener('change', async () => {
    const file = el.replayFile.files?.[0]
    if (!file) return
    try {
      const json = JSON.parse(await file.text())
      call('onReplayFile', json, file.name)
    } catch (err) {
      api.setMessage(`Could not read ${file.name}: ${err.message}`, 'error')
    } finally {
      el.replayFile.value = ''
    }
  })
  el.replayPlay?.addEventListener('click', () => call('onReplayPlay'))
  el.replayStop?.addEventListener('click', () => call('onReplayStop'))

  // ---- record / test tone ----
  el.record?.addEventListener('click', () => call('onRecordToggle'))
  el.tone?.addEventListener('click', () => {
    toneOn = !toneOn
    el.tone.setAttribute('aria-pressed', String(toneOn))
    call('onTestTone', toneOn)
  })

  // ---- resume overlay ----
  el.resume?.addEventListener('click', () => {
    if (handlers.onResume) call('onResume')
    else call('onStart')
  })

  const api = {
    setEngineState(state) {
      engineState = state || 'off'
      if (!el.engine) return
      el.engine.dataset.state = engineState
      el.engine.textContent = {
        off: 'Start Engine', cranking: 'Starting…', running: 'Stop Engine', stopping: 'Start Engine',
      }[engineState] ?? 'Start Engine'
    },

    setSource(name) {
      source.select(name)
      showSourcePanels(name)
    },

    setRecording(on, elapsedS = 0) {
      if (!el.record) return
      el.record.setAttribute('aria-pressed', String(!!on))
      const text = on ? `Stop recording ${formatClock(elapsedS)}` : 'Record drive'
      if (el.recordLabel && el.recordLabel.textContent !== text) el.recordLabel.textContent = text
    },

    setTestTone(on) {
      toneOn = !!on
      el.tone?.setAttribute('aria-pressed', String(toneOn))
    },

    setReplayState(playing) {
      if (el.replayPlay) el.replayPlay.disabled = !!playing
      if (el.replayStop) el.replayStop.disabled = !playing
    },

    setGpsStatus(info = {}) {
      const text = formatGps(info)
      const status = info.status || 'waiting'
      if (el.gps && el.gps.dataset.status !== status) el.gps.dataset.status = status
      if (text !== lastGpsText && el.gpsText) { el.gpsText.textContent = text; lastGpsText = text }
    },

    setFixtures(list = [], selected) {
      if (!el.fixture) return
      const keep = selected ?? el.fixture.value
      el.fixture.textContent = ''
      el.fixture.append(new Option('— choose a fixture —', ''))
      for (const item of list) {
        const name = typeof item === 'string' ? item : item.name
        const opt = new Option(fixtureLabel(item), name)
        if (item.description) opt.title = item.description
        el.fixture.append(opt)
      }
      el.fixture.value = list.some((i) => (typeof i === 'string' ? i : i.name) === keep) ? keep : ''
    },

    setSettings(s = {}) {
      if (s.volume != null) setRange(el.volume, el.volumeOut, s.volume)
      if (s.mix != null) setRange(el.mix, el.mixOut, s.mix)
      if (s.preset) preset.select(s.preset)
      if (s.source) api.setSource(s.source)
      if (s.units) units.select(s.units)
      if (s.outputRoute) route.select(s.outputRoute)
      if (typeof s.releaseToZero === 'boolean') {
        releaseToZero = s.releaseToZero
        if (el.releaseToZero) el.releaseToZero.checked = releaseToZero
      }
      if (s.replayFixture != null && el.fixture) {
        const has = [...el.fixture.options].some((o) => o.value === s.replayFixture)
        if (has) el.fixture.value = s.replayFixture
      }
    },

    showResumeOverlay(show) {
      if (el.overlay) el.overlay.hidden = !show
    },

    setMessage(text, level = 'info', { timeoutMs = 0 } = {}) {
      if (!el.message) return
      clearTimeout(messageTimer)
      el.message.hidden = !text
      el.message.textContent = text || ''
      el.message.dataset.level = level
      if (text && timeoutMs > 0) messageTimer = setTimeout(() => { el.message.hidden = true }, timeoutMs)
    },

    /** Current simulator pedal positions (0..1). */
    get sim() { return { throttle: throttle.value, brake: brake.value, freeRev: freeRevOn } },
  }

  api.setEngineState('off')
  api.setReplayState(false)
  return api
}

// ---------- helpers ----------

function setRange(input, out, v01) {
  if (!input) return
  const v = Math.round(Math.max(0, Math.min(1, v01)) * 100)
  input.value = String(v)
  if (out) out.textContent = String(v)
}

function bindRange(input, out, onChange) {
  if (!input) return
  input.addEventListener('input', () => {
    if (out) out.textContent = input.value
    onChange(Number(input.value) / 100)
  })
}

function bindSegmented(group, onChange) {
  const buttons = group ? [...group.querySelectorAll('button[data-value]')] : []
  let current = null
  function select(value) {
    if (!buttons.some((b) => b.dataset.value === value)) return false
    current = value
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value))
    return true
  }
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (b.dataset.value === current) return
      select(b.dataset.value)
      onChange(b.dataset.value)
    })
  }
  return { select, get value() { return current } }
}

// Large custom vertical slider: works with touch, mouse and keyboard; multi-touch safe
// (throttle and brake can be held at once) because each element captures its own pointer.
function bindVSlider(node, onChange, springBack) {
  let value = 0
  let activePointer = null
  const fill = node?.querySelector('.vslider-fill')
  const label = node?.querySelector('.vslider-value')

  function set(v, silent = false) {
    const nv = Math.max(0, Math.min(1, v))
    const changed = Math.abs(nv - value) > 1e-4
    value = nv
    const pct = Math.round(nv * 100)
    if (fill) fill.style.height = `${pct}%`
    if (label) label.textContent = `${pct}%`
    node?.setAttribute('aria-valuenow', String(pct))
    if (changed && !silent) onChange(nv)
  }

  function fromEvent(e) {
    const rect = node.getBoundingClientRect()
    // Small dead zones at both ends make 0% and 100% easy to hit.
    const pad = Math.min(16, rect.height * 0.06)
    const y = (rect.bottom - pad - e.clientY) / Math.max(1, rect.height - 2 * pad)
    return Math.max(0, Math.min(1, y))
  }

  if (node) {
    node.addEventListener('pointerdown', (e) => {
      activePointer = e.pointerId
      try { node.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      set(fromEvent(e))
      e.preventDefault()
    })
    node.addEventListener('pointermove', (e) => {
      if (e.pointerId === activePointer) set(fromEvent(e))
    })
    const end = (e) => {
      if (e.pointerId !== activePointer) return
      activePointer = null
      if (springBack()) set(0)
    }
    node.addEventListener('pointerup', end)
    node.addEventListener('pointercancel', end)
    node.addEventListener('keydown', (e) => {
      const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.25, PageDown: -0.25 }[e.key]
      if (step != null) { set(value + step); e.preventDefault() }
      else if (e.key === 'Home') { set(0); e.preventDefault() }
      else if (e.key === 'End') { set(1); e.preventDefault() }
    })
    node.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  return { set, get value() { return value } }
}

function fixtureLabel(item) {
  if (typeof item === 'string') return item
  const base = item.label || item.name
  return Number.isFinite(item.durationS) ? `${base} (${formatClock(item.durationS)})` : base
}

function formatClock(s) {
  const t = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function formatGps({ source, status = 'waiting', accuracy, updateHz, ageMs } = {}) {
  const src = SOURCE_LABELS[source] || (source ? String(source) : 'GPS')
  if (status === 'denied') return `${src} · location permission denied`
  if (status === 'unsupported') return `${src} · not available in this browser`
  if (status === 'error') return `${src} · error`
  const parts = [src]
  if (Number.isFinite(accuracy)) parts.push(`±${accuracy < 10 ? accuracy.toFixed(1) : Math.round(accuracy)} m`)
  if (Number.isFinite(updateHz) && updateHz > 0) parts.push(`${updateHz.toFixed(1)} Hz`)
  if ((status === 'stale' || status === 'lost') && Number.isFinite(ageMs)) {
    parts.push(`${status} ${(ageMs / 1000).toFixed(0)} s`)
  } else {
    parts.push(status)
  }
  return parts.join(' · ')
}
