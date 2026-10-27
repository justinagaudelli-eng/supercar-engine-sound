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
  let anchor = null      // last accepted fix
  let lastSpeed = null   // last accepted speed measurement
  let rejectStreak = 0
  const stats = { accepted: 0, rejected: 0, lastReject: null }

  function reject(reason) {
    stats.rejected++
    stats.lastReject = reason
    rejectStreak++
    return { sample: null, reason }
  }

  return {
    stats,
    reset() { anchor = null; lastSpeed = null; rejectStreak = 0 },
    /**
     * @param fix {t (ms), lat, lon, speed (m/s|null), accuracy (m)}
     * @param timestamp ms in the consumer's clock (performance.now() timebase)
     * @returns {{sample: object|null, reason?: string}}
     */
    process(fix, timestamp) {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return reject('invalid')
      const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : cfg.maxAccuracyM
      if (accuracy > cfg.maxAccuracyM) return reject('accuracy')
      if (anchor && fix.t <= anchor.t) return reject('duplicate')

      const dtMs = anchor ? fix.t - anchor.t : Infinity
      const hasDoppler = Number.isFinite(fix.speed) && fix.speed >= 0
      let speed, sigma

      if (hasDoppler) {
        speed = fix.speed
        sigma = cfg.dopplerSpeedSigma
      } else if (anchor && dtMs <= cfg.maxDerivedDtMs) {
        const dist = haversineM(anchor.lat, anchor.lon, fix.lat, fix.lon)
        const dt = dtMs / 1000
        speed = dist / dt
        const anchorAcc = Number.isFinite(anchor.accuracy) ? anchor.accuracy : accuracy
        // Position errors at both ends contribute, but GPS errors are strongly correlated
        // between consecutive fixes, so only a fraction of the naive combined error counts.
        sigma = Math.max(cfg.minDerivedSpeedSigma, cfg.derivedSigmaFactor * Math.hypot(accuracy, anchorAcc) / dt)
      } else {
        // First fix (or first after a long gap) with no Doppler speed: re-anchor only.
        anchor = { ...fix, accuracy }
        rejectStreak = 0
        return { sample: null, reason: 'anchor' }
      }

      const forceAccept = rejectStreak >= cfg.reanchorAfterRejects
      if (!forceAccept) {
        if (speed > cfg.maxSpeedMps) return reject('speed')
        if (lastSpeed != null && Number.isFinite(dtMs)) {
          const accel = Math.abs(speed - lastSpeed) / (dtMs / 1000)
          // Only judge accel between reasonably close fixes; after a gap anything goes.
          if (dtMs <= cfg.maxDerivedDtMs && accel > cfg.maxAccelMps2) return reject('jump')
        }
      } else if (speed > cfg.maxSpeedMps) {
        // Even after a reject streak, a physically impossible speed is never used.
        anchor = { ...fix, accuracy }
        rejectStreak = 0
        return { sample: null, reason: 'anchor' }
      }

      anchor = { ...fix, accuracy }
      lastSpeed = speed
      rejectStreak = 0
      stats.accepted++
      // Distance/time is the mean speed over the interval, i.e. the speed at its midpoint.
      const measuredAt = hasDoppler ? timestamp - cfg.dopplerLatencyMs : timestamp - dtMs / 2
      return {
        sample: {
          speedMps: speed,
          accelMps2: null,
          timestamp: measuredAt,
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
      if (!geo || watchId == null || typeof geo.getCurrentPosition !== 'function') return
      try {
        geo.getCurrentPosition(handlePosition, () => {}, { ...cfg.watchOptions, timeout: 3000 })
      } catch { /* ignore: the watch is still running */ }
    },
    startRecording() { recording = [] },
    /** Stop recording and return a trace object in fixture format. */
    stopRecording() {
      const fixes = recording ?? []
      recording = null
      // Re-base times so the trace starts at t = 0.
      const base = fixes.length ? fixes[0].t : 0
      return {
        version: 1,
        name: `drive-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        description: 'Recorded live GPS drive',
        recordedAt: new Date().toISOString(),
        fixes: fixes.map((f) => ({ ...f, t: f.t - base })),
      }
    },
    /** For tests / debugging: inject a position as if it came from the browser. */
    _inject: handlePosition,
  }
}
