// Generates a synthetic "recorded" sample set for sample-layer tests: harmonic engine-like
// tones at fixed rpms, each WAV with a non-looping pre-roll and tail around a seamless loop
// of an integer number of firing periods. Written to tests/audio/fixtures/samples/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeWav16 } from './analysis.js'

export const FIXTURE_RPMS = [2000, 4000, 6000, 8000]
const SR = 48000

function tone(rpm, layer, n) {
  const out = new Float32Array(n)
  const bright = layer === 'on' ? 1 : 0.55
  const level = layer === 'on' ? 0.5 : 0.25
  // orders 1.5 … 15 in 1.5 steps (multiples of the half-firing frequency keep the loop exact)
  const parts = []
  for (let k = 1; k <= 10; k++) {
    const order = 1.5 * k
    const amp = (k === 2 ? 1 : k % 2 === 0 ? 0.5 : 0.18) * Math.pow(bright, k / 2) / Math.sqrt(k)
    parts.push({ f: order * rpm / 60, amp, ph: (k * 2.39996) % (2 * Math.PI) })
  }
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const p of parts) s += p.amp * Math.sin(2 * Math.PI * p.f * i / SR + p.ph)
    out[i] = s * level / 2
  }
  return out
}

export function writeSampleFixtures(dir) {
  mkdirSync(dir, { recursive: true })
  const loops = []
  for (const layer of ['on', 'off']) {
    for (const rpm of FIXTURE_RPMS) {
      // Loop length = whole number of order-1.5 periods (rpm/40 Hz) → seamless; ≈ 0.3 s.
      const period = SR * 40 / rpm             // samples (integer for these rpms)
      const periods = Math.round(0.3 * SR / period)
      const pre = 4800, loopLen = periods * period, tail = 2400
      const x = tone(rpm, layer, pre + loopLen + tail)
      const file = `${layer}_${rpm}.wav`
      writeFileSync(join(dir, file), encodeWav16(x, SR))
      loops.push({ file, rpm, layer, loopStart: pre / SR, loopEnd: (pre + loopLen) / SR, gain: 1 })
    }
  }
  const manifest = { version: 1, name: 'synthetic-test-set', loops }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
