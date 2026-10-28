// GPS input: a pure fix processor (shared by live GPS and Replay) and the browser source.

const R_EARTH = 6371008.8

export function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Turns raw fixes {t, lat, lon, speed, accuracy} into input samples, or rejects them.
 * Pure and deterministic: replay and unit tests drive it exactly like live GPS does.
 */
export function createGpsFixProcessor(cfg) {
  let anchor = null      // last accepted fix (for duplicate / clock checks)
  let lastSpeed = null   // last accepted speed measurement
  let lastSpeedT = null  // trace time (ms) of lastSpeed
  let rejectStreak = 0
  let history = []       // recent fixes whose position changed: { t, ts, lat, lon, accuracy }
  let dopplerDisagree = 0
  let dopplerMovingT = null // last trace time coords.speed itself said we were moving
  let lastVel = null         // last fitted velocity vector {vx, vy} (m/s east, north)
  let stopped = false        // position-derived: standing still (hysteresis; unknown at start)
  const stats = { accepted: 0, rejected: 0, lastReject: null, dopplerBroken: false, lastDerived: null }

  function reject(reason) {
    stats.rejected++
    stats.lastReject = reason
    rejectStreak++
    return { sample: null, reason }
  }

  function reset() {
    anchor = null; lastSpeed = null; lastSpeedT = null; rejectStreak = 0; history = []; dopplerMovingT = null;
    stopped = false; lastVel = null
  }

  /**
   * Speed from positions: least-squares fit of east/north position vs time over the last
   * `derivedWindowMs` of fixes (plus this one). Using every fix averages out jitter, and the
   * fitted slope is the velocity at the window's centre time, unbiased under constant accel.
   * Returns { speed, sigma, ts (consumer-clock centre time), n, full } or null.
   */
  function derive(fix, accuracy, timestamp) {
    const pts = history.filter((h) => fix.t - h.t <= cfg.derivedWindowMs)
    pts.push({ t: fix.t, ts: timestamp, lat: fix.lat, lon: fix.lon, accuracy })
    if (pts.length < 2) return null
    const span = (pts.at(-1).t - pts[0].t) / 1000
    if (span <= 0) return null
    const lat0 = fix.lat * Math.PI / 180
    const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(lat0)
    let tm = 0, tsm = 0
    for (const p of pts) { tm += p.t; tsm += p.ts }
    tm /= pts.length; tsm /= pts.length
    let stt = 0, stx = 0, sty = 0, accSum = 0
    for (const p of pts) {
      const dt = (p.t - tm) / 1000
      const x = (p.lon - fix.lon) * mPerDegLon, y = (p.lat - fix.lat) * mPerDegLat
      stt += dt * dt; stx += dt * x; sty += dt * y; accSum += p.accuracy
    }
    const vx = stx / stt, vy = sty / stt
    let speed = Math.hypot(vx, vy)
    // Per-axis position noise is a fraction of the reported accuracy (errors are correlated).
    const sigmaPos = cfg.derivedSigmaFactor * accSum / pts.length
    const sigmaV = sigmaPos / Math.sqrt(stt)
    const full = span * 1000 >= cfg.minDerivedDtMs
    // Not significantly different from zero = standing still (parked jitter must not rev the
    // engine). Hysteresis: once stopped, it takes clearly more evidence to count as moving.
    const threshold = cfg.stationarySigmas * sigmaV * (stopped ? cfg.stoppedHysteresis : 1)
    if (speed < threshold) speed = 0
    if (full) stopped = speed === 0
    lastVel = speed === 0 ? { vx: 0, vy: 0 } : { vx, vy }
    return { speed, sigma: Math.max(cfg.minDerivedSpeedSigma, sigmaV), ts: tsm, n: pts.length, full }
  }

  return {
    stats,
    reset,
    /**
     * @param fix {t (ms), lat, lon, speed (m/s|null), accuracy (m)}
     * @param timestamp ms in the consumer's clock (performance.now() timebase)
     * @returns {{sample: object|null, reason?: string}}
     */
    process(fix, timestamp) {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return reject('invalid')
      const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : cfg.maxAccuracyM
      if (accuracy > cfg.maxAccuracyM) return reject('accuracy')
      if (anchor && fix.t <= anchor.t) {
        // A big backwards step is the car correcting its clock, not a duplicate: start over.
        if (fix.t < anchor.t - cfg.clockJumpMs) reset()
        else return reject('duplicate')
      }

      const prevPos = history.at(-1)
      const moved = !prevPos || prevPos.lat !== fix.lat || prevPos.lon !== fix.lon
      // Some firmware re-emits the same position at a higher rate: no new position info.
      const repeat = !moved && fix.t - prevPos.t < cfg.repeatWindowMs

      const dopplerUsable = Number.isFinite(fix.speed) && fix.speed >= 0 && !stats.dopplerBroken
      // Gross position outlier (multipath): the fix lands far from where the last fitted
      // velocity says the car should be. Keep it out of the fit window entirely.
      if (moved && prevPos && !dopplerUsable && lastVel && rejectStreak < cfg.reanchorAfterRejects) {
        const dt = (fix.t - prevPos.t) / 1000
        if (dt > 0 && dt * 1000 <= cfg.maxDerivedDtMs) {
          const mLon = 111320 * Math.cos(fix.lat * Math.PI / 180)
          const ex = (fix.lon - prevPos.lon) * mLon - lastVel.vx * dt
          const ey = (fix.lat - prevPos.lat) * 111320 - lastVel.vy * dt
          const tol = 0.5 * cfg.maxAccelMps2 * dt * dt + cfg.outlierAccuracyFactor * Math.hypot(accuracy, prevPos.accuracy)
          if (Math.hypot(ex, ey) > tol) return reject('outlier')
        }
      }
      const derived = repeat ? null : derive(fix, accuracy, timestamp)
      if (derived) stats.lastDerived = derived.speed

      let hasDoppler = dopplerUsable
      if (hasDoppler && fix.speed > 1.5) dopplerMovingT = fix.t
      // Older (Intel) cars report speed 0 while moving. If positions keep clearly disagreeing
      // (and Doppler hasn't itself just reported motion, i.e. this isn't a real stop), stop
      // trusting Doppler for the rest of the session.
      const recentlyMoving = dopplerMovingT != null && fix.t - dopplerMovingT < cfg.derivedWindowMs + 2000
      if (hasDoppler && !recentlyMoving && derived?.full && derived.speed > cfg.dopplerZeroCheckMps && fix.speed < 0.5) {
        // A single disagreement may be parked jitter: only switch over once it persists.
        if (++dopplerDisagree >= cfg.dopplerBrokenAfter) { stats.dopplerBroken = true; hasDoppler = false }
      } else if (hasDoppler) {
        dopplerDisagree = 0 // needs consecutive disagreements
      }

      if (moved) {
        history.push({ t: fix.t, ts: timestamp, lat: fix.lat, lon: fix.lon, accuracy })
        while (history.length && history[0].t < fix.t - cfg.derivedWindowMs) history.shift()
      }

      let speed, sigma, measuredAt
      if (hasDoppler) {
        speed = fix.speed
        sigma = cfg.dopplerSpeedSigma
        measuredAt = timestamp - cfg.dopplerLatencyMs
      } else if (derived && (derived.full || lastSpeed == null)) {
        speed = derived.speed
        sigma = derived.sigma
        measuredAt = derived.ts // the fitted slope is the velocity at the window's centre
      } else {
        // First fix, a repeat, or first after a long gap, with no usable Doppler: anchor only.
        anchor = { ...fix, accuracy }
        rejectStreak = 0
        return { sample: null, reason: repeat ? 'repeat' : 'anchor' }
      }

      const dtMs = lastSpeedT == null ? Infinity : fix.t - lastSpeedT
      const forceAccept = rejectStreak >= cfg.reanchorAfterRejects
      if (!forceAccept) {
        if (speed > cfg.maxSpeedMps) return reject('speed')
        if (lastSpeed != null && dtMs <= cfg.maxDerivedDtMs) {
          const accel = Math.abs(speed - lastSpeed) / Math.max(0.2, dtMs / 1000)
          if (accel > cfg.maxAccelMps2) {
            // A position outlier must not poison the window either.
            if (moved && !hasDoppler) history.pop()
            return reject('jump')
          }
        }
      } else if (speed > cfg.maxSpeedMps) {
        reset()
        anchor = { ...fix, accuracy }
        return { sample: null, reason: 'anchor' }
      }

      anchor = { ...fix, accuracy }
      lastSpeed = speed
      lastSpeedT = fix.t
      rejectStreak = 0
      stats.accepted++
      return {
        sample: {
          speedMps: speed,
          accelMps2: null,
          timestamp: Math.min(timestamp, measuredAt),
          receivedAt: timestamp,
          source: 'gps',
          accuracy,
          speedSigma: sigma,
          derived: !hasDoppler,
        },
      }
    },
  }
}

/** Convert a browser GeolocationPosition to our raw fix format. */
export function positionToFix(pos, t0) {
  const c = pos.coords
  return {
    t: Math.round(pos.timestamp - t0),
    lat: c.latitude,
    lon: c.longitude,
    speed: c.speed == null || Number.isNaN(c.speed) ? null : c.speed,
    accuracy: c.accuracy,
    heading: c.heading == null || Number.isNaN(c.heading) ? null : c.heading,
  }
}

/**
 * Live GPS via navigator.geolocation.watchPosition.
 * onSample(sample) gets processed samples; onStatus(status, detail) gets
 * 'requesting' | 'active' | 'denied' | 'unavailable' | 'unsupported' | 'error'.
 */
export function createGpsSource(cfg, { onSample, onStatus, onFix, geolocation, now } = {}) {
  const geo = geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : null)
  const clock = now ?? (() => performance.now())
  const processor = createGpsFixProcessor(cfg)
  let watchId = null
  let t0 = null
  let recording = null
  let status = 'idle'
  let pollInFlight = false
  let recordingName = null

  const setStatus = (s, detail) => { status = s; onStatus?.(s, detail) }

  function handlePosition(pos) {
    if (t0 == null) t0 = pos.timestamp
    const fix = positionToFix(pos, t0)
    if (recording) recording.push(fix)
    if (status !== 'active') setStatus('active')
    onFix?.(fix)
    const { sample } = processor.process(fix, clock())
    if (sample) onSample?.(sample)
  }

  function handleError(err) {
    if (err.code === 1) setStatus('denied', err.message)
    else if (err.code === 2) setStatus('unavailable', err.message)
    else if (err.code === 3) setStatus('timeout', err.message) // watch continues
    else setStatus('error', err.message)
  }

  return {
    processor,
    get status() { return status },
    get recording() { return recording != null },
    start() {
      if (!geo) { setStatus('unsupported'); return false }
      if (watchId != null) return true
      setStatus('requesting')
      try {
        watchId = geo.watchPosition(handlePosition, handleError, cfg.watchOptions)
      } catch (e) {
        setStatus('error', String(e))
        return false
      }
      return true
    },
    stop() {
      if (watchId != null && geo) geo.clearWatch(watchId)
      watchId = null
      processor.reset()
      t0 = null
      setStatus('idle')
    },
    /**
     * One-shot getCurrentPosition, for when watchPosition goes quiet (reported on some
     * Tesla firmware). Results go through the same handler, so duplicates are rejected.
     */
    poll() {
      if (!geo || watchId == null || pollInFlight || typeof geo.getCurrentPosition !== 'function') return
      pollInFlight = true
      const done = () => { pollInFlight = false }
      try {
        geo.getCurrentPosition((pos) => { done(); handlePosition(pos) }, done, { ...cfg.watchOptions, timeout: 3000 })
      } catch { done() }
    },
    /** Current recording so far (for crash-safe flushing), without stopping it. */
    peekRecording() {
      if (!recording) return null
      const base = recording.length ? recording[0].t : 0
      return { version: 1, name: recordingName, description: 'Recorded live GPS drive (in progress)',
        fixes: recording.map((f) => ({ ...f, t: f.t - base })) }
    },
    startRecording() {
      recording = []
      recordingName = `drive-${new Date().toISOString().replace(/[:.]/g, '-')}`
    },
    /** Stop recording and return a trace object in fixture format. */
    stopRecording() {
      const fixes = recording ?? []
      recording = null
      // Re-base times so the trace starts at t = 0.
      const base = fixes.length ? fixes[0].t : 0
      return {
        version: 1,
        name: recordingName ?? `drive-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        description: 'Recorded live GPS drive',
        recordedAt: new Date().toISOString(),
        fixes: fixes.map((f) => ({ ...f, t: f.t - base })),
      }
    },
    /** For tests / debugging: inject a position as if it came from the browser. */
    _inject: handlePosition,
  }
}
