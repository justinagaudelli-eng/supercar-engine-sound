// The input → vehicle pipeline shared by the app, offline audio tests and dev scripts.

import { inputConfig } from './input/config.js'
import { vehicleConfig } from './vehicle/config.js'
import { createInputBus } from './input/inputBus.js'
import { createReplay } from './input/replay.js'
import { createRpmModel } from './vehicle/rpmModel.js'

export function createPipeline({ input = inputConfig, vehicle = vehicleConfig, seed = 1 } = {}) {
  const bus = createInputBus(input)
  let lastMs = null

  const p = {
    bus,
    model: createRpmModel(vehicle, { seed }),
    /** Swap the car (gearing, redline…). The new model starts with the engine off. */
    setVehicle(v) { p.model = createRpmModel(v, { seed }) },
    /** Advance to nowMs; extra flags (e.g. freeRev) are passed to the rpm model. */
    tick(nowMs, extra = {}) {
      const dt = lastMs == null ? 0 : (nowMs - lastMs) / 1000
      lastMs = nowMs
      const estimate = bus.estimate(nowMs)
      const frame = p.model.step(dt, { ...estimate, ...extra })
      return { estimate, frame }
    },
    resetClock() { lastMs = null },
  }
  return p
}

/**
 * Run a GPS trace through replay → bus → rpm model at `fps` and return a frame timeline
 * [{ t (s), frame, estimate }] for offline rendering. The engine starts already running
 * unless `withStartup` is set, in which case the trace starts after the startup sequence.
 */
export function traceToTimeline(trace, { fps = 200, withStartup = false, tailS = 1, seed = 1, vehicle = vehicleConfig } = {}) {
  const p = createPipeline({ seed, vehicle })
  const timeline = []
  let offsetS = 0
  if (withStartup) {
    p.model.start()
    const startS = 3
    for (let i = 0; i <= startS * fps; i++) {
      const t = i / fps
      timeline.push({ t, ...p.tick(t * 1000) })
    }
    offsetS = startS
  } else {
    p.model.forceRunning()
  }
  const rep = createReplay(trace, inputConfig.gps, { onSample: (s) => p.bus.push(s) })
  const durS = (trace.durationS ?? trace.fixes.at(-1).t / 1000) + tailS
  for (let i = 1; i <= durS * fps; i++) {
    const t = offsetS + i / fps
    rep.step(t * 1000) // replay clock starts at its first step
    timeline.push({ t, ...p.tick(t * 1000) })
  }
  return timeline
}
