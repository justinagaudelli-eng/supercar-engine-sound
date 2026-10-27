// Event layer: translates vehicle-model frames into worklet parameter targets, and plays a
// few modest one-shot sounds on frame events. The rpm curves for startup / shifts / limiter
// come from the vehicle model itself; the worklet turns `cut`, `combustion` and `starter`
// into skipped firings, blats, thumps and starter whine. One-shots here only add what the
// worklet can't: starter solenoid click, the "catch" bark, key-off click + engine-stop thud,
// and a small crack on loaded upshifts.
//
// One-shot buffers are synthesised once (seeded, deterministic) with raised-cosine fade-in
// and fade-out, so they never click.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Pure: frame (vehicle model) → worklet parameter targets. */
export function frameToParams(frame) {
  const f = frame || {}
  const state = f.engineState || 'running'
  const rpm = Math.max(0, Number.isFinite(f.rpm) ? f.rpm : 0)
  const combustion = Number.isFinite(f.combustion) ? clamp01(f.combustion)
    : state === 'running' ? 1 : 0
  return {
    rpm,
    load: clamp01(Number.isFinite(f.load) ? f.load : 0),
    cut: clamp01(Number.isFinite(f.cut) ? f.cut : 0),
    combustion,
    starter: clamp01(Number.isFinite(f.starter) ? f.starter : state === 'cranking' ? 1 : 0),
  }
}

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function applyFades(data, sr, E) {
  const nIn = Math.max(1, Math.round(E.fadeInS * sr))
  const nOut = Math.max(1, Math.round(E.fadeOutS * sr))
  for (let i = 0; i < nIn && i < data.length; i++) data[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / nIn)
  for (let i = 0; i < nOut && i < data.length; i++) {
    data[data.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / nOut)
  }
}

// Two-pole resonant band-pass (RBJ), applied in place.
function bandpass(data, sr, hz, q) {
  const w = 2 * Math.PI * hz / sr
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < data.length; i++) {
    const x = data[i]
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    data[i] = y
  }
}

function lowpass1(data, sr, hz) {
  const c = 1 - Math.exp(-2 * Math.PI * hz / sr)
  let y = 0
  for (let i = 0; i < data.length; i++) { y += c * (data[i] - y); data[i] = y }
}

function normalize(data, level) {
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= level / peak
}

function makeBuffer(ctx, lengthS, fill) {
  const sr = ctx.sampleRate
  const buf = ctx.createBuffer(1, Math.max(1, Math.round(lengthS * sr)), sr)
  fill(buf.getChannelData(0), sr)
  return buf
}

/** Build one-shot buffers. Exported for tests / the debug UI. */
export function buildOneShots(ctx, config) {
  const E = config.events
  const rand = rng(config.seed ^ 0xe7e7)
  const noiseBurst = (d, sr, decayS) => {
    const k = Math.exp(-1 / (decayS * sr))
    let env = 1
    for (let i = 0; i < d.length; i++) { d[i] = (rand() * 2 - 1) * env; env *= k }
  }
  const click = (spec, second) => (d, sr) => {
    noiseBurst(d, sr, spec.decayS)
    if (second) {
      // solenoid: pull-in click then the pinion engaging a few ms later
      const off = Math.round(spec.secondDelayS * sr)
      const k = Math.exp(-1 / (spec.decayS * sr))
      let env = 0.7
      for (let i = off; i < d.length; i++) { d[i] += (rand() * 2 - 1) * env; env *= k }
    }
    bandpass(d, sr, spec.bpHz, 2)
    applyFades(d, sr, E)
    normalize(d, spec.level)
  }
  const C = E.catchBark
  const T = E.shutdownThud
  return {
    solenoid: makeBuffer(ctx, E.solenoidClick.lengthS, click(E.solenoidClick, true)),
    shutdownClick: makeBuffer(ctx, E.shutdownClick.lengthS, click(E.shutdownClick, false)),
    shiftCrack: makeBuffer(ctx, E.shiftCrack.lengthS, (d, sr) => {
      noiseBurst(d, sr, E.shiftCrack.decayS)
      bandpass(d, sr, E.shiftCrack.bpHz, 1.2)
      applyFades(d, sr, E)
      normalize(d, E.shiftCrack.level)
    }),
    catchBark: makeBuffer(ctx, C.lengthS, (d, sr) => {
      // low thump + lowpassed noise "whump" as the first cylinders light off
      const noise = new Float32Array(d.length)
      noiseBurst(noise, sr, C.decayS)
      lowpass1(noise, sr, C.noiseLpHz)
      lowpass1(noise, sr, C.noiseLpHz)
      const k = Math.exp(-1 / (C.decayS * sr))
      let env = 1
      for (let i = 0; i < d.length; i++) {
        d[i] = env * Math.sin(2 * Math.PI * C.thumpHz * i / sr) + C.noiseLevel * 4 * noise[i]
        env *= k
      }
      applyFades(d, sr, E)
      normalize(d, C.level)
    }),
    shutdownThud: makeBuffer(ctx, T.lengthS, (d, sr) => {
      const k = Math.exp(-1 / (T.decayS * sr))
      let env = 1
      for (let i = 0; i < d.length; i++) {
        // the engine rocking on its mounts as it stops: a low, slightly falling thud
        const f = T.hz * (1 - 0.2 * i / d.length)
        d[i] = env * Math.sin(2 * Math.PI * f * i / sr)
        env *= k
      }
      applyFades(d, sr, E)
      normalize(d, T.level)
    }),
  }
}

export function createEvents(ctx, config, destination) {
  const E = config.events
  const shots = buildOneShots(ctx, config)
  const live = new Set()

  function play(buffer, when, gain = 1) {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    let node = src
    if (gain !== 1) {
      const g = ctx.createGain()
      g.gain.value = gain
      src.connect(g)
      node = g
    }
    node.connect(destination)
    live.add(src)
    src.onended = () => { live.delete(src); try { node.disconnect() } catch { /* gone */ } }
    src.start(Math.max(when, ctx.currentTime))
  }

  return {
    frameToParams,
    /** Schedule one-shots for this frame's events at `when` (seconds, context time). */
    handle(frame, when) {
      const events = frame && frame.events
      if (!events || events.length === 0) return
      for (const ev of events) {
        switch (ev.type) {
          case 'startup': play(shots.solenoid, when); break
          case 'catch': play(shots.catchBark, when); break
          case 'shutdown':
            play(shots.shutdownClick, when)
            play(shots.shutdownThud, when + E.shutdownThud.delayS)
            break
          case 'upshift': {
            const load = Number.isFinite(ev.load) ? ev.load : frame.load
            if (load >= E.shiftCrack.minLoad) play(shots.shiftCrack, when, load)
            break
          }
          default: break // 'downshift' / 'limiter': worklet handles via rpm/load/cut
        }
      }
    },
    dispose() {
      for (const s of live) { try { s.stop() } catch { /* not started */ } }
      live.clear()
    },
  }
}
