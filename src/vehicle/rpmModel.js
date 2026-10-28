// Engine + PDK behaviour: turns (speed, accel, load) into rpm, gear and sound-relevant
// flags every frame. Deterministic for a given seed and dt sequence.

import { coupledRpm, bestGear } from './gearbox.js'
import { clamp, clamp01, lerp, onePole, rng } from '../util/math.js'

export function createRpmModel(cfg, { seed = 1 } = {}) {
  const E = cfg.engine, GB = cfg.gearbox, S = cfg.shift, L = cfg.launch, ST = cfg.startup
  const topGear = GB.ratios.length
  const random = rng(seed)

  let state = 'off'          // 'off' | 'cranking' | 'running' | 'stopping'
  let t = 0                  // model time (s)
  let stateT = 0             // time in current state
  let rpm = 0
  let gear = 1
  let gearChosen = false     // false until we've picked a gear for the current speed
  let load = 0               // smoothed load (sound)
  let shiftLoad = 0          // slower-smoothed load for shift decisions (ignores accel noise)
  let lastShiftType = null
  let kickdownUntil = -Infinity
  let lastShiftT = -Infinity
  let shift = null           // { type, from, toGear, t0, dur, startRpm }
  let limiterPhase = 0
  let limiterActive = false
  let catchT = null          // when the engine caught (for the startup flare)
  let stopFromRpm = 0
  let announced = false      // startup/shutdown event sent for the current state
  let lastStatus = null      // input status last frame (to spot the first live fix)
  let wobblePhase = random() * 10
  let wobbleWalk = 0

  function upshiftRpm(ld) {
    const x = clamp01((ld - S.upshiftLoadLo) / (S.upshiftLoadHi - S.upshiftLoadLo))
    return lerp(S.upshiftLightRpm, S.upshiftFullRpm, Math.pow(x, S.upshiftCurve))
  }

  function downshiftRpm(ld, accel) {
    let r = lerp(S.downshiftLightRpm, S.downshiftFullRpm, Math.pow(clamp01(ld), S.downshiftCurve))
    if (accel <= S.brakingAccelMps2) r = Math.max(r, S.brakingDownshiftRpm)
    return r
  }

  function idleTarget(dt) {
    // Two slow incommensurate sines + a gentle random walk = a living, unsteady idle.
    wobblePhase += dt
    wobbleWalk = clamp(wobbleWalk + (random() - 0.5) * 0.4 * dt * 10, -1, 1) * 0.995
    const w = 0.55 * Math.sin(2 * Math.PI * 0.37 * wobblePhase) +
      0.3 * Math.sin(2 * Math.PI * 1.13 * wobblePhase + 1.3) + 0.15 * wobbleWalk
    let target = E.idleRpm + E.idleWobbleRpm * w
    // Startup flare: rise to flareRpm then settle back to idle.
    if (catchT != null) {
      const since = t - catchT
      const flare = ST.flareRpm - E.idleRpm
      const env = since < ST.flareRiseS
        ? Math.sin((since / ST.flareRiseS) * Math.PI / 2)
        : Math.exp(-(since - ST.flareRiseS) / ST.settleTauS)
      target += flare * env
      if (since > ST.flareRiseS + 6 * ST.settleTauS) catchT = null
    }
    return target
  }

  function chooseInitialGear(speed, ld) {
    const lo = downshiftRpm(ld, 0) + S.hysteresisRpm * 0.5
    const hi = upshiftRpm(ld)
    gear = speed < L.creepSpeedMps ? 1 : bestGear(speed, lo, hi, GB)
    gearChosen = true
  }

  function beginShift(type, toGear, startRpm, events) {
    const dur = type === 'upshift' ? S.upshiftTimeS : S.downshiftTimeS
    shift = { type, from: gear, toGear, t0: t, dur, startRpm }
    events.push({ type, from: gear, to: toGear, load })
    lastShiftType = type
    gear = toGear
    lastShiftT = t
  }

  function decideShift(speed, accel, events) {
    if (shift) return
    const since = t - lastShiftT
    const cur = coupledRpm(speed, gear, GB)
    const braking = accel <= S.brakingAccelMps2
    // Under braking PDK holds lower gears (engine braking + blips), so the ceiling rises.
    // Upshift point: noise spikes in load may only delay an upshift (max of fast/slow);
    // downshift point: uses the slow load so a spike can't trigger one.
    const upLoad = Math.max(load, shiftLoad)
    const up = braking ? Math.max(upshiftRpm(upLoad), S.brakingUpshiftFloorRpm) : upshiftRpm(upLoad)
    // Current gear is physically impossible (speed appeared suddenly, e.g. GPS lock while
    // rolling): select the right gear silently instead of cascading through shifts.
    if (cur > E.limiterRpm + 300) {
      gear = bestGear(speed, downshiftRpm(shiftLoad, accel) + S.hysteresisRpm * 0.5, up, GB)
      return
    }
    // Changing direction (up after down or vice versa) needs a longer pause: anti-hunt.
    const reverseOk = (type) => lastShiftType == null || lastShiftType === type || since >= S.reverseShiftIntervalS
    // Upshift: a full-throttle run may shift as soon as the next gear is ready; otherwise
    // respect the minimum interval and any kickdown hold.
    const flatOut = cur >= S.upshiftFullRpm - 50
    if (gear < topGear && cur >= up && (flatOut ||
        (since >= S.minShiftIntervalS && t >= kickdownUntil && reverseOk('upshift')))) {
      beginShift('upshift', gear + 1, rpm, events)
      return
    }
    if (gear <= 1) return
    // Stopped, or rolling so slowly the clutch is open: PDK silently drops to the right gear.
    if (speed < L.creepSpeedMps || cur < E.idleRpm * 0.9) {
      gear = speed < L.creepSpeedMps ? 1 : bestGear(speed, E.idleRpm, up, GB)
      return
    }
    const lower = coupledRpm(speed, gear - 1, GB)
    const landsOk = lower <= up - S.hysteresisRpm
    // Kickdown: lots of throttle and a lower gear has room to pull.
    if (load >= S.kickdownLoad && shiftLoad >= S.kickdownLoad * 0.7 && lower <= S.kickdownTargetRpm &&
        landsOk && since >= S.kickdownIntervalS) {
      beginShift('downshift', gear - 1, rpm, events)
      kickdownUntil = t + S.kickdownHoldS
      return
    }
    // Normal / braking downshift when revs sag.
    const interval = braking ? S.brakingShiftIntervalS : S.minShiftIntervalS
    if (cur < downshiftRpm(shiftLoad, accel) && landsOk && since >= interval && reverseOk('downshift')) {
      beginShift('downshift', gear - 1, rpm, events)
    }
  }

  // Drivetrain rpm the engine is pulled toward (clutch slip near standstill, idle floor).
  function drivetrainTarget(speed, idle) {
    const coupled = coupledRpm(speed, gear, GB)
    if (gear === 1) {
      const slip = lerp(L.clutchSlipRpmLight, L.clutchSlipRpmFull, clamp01(load))
      // Clutch slips until the wheels catch up with the slip rpm (only while driving off).
      if (load > 0.05 && coupled < slip) return Math.max(idle, slip)
    }
    return Math.max(idle, coupled)
  }

  function stepRunning(dt, input, frame) {
    const { speedMps: speed = 0, accelMps2: accel = 0, freeRev = false } = input
    const idle = idleTarget(dt)

    if (freeRev && speed < L.creepSpeedMps) {
      // Parked/neutral revving (simulator "rev in neutral" button).
      gear = 0; shift = null; gearChosen = false
      const target = idle + Math.pow(load, 1.3) * (E.limiterRpm + 400 - idle)
      const rate = target > rpm ? E.freeRevRiseRpmPerS : E.freeRevFallRpmPerS
      rpm += clamp(target - rpm, -rate * dt, rate * dt)
      return applyLimiter(dt, rpm >= E.limiterRpm - 1 && load > 0.5, frame)
    }

    // First fix after 'waiting' (or after a lost signal): the car may already be rolling,
    // so pick the right gear silently rather than revving through a shift cascade.
    if (input.status && input.status !== lastStatus && (lastStatus === 'waiting' || lastStatus === 'lost')) {
      gearChosen = false
    }
    lastStatus = input.status ?? lastStatus
    if (!gearChosen || gear === 0) chooseInitialGear(speed, load)
    decideShift(speed, accel, frame.events)

    const target = drivetrainTarget(speed, idle)
    if (shift) {
      const p = clamp01((t - shift.t0) / shift.dur)
      frame.shifting = true
      if (shift.type === 'upshift') {
        // Eased drop from the old-gear rpm to the new-gear rpm; ignition cut at the start.
        const e = p * p * (3 - 2 * p)
        rpm = lerp(shift.startRpm, target, e)
        if (load >= S.upshiftCutMinLoad && (t - shift.t0) < S.upshiftCutS) frame.cut = 1
      } else {
        // Rev-match blip: overshoot the new-gear rpm slightly, then settle onto it.
        const peak = target + S.blipOvershootRpm
        rpm = p < 0.6 ? lerp(shift.startRpm, peak, Math.sin((p / 0.6) * Math.PI / 2))
          : lerp(peak, target, (p - 0.6) / 0.4)
        frame.load = Math.max(frame.load, S.blipLoad * Math.sin(p * Math.PI))
      }
      if (p >= 1) shift = null
    } else {
      const step = (target - rpm) * onePole(dt, E.rpmTauS)
      rpm += clamp(step, -E.maxSlewRpmPerS * dt, E.maxSlewRpmPerS * dt)
    }

    const atLimiter = rpm >= E.limiterRpm - 1 && load > 0.5
    return applyLimiter(dt, atLimiter, frame)
  }

  function applyLimiter(dt, atLimiter, frame) {
    if (rpm > E.limiterRpm) rpm = E.limiterRpm
    if (atLimiter) {
      if (!limiterActive) frame.events.push({ type: 'limiter' })
      limiterActive = true
      limiterPhase = (limiterPhase + dt * E.limiterHz) % 1
      // Sawtooth-ish bounce: fuel cut drops revs quickly, they recover as it re-fires.
      const drop = limiterPhase < 0.35 ? limiterPhase / 0.35 : 1 - (limiterPhase - 0.35) / 0.65
      rpm = E.limiterRpm - E.limiterBounceRpm * drop
      if (limiterPhase < 0.35) frame.cut = 1
    } else {
      limiterActive = false
      limiterPhase = 0
    }
  }

  return {
    start() {
      if (state === 'running' || state === 'cranking') return
      state = 'cranking'; stateT = 0; rpm = 0; gearChosen = false; shift = null; announced = false
    },
    stop() {
      if (state === 'off' || state === 'stopping') return
      state = 'stopping'; stateT = 0; stopFromRpm = rpm; shift = null; announced = false
    },
    reset() {
      state = 'off'; t = 0; stateT = 0; rpm = 0; gear = 1; gearChosen = false; load = 0
      lastShiftT = -Infinity; shift = null; limiterActive = false; catchT = null
      shiftLoad = 0; lastShiftType = null; kickdownUntil = -Infinity
    },
    /** Jump straight to running (tests, page reload while driving). */
    forceRunning() { state = 'running'; stateT = 0; rpm = E.idleRpm; catchT = null },
    get state() { return state },

    step(dtIn, input = {}) {
      const dt = clamp(dtIn, 0, 0.25)
      t += dt; stateT += dt
      const target = clamp01(input.load ?? 0)
      load += (target - load) * onePole(dt, target > load ? cfg.load.attackS : cfg.load.releaseS)
      shiftLoad += (target - shiftLoad) * onePole(dt, cfg.load.shiftTauS)

      const frame = {
        rpm: 0, gear: 0, load, throttle: target, cut: 0, combustion: 0, starter: 0,
        engineState: state, shifting: false, events: [], speedMps: input.speedMps ?? 0,
      }

      if (state === 'off') {
        rpm = 0
      } else if (state === 'cranking') {
        frame.starter = 1
        // Starter turns the engine with a compression-stroke ripple.
        rpm = ST.crankRpm * (1 + 0.12 * Math.sin(2 * Math.PI * (ST.crankRpm / 60 * 3) * stateT))
        if (!announced) { frame.events.push({ type: 'startup' }); announced = true }
        if (stateT >= ST.crankS) {
          state = 'running'; stateT = 0; catchT = t
          frame.events.push({ type: 'catch' })
          frame.engineState = 'running'
        }
      }
      if (state === 'running') {
        frame.combustion = 1
        stepRunning(dt, input, frame)
        frame.gear = gear
      } else if (state === 'stopping') {
        if (!announced) { frame.events.push({ type: 'shutdown' }); announced = true }
        const p = clamp01(stateT / ST.shutdownS)
        rpm = stopFromRpm * (1 - p) * (1 - p)
        frame.combustion = 0
        if (p >= 1) { state = 'off'; rpm = 0; frame.engineState = 'off' }
      }

      frame.rpm = rpm
      frame.load = state === 'running' ? Math.max(frame.load, 0) : 0
      return frame
    },
  }
}
