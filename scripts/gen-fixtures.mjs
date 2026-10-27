// Generates the synthetic GPS drive traces in fixtures/ (deterministic, seeded).
// Run: node scripts/gen-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { rng } from '../src/util/math.js'

const MPH = 0.44704
const ORIGIN = { lat: 37.4, lon: -122.1 }
const M_PER_DEG_LAT = 111320

function gauss(rand) {
  // Box–Muller
  const u = Math.max(1e-12, rand()), v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * segments: [{ dur (s), to (mph) }] — linear speed change to `to` over `dur`
 * (or hold when `to` equals the current speed).
 */
function profile(segments, startMph = 0) {
  return (t) => {
    let v0 = startMph, t0 = 0
    for (const s of segments) {
      if (t <= t0 + s.dur) return (v0 + (s.to - v0) * ((t - t0) / s.dur)) * MPH
      v0 = s.to; t0 += s.dur
    }
    return v0 * MPH
  }
}

function build(name, description, speedAt, durS, opts = {}) {
  const {
    hz = 1, seed = 7, speedNoise = 0.15, posNoise = 2.5, accuracy = 5,
    dropFrom = null, dropTo = null, nullSpeed = false, outlierEvery = 0, jitterMs = 40,
  } = opts
  const rand = rng(seed)
  const fixes = []
  const headingDeg = 60
  const h = (headingDeg * Math.PI) / 180
  const lonScale = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)
  let dist = 0
  const dt = 0.01
  let nextFix = 0
  let n = 0
  for (let t = 0; t <= durS + 1e-9; t += dt) {
    dist += speedAt(t) * dt
    if (t + 1e-9 < nextFix) continue
    nextFix += 1 / hz
    if (dropFrom != null && t >= dropFrom && t < dropTo) continue
    n++
    const tMs = Math.max(0, Math.round(t * 1000 + (rand() - 0.5) * 2 * jitterMs))
    let north = dist * Math.cos(h) + gauss(rand) * posNoise
    let east = dist * Math.sin(h) + gauss(rand) * posNoise
    let acc = accuracy * (0.8 + 0.4 * rand())
    let speed = nullSpeed ? null : Math.max(0, speedAt(t) + gauss(rand) * speedNoise)
    if (outlierEvery && n % outlierEvery === 0) {
      // A multipath outlier: position jumps ~60 m, Doppler speed spikes.
      north += 60 * (rand() > 0.5 ? 1 : -1)
      if (speed != null) speed += 12
      acc = accuracy * 1.5
    }
    fixes.push({
      t: tMs,
      lat: +(ORIGIN.lat + north / M_PER_DEG_LAT).toFixed(7),
      lon: +(ORIGIN.lon + east / lonScale).toFixed(7),
      speed: speed == null ? null : +speed.toFixed(3),
      accuracy: +acc.toFixed(1),
      heading: headingDeg,
    })
  }
  // Keep times strictly increasing after jitter.
  for (let i = 1; i < fixes.length; i++) if (fixes[i].t <= fixes[i - 1].t) fixes[i].t = fixes[i - 1].t + 1
  // Ground truth speed at each second, for tests.
  const truth = []
  for (let t = 0; t <= durS; t += 0.5) truth.push({ t: Math.round(t * 1000), speed: +speedAt(t).toFixed(3) })
  return { version: 1, name, description, synthetic: true, durationS: durS, fixes, truth }
}

const fixtures = [
  build('launch-to-60', 'Stopped 3 s, full-throttle launch to 60 mph in ~4 s, hold, ease off.',
    profile([{ dur: 3, to: 0 }, { dur: 4.2, to: 60 }, { dur: 6, to: 60 }, { dur: 8, to: 40 }]), 21),
  build('highway-merge', 'Cruise 35 mph on a ramp, hard acceleration to 70 mph, settle into highway cruise.',
    profile([{ dur: 5, to: 35 }, { dur: 8, to: 72 }, { dur: 3, to: 70 }, { dur: 10, to: 70 }], 35), 26),
  build('steady-cruise', 'Steady 45 mph cruise with small speed wander (light load).',
    (t) => (45 + 1.2 * Math.sin(t / 7)) * MPH, 40),
  build('stop-and-go', 'Traffic: crawl, stop, creep, 20 mph, stop — repeatedly.',
    profile([
      { dur: 2, to: 0 }, { dur: 4, to: 12 }, { dur: 3, to: 0 }, { dur: 3, to: 0 },
      { dur: 6, to: 22 }, { dur: 4, to: 22 }, { dur: 5, to: 0 }, { dur: 2, to: 0 },
      { dur: 3, to: 8 }, { dur: 3, to: 0 }, { dur: 3, to: 0 },
    ]), 38, { seed: 11 }),
  build('hard-braking', 'Cruise 65 mph, then threshold braking to a stop (~1 g), idle.',
    profile([{ dur: 5, to: 65 }, { dur: 3.2, to: 0 }, { dur: 5, to: 0 }], 65), 13.2, { hz: 1, seed: 3 }),
  build('gps-dropout', 'Cruise 50 mph, 12 s tunnel with no fixes, signal returns at 50 mph.',
    (t) => 50 * MPH, 30, { dropFrom: 8, dropTo: 20, seed: 5 }),
  build('noisy-fixes', 'Accelerating 20→55 mph with no Doppler speed (positions only), 12 m noise and outliers.',
    profile([{ dur: 4, to: 20 }, { dur: 10, to: 55 }, { dur: 10, to: 55 }], 20), 24,
    { nullSpeed: true, posNoise: 3, accuracy: 12, outlierEvery: 7, seed: 9 }),
]

mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true })
const index = []
for (const f of fixtures) {
  writeFileSync(new URL(`../fixtures/${f.name}.json`, import.meta.url), JSON.stringify(f, null, 1) + '\n')
  index.push({ name: f.name, description: f.description, file: `${f.name}.json`, durationS: f.durationS })
  console.log(`${f.name}: ${f.fixes.length} fixes`)
}
writeFileSync(new URL('../fixtures/index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n')
