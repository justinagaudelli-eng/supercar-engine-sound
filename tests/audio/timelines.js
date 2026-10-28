// Synthetic vehicle-model frame timelines for audio tests ([{ t, frame }], 60 Hz like the app).
// Shapes follow src/vehicle/config.js (PDK ratios, 110 ms upshift with 70 ms cut, 160 ms
// blips, 11 Hz limiter). Anything producing frames can be rendered with harness.js.

export const FRAME_DT = 1 / 60
const RATIOS = [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84]
const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)))

export function frame(rpm, load, extra = {}) {
  return {
    rpm, load, throttle: load, cut: 0, combustion: 1, starter: 0, engineState: 'running',
    gear: 3, shifting: false, events: [], ...extra,
  }
}

export function constant(rpm, load, duration) {
  const tl = []
  for (let t = 0; t <= duration; t += 0.25) tl.push({ t, frame: frame(rpm, load) })
  return tl
}

/** Full-load sweep idle → redline, then lift-off overrun back down (pops). rpmAt(t) for overlays. */
export function sweep({ up = 8, down = 5, lo = 900, hi = 9000, end = 2000 } = {}) {
  const rpmAt = (t) => (t <= up ? lo + (hi - lo) * t / up : hi - (hi - end) * Math.min(1, (t - up) / down))
  const tl = []
  for (let t = 0; t <= up + down; t += FRAME_DT) tl.push({ t, frame: frame(rpmAt(t), t <= up ? 1 : 0) })
  return { timeline: tl, duration: up + down + 0.5, rpmAt }
}

/** Full-throttle pulls through gears 1→5 with PDK upshifts (cut + ~110 ms rpm drop). */
export function upshifts({ start = 5500, shiftAt = 8800, rate = 4200, duration = 7 } = {}) {
  const tl = []
  const rpmTrace = []
  let rpm = start, gear = 1, shift = null
  for (let t = 0; t <= duration; t += FRAME_DT) {
    let cut = 0
    const events = []
    if (!shift) {
      rpm += rate * FRAME_DT * Math.pow(0.8, gear - 1)
      if (rpm >= shiftAt && gear < 5) {
        shift = { t0: t, from: rpm, to: rpm * RATIOS[gear] / RATIOS[gear - 1] }
        gear++
        events.push({ type: 'upshift', from: gear - 1, to: gear, load: 1 })
      }
    }
    if (shift) {
      const u = (t - shift.t0) / 0.11
      rpm = shift.from + (shift.to - shift.from) * ease(u)
      if (t - shift.t0 < 0.07) cut = 1
      if (u >= 1) shift = null
    }
    rpmTrace.push([t, rpm])
    tl.push({ t, frame: frame(rpm, 1, { cut, gear, shifting: !!shift, events }) })
  }
  return { timeline: tl, duration: duration + 0.3, rpmAt: interp(rpmTrace) }
}

/** Off-throttle deceleration with rev-matched downshift blips. */
export function downshiftBlips({ start = 7000, decel = 1300, at = 4200, duration = 7 } = {}) {
  const tl = []
  const rpmTrace = []
  let rpm = start, gear = 5, blip = null
  for (let t = 0; t <= duration; t += FRAME_DT) {
    let load = 0
    const events = []
    if (!blip) {
      rpm = Math.max(1500, rpm - decel * FRAME_DT)
      if (rpm <= at && gear > 2) {
        blip = { t0: t, from: rpm, to: rpm * RATIOS[gear - 2] / RATIOS[gear - 1] }
        gear--
        events.push({ type: 'downshift', from: gear + 1, to: gear })
      }
    }
    if (blip) {
      const u = (t - blip.t0) / 0.16
      // overshoot then settle onto the new-gear rpm
      rpm = blip.from + (blip.to + 260 * Math.sin(Math.PI * Math.min(1, u)) - blip.from) * ease(u * 1.4)
      load = u < 1 ? 0.55 : 0
      if (u >= 1) { rpm = blip.to; blip = null }
    }
    rpmTrace.push([t, rpm])
    tl.push({ t, frame: frame(rpm, load, { gear, shifting: !!blip, events }) })
  }
  return { timeline: tl, duration: duration + 0.3, rpmAt: interp(rpmTrace) }
}

/** Bouncing on the 9000 rpm limiter at full load (~11 Hz cut/recover). */
export function limiter({ duration = 3, hz = 11, top = 9000, bounce = 220 } = {}) {
  const tl = []
  const rpmTrace = []
  for (let t = 0; t <= duration; t += FRAME_DT) {
    let rpm, cut = 0
    const events = []
    if (t < 0.6) rpm = 8000 + (top - 8000) * t / 0.6
    else {
      const ph = ((t - 0.6) * hz) % 1
      if (ph < 0.35) { cut = 1; rpm = top - bounce * ph / 0.35 } else rpm = top - bounce * (1 - (ph - 0.35) / 0.65)
      if (t - 0.6 < FRAME_DT) events.push({ type: 'limiter' })
    }
    rpmTrace.push([t, rpm])
    tl.push({ t, frame: frame(rpm, 1, { cut, events }) })
  }
  return { timeline: tl, duration: duration + 0.3, rpmAt: interp(rpmTrace) }
}

/** Full-load pull, then lift-off (overrun pops/crackles) as revs fall. */
export function overrun({ pull = 1.2, fall = 3, from = 7200, to = 8200, end = 3000 } = {}) {
  const rpmAt = (t) => (t < pull ? from + (to - from) * t / pull : end + (to - end) * Math.exp(-(t - pull) / (fall / 2.5)))
  const tl = []
  for (let t = 0; t <= pull + fall; t += FRAME_DT) tl.push({ t, frame: frame(rpmAt(t), t < pull ? 1 : 0) })
  return { timeline: tl, duration: pull + fall + 0.3, rpmAt }
}

/** Key on: crank → catch → flare to 2500 → settle to idle; then key off. */
export function startStop({ crankAt = 0.2, crankS = 0.75, crankRpm = 230, flareRpm = 2500, idle = 900, stopAt = 4.5, stopS = 1.1, duration = 6.5 } = {}) {
  const tl = []
  const rpmTrace = []
  const catchAt = crankAt + crankS
  for (let t = 0; t <= duration; t += FRAME_DT) {
    const events = []
    let f
    if (t < crankAt) f = { rpm: 0, combustion: 0, starter: 0, engineState: 'off' }
    else if (t < catchAt) {
      if (t - crankAt < FRAME_DT) events.push({ type: 'startup' })
      f = { rpm: crankRpm * ease((t - crankAt) / 0.15), combustion: 0, starter: 1, engineState: 'cranking' }
    } else if (t < stopAt) {
      if (t - catchAt < FRAME_DT) events.push({ type: 'catch' })
      const u = t - catchAt
      const rpm = u < 0.35 ? crankRpm + (flareRpm - crankRpm) * ease(u / 0.35)
        : idle + (flareRpm - idle) * Math.exp(-(u - 0.35) / 0.7)
      f = { rpm, combustion: 1, starter: 0, engineState: 'running', load: u < 0.35 ? 0.35 : 0.15 }
    } else {
      if (t - stopAt < FRAME_DT) events.push({ type: 'shutdown' })
      const u = (t - stopAt) / stopS
      f = { rpm: u >= 1 ? 0 : idle * (1 - ease(u)), combustion: 0, starter: 0, engineState: u >= 1 ? 'off' : 'stopping' }
    }
    rpmTrace.push([t, f.rpm])
    tl.push({ t, frame: frame(f.rpm, f.load ?? 0.15, { ...f, events }) })
  }
  return { timeline: tl, duration, rpmAt: interp(rpmTrace) }
}

/** Sweep for the sample layer with load toggling (exercises rpm + on/off crossfades). */
export function sampleSweep({ duration = 8, lo = 1500, hi = 8500, togglePeriod = 1.6 } = {}) {
  const rpmAt = (t) => lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / duration))
  const tl = []
  for (let t = 0; t <= duration; t += FRAME_DT) {
    tl.push({ t, frame: frame(rpmAt(t), Math.floor(t / togglePeriod) % 2 ? 0 : 1) })
  }
  return { timeline: tl, duration: duration + 0.2, rpmAt }
}

function interp(trace) {
  return (t) => {
    let i = Math.min(trace.length - 1, Math.max(0, Math.round(t / FRAME_DT)))
    return trace[i][1]
  }
}

// Timelines produced by the real vehicle model (so they exercise its launch/shift logic).
import { createRpmModel } from '../../src/vehicle/rpmModel.js'
import { vehicleConfig } from '../../src/vehicle/config.js'

function fromModel(duration, inputAt) {
  const m = createRpmModel(vehicleConfig, { seed: 7 })
  m.forceRunning()
  const tl = [], rpmTrace = []
  for (let t = 0; t <= duration; t += FRAME_DT) {
    const f = m.step(FRAME_DT, inputAt(t))
    rpmTrace.push([t, f.rpm])
    tl.push({ t, frame: f })
  }
  return { timeline: tl, duration: duration + 0.3, rpmAt: interp(rpmTrace) }
}

/** Launch control: 2.5 s on the 2-step, then drive off hard (aggressive shifts). */
export function launchControl() {
  return fromModel(7, (t) => {
    const go = Math.max(0, t - 2.5)
    return { speedMps: go > 0 ? 5.5 * go : 0, accelMps2: go > 0 ? 5.5 : 0, load: go > 0 ? 1 : 0, launch: true, aggressive: true }
  })
}

/** Aggressive style: full-throttle pull through the gears, then hard braking with blips. */
export function aggressiveShifts() {
  return fromModel(12, (t) => {
    const v = t < 6 ? 2 + 5 * t : Math.max(0, 32 - 7 * (t - 6))
    return { speedMps: v, accelMps2: t < 6 ? 5 : -7, load: t < 6 ? 1 : 0, aggressive: true }
  })
}
