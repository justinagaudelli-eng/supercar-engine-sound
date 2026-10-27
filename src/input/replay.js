// Replays a recorded or synthetic GPS trace through the same fix processor as live GPS.

import { createGpsFixProcessor } from './gps.js'

export function validateTrace(trace) {
  if (!trace || !Array.isArray(trace.fixes)) throw new Error('Trace must have a "fixes" array')
  let prev = -Infinity
  for (const f of trace.fixes) {
    if (!Number.isFinite(f.t)) throw new Error('Every fix needs a numeric "t" (ms)')
    if (f.t < prev) throw new Error('Fix times must be non-decreasing')
    prev = f.t
  }
  return trace
}

export function traceDurationMs(trace) {
  const f = trace.fixes
  return f.length ? f[f.length - 1].t : 0
}

/**
 * step(nowMs) emits all fixes whose trace time has been reached.
 * onSample gets processed samples (source 'replay'); onFix gets raw fixes.
 */
export function createReplay(trace, gpsCfg, { onSample, onFix, onEnd, rate = 1, loop = false } = {}) {
  validateTrace(trace)
  const processor = createGpsFixProcessor(gpsCfg)
  let startMs = null
  let idx = 0
  let ended = false
  const duration = traceDurationMs(trace)

  function step(nowMs) {
    if (ended) return
    if (startMs == null) startMs = nowMs
    let traceT = (nowMs - startMs) * rate
    while (idx < trace.fixes.length && trace.fixes[idx].t <= traceT) {
      const fix = trace.fixes[idx++]
      if (fix.lost) continue
      onFix?.(fix)
      // Map the fix's trace time back onto the consumer's clock.
      const ts = startMs + fix.t / rate
      const { sample } = processor.process(fix, ts)
      if (sample) onSample?.({ ...sample, source: 'replay' })
    }
    if (idx >= trace.fixes.length) {
      if (loop) {
        // Restart cleanly; the processor needs a fresh anchor.
        startMs = nowMs; idx = 0; processor.reset()
      } else if (traceT >= duration) {
        ended = true
        onEnd?.()
      }
    }
  }

  return {
    step,
    get progress() { return startMs == null ? 0 : Math.min(1, idx / Math.max(1, trace.fixes.length)) },
    get ended() { return ended },
    get durationMs() { return duration / rate },
    processor,
  }
}
