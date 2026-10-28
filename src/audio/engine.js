// Audio engine: AudioWorklet flat-six synth + optional sample layer → mixer → limiter.
// Contract: ARCHITECTURE.md "Audio engine". Works with AudioContext and OfflineAudioContext.
//
//   const engine = await createEngine(ctx, audioConfig, { seed?, outputRoute?, onRouteFallback?, onMediaPause? })
//   engine.connect(ctx.destination)
//   engine.setFrame(frame, when)          // vehicle-model frame → smoothed AudioParams
//   engine.setPreset('street'|'track'|'cabin'); engine.setVolume(0..1); engine.setMix(0..1)
//   await engine.loadSamples(url)         // → { loaded, count, error }; never throws
//   engine.levels(); engine.testTone(on); await engine.setOutputRoute('direct'|'mediaElement')
//   engine.dispose()

import { audioConfig as defaultConfig } from './config.js'
import { createMixer } from './mixer.js'
import { createEvents, frameToParams } from './events.js'
import { createSampleLayer } from './sampleLayer.js'

// Vite rewrites this to the hashed asset URL at build time (works with base './').
const WORKLET_URL = new URL('./flatSix.worklet.js', import.meta.url)
const loadedContexts = new WeakSet()

const PARAMS = ['rpm', 'load', 'cut', 'combustion', 'starter', 'twoStep']

export async function createEngine(ctx, config = defaultConfig, options = {}) {
  if (!loadedContexts.has(ctx)) {
    await ctx.audioWorklet.addModule(WORKLET_URL)
    loadedContexts.add(ctx)
  }
  const seed = options.seed ?? config.seed
  const synth = new AudioWorkletNode(ctx, 'flat-six', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [5],   // exhaust mid/side, intake mid/side, mech
    processorOptions: { config: config.worklet, seed },
  })
  const mixer = createMixer(ctx, config)
  synth.connect(mixer.input)
  const events = createEvents(ctx, { ...config, seed }, mixer.eventsInput)
  const P = config.params
  const tau = { rpm: P.rpmTauS, load: P.loadTauS, cut: P.cutTauS, combustion: P.combustionTauS, starter: P.starterTauS, twoStep: P.twoStepTauS }
  const params = Object.fromEntries(PARAMS.map((n) => [n, synth.parameters.get(n)]))

  let first = true
  let lastWhen = -Infinity
  const sent = { rpm: NaN, load: NaN, cut: NaN, combustion: NaN, starter: NaN, twoStep: NaN }
  const EPS = P.epsilon
  const { onRouteFallback, onMediaPause } = options
  let sampleLayer = null
  let tone = null
  let destination = null
  let route = 'direct'
  let mediaDest = null
  let mediaEl = null
  let lastFrameParams = frameToParams({ engineState: 'off' })

  function connectRoute() {
    try { mixer.output.disconnect() } catch { /* not connected */ }
    if (route === 'mediaElement' && mediaDest) mixer.output.connect(mediaDest)
    else if (destination) mixer.output.connect(destination)
  }

  const engine = {
    context: ctx,
    output: mixer.output,
    node: synth,
    mixer,

    connect(dest) {
      destination = dest
      connectRoute()
      return dest
    },

    disconnect() {
      destination = null
      try { mixer.output.disconnect() } catch { /* not connected */ }
    },

    /**
     * Schedule a vehicle-model frame at context time `when`.
     * - First frame: values jump (nothing has sounded yet); afterwards always glide.
     * - Values that moved less than params.epsilon are not re-sent (fewer automation events).
     * - A gap > params.gapResetS since the previous frame (context suspended and resumed, tab
     *   throttled…) cancels anything still pending and restarts the glides from `when`, so
     *   stale automation can never cause a jump after a resume.
     */
    setFrame(frame, when = ctx.currentTime) {
      const p = frameToParams(frame)
      lastFrameParams = p
      if (when < ctx.currentTime) when = ctx.currentTime
      const gap = !first && when - lastWhen > P.gapResetS
      if (gap) {
        for (const n of PARAMS) {
          const prm = params[n]
          if (prm.cancelAndHoldAtTime) prm.cancelAndHoldAtTime(when)
          else prm.cancelScheduledValues(when)
          sent[n] = NaN
        }
      }
      for (const n of PARAMS) {
        if (first) params[n].setValueAtTime(p[n], when)
        else if (!(Math.abs(p[n] - sent[n]) < EPS[n])) params[n].setTargetAtTime(p[n], when, tau[n])
        else continue
        sent[n] = p[n]
      }
      first = false
      lastWhen = when
      mixer.setDriveFor(p.rpm, p.load, when, gap)
      events.handle(frame, when)
      if (sampleLayer) sampleLayer.update(p, when, gap)
    },

    setPreset(name, when = ctx.currentTime) { mixer.setPreset(name, when) },
    setVolume(v, when = ctx.currentTime) { mixer.setVolume(v, when) },
    setMix(m, when = ctx.currentTime) { mixer.setMix(m, when) },

    async loadSamples(manifestUrl) {
      try {
        const layer = await createSampleLayer(ctx, manifestUrl, config, mixer.sampleInput)
        if (!layer) return { loaded: false, count: 0, error: null }
        if (sampleLayer) sampleLayer.dispose()
        sampleLayer = layer
        sampleLayer.update(lastFrameParams, ctx.currentTime)
        mixer.setSamplesActive(true)
        return { loaded: true, count: layer.count, error: null }
      } catch (e) {
        console.warn('[audio] sample layer disabled:', e.message)
        return { loaded: false, count: 0, error: e.message }
      }
    },

    levels() { return mixer.levels() },

    /** Gentle 440 Hz sine through the master chain (speaker check). */
    testTone(on) {
      const T = config.mixer.testTone
      const t = ctx.currentTime
      if (on && !tone) {
        const osc = ctx.createOscillator()
        osc.frequency.value = T.hz
        const g = ctx.createGain()
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(T.level, t + T.rampS)
        osc.connect(g).connect(mixer.fxInput)
        osc.start(t)
        tone = { osc, g }
      } else if (!on && tone) {
        const { osc, g } = tone
        g.gain.cancelScheduledValues(t)
        g.gain.setValueAtTime(g.gain.value, t)
        g.gain.linearRampToValueAtTime(0, t + T.rampS)
        osc.stop(t + T.rampS + 0.01)
        osc.onended = () => { osc.disconnect(); g.disconnect() }
        tone = null
      }
      return !!tone
    },

    /**
     * 'direct' → engine.connect() destination. 'mediaElement' → MediaStreamAudioDestination →
     * <audio> element (helps keep audio alive in the background on some browsers). Real
     * AudioContext only. Should be called from a user gesture the first time (audio.play()).
     * If play() rejects, routing falls back to 'direct', resolves 'direct' and calls
     * options.onRouteFallback({ requested, route, error }). options.onMediaPause() fires when the
     * media element is paused (e.g. by the browser in the background) while it is the route.
     */
    async setOutputRoute(next) {  // resolves to the route actually in use
      if (next === 'mediaElement') {
        if (typeof ctx.createMediaStreamDestination !== 'function' || typeof Audio === 'undefined') {
          throw new Error('mediaElement route needs a real AudioContext')
        }
        if (!mediaDest) {
          mediaDest = ctx.createMediaStreamDestination()
          mediaEl = new Audio()
          mediaEl.autoplay = true
          mediaEl.srcObject = mediaDest.stream
          mediaEl.addEventListener('pause', () => { if (route === 'mediaElement') onMediaPause?.() })
        }
        // Only re-route once the element is actually playing; if play() is refused (autoplay
        // policy, no gesture) stay on — or fall back to — direct output, never go silent.
        try {
          await mediaEl.play()
        } catch (e) {
          route = 'direct'
          connectRoute()
          onRouteFallback?.({ requested: 'mediaElement', route: 'direct', error: e.message })
          return route
        }
        route = 'mediaElement'
        connectRoute()
      } else {
        route = 'direct'
        connectRoute()
        if (mediaEl) mediaEl.pause()
      }
      return route
    },
    get outputRoute() { return route },
    get mediaElement() { return mediaEl },

    dispose() {
      engine.testTone(false)
      events.dispose()
      if (sampleLayer) sampleLayer.dispose()
      sampleLayer = null
      try { synth.disconnect() } catch { /* gone */ }
      synth.port.close?.()
      mixer.dispose()
      if (mediaEl) { mediaEl.pause(); mediaEl.srcObject = null }
    },
  }

  // outputRoute may come as an option or inside the config object (main.js does the latter)
  if ((options.outputRoute ?? config.outputRoute) === 'mediaElement') {
    engine.setOutputRoute('mediaElement').catch((e) => {
      console.warn('[audio] mediaElement route failed:', e.message)
      onRouteFallback?.({ requested: 'mediaElement', route: 'direct', error: e.message })
    })
  }
  return engine
}
