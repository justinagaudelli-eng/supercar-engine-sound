// Mixer / master chain (native nodes, cheap in C++):
//
//   worklet[3ch] → splitter → exhaust/intake/mech gains (preset) ─┐ (analysers per voice)
//                                                                  ├► voiceBus → synthMix
//   synthMix → preDrive (rpm/load) → WaveShaper(tanh, asym) → postDrive (compensation) → HP (DC)
//            → body peak → low shelf → high shelf → lowpass (preset tone) → presetOut ─┐
//   sampleLayer → sampleMix ──────────────────────────────────────────────────────────┤
//   events one-shots / test tone ─────────────────────────────────────────────────────┤
//                         compressor → limiter → ceiling clipper → volume → output (+ master analyser)
//
// The ceiling clipper is a WaveShaper whose curve saturates at `ceiling` (−1 dBFS): input
// beyond ±1 is clamped to the curve ends by the spec, so output peak ≤ ceiling × volume cap.

const dbToGain = (db) => Math.pow(10, db / 20)

export function driveForFrame(rpm, load, mixCfg, presetDrive = 1) {
  const D = mixCfg.drive
  const r = Math.max(0, Math.min(1.1, rpm / D.redlineRpm))
  const l = Math.max(0, Math.min(1, load))
  return 1 + D.amount * presetDrive * Math.pow(r, D.exp) * (D.loadMin + (1 - D.loadMin) * l)
}

// Saturation curve f(u) on u ∈ [−range, range], normalised to unit slope at 0.
function saturator(u, asym) {
  const t = Math.tanh(asym)
  return (Math.tanh(u + asym) - t) / (1 - t * t)
}

function makeDriveCurve(D) {
  const n = D.curveSize
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = saturator(x * D.range, D.asymmetry) / D.range
  }
  return curve
}

// Linear below `knee`, smooth (tanh) approach to `ceiling` above it.
function makeCeilingCurve(ceiling, knee, n = 8192) {
  const curve = new Float32Array(n)
  const k = knee * ceiling
  const span = ceiling - k
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= k ? a : k + span * Math.tanh((a - k) / span)
    curve[i] = Math.sign(x) * Math.min(y, ceiling)
  }
  return curve
}

export function createMixer(ctx, config) {
  const M = config.mixer
  const D = M.drive

  const splitter = ctx.createChannelSplitter(3)
  const voice = {}
  const analysers = {}
  const voiceBus = ctx.createGain()
  voiceBus.gain.value = M.synthTrim
  for (const [i, name] of ['exhaust', 'intake', 'mech'].entries()) {
    const g = ctx.createGain()
    splitter.connect(g, i)
    const a = ctx.createAnalyser()
    a.fftSize = M.analyserFftSize
    g.connect(a)
    g.connect(voiceBus)
    voice[name] = g
    analysers[name] = a
  }

  const synthMix = ctx.createGain()
  voiceBus.connect(synthMix)

  const preDrive = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  shaper.curve = makeDriveCurve(D)
  shaper.oversample = D.oversample
  const postDrive = ctx.createGain()
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'; hp.frequency.value = M.hpHz; hp.Q.value = Math.SQRT1_2
  const body = ctx.createBiquadFilter()
  body.type = 'peaking'; body.frequency.value = M.body.hz; body.Q.value = M.body.q; body.gain.value = M.body.gainDb
  const lowShelf = ctx.createBiquadFilter(); lowShelf.type = 'lowshelf'
  const highShelf = ctx.createBiquadFilter(); highShelf.type = 'highshelf'
  const lowpass = ctx.createBiquadFilter(); lowpass.type = 'lowpass'
  const presetOut = ctx.createGain()
  synthMix.connect(preDrive).connect(shaper).connect(postDrive).connect(hp).connect(body)
    .connect(lowShelf).connect(highShelf).connect(lowpass).connect(presetOut)

  const sampleIn = ctx.createGain()     // sample layer connects here
  const sampleMix = ctx.createGain()
  const sampleAnalyser = ctx.createAnalyser()
  sampleAnalyser.fftSize = M.analyserFftSize
  sampleIn.connect(sampleMix)
  sampleMix.connect(sampleAnalyser)

  const fxIn = ctx.createGain()         // test tone + events (pre-compressor)
  const eventsIn = ctx.createGain()     // one-shot event layer
  eventsIn.gain.value = M.events
  eventsIn.connect(fxIn)

  const comp = ctx.createDynamicsCompressor()
  const lim = ctx.createDynamicsCompressor()
  for (const [c, s] of [[comp, M.compressor], [lim, M.limiter]]) {
    c.threshold.value = s.threshold; c.knee.value = s.knee; c.ratio.value = s.ratio
    c.attack.value = s.attack; c.release.value = s.release
  }
  const ceiling = ctx.createWaveShaper()
  ceiling.curve = makeCeilingCurve(M.ceiling, M.ceilingKnee)
  ceiling.oversample = 'none'
  const volume = ctx.createGain()
  const masterAnalyser = ctx.createAnalyser()
  masterAnalyser.fftSize = M.analyserFftSize

  presetOut.connect(comp)
  sampleMix.connect(comp)
  fxIn.connect(comp)
  comp.connect(lim).connect(ceiling).connect(volume)
  volume.connect(masterAnalyser)
  // Dedicated output node: the engine re-routes (disconnects) this one without touching taps.
  const out = ctx.createGain()
  volume.connect(out)
  analysers.sample = sampleAnalyser
  analysers.master = masterAnalyser

  let preset = config.presets[config.defaultPreset]
  let mix = 0
  let samplesActive = false
  let lastDrive = 1
  const lastRpmLoad = { rpm: 0, load: 0 }
  const lastDriveFor = () => driveForFrame(lastRpmLoad.rpm, lastRpmLoad.load, M, preset.drive)

  const at = (param, v, when, tau) => param.setTargetAtTime(v, when, tau)

  function applyPreset(p, when, tau) {
    at(voice.exhaust.gain, p.exhaust, when, tau)
    at(voice.intake.gain, p.intake, when, tau)
    at(voice.mech.gain, p.mech, when, tau)
    lowShelf.frequency.setValueAtTime(p.lowShelf.hz, when)
    highShelf.frequency.setValueAtTime(p.highShelf.hz, when)
    at(lowShelf.gain, p.lowShelf.gainDb, when, tau)
    at(highShelf.gain, p.highShelf.gainDb, when, tau)
    at(lowpass.frequency, p.lowpassHz, when, tau)
    lowpass.Q.setValueAtTime(p.lowpassQ, when)
    at(presetOut.gain, p.outputGain, when, tau)
  }

  function applyMix(when, tau) {
    const m = samplesActive ? mix : 0
    // equal-power synth/sample crossfade
    at(synthMix.gain, Math.cos(m * Math.PI / 2), when, tau)
    at(sampleMix.gain, Math.sin(m * Math.PI / 2) * M.samples, when, tau)
  }

  function setDrive(d, when) {
    lastDrive = d
    const ref = D.refLevel
    // Post-gain keeps a signal at the reference level at the same loudness, so drive adds
    // harmonics/compression rather than volume. (Curve is pre-scaled by 1/range, see above.)
    at(preDrive.gain, d / D.range, when, D.tauS)
    at(postDrive.gain, D.range * ref / saturator(d * ref, D.asymmetry), when, D.tauS)
  }

  // Initial state (set immediately, no glide).
  const t0 = ctx.currentTime
  for (const [name, g] of Object.entries(voice)) g.gain.setValueAtTime(preset[name], t0)
  lowShelf.frequency.value = preset.lowShelf.hz; lowShelf.gain.value = preset.lowShelf.gainDb
  highShelf.frequency.value = preset.highShelf.hz; highShelf.gain.value = preset.highShelf.gainDb
  lowpass.frequency.value = preset.lowpassHz; lowpass.Q.value = preset.lowpassQ
  presetOut.gain.value = preset.outputGain
  synthMix.gain.value = 1
  sampleMix.gain.value = 0
  preDrive.gain.value = 1 / D.range
  postDrive.gain.value = D.range * D.refLevel / saturator(D.refLevel, D.asymmetry)
  volume.gain.value = volumeGain(config.volume.default, config)

  const buf = new Float32Array(M.analyserFftSize)
  function rmsDb(a) {
    a.getFloatTimeDomainData(buf)
    let s = 0
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
    const r = Math.sqrt(s / buf.length)
    return r > 1e-10 ? 20 * Math.log10(r) : -200
  }

  return {
    input: splitter,
    sampleInput: sampleIn,
    fxInput: fxIn,
    eventsInput: eventsIn,
    output: out,
    nodes: { voice, preDrive, shaper, postDrive, comp, lim, ceiling, volume },
    setPreset(name, when = ctx.currentTime) {
      const p = config.presets[name]
      if (!p) throw new Error(`unknown preset "${name}" (expected ${Object.keys(config.presets).join(', ')})`)
      preset = p
      applyPreset(p, when, M.presetTauS)
      setDrive(lastDriveFor(), when)
    },
    get presetDrive() { return preset.drive },
    setVolume(v, when = ctx.currentTime) {
      at(volume.gain, volumeGain(v, config), when, M.volumeTauS)
    },
    setMix(m, when = ctx.currentTime) {
      mix = Math.max(0, Math.min(1, m))
      applyMix(when, M.mixTauS)
    },
    setSamplesActive(active, when = ctx.currentTime) {
      samplesActive = active
      applyMix(when, M.mixTauS)
    },
    setDriveFor(rpm, load, when) {
      lastRpmLoad.rpm = rpm; lastRpmLoad.load = load
      setDrive(driveForFrame(rpm, load, M, preset.drive), when)
    },
    get drive() { return lastDrive },
    levels() {
      return {
        exhaust: rmsDb(analysers.exhaust),
        intake: rmsDb(analysers.intake),
        mech: rmsDb(analysers.mech),
        sample: rmsDb(analysers.sample),
        master: rmsDb(analysers.master),
      }
    },
    dispose() {
      for (const n of [splitter, voiceBus, synthMix, preDrive, shaper, postDrive, hp, body, lowShelf,
        highShelf, lowpass, presetOut, sampleIn, sampleMix, fxIn, eventsIn, comp, lim, ceiling, volume, out,
        ...Object.values(voice), ...Object.values(analysers)]) {
        try { n.disconnect() } catch { /* already disconnected */ }
      }
    },
  }
}

export function volumeGain(v, config) {
  const x = Math.max(0, Math.min(1, v))
  return config.volume.cap * Math.pow(x, config.volume.curve)
}

export { dbToGain }
