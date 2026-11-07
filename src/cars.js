// Car profiles. Each car is a set of overrides on top of the GT3 RS base configs
// (src/vehicle/config.js, src/audio/config.js). buildCar(id) returns complete configs.
//
// Confidence: engine layout, displacement, redline and published gear ratios come from maker
// data / spec databases where noted; everything marked ESTIMATE is a plausible value chosen
// so the speed-vs-rpm and shift behaviour feel right (exact ratios weren't published).
// The sound itself is synthesized: no recordings of these cars are used.

import { vehicleConfig as baseVehicle } from './vehicle/config.js'
import { audioConfig as baseAudio } from './audio/config.js'

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)

/** Deep merge: objects merge recursively, arrays and scalars replace. Never mutates. */
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over
  const out = isObj(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : v
  return out
}

// Scale every *Rpm field (and [lo, hi] *Rpm pairs) in an object tree by k. Used to move the
// GT3 RS's shift points / rpm thresholds onto an engine with a different redline.
function scaleRpm(obj, k) {
  const out = {}
  for (const [key, v] of Object.entries(obj)) {
    if (isObj(v)) out[key] = scaleRpm(v, k)
    else if (/Rpm$/.test(key) && typeof v === 'number') out[key] = Math.round(v * k)
    else if (/Rpm$/.test(key) && Array.isArray(v)) out[key] = v.map((x) => Math.round(x * k))
    else out[key] = v
  }
  return out
}

const BASE_REDLINE = baseVehicle.engine.redlineRpm   // 9000
const BASE_CYL = baseAudio.worklet.firingOrder.length // 6

// Common audio overrides derived from redline + cylinder count, so a profile only has to
// state what makes that car sound different.
function derivedAudio(redline, cylinders) {
  const k = redline / BASE_REDLINE
  const W = baseAudio.worklet
  const perSlot = BASE_CYL / cylinders       // per-firing probabilities → same events per second
  return {
    worklet: {
      redlineRpm: redline,
      exhaust: { flapOpenRpm: W.exhaust.flapOpenRpm.map((x) => Math.round(x * k)) },
      intake: { flapBumps: W.intake.flapBumps.map((b) => ({ ...b, rpm: Math.round(b.rpm * k) })) },
      overrun: {
        minRpm: Math.round(W.overrun.minRpm * k), fullRpm: Math.round(W.overrun.fullRpm * k),
        probBase: W.overrun.probBase * perSlot, probPerRpm: W.overrun.probPerRpm * perSlot,
      },
      twoStep: { bangProb: W.twoStep.bangProb * perSlot },
      rasp: { startRpm: Math.round(W.rasp.startRpm * k), fullRpm: redline },
    },
    mixer: { drive: { redlineRpm: redline } },
  }
}

function derivedVehicle(redline) {
  const k = redline / BASE_REDLINE
  const shift = scaleRpm(baseVehicle.shift, k)
  shift.upshiftFullRpm = redline - 150
  return {
    engine: { redlineRpm: redline, limiterRpm: redline },
    shift,
  }
}

// Shared turbo defaults (worklet.turbo). null on naturally aspirated cars.
const TURBO = {
  spoolRpm: [1800, 4200],        // boost builds between these (× load)
  spoolTauS: 0.45,               // boost rise time constant (lag)
  dumpTauS: 0.12,                // boost falls this fast off throttle
  shaftUpTauS: 0.5,              // turbine speed follows boost…
  shaftDownTauS: 1.4,            // …and spins down slowly (the whistle after a lift)
  shaftIdle: 0.12,               // free-spinning turbine from exhaust flow alone (× rpm/redline)
  torqueLag: 0.35,               // share of combustion strength that waits for boost
  cutDump: 0.5,                  // ignition cut drops boost target by this much
  whine: { hzLo: 2400, hzHi: 7200, level: 0.018, h2: 0.22, loadMin: 0.35 },
  whoosh: { hzLo: 900, hzHi: 3200, q: 1.1, level: 0.09 },
  bov: {
    armLoad: 0.5, armBoost: 0.35, liftLoad: 0.15,
    level: 0.7, attackS: 0.004, decayS: 0.2,
    hzStart: 3400, hzEnd: 1400, q: 1.4,
    flutter: 0.55, flutterHz: 17, // compressor surge "chatter" (0 = clean pssh)
    shiftGain: 0.45,              // a loaded upshift gives a smaller chuff
    dump: 0.6, minIntervalS: 0.35,
  },
}

// Firing orders (cylinder numbers; bankBFirstCylinder marks where bank B starts).
const FLAT_PLANE_V8 = { firingOrder: [1, 5, 3, 7, 4, 8, 2, 6], bankBFirstCylinder: 5 }
const V10 = { firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9], bankBFirstCylinder: 6 }
const V12 = { firingOrder: [1, 7, 4, 10, 2, 8, 6, 12, 3, 9, 5, 11], bankBFirstCylinder: 7 }

export const CARS = [
  {
    id: 'gt3rs',
    name: 'Porsche 911 GT3 RS (992)',
    short: 'GT3 RS',
    engine: '4.0 L flat-six · naturally aspirated · 9,000 rpm',
    redlineRpm: 9000,
    vehicle: {},
    audio: {},
  },
  {
    id: 'svj',
    name: 'Lamborghini Aventador SVJ',
    short: 'Aventador SVJ',
    engine: '6.5 L V12 · naturally aspirated · 8,700 rpm',
    redlineRpm: 8700,
    vehicle: {
      engine: { idleRpm: 1000, idleWobbleRpm: 18, freeRevRiseRpmPerS: 11000, freeRevFallRpmPerS: 6000 },
      // ISR 7-speed single-clutch automated manual: brutal, slightly slower shifts.
      // Ratios: spec databases (Motor Matchup / CarSpecs); final 2.86.
      gearbox: { ratios: [3.91, 2.44, 1.81, 1.46, 1.19, 0.97, 0.89], finalDrive: 2.86, tireCircumferenceM: 2.17 },
      shift: { upshiftTimeS: 0.14, upshiftCutS: 0.1, aggressive: { upshiftCutS: 0.13, upshiftBang: 0.95 } },
      launch: { twoStepRpm: 5000, twoStepBounceRpm: 420 },
      startup: { crankS: 0.9, flareRpm: 3200, flareRiseS: 0.4 },
      sim: { massKg: 1700 + 80, peakPowerW: 566000, tractionMu: 1.3, rearWeightFrac: 1, cdA: 0.8 },
    },
    audio: {
      worklet: {
        ...V12,
        imbalance: { timingDeg: 1.6, gainLo: 0.1, gainHi: 0.05 },
        lump: { sigmaLo: 0.06 },
        pulse: { decayFracLo: 0.34, decayFracHi: 0.24 },
        exhaust: {
          headerA: { delayS: 0.0029, feedback: 0.42, lpHz: 5500 },
          headerB: { delayS: 0.0031, feedback: 0.42, lpHz: 5500 },
          main: { delayS: 0.0052, feedback: 0.28, lpHz: 3000 },
          flapMixClosed: 0.65, flapMixOpen: 0.15,
          lowpass: { baseHz: 900, perRpmHz: 0.65, maxHz: 8500 },
        },
        rasp: { drive: 6, level: 0.42, hpHz: 1600 },
        intake: { howl: { hzLo: 1050, hzHi: 1500, q: 2, gain: 0.85 }, gain: 0.7 },
        mech: { orders: [6, 12, 18, 24], ampLo: [0.005, 0.003, 0.002, 0.001], ampHi: [0.016, 0.014, 0.01, 0.008] },
        overrun: { gainMin: 0.6, gainMax: 1.15, burstProb: 0.35, windowS: 2.2 },
        turbo: null,
      },
    },
  },
  {
    id: 'sto',
    name: 'Lamborghini Huracán STO',
    short: 'Huracán STO',
    engine: '5.2 L V10 · naturally aspirated · 8,500 rpm',
    redlineRpm: 8500,
    vehicle: {
      engine: { idleRpm: 1000, idleWobbleRpm: 20 },
      // 7-speed DCT. Ratios ESTIMATE (Huracán family; STO is geared short).
      gearbox: { ratios: [3.13, 2.59, 1.96, 1.52, 1.2, 0.98, 0.81], finalDrive: 3.4, tireCircumferenceM: 2.14 },
      launch: { twoStepRpm: 5200 },
      startup: { flareRpm: 3000 },
      sim: { massKg: 1450 + 80, peakPowerW: 470000, tractionMu: 1.3, rearWeightFrac: 0.59, cdA: 0.85 },
    },
    audio: {
      worklet: {
        ...V10,
        imbalance: { timingDeg: 2.2, gainLo: 0.14, gainHi: 0.07 },
        exhaust: {
          headerA: { delayS: 0.0026, feedback: 0.44, lpHz: 5500 },
          headerB: { delayS: 0.0028, feedback: 0.44, lpHz: 5500 },
          main: { delayS: 0.0042, feedback: 0.26, lpHz: 3200 },   // short top-exit pipes
          flapMixClosed: 0.6, flapMixOpen: 0.12,
          lowpass: { baseHz: 850, perRpmHz: 0.7, maxHz: 8500 },
        },
        rasp: { drive: 7, level: 0.46, hpHz: 1500 },
        intake: { howl: { hzLo: 1000, hzHi: 1400, q: 2, gain: 0.8 }, gain: 0.65 },
        mech: { orders: [5, 10, 15, 20], ampLo: [0.006, 0.004, 0.003, 0.0015], ampHi: [0.018, 0.016, 0.012, 0.009] },
        overrun: { gainMin: 0.6, gainMax: 1.05, burstProb: 0.4, windowS: 2.4 },
        twoStep: { bangGain: 1.4 },
        turbo: null,
      },
    },
  },
  {
    id: 'temerario',
    name: 'Lamborghini Temerario',
    short: 'Temerario',
    engine: '4.0 L twin-turbo flat-plane V8 hybrid · 10,000 rpm',
    redlineRpm: 10000,
    vehicle: {
      engine: { idleRpm: 1050, freeRevRiseRpmPerS: 16000, freeRevFallRpmPerS: 8000 },
      // 8-speed DCT. Ratios ESTIMATE (not published at time of writing).
      gearbox: { ratios: [3.33, 2.55, 2.02, 1.66, 1.4, 1.2, 1.06, 0.95], finalDrive: 3.9, tireCircumferenceM: 2.22 },
      launch: { twoStepRpm: 4500, twoStepBounceRpm: 380 },
      startup: { flareRpm: 2800 },
      sim: { massKg: 1800 + 80, peakPowerW: 677000, tractionMu: 1.3, rearWeightFrac: 1, cdA: 0.75 },
    },
    audio: {
      worklet: {
        ...FLAT_PLANE_V8,
        imbalance: { timingDeg: 2, gainLo: 0.12, gainHi: 0.06 },
        pulse: { turbulence: 0.38 },
        exhaust: {
          headerA: { delayS: 0.0022, feedback: 0.36, lpHz: 4500 },
          headerB: { delayS: 0.0024, feedback: 0.36, lpHz: 4500 },
          main: { delayS: 0.0058, feedback: 0.3, lpHz: 2600 },
          lowpass: { baseHz: 650, perRpmHz: 0.5, maxHz: 7000 },   // turbines take the edge off
        },
        rasp: { level: 0.26 },
        intake: { tonal: 0.6, noise: 0.5, howl: { gain: 0.4 } },
        mech: { orders: [4, 8, 12, 16], ampLo: [0.006, 0.004, 0.003, 0.0015], ampHi: [0.02, 0.018, 0.014, 0.01] },
        overrun: { gainMin: 0.4, gainMax: 0.85 },
        // Electric motors fill the low end → turbo lag is barely felt.
        turbo: { ...TURBO, spoolRpm: [2200, 4500], spoolTauS: 0.25, torqueLag: 0.2,
          whine: { ...TURBO.whine, hzHi: 7800 }, bov: { ...TURBO.bov, flutter: 0.35, level: 0.55 } },
      },
    },
  },
  {
    id: '765lt',
    name: 'McLaren 765LT',
    short: '765LT',
    engine: '4.0 L twin-turbo flat-plane V8 · 8,500 rpm',
    redlineRpm: 8500,
    vehicle: {
      engine: { idleRpm: 950 },
      // 7-speed SSG. Ratios ESTIMATE (720S-style, shorter final drive per McLaren).
      gearbox: { ratios: [3.98, 2.61, 1.91, 1.48, 1.16, 0.99, 0.84], finalDrive: 3.6, tireCircumferenceM: 2.11 },
      launch: { twoStepRpm: 4000, twoStepBounceRpm: 360 },
      startup: { flareRpm: 2400 },
      sim: { massKg: 1420 + 80, peakPowerW: 563000, tractionMu: 1.3, rearWeightFrac: 0.58, cdA: 0.75 },
    },
    audio: {
      worklet: {
        ...FLAT_PLANE_V8,
        pulse: { turbulence: 0.42, turbulenceOffLoad: 0.4 },
        exhaust: {
          headerA: { delayS: 0.0021, feedback: 0.34, lpHz: 4200 },
          headerB: { delayS: 0.0023, feedback: 0.34, lpHz: 4200 },
          main: { delayS: 0.0048, feedback: 0.3, lpHz: 2400 },
          flapMixClosed: 0.6, flapMixOpen: 0.2,
          lowpass: { baseHz: 600, perRpmHz: 0.45, maxHz: 6500 },
        },
        rasp: { level: 0.2, drive: 4 },
        intake: { tonal: 0.5, noise: 0.6, howl: { gain: 0.35 } },
        mech: { orders: [4, 8, 12, 16], ampLo: [0.006, 0.004, 0.003, 0.0015], ampHi: [0.02, 0.018, 0.014, 0.01] },
        overrun: { gainMin: 0.45, gainMax: 0.95, burstProb: 0.3 },
        // Big turbos, noticeable lag, loud wastegate chatter and flutter on lift.
        turbo: { ...TURBO, spoolRpm: [2500, 5000], spoolTauS: 0.55, torqueLag: 0.45,
          whoosh: { ...TURBO.whoosh, level: 0.13 },
          bov: { ...TURBO.bov, level: 0.9, flutter: 0.75, flutterHz: 15, decayS: 0.26 } },
      },
    },
  },
  {
    id: 'turbos',
    name: 'Porsche 911 Turbo S (992)',
    short: '911 Turbo S',
    engine: '3.7 L twin-turbo flat-six · 7,200 rpm',
    redlineRpm: 7200,
    vehicle: {
      engine: { idleRpm: 850, freeRevRiseRpmPerS: 9000, freeRevFallRpmPerS: 5000 },
      // 8-speed PDK. Ratios ESTIMATE.
      gearbox: { ratios: [4.89, 3.17, 2.15, 1.56, 1.18, 0.93, 0.76, 0.62], finalDrive: 3.05, tireCircumferenceM: 2.2 },
      launch: { twoStepRpm: 4200, twoStepBounceRpm: 350 },
      startup: { flareRpm: 2000 },
      sim: { massKg: 1640 + 80, peakPowerW: 478000, tractionMu: 1.25, rearWeightFrac: 1, cdA: 0.69 },
    },
    audio: {
      worklet: {
        pulse: { turbulence: 0.4 },
        exhaust: {
          flapMixClosed: 0.85, flapMixOpen: 0.45,
          lowpass: { baseHz: 550, perRpmHz: 0.5, maxHz: 5500 },
        },
        rasp: { level: 0.12, drive: 3 },
        intake: { tonal: 0.5, noise: 0.55, howl: { gain: 0.3 } },
        overrun: { gainMin: 0.3, gainMax: 0.6, probBase: 0.003 },
        turbo: { ...TURBO, spoolRpm: [1600, 3600], spoolTauS: 0.4,
          bov: { ...TURBO.bov, flutter: 0.2, level: 0.6 } },
      },
    },
  },
]

export const DEFAULT_CAR = 'gt3rs'
export const CAR_IDS = CARS.map((c) => c.id)

/** Complete { car, vehicle, audio } configs for a car id (unknown id → default car). */
export function buildCar(id) {
  const car = CARS.find((c) => c.id === id) ?? CARS.find((c) => c.id === DEFAULT_CAR)
  if (car.id === DEFAULT_CAR) return { car, vehicle: baseVehicle, audio: baseAudio }
  const cyl = (car.audio.worklet?.firingOrder ?? baseAudio.worklet.firingOrder).length
  const vehicle = merge(merge(baseVehicle, derivedVehicle(car.redlineRpm)), car.vehicle)
  const audio = merge(merge(baseAudio, derivedAudio(car.redlineRpm, cyl)), car.audio)
  return { car, vehicle, audio }
}
