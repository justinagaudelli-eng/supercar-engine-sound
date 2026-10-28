// App orchestration: input sources → pipeline (filter + rpm model) → audio engine + UI.

import { inputConfig } from './input/config.js'
import { vehicleConfig } from './vehicle/config.js'
import { createPipeline } from './pipeline.js'
import { createGpsSource } from './input/gps.js'
import { createSimulator } from './input/simulator.js'
import { createReplay, validateTrace } from './input/replay.js'
import { createEngine } from './audio/engine.js'
import { audioConfig } from './audio/config.js'
import { createTach } from './ui/tach.js'
import { createControls } from './ui/controls.js'
import { createDebugPanel } from './ui/debugPanel.js'
import { loadSettings, updateSettings } from './ui/settings.js'

const MPS_TO_MPH = 2.236936
const TICK_MS = 1000 / 60
const SESSION_KEY = 'gt3rs-session-v1'          // engine running → survive a mid-drive reload
const RESUME_WINDOW_MS = 10 * 60 * 1000
const REC_CURRENT_KEY = 'gt3rs-rec-current-v1'  // in-progress recording (crash-safe)
const REC_SAVED_KEY = 'gt3rs-recordings-v1'     // last few finished recordings
const REC_KEEP = 3

// Bundled replay fixtures (fixtures/*.json), keyed by name.
const fixtureModules = import.meta.glob('../fixtures/*.json', { eager: true, import: 'default' })
const fixtures = Object.values(fixtureModules)
  .filter((f) => f && Array.isArray(f.fixes))
  .sort((a, b) => a.name.localeCompare(b.name))
const fixtureByName = new Map(fixtures.map((f) => [f.name, f]))

// ?replayRate=8 plays replays faster (used by the end-to-end tests).
const replayRate = Math.max(0.25, Math.min(32, Number(new URLSearchParams(location.search).get('replayRate')) || 1))

let settings = loadSettings()
const state = {
  ctx: null,
  engine: null,
  engineWanted: false,      // user tapped Start (and not Stop)
  source: settings.source,
  freeRev: false,
  replay: null,
  replayTrace: null,
  recordingSince: null,
  wakeLock: null,
  wakeLockState: 'none',
  lastFrame: null,
  lastEstimate: null,
  lastPollMs: 0,
  tickMs: 0,
  errors: [],
  enginePromise: null,
  suspendTimer: null,
  toneOn: false,
  recordFlushMs: 0,
  // Audio watchdog: the car can silence us while the context still says 'running'.
  watchdog: {
    lastCtxT: null, lastWallMs: null, stalledS: 0,
    reset() { this.lastCtxT = null; this.lastWallMs = null; this.stalledS = 0 },
  },
}

const pipeline = createPipeline()
const simulator = createSimulator()
let gpsStatus = 'idle'
const gps = createGpsSource(inputConfig.gps, {
  onSample: (s) => { if (state.source === 'gps') pipeline.bus.push(s) },
  onStatus: (s, detail) => {
    gpsStatus = s
    if (s === 'denied') controls.setMessage('Location permission denied — allow it in the browser, or use Simulator/Replay.', 'error')
    else if (s === 'unsupported') controls.setMessage('This browser has no geolocation.', 'error')
    else if (s === 'unavailable') controls.setMessage(`GPS unavailable${detail ? `: ${detail}` : ''}`, 'warn', { timeoutMs: 6000 })
  },
})

// ---------- UI ----------
const tach = createTach(document.getElementById('tach'), {
  redlineRpm: vehicleConfig.engine.redlineRpm,
  maxRpm: 10000,
  units: settings.units,
})
const debug = createDebugPanel(document.getElementById('debug'), {
  open: settings.debugOpen,
  onToggle: (open) => { settings = updateSettings({ debugOpen: open }) },
})
const controls = createControls(document, {
  onStart: () => startEngine(),
  onStop: stopEngine,
  onResume: () => resumeAudio(),
  onVolume: (v) => { settings = updateSettings({ volume: v }); state.engine?.setVolume(v) },
  onMix: (v) => { settings = updateSettings({ mix: v }); state.engine?.setMix(v) },
  onPreset: (p) => { settings = updateSettings({ preset: p }); state.engine?.setPreset(p) },
  onSource: (s) => setSource(s),
  onUnits: (u) => { settings = updateSettings({ units: u }); tach.setUnits(u) },
  onOutputRoute: (r) => {
    settings = updateSettings({ outputRoute: r })
    controls.setMessage('Audio output route changes on the next Start Engine.', 'info', { timeoutMs: 4000 })
  },
  onReleaseToZero: (on) => { settings = updateSettings({ releaseToZero: on }) },
  onThrottle: (v) => simulator.setThrottle(v),
  onBrake: (v) => simulator.setBrake(v),
  onFreeRev: (on) => { state.freeRev = on },
  onReplaySelect: (name) => {
    settings = updateSettings({ replayFixture: name })
    state.replayTrace = fixtureByName.get(name) ?? null
  },
  onReplayFile: (json, fileName) => {
    try {
      state.replayTrace = validateTrace(typeof json === 'string' ? JSON.parse(json) : json)
      state.replayTrace.name ??= fileName
      controls.setMessage(`Loaded ${fileName ?? 'trace'} (${state.replayTrace.fixes.length} fixes)`, 'info', { timeoutMs: 4000 })
    } catch (e) {
      controls.setMessage(`Could not load trace: ${e.message}`, 'error', { timeoutMs: 8000 })
    }
  },
  onReplayPlay: playReplay,
  onReplayStop: stopReplay,
  onRecordToggle: toggleRecording,
  onTestTone: (on) => {
    if (!state.engine) { controls.setTestTone(false); controls.setMessage('Start the engine first (that unlocks audio).', 'info', { timeoutMs: 4000 }); return }
    state.toneOn = on
    state.engine.testTone(on)
  },
})
const recovered = recoverInterruptedRecording()
refreshFixtureList()
controls.setSettings(settings)
state.replayTrace = fixtureByName.get(settings.replayFixture) ?? null
controls.setReplayState(false)
controls.setEngineState('off')
if (recovered) controls.setMessage(`Recovered an interrupted recording (${recovered.fixes.length} fixes) — it's under Replay.`, 'info', { timeoutMs: 10000 })
// Page reloaded mid-drive: one tap brings the engine straight back (no cold start).
if (recentSession()) {
  state.engineWanted = true
  controls.showResumeOverlay(true)
}

// ---------- audio ----------
// Session marker: if the page reloads mid-drive (Tesla does this), the next tap resumes the
// engine straight to idle instead of a cold start.
function markSession(running) {
  try {
    if (running) localStorage.setItem(SESSION_KEY, JSON.stringify({ at: Date.now() }))
    else localStorage.removeItem(SESSION_KEY)
  } catch { /* storage unavailable: no reload recovery */ }
}
function recentSession() {
  try {
    const v = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    return v && Date.now() - v.at < RESUME_WINDOW_MS
  } catch { return false }
}

function createContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) throw new Error('Web Audio is not supported in this browser')
  // 'playback' latency: larger buffers, fewer glitches on a weak CPU; we don't need low latency.
  const ctx = new Ctx({ latencyHint: 'playback' })
  ctx.onstatechange = () => {
    controls.showResumeOverlay(state.engineWanted && ctx.state !== 'running')
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = ctx.state === 'running' ? 'playing' : 'paused' } catch { /* optional */ }
    }
  }
  return ctx
}

function startEngine({ warm = false } = {}) {
  state.engineWanted = true
  controls.setEngineState('cranking')
  try {
    // Create + resume synchronously inside the tap so the browser counts it as a gesture.
    state.ctx ??= createContext()
    state.ctx.resume().catch(() => {})
  } catch (e) {
    state.engineWanted = false
    fail('Audio could not start', e)
    return
  }
  requestWakeLock()
  if (state.source === 'gps') gps.start()
  setupMediaSession()

  // One shared build promise: repeated taps while the worklet loads never make two engines.
  state.enginePromise ??= buildEngine(state.ctx).catch((e) => {
    state.enginePromise = null
    throw e
  })
  state.enginePromise.then(() => {
    if (!state.engineWanted) return // Stop was tapped while loading
    if (warm) pipeline.model.forceRunning()
    else pipeline.model.start()
    markSession(true)
    controls.showResumeOverlay(state.ctx.state !== 'running')
  }).catch((e) => { state.engineWanted = false; fail('Audio engine failed to load', e) })
}

async function buildEngine(ctx) {
  state.enginesBuilt = (state.enginesBuilt ?? 0) + 1
  const engine = await createEngine(ctx, { ...audioConfig, outputRoute: settings.outputRoute }, {
    onRouteFallback: ({ error }) => {
      controls.setMessage(`Media-element output failed (${error}); using direct Web Audio.`, 'warn', { timeoutMs: 8000 })
    },
    onMediaPause: () => { if (state.engineWanted) controls.showResumeOverlay(true) },
  })
  engine.connect(ctx.destination)
  engine.setPreset(settings.preset)
  engine.setVolume(settings.volume)
  engine.setMix(settings.mix)
  state.engine = engine
  // Optional user samples; silently synth-only when absent.
  engine.loadSamples(new URL('samples/manifest.json', document.baseURI).href).catch(() => {})
  return engine
}

function stopEngine() {
  state.engineWanted = false
  pipeline.model.stop()
  controls.setEngineState('stopping')
  controls.showResumeOverlay(false)
  releaseWakeLock()
  markSession(false)
  if (state.engine && state.toneOn) { state.engine.testTone(false); state.toneOn = false; controls.setTestTone(false) }
  // After the shutdown sound, suspend audio so the car's media source (and CPU) is released.
  clearTimeout(state.suspendTimer)
  state.suspendTimer = setTimeout(() => {
    if (!state.engineWanted && state.ctx?.state === 'running') state.ctx.suspend().catch(() => {})
  }, (vehicleConfig.startup.shutdownS + 0.6) * 1000)
}

function resumeAudio() {
  if (!state.ctx) return startEngine({ warm: recentSession() })
  clearTimeout(state.suspendTimer)
  state.ctx.resume().then(() => controls.showResumeOverlay(false)).catch((e) => fail('Could not resume audio', e))
  if (state.engineWanted && pipeline.model.state === 'off') pipeline.model.start()
  state.watchdog.reset()
}

function fail(msg, err) {
  console.error(msg, err)
  state.errors.push(`${msg}: ${err?.message ?? err}`)
  controls.setMessage(`${msg}: ${err?.message ?? err}`, 'error')
  controls.setEngineState(pipeline.model.state)
}

// ---------- sources ----------
function setSource(name) {
  if (state.source === name) return
  if (state.recordingSince != null) toggleRecording()
  state.source = name
  settings = updateSettings({ source: name })
  controls.setSource(name)
  stopReplay()
  pipeline.bus.reset()
  simulator.reset()
  state.freeRev = false
  if (name === 'gps') { if (state.engineWanted) gps.start() } else gps.stop()
}

function playReplay() {
  if (!state.replayTrace) { controls.setMessage('Choose a fixture or load a JSON trace first.', 'info', { timeoutMs: 4000 }); return }
  pipeline.bus.reset()
  state.replay = createReplay(state.replayTrace, inputConfig.gps, {
    rate: replayRate,
    onSample: (s) => pipeline.bus.push(s),
    onEnd: () => { state.replay = null; controls.setReplayState(false) },
  })
  controls.setReplayState(true)
}

function stopReplay() {
  state.replay = null
  controls.setReplayState(false)
}

// Recordings are flushed to localStorage while driving (a mid-drive reload must not lose
// them) and the last few are kept so they can be replayed in the car or downloaded later.

function savedRecordings() {
  try { return JSON.parse(localStorage.getItem(REC_SAVED_KEY) || '[]').filter((r) => r && Array.isArray(r.fixes)) } catch { return [] }
}
function storeRecording(trace) {
  let list = [...savedRecordings(), trace]
  while (list.length) {
    list = list.slice(-REC_KEEP)
    try { localStorage.setItem(REC_SAVED_KEY, JSON.stringify(list)); return true } catch { list.shift() }
  }
  return false
}
function recoverInterruptedRecording() {
  try {
    const cur = JSON.parse(localStorage.getItem(REC_CURRENT_KEY) || 'null')
    localStorage.removeItem(REC_CURRENT_KEY)
    if (cur && Array.isArray(cur.fixes) && cur.fixes.length > 5) {
      storeRecording({ ...cur, name: `${cur.name} (recovered)` })
      return cur
    }
  } catch { /* ignore */ }
  return null
}
function flushRecording() {
  const trace = gps.peekRecording?.()
  if (!trace) return
  try { localStorage.setItem(REC_CURRENT_KEY, JSON.stringify(trace)) } catch { /* full: keep in memory */ }
}
function refreshFixtureList() {
  const recorded = savedRecordings()
  for (const r of recorded) fixtureByName.set(r.name, r)
  controls.setFixtures([
    ...recorded.map((r) => ({ name: r.name, description: r.description ?? 'Recorded drive', durationS: (r.fixes.at(-1)?.t ?? 0) / 1000 })),
    ...fixtures.map((f) => ({ name: f.name, description: f.description, durationS: f.durationS })),
  ], settings.replayFixture)
}

function toggleRecording() {
  if (state.recordingSince == null) {
    if (state.source !== 'gps') { controls.setMessage('Recording uses live GPS — switch input to GPS.', 'info', { timeoutMs: 4000 }); return }
    gps.start()
    gps.startRecording()
    state.recordingSince = performance.now()
    state.recordFlushMs = performance.now()
    controls.setRecording(true, 0)
  } else {
    const trace = gps.stopRecording()
    state.recordingSince = null
    controls.setRecording(false)
    try { localStorage.removeItem(REC_CURRENT_KEY) } catch { /* ignore */ }
    const kept = storeRecording(trace)
    refreshFixtureList()
    downloadJson(trace, `${trace.name}.json`)
    controls.setMessage(`Saved ${trace.fixes.length} fixes as ${trace.name}.json${kept ? ' (also kept under Replay)' : ''}`, 'info', { timeoutMs: 8000 })
  }
}

function downloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

// ---------- wake lock / visibility / media session ----------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) { state.wakeLockState = 'unsupported'; return }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen')
    state.wakeLockState = 'active'
    state.wakeLock.addEventListener('release', () => { state.wakeLockState = 'released' })
  } catch (e) {
    state.wakeLockState = `denied (${e.name})`
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {})
  state.wakeLock = null
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (state.engineWanted) {
    requestWakeLock() // locks are dropped when the page is hidden
    if (state.ctx && state.ctx.state !== 'running') controls.showResumeOverlay(true)
  }
})

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'GT3 RS engine', artist: 'Procedural flat-six' })
    navigator.mediaSession.setActionHandler('play', () => resumeAudio())
    navigator.mediaSession.setActionHandler('pause', () => state.ctx?.suspend())
  } catch { /* optional */ }
}

// ---------- main loop ----------
let lastTick = performance.now()
let lastUiState = ''

function tick() {
  const t0 = performance.now()
  const dt = (t0 - lastTick) / 1000
  lastTick = t0

  try {
    if (state.source === 'sim') pipeline.bus.push(simulator.step(dt, t0))
    else if (state.source === 'replay') state.replay?.step(t0)

    const { estimate, frame } = pipeline.tick(t0, { freeRev: state.source === 'sim' && state.freeRev })
    state.lastEstimate = estimate
    state.lastFrame = frame

    // watchPosition sometimes goes quiet on the car: poll as a fallback.
    if (state.source === 'gps' && state.engineWanted && estimate.ageMs != null &&
        estimate.ageMs > inputConfig.gps.pollAfterMs && t0 - state.lastPollMs > inputConfig.gps.pollEveryMs) {
      state.lastPollMs = t0
      gps.poll()
    }

    if (state.engine && state.ctx) state.engine.setFrame(frame, state.ctx.currentTime)

    const uiKey = frame.engineState
    if (uiKey !== lastUiState) { lastUiState = uiKey; controls.setEngineState(frame.engineState) }
    if (state.recordingSince != null) {
      controls.setRecording(true, (t0 - state.recordingSince) / 1000)
      if (t0 - state.recordFlushMs > 10_000) { state.recordFlushMs = t0; flushRecording() }
    }
    if (state.engineWanted) checkAudioWatchdog(t0)

    const gpsInfo = {
      source: state.source,
      status: state.source === 'gps' && ['denied', 'unsupported', 'error'].includes(gpsStatus) ? gpsStatus : estimate.status,
      accuracy: estimate.accuracy,
      updateHz: estimate.updateHz,
      ageMs: estimate.ageMs,
    }
    controls.setGpsStatus(gpsInfo)
  } catch (e) {
    // Never let one bad frame kill the loop while driving.
    if (state.errors.length < 50) state.errors.push(String(e?.stack ?? e))
    console.error(e)
  }
  state.tickMs = performance.now() - t0
}

// If audio time stops advancing while we're supposed to be playing (another media source took
// over, or the browser went to the background), ask for a tap instead of failing silently.
function checkAudioWatchdog(nowMs) {
  const w = state.watchdog, ctx = state.ctx
  if (!ctx || !state.engine) return
  if (w.lastWallMs == null || nowMs - w.lastWallMs >= 1000) {
    if (w.lastWallMs != null && document.visibilityState === 'visible') {
      const wall = (nowMs - w.lastWallMs) / 1000
      const audio = ctx.currentTime - w.lastCtxT
      w.stalledS = audio < wall * 0.5 ? w.stalledS + wall : 0
      if (w.stalledS >= 2) controls.showResumeOverlay(true)
    }
    w.lastWallMs = nowMs
    w.lastCtxT = ctx.currentTime
  }
}

let drawSkip = false
function draw() {
  // 30 fps is plenty for a tach and halves main-thread work on the car's CPU.
  drawSkip = !drawSkip
  if (drawSkip) { requestAnimationFrame(draw); return }
  const f = state.lastFrame, e = state.lastEstimate
  if (f && e) {
    tach.draw({
      rpm: f.rpm, gear: f.engineState === 'running' ? f.gear : null,
      speedMph: e.speedMps * MPS_TO_MPH, shifting: f.shifting, limiter: f.cut > 0 && f.rpm > vehicleConfig.engine.limiterRpm - 400,
    })
    if (debug.open) debug.update({
      rawSpeedMps: e.rawSpeedMps, speedMps: e.speedMps, accelMps2: e.accelMps2, load: f.load,
      throttle: f.throttle, rpm: f.rpm, gear: f.gear, engineState: f.engineState, source: state.source,
      gpsStatus: state.source === 'gps' ? gpsStatus : '–', accuracy: e.accuracy, updateHz: e.updateHz,
      fixAgeMs: e.ageMs, tickMs: state.tickMs, frameBudgetMs: TICK_MS, cpu: state.tickMs / TICK_MS,
      wakeLock: state.wakeLockState, ctxState: state.ctx?.state ?? 'not started',
      sampleRate: state.ctx?.sampleRate, baseLatency: state.ctx?.baseLatency, outputLatency: state.ctx?.outputLatency,
      outputRoute: settings.outputRoute, levels: state.engine?.levels?.() ?? {},
    })
  }
  requestAnimationFrame(draw)
}

// Logic runs on a timer (keeps going when rAF pauses); drawing runs on rAF.
setInterval(tick, TICK_MS)
requestAnimationFrame(draw)

// Test/debug hook (read-only snapshot).
window.__gt3rs = {
  get state() {
    return {
      ctxState: state.ctx?.state ?? null,
      engineState: state.lastFrame?.engineState ?? 'off',
      rpm: state.lastFrame?.rpm ?? 0,
      gear: state.lastFrame?.gear ?? 0,
      speedMps: state.lastEstimate?.speedMps ?? 0,
      status: state.lastEstimate?.status ?? 'waiting',
      source: state.source,
      replayPlaying: state.replay != null,
      errors: [...state.errors],
      enginesBuilt: state.enginesBuilt ?? 0,
      overlay: !document.getElementById('resume-overlay')?.hidden,
      levels: state.engine?.levels?.() ?? {},
    }
  },
}

