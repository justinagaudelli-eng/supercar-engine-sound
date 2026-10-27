// Slicer page controller. The math lives in pitch.js / loopMath.js / wav.js / zip.js; this
// file reads the form, runs the pipeline and handles canvas, preview and downloads.

import { decodeWavHeader, encodeWav } from './wav.js'
import { createZip } from './zip.js'
import {
  estimateRpmCurve, linearRpmCurve, fillCurveGaps, refinePeriod, createPhaseMap,
  warpToConstantPitch, freqFromRpm, FIRING_ORDER,
} from './pitch.js'
import {
  chooseLoopPoints, crossfadeLoop, targetRpmTimes, rpmTargets, commonGain, detectActiveRange,
} from './loopMath.js'

const $ = (id) => document.getElementById(id)
const SEAM_OK = 0.05           // seamError below this needs no crossfade
const FIRINGS_PER_CYCLE = 6    // flat-six: 6 firings per 720 degrees

const state = {
  bytes: null,           // original file bytes (kept to re-decode at another rate)
  fileName: '',
  sampleRate: 0,
  channels: [],          // DC-blocked source channels
  mono: null,
  estimate: null,        // [{t, rpm (order 3), confidence}]
  loops: [],
  gain: 1,
  preview: null,         // AudioContext while previewing
}

// ---------- form ----------

function num(id, fallback) {
  const v = Number($(id).value)
  return $(id).value !== '' && Number.isFinite(v) ? v : fallback
}

function readOptions() {
  return {
    trimStart: num('trim-start', 0),
    trimEnd: num('trim-end', duration()),
    mode: document.querySelector('input[name="rpm-mode"]:checked').value,
    rpmStart: num('rpm-start', 1500),
    rpmEnd: num('rpm-end', 9000),
    order: num('order', FIRING_ORDER),
    minRpm: num('min-rpm', 700),
    maxRpm: num('max-rpm', 10000),
    step: Math.max(50, num('rpm-step', 500)),
    rangeFrom: num('range-from', null),
    rangeTo: num('range-to', null),
    lenMode: $('len-mode').value,
    lenValue: num('len-value', 0.3),
    layer: $('layer').value,
    seam: $('seam').value,
    peakDb: Math.min(0, num('peak-db', -1)),
    name: ($('set-name').value || 'samples').trim(),
    engineCycles: $('engine-cycles').checked,
    flatten: $('flatten').checked,
    channelMode: $('channels').value,
  }
}

function duration() {
  return state.mono ? state.mono.length / state.sampleRate : 0
}

function setStatus(text, level = '') {
  $('status').textContent = text
  $('status').dataset.level = level
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

// ---------- loading ----------

async function loadFile(file) {
  state.bytes = await file.arrayBuffer()
  state.fileName = file.name
  await decode()
}

async function decode() {
  if (!state.bytes) return
  setStatus('Decoding…')
  let rate = Number($('rate').value) || 0
  let note = ''
  if (!rate) {
    try { rate = decodeWavHeader(new Uint8Array(state.bytes)).sampleRate } catch { rate = 0 }
    if (!rate) { rate = 48000; note = ' (not a WAV, so the source rate is unknown: using 48000 Hz)' }
  }
  try {
    const ctx = new OfflineAudioContext(1, 1, rate)
    const buf = await ctx.decodeAudioData(state.bytes.slice(0))
    state.sampleRate = buf.sampleRate
    state.channels = Array.from({ length: buf.numberOfChannels }, (_, c) => dcBlock(buf.getChannelData(c), buf.sampleRate))
    state.mono = mixdown(state.channels)
  } catch (err) {
    setStatus(`Could not decode ${state.fileName}: ${err.message || err}`, 'error')
    return
  }
  state.estimate = null
  state.loops = []
  renderTable()
  const range = detectActiveRange(state.mono, state.sampleRate)
  $('trim-start').value = range.start.toFixed(2)
  $('trim-end').value = range.end.toFixed(2)
  $('file-info').textContent = `${state.fileName}: ${duration().toFixed(2)} s, ` +
    `${state.channels.length} ch, ${state.sampleRate} Hz${note}`
  setStatus('Loaded. Set the RPM range or press Estimate.', 'ok')
  drawCurve()
}

function mixdown(chans) {
  if (chans.length === 1) return chans[0]
  const out = new Float32Array(chans[0].length)
  for (const c of chans) for (let i = 0; i < out.length; i++) out[i] += c[i] / chans.length
  return out
}

// Removes DC / sub-audio drift so rising zero crossings are meaningful.
function dcBlock(x, sampleRate) {
  const a = Math.exp((-2 * Math.PI * 10) / sampleRate)
  const y = new Float32Array(x.length)
  let px = 0, py = 0
  for (let i = 0; i < x.length; i++) {
    py = a * (py + x[i] - px)
    px = x[i]
    y[i] = py
  }
  return y
}

// ---------- rpm curve ----------

async function estimate() {
  if (!state.mono) return setStatus('Load a recording first.', 'warn')
  const o = readOptions()
  setStatus('Tracking pitch…')
  await nextFrame()
  const t0 = performance.now()
  state.estimate = estimateRpmCurve(state.mono, state.sampleRate, {
    minRpm: o.minRpm, maxRpm: o.maxRpm, startS: o.trimStart, endS: o.trimEnd,
  })
  document.querySelector('input[name="rpm-mode"][value="estimated"]').checked = true
  const curve = activeCurve()
  const voiced = curve.filter((p) => p.rpm != null)
  if (voiced.length < 2) {
    setStatus('No stable pitch found. Check the sweep range, or use manual RPM.', 'error')
  } else {
    const rpms = voiced.map((p) => p.rpm)
    $('rpm-start').value = Math.round(Math.min(...rpms) / 50) * 50
    $('rpm-end').value = Math.round(Math.max(...rpms) / 50) * 50
    const pct = Math.round((voiced.length / curve.length) * 100)
    setStatus(`Tracked ${curve.length} frames (${pct}% voiced) in ${Math.round(performance.now() - t0)} ms. ` +
      'If the curve looks half or double the real RPM, change “Detected pitch is…”.', 'ok')
  }
  drawCurve()
}

/** The rpm curve in use, clipped to the sweep window: [{t, rpm|null}]. */
function activeCurve(o = readOptions()) {
  if (o.mode === 'estimated' && state.estimate) {
    const k = FIRING_ORDER / o.order
    return state.estimate
      .filter((p) => p.t >= o.trimStart && p.t <= o.trimEnd)
      .map((p) => ({ t: p.t, rpm: p.rpm != null ? p.rpm * k : null }))
  }
  if (o.trimEnd <= o.trimStart) return []
  return linearRpmCurve(o.trimStart, o.trimEnd, o.rpmStart, o.rpmEnd)
}

// ---------- cutting ----------

function planJobs(curve, o) {
  const filled = fillCurveGaps(curve)
  if (filled.length < 2) return []
  if (o.layer !== 'auto') {
    return [{ layer: o.layer, direction: o.layer === 'off' ? 'down' : 'up', fromS: -Infinity, toS: Infinity }]
  }
  let peak = 0
  for (let i = 1; i < filled.length; i++) if (filled[i].rpm > filled[peak].rpm) peak = i
  const tPeak = filled[peak].t
  return [
    { layer: 'on', direction: 'up', fromS: -Infinity, toS: tPeak },
    { layer: 'off', direction: 'down', fromS: tPeak, toS: Infinity },
  ]
}

function cycleCount(rpm, o) {
  const f = freqFromRpm(rpm)
  let c = o.lenMode === 'cycles' ? Math.round(o.lenValue) : Math.round(o.lenValue * f)
  if (o.engineCycles) c = Math.round(c / FIRINGS_PER_CYCLE) * FIRINGS_PER_CYCLE
  return Math.max(o.engineCycles ? FIRINGS_PER_CYCLE : 1, c)
}

function sliceZeroPad(x, start, length) {
  const out = new Float32Array(length)
  const a = Math.max(0, start)
  const b = Math.min(x.length, start + length)
  if (b > a) out.set(x.subarray(a, b), a - start)
  return out
}

function rpmAt(filled, t) {
  if (!filled.length) return null
  if (t <= filled[0].t) return filled[0].rpm
  for (let i = 1; i < filled.length; i++) {
    if (filled[i].t >= t) {
      const a = filled[i - 1], b = filled[i]
      return a.rpm + ((b.rpm - a.rpm) * (t - a.t)) / (b.t - a.t)
    }
  }
  return filled[filled.length - 1].rpm
}

async function cut() {
  if (!state.mono) return setStatus('Load a recording first.', 'warn')
  const o = readOptions()
  const curve = activeCurve(o)
  const filled = fillCurveGaps(curve)
  if (filled.length < 2) return setStatus('No usable RPM curve. Press Estimate or enter start/end RPM.', 'error')
  setStatus('Cutting loops…')
  await nextFrame()

  const sr = state.sampleRate
  const outChans = o.channelMode === 'keep' ? state.channels : [state.mono]
  const phaseMap = o.flatten ? createPhaseMap(filled) : null
  const rpms = filled.map((p) => p.rpm)
  const lo = o.rangeFrom ?? Math.min(...rpms)
  const hi = o.rangeTo ?? Math.max(...rpms)
  const targets = rpmTargets(lo, hi, o.step)
  const loops = []
  const missing = []

  for (const job of planJobs(curve, o)) {
    let hits = targetRpmTimes(filled, targets, job)
    if (o.layer !== 'auto' && hits.every((h) => h.t == null)) hits = targetRpmTimes(filled, targets, { direction: 'any' })
    for (const { rpm, t } of hits) {
      if (t == null) { if (o.layer !== 'auto') missing.push(rpm); continue }
      loops.push(cutOne(rpm, t, job.layer, o, { sr, outChans, phaseMap, filled }))
    }
  }
  if (!loops.length) return setStatus('No target RPM was reached inside the sweep window.', 'error')

  state.gain = commonGain(loops.map((l) => l.chans), Math.pow(10, o.peakDb / 20))
  for (const l of loops) for (const ch of l.chans) for (let i = 0; i < ch.length; i++) ch[i] *= state.gain
  loops.sort((a, b) => (a.layer === b.layer ? a.targetRpm - b.targetRpm : a.layer === 'on' ? -1 : 1))
  state.loops = loops
  renderTable()
  drawCurve()
  const gainDb = (20 * Math.log10(state.gain)).toFixed(1)
  const faded = loops.filter((l) => l.faded).length
  setStatus(`${loops.length} loops cut, common gain ${gainDb} dB, ${faded} seam crossfade(s)` +
    (missing.length ? `. Not reached: ${missing.join(', ')} rpm` : '.'), 'ok')
}

function cutOne(rpm, t, layer, o, { sr, outChans, phaseMap, filled }) {
  const cycles = cycleCount(rpm, o)
  const nominalP = sr / freqFromRpm(rpm)
  const fade = Math.max(8, Math.min(Math.round(0.004 * sr), Math.floor(nominalP / 2)))
  const margin = Math.ceil(nominalP * 1.2) + fade + 16
  const segLen = Math.ceil(cycles * nominalP * 1.1) + 2 * margin
  const center = Math.floor(segLen / 2)

  let seg, monoSeg, period, loopRpm
  if (phaseMap) {
    const monoOnly = outChans.length === 1 && outChans[0] === state.mono
    const warped = warpToConstantPitch(monoOnly ? [state.mono] : [state.mono, ...outChans], sr, phaseMap, t, rpm, segLen)
    monoSeg = warped[0]
    seg = monoOnly ? [monoSeg] : warped.slice(1)
    period = nominalP
    loopRpm = rpm
  } else {
    const s0 = Math.round(t * sr) - center
    monoSeg = sliceZeroPad(state.mono, s0, segLen)
    seg = outChans.map((c) => (c === state.mono ? monoSeg : sliceZeroPad(c, s0, segLen)))
    period = refinePeriod(monoSeg, center, nominalP, { range: 0.08 })
    loopRpm = Math.round((20 * sr / period) * 10) / 10   // firing period → rpm
  }

  const pts = chooseLoopPoints(monoSeg, sr, center, period, cycles)
  const faded = o.seam === 'always' || (o.seam === 'auto' && pts.error > SEAM_OK)
  const chans = seg.map((ch) => (faded ? crossfadeLoop(ch, pts.start, pts.end, fade) : ch.slice(pts.start, pts.end)))

  // Pitch drift across the loop in the source (what flattening removes).
  const halfS = (pts.end - pts.start) / sr / 2
  const r0 = rpmAt(filled, t - halfS)
  const r1 = rpmAt(filled, t + halfS)
  const drift = r0 && r1 ? Math.abs(r1 - r0) / rpm : 0

  return {
    layer, targetRpm: rpm, rpm: loopRpm, t, cycles, chans, faded,
    error: pts.error, aligned: pts.aligned, drift, flattened: !!phaseMap,
    file: `${layer}_${rpm}.wav`,
  }
}

// ---------- output ----------

function buildManifest() {
  const o = readOptions()
  const sr = state.sampleRate
  return {
    version: 1,
    name: o.name,
    loops: state.loops.map((l) => ({
      file: l.file,
      rpm: l.rpm,
      layer: l.layer,
      loopStart: 0,
      loopEnd: Math.round((l.chans[0].length / sr) * 1e6) / 1e6,
      gain: 1,
    })),
  }
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function downloadZip() {
  if (!state.loops.length) return setStatus('Cut loops first.', 'warn')
  const manifest = JSON.stringify(buildManifest(), null, 2)
  const files = state.loops.map((l) => ({ name: l.file, data: encodeWav(l.chans, state.sampleRate) }))
  files.push({ name: 'manifest.json', data: manifest })
  const safe = readOptions().name.replace(/[^\w.-]+/g, '_') || 'samples'
  download(createZip(files), `${safe}.zip`, 'application/zip')
  setStatus(`Downloaded ${safe}.zip. Unzip its contents into public/samples/.`, 'ok')
}

function downloadManifest() {
  if (!state.loops.length) return setStatus('Cut loops first.', 'warn')
  download(JSON.stringify(buildManifest(), null, 2), 'manifest.json', 'application/json')
}

// ---------- preview ----------

function stopPreview() {
  if (state.preview) { state.preview.close().catch(() => {}); state.preview = null }
}

function toBuffer(ctx, loop) {
  const buf = ctx.createBuffer(loop.chans.length, loop.chans[0].length, state.sampleRate)
  loop.chans.forEach((c, i) => buf.copyToChannel(c, i))
  return buf
}

function equalPowerCurve(fadeIn) {
  const c = new Float32Array(32)
  for (let i = 0; i < c.length; i++) {
    const th = (i / (c.length - 1)) * (Math.PI / 2)
    c[i] = fadeIn ? Math.sin(th) : Math.cos(th)
  }
  return c
}

function playLoops(loops, holdS, fadeS) {
  stopPreview()
  const ctx = new AudioContext({ latencyHint: 'playback' })
  state.preview = ctx
  let t = ctx.currentTime + 0.1
  loops.forEach((loop, i) => {
    const src = ctx.createBufferSource()
    src.buffer = toBuffer(ctx, loop)
    src.loop = true
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(g).connect(ctx.destination)
    const first = i === 0
    const last = i === loops.length - 1
    if (first) g.gain.setValueAtTime(1, t)
    else g.gain.setValueCurveAtTime(equalPowerCurve(true), t, fadeS)
    const outAt = t + holdS + (first ? 0 : fadeS)
    if (last) g.gain.setTargetAtTime(0, outAt, 0.02)
    else g.gain.setValueCurveAtTime(equalPowerCurve(false), outAt, fadeS)
    src.start(t)
    src.stop(outAt + fadeS + 0.2)
    if (last) src.onended = () => { if (state.preview === ctx) stopPreview() }
    t = outAt
  })
}

function previewSweep() {
  if (!state.loops.length) return setStatus('Cut loops first.', 'warn')
  const hasOn = state.loops.some((l) => l.layer === 'on')
  const layerLoops = state.loops.filter((l) => l.layer === (hasOn ? 'on' : 'off'))
    .sort((a, b) => a.rpm - b.rpm)
  playLoops(layerLoops, 0.35, 0.12)
}

// ---------- rendering ----------

function renderTable() {
  const body = $('loops')
  body.textContent = ''
  const sr = state.sampleRate
  state.loops.forEach((l, i) => {
    const tr = document.createElement('tr')
    const len = l.chans[0].length
    const cells = [
      l.file,
      String(l.rpm),
      l.t.toFixed(3),
      String(l.cycles),
      `${((len / sr) * 1000).toFixed(1)} ms`,
      `${l.error.toFixed(3)}${l.faded ? ' (xfade)' : ''}${l.aligned ? '' : ' ⚠ no ZC'}`,
      `${(l.drift * 100).toFixed(1)}%${l.flattened ? ' → 0' : ''}`,
    ]
    cells.forEach((text, k) => {
      const td = document.createElement('td')
      td.textContent = text
      if ((k === 5 && !l.aligned) || (k === 6 && !l.flattened && l.drift > 0.03)) td.className = 'warn'
      tr.append(td)
    })
    const td = document.createElement('td')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'row-play'
    b.textContent = 'Play'
    b.addEventListener('click', () => playLoops([state.loops[i]], 1.5, 0.05))
    td.append(b)
    tr.append(td)
    body.append(tr)
  })
}

function drawCurve() {
  const canvas = $('curve')
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.round(canvas.clientWidth * dpr)
  const h = Math.round(canvas.clientHeight * dpr)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  if (!state.mono) return

  const o = readOptions()
  const dur = duration()
  const padL = 48 * dpr, padB = 22 * dpr, padT = 8 * dpr
  const plotW = w - padL - 8 * dpr
  const plotH = h - padB - padT
  const x = (t) => padL + (t / dur) * plotW
  const curve = activeCurve(o)
  const rpms = curve.map((p) => p.rpm).filter((r) => r != null)
  const top = Math.max(10000, ...(rpms.length ? [Math.max(...rpms) * 1.05] : []))
  const y = (rpm) => padT + plotH * (1 - rpm / top)

  // Waveform envelope.
  ctx.fillStyle = '#3a3f47'
  const mid = padT + plotH / 2
  const per = Math.max(1, Math.floor(state.mono.length / plotW))
  for (let px = 0; px < plotW; px++) {
    let mn = 0, mx = 0
    const a = px * per
    for (let i = a; i < a + per && i < state.mono.length; i += Math.max(1, per >> 6)) {
      const v = state.mono[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    ctx.fillRect(padL + px, mid - mx * plotH / 2, 1, Math.max(1, (mx - mn) * plotH / 2))
  }

  // Grid + labels.
  ctx.strokeStyle = '#22262c'
  ctx.fillStyle = '#9097a1'
  ctx.font = `${11 * dpr}px system-ui, sans-serif`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let r = 0; r <= top; r += 1000) {
    ctx.beginPath(); ctx.moveTo(padL, y(r)); ctx.lineTo(w, y(r)); ctx.stroke()
    if (r % 2000 === 0) ctx.fillText(`${r / 1000}k`, padL - 6 * dpr, y(r))
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const tStep = dur > 60 ? 10 : dur > 20 ? 5 : dur > 6 ? 1 : 0.5
  for (let t = 0; t <= dur; t += tStep) ctx.fillText(`${t}s`, x(t), h - padB + 4 * dpr)

  // Outside the sweep window.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(padL, padT, Math.max(0, x(o.trimStart) - padL), plotH)
  ctx.fillRect(x(o.trimEnd), padT, Math.max(0, w - x(o.trimEnd)), plotH)

  // RPM curve (broken at unvoiced frames).
  ctx.strokeStyle = '#ff8a1f'
  ctx.lineWidth = 2 * dpr
  ctx.setLineDash(o.mode === 'manual' ? [6 * dpr, 4 * dpr] : [])
  ctx.beginPath()
  let pen = false
  for (const p of curve) {
    if (p.rpm == null) { pen = false; continue }
    if (pen) ctx.lineTo(x(p.t), y(p.rpm))
    else ctx.moveTo(x(p.t), y(p.rpm))
    pen = true
  }
  ctx.stroke()
  ctx.setLineDash([])

  // Loop markers.
  for (const l of state.loops) {
    ctx.fillStyle = l.layer === 'on' ? '#2fdc6a' : '#3d8bff'
    ctx.fillRect(x(l.t) - dpr, y(l.targetRpm) - 4 * dpr, 2 * dpr, 8 * dpr)
    ctx.fillRect(x(l.t) - dpr, h - padB - 8 * dpr, 2 * dpr, 8 * dpr)
  }
}

// ---------- wiring ----------

$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0]
  if (f) loadFile(f).catch((err) => setStatus(String(err.message || err), 'error'))
})
$('rate').addEventListener('change', () => decode())
$('btn-trim').addEventListener('click', () => {
  if (!state.mono) return
  const r = detectActiveRange(state.mono, state.sampleRate)
  $('trim-start').value = r.start.toFixed(2)
  $('trim-end').value = r.end.toFixed(2)
  drawCurve()
})
$('btn-estimate').addEventListener('click', () => estimate())
$('btn-cut').addEventListener('click', () => cut().catch((err) => setStatus(String(err.message || err), 'error')))
$('btn-zip').addEventListener('click', downloadZip)
$('btn-manifest').addEventListener('click', downloadManifest)
$('btn-preview').addEventListener('click', previewSweep)
$('btn-stop').addEventListener('click', stopPreview)
$('len-mode').addEventListener('change', () => {
  const cycles = $('len-mode').value === 'cycles'
  $('len-value').step = cycles ? '6' : '0.01'
  $('len-value').min = cycles ? '1' : '0.02'
  $('len-value').value = cycles ? '48' : '0.3'
})
for (const id of ['trim-start', 'trim-end', 'rpm-start', 'rpm-end', 'order']) {
  $(id).addEventListener('change', drawCurve)
}
for (const r of document.querySelectorAll('input[name="rpm-mode"]')) r.addEventListener('change', drawCurve)
window.addEventListener('resize', drawCurve)
