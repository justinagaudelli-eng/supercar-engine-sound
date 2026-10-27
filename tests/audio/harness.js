// Offline-render harness for Playwright audio tests (served by the Vite dev server).
//
//   window.renderTimeline({
//     timeline: [{ t, frame }],   // any vehicle-model frames, pre-scheduled via engine.setFrame
//     duration, sampleRate = 48000, channels = 1,
//     preset = 'street', volume = 1, mix = 0, samplesUrl, seed, config (deep-merged overrides)
//   }) → { sampleRate, renderMs, length, data: base64 Float32 (channel 0), loaded }
//
// Other suites (e.g. replay fixtures through the vehicle model) can build any timeline and
// reuse this page plus tests/audio/analysis.js.

import { createEngine } from '../../src/audio/engine.js'
import { audioConfig } from '../../src/audio/config.js'

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base?.[k], v)
  return out
}

function toBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return btoa(s)
}

window.renderTimeline = async (opts) => {
  const {
    timeline, duration, sampleRate = 48000, channels = 1, preset = 'street', volume = 1,
    mix = 0, samplesUrl = null, seed, config,
  } = opts
  const cfg = config ? deepMerge(audioConfig, config) : audioConfig
  const ctx = new OfflineAudioContext(channels, Math.ceil(duration * sampleRate), sampleRate)
  const engine = await createEngine(ctx, cfg, { seed })
  engine.connect(ctx.destination)
  engine.setPreset(preset, 0)
  engine.setVolume(volume, 0)
  let loaded = null
  if (samplesUrl) loaded = await engine.loadSamples(samplesUrl)
  engine.setMix(mix, 0)
  for (const { t, frame } of timeline) engine.setFrame(frame, t)
  const t0 = performance.now()
  const buf = await ctx.startRendering()
  const renderMs = performance.now() - t0
  return { sampleRate, renderMs, length: buf.length, data: toBase64(buf.getChannelData(0)), loaded }
}

// Worklet only (no mixer / native nodes): isolates the synth's own CPU cost.
window.renderWorkletOnly = async ({ duration = 10, sampleRate = 48000, rpmFrom = 900, rpmTo = 9000 } = {}) => {
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate)
  await ctx.audioWorklet.addModule(new URL('../../src/audio/flatSix.worklet.js', import.meta.url))
  const node = new AudioWorkletNode(ctx, 'flat-six', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [3],
    processorOptions: { config: audioConfig.worklet, seed: audioConfig.seed },
  })
  node.connect(ctx.destination)
  const p = (n) => node.parameters.get(n)
  p('combustion').setValueAtTime(1, 0)
  p('load').setValueAtTime(1, 0)
  p('rpm').setValueAtTime(rpmFrom, 0)
  p('rpm').linearRampToValueAtTime(rpmTo, duration)
  const t0 = performance.now()
  await ctx.startRendering()
  return { renderMs: performance.now() - t0 }
}

window.harnessReady = true
document.getElementById('status').textContent = 'ready'
