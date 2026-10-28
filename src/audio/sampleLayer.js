// Optional sample layer: rpm-tagged loops from /samples/manifest.json.
//
// Every loop plays continuously as a looping AudioBufferSourceNode with its own gain; only
// the two loops nearest the current rpm (per layer) have non-zero gain (equal-power
// crossfade), playbackRate = rpm / loop.rpm, and the on/off layers are blended equal-power
// by load. All changes go through setTargetAtTime. Native nodes only → negligible CPU.

import { parseManifest } from './manifest.js'

/**
 * Equal-power crossfade weights between the two loops nearest `rpm`.
 * @param {number} rpm
 * @param {Array<{rpm:number}|number>} loops sorted ascending by rpm
 * @returns {number[]} one weight per loop; at most two are non-zero and w1² + w2² = 1.
 * Below the first / above the last loop the end loop gets weight 1 (clamped).
 */
export function crossfadeWeights(rpm, loops) {
  const n = loops.length
  const w = new Array(n).fill(0)
  if (n === 0) return w
  const r = (i) => (typeof loops[i] === 'number' ? loops[i] : loops[i].rpm)
  if (n === 1 || !(rpm > r(0))) { w[0] = 1; return w }
  if (rpm >= r(n - 1)) { w[n - 1] = 1; return w }
  let i = 0
  while (i < n - 2 && rpm >= r(i + 1)) i++
  const t = (rpm - r(i)) / (r(i + 1) - r(i))
  w[i] = Math.cos(t * Math.PI / 2)
  w[i + 1] = Math.sin(t * Math.PI / 2)
  return w
}

/** Equal-power on/off layer weights from load (0 = off/overrun, 1 = on). */
export function loadWeights(load) {
  const l = Math.max(0, Math.min(1, Number.isFinite(load) ? load : 0))
  return { on: Math.sin(l * Math.PI / 2), off: Math.cos(l * Math.PI / 2) }
}

/**
 * Load and start the sample layer. Resolves to null (silently) if the manifest is missing.
 * Throws on an invalid manifest or undecodable audio.
 */
export async function createSampleLayer(ctx, manifestUrl, config, destination) {
  const S = config.samples
  let res
  try {
    res = await fetch(manifestUrl, { cache: 'no-cache' })
  } catch {
    return null
  }
  if (!res.ok) return null
  const text = await res.text()
  // Dev servers / SPA hosts may answer a missing file with index.html (HTTP 200): treat as missing.
  if (/^\s*</.test(text)) return null
  const manifest = parseManifest(text, res.url || new URL(manifestUrl, globalThis.location?.href).href)

  // Decode each distinct file once.
  const files = [...new Set(manifest.loops.map((l) => l.url))]
  const decoded = new Map()
  await Promise.all(files.map(async (url) => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`sample layer: cannot fetch ${url} (HTTP ${r.status})`)
    const buf = await r.arrayBuffer()
    decoded.set(url, await ctx.decodeAudioData(buf))
  }))

  const out = ctx.createGain()
  out.connect(destination)
  const startAt = ctx.currentTime
  const voices = manifest.loops.map((loop) => {
    const buffer = decoded.get(loop.url)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const loopEnd = loop.loopEnd === null ? buffer.duration : Math.min(loop.loopEnd, buffer.duration)
    src.loopStart = Math.min(loop.loopStart, loopEnd)
    src.loopEnd = loopEnd
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(g).connect(out)
    src.start(startAt, src.loopStart)
    return { loop, src, gain: g }
  })
  const byLayer = {
    on: manifest.layers.on.map((l) => voices.find((v) => v.loop === l)),
    off: manifest.layers.off.map((l) => voices.find((v) => v.loop === l)),
  }
  const single = !manifest.hasOn || !manifest.hasOff
  const target = new Map(voices.map((v) => [v, 0]))
  // Last values actually scheduled per voice. Only voices that are audible (target > 0) or
  // that were audible last frame (fading out) get automation; dormant voices are left alone.
  const sentGain = new Map(voices.map((v) => [v, 0]))
  const sentRate = new Map(voices.map((v) => [v, NaN]))
  const zeroAt = new Map(voices.map((v) => [v, -Infinity]))   // when the fade to 0 was scheduled
  const SETTLED = 5 * S.tauS                                    // after this a faded voice is silent
  const EPS_GAIN = 1e-4, EPS_RATE = 1e-4

  return {
    manifest,
    count: voices.length,
    /** p = { rpm, load, combustion } (from events.frameToParams). force: re-send everything. */
    update(p, when, force = false) {
      for (const v of voices) target.set(v, 0)
      const lw = single ? { on: 1, off: 0 } : loadWeights(p.load)
      for (const layer of single ? ['on'] : ['on', 'off']) {
        const list = byLayer[layer]
        const w = crossfadeWeights(p.rpm, list.map((v) => v.loop))
        for (let i = 0; i < list.length; i++) {
          if (w[i] > 0) target.set(list[i], target.get(list[i]) + w[i] * lw[layer])
        }
      }
      const life = Math.max(0, Math.min(1, p.combustion))
      for (const v of voices) {
        const g = target.get(v) * v.loop.gain * life
        const was = sentGain.get(v)
        const silent = was === 0 && when - zeroAt.get(v) >= SETTLED
        if (!force && g === 0 && silent) continue               // dormant: nothing to do
        const rate = Math.max(S.minRate, Math.min(S.maxRate, p.rpm / v.loop.rpm))
        if (silent && g > 0) {
          // waking up from silence: snap the rate (inaudible) so it doesn't glide from a stale value
          v.src.playbackRate.cancelScheduledValues(when)
          v.src.playbackRate.setValueAtTime(rate, when)
          sentRate.set(v, rate)
        } else if (force || !(Math.abs(rate - sentRate.get(v)) < EPS_RATE)) {
          v.src.playbackRate.setTargetAtTime(rate, when, S.tauS)
          sentRate.set(v, rate)
        }
        if (force || Math.abs(g - was) >= EPS_GAIN || (g === 0 && was !== 0)) {
          v.gain.gain.setTargetAtTime(g, when, S.tauS)
          if (g === 0 && was !== 0) zeroAt.set(v, when)
          sentGain.set(v, g)
        }
      }
    },
    dispose() {
      for (const v of voices) { try { v.src.stop() } catch { /* not started */ } v.src.disconnect(); v.gain.disconnect() }
      out.disconnect()
    },
  }
}
