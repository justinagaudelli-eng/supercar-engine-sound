export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
export const clamp01 = (x) => clamp(x, 0, 1)
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t) }
/** One-pole smoothing coefficient for time constant tau (s) over dt (s). */
export const onePole = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau))

/** Small deterministic PRNG (mulberry32) so tests and offline renders are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
