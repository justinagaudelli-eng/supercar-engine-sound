// Canvas tachometer. The static dial (face, ticks, numbers, redline band) is cached in an
// offscreen canvas; each draw() only blits it and paints the needle, arc bar and readouts,
// and skips the frame entirely when nothing visible changed.

const SWEEP_START = Math.PI * 0.75   // 7:30 o'clock
const SWEEP = Math.PI * 1.5          // 270 degrees
const MAX_DPR = 2

const COLORS = {
  face: '#121417',
  rim: '#2a2e35',
  tick: '#c9ced6',
  tickMinor: '#5b616b',
  number: '#e8eaee',
  red: '#ff2d2d',
  redDim: 'rgba(255, 45, 45, 0.35)',
  track: '#22262c',
  bar: '#e8eaee',
  barWarm: '#ffb020',
  needle: '#ff3b1f',
  text: '#f4f5f7',
  textDim: '#8a909a',
  ledOff: '#23272d',
  ledGreen: '#2fdc6a',
  ledAmber: '#ffb020',
  ledRed: '#ff2d2d',
  ledBlue: '#3d8bff',
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export function createTach(canvas, { redlineRpm = 8500, maxRpm = 10000, units = 'mph' } = {}) {
  const ctx = canvas.getContext('2d')
  const dial = document.createElement('canvas')
  let geom = null
  let lastKey = ''
  let last = { rpm: 0, gear: null, speedMph: 0, shifting: false, limiter: false }
  let unitMode = units

  const shiftStart = redlineRpm - 1500
  const shiftFlash = redlineRpm - 100

  function angleOf(rpm) {
    const f = Math.max(0, Math.min(1, rpm / maxRpm))
    return SWEEP_START + f * SWEEP
  }

  function measure() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const cssW = Math.max(1, canvas.clientWidth || canvas.width)
    const cssH = Math.max(1, canvas.clientHeight || canvas.height)
    const w = Math.round(cssW * dpr)
    const h = Math.round(cssH * dpr)
    if (geom && geom.w === w && geom.h === h) return false
    canvas.width = w
    canvas.height = h
    const size = Math.min(w, h)
    geom = { w, h, dpr, cx: w / 2, cy: h / 2 + size * 0.03, r: size * 0.47, size }
    buildDial()
    return true
  }

  function buildDial() {
    const { w, h, cx, cy, r, size } = geom
    dial.width = w
    dial.height = h
    const d = dial.getContext('2d')
    d.clearRect(0, 0, w, h)

    d.fillStyle = COLORS.face
    d.beginPath(); d.arc(cx, cy, r, 0, Math.PI * 2); d.fill()
    d.strokeStyle = COLORS.rim
    d.lineWidth = Math.max(2, size * 0.008)
    d.stroke()

    // Redline band on the outer edge.
    d.strokeStyle = COLORS.red
    d.lineWidth = r * 0.07
    d.beginPath()
    d.arc(cx, cy, r * 0.93, angleOf(redlineRpm), angleOf(maxRpm))
    d.stroke()

    // Arc-bar track.
    d.strokeStyle = COLORS.track
    d.lineWidth = r * 0.09
    d.beginPath()
    d.arc(cx, cy, r * 0.74, angleOf(0), angleOf(maxRpm))
    d.stroke()

    // Ticks: majors every 1000, minors every 250.
    for (let rpm = 0; rpm <= maxRpm; rpm += 250) {
      const major = rpm % 1000 === 0
      const half = rpm % 500 === 0
      const a = angleOf(rpm)
      const r0 = r * (major ? 0.80 : half ? 0.835 : 0.85)
      const r1 = r * 0.885
      d.strokeStyle = rpm >= redlineRpm ? COLORS.red : major ? COLORS.tick : COLORS.tickMinor
      d.lineWidth = major ? size * 0.009 : size * 0.004
      d.beginPath()
      d.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
      d.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      d.stroke()
    }

    d.fillStyle = COLORS.number
    d.textAlign = 'center'
    d.textBaseline = 'middle'
    d.font = `600 ${Math.round(size * 0.062)}px ${FONT}`
    for (let rpm = 0; rpm <= maxRpm; rpm += 1000) {
      const a = angleOf(rpm)
      d.fillStyle = rpm >= redlineRpm ? COLORS.red : COLORS.number
      d.fillText(String(rpm / 1000), cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62)
    }

    d.fillStyle = COLORS.textDim
    d.font = `500 ${Math.round(size * 0.032)}px ${FONT}`
    d.fillText('x1000 rpm', cx, cy + r * 0.80)
  }

  function ledColors(rpm, limiter, blink) {
    const n = 5
    const palette = [COLORS.ledGreen, COLORS.ledGreen, COLORS.ledAmber, COLORS.ledAmber, COLORS.ledRed]
    if (limiter || rpm >= shiftFlash) {
      return new Array(n).fill(blink ? COLORS.ledBlue : COLORS.ledRed)
    }
    const out = []
    for (let i = 0; i < n; i++) {
      const on = rpm >= shiftStart + (i * (shiftFlash - shiftStart)) / n
      out.push(on ? palette[i] : COLORS.ledOff)
    }
    return out
  }

  function render(state, blink) {
    const { w, h, cx, cy, r, size } = geom
    const { rpm, gear, speedMph, limiter, shifting } = state
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(dial, 0, 0)

    // Arc bar.
    if (rpm > 20) {
      ctx.strokeStyle = rpm >= redlineRpm ? COLORS.red : rpm >= shiftStart ? COLORS.barWarm : COLORS.bar
      ctx.lineWidth = r * 0.09
      ctx.beginPath()
      ctx.arc(cx, cy, r * 0.74, angleOf(0), angleOf(rpm))
      ctx.stroke()
    }

    // Shift lights.
    const leds = ledColors(rpm, limiter, blink)
    const ledR = size * 0.022
    const gap = ledR * 2.9
    for (let i = 0; i < leds.length; i++) {
      ctx.fillStyle = leds[i]
      ctx.beginPath()
      ctx.arc(cx + (i - 2) * gap, cy - r * 0.42, ledR, 0, Math.PI * 2)
      ctx.fill()
    }

    // Gear.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = shifting ? COLORS.barWarm : COLORS.text
    ctx.font = `800 ${Math.round(size * 0.24)}px ${FONT}`
    ctx.fillText(gearLabel(gear), cx, cy - r * 0.07)

    // Speed.
    const kmh = unitMode === 'kmh'
    const shown = Math.round((speedMph || 0) * (kmh ? 1.609344 : 1))
    ctx.font = `700 ${Math.round(size * 0.1)}px ${FONT}`
    ctx.fillStyle = COLORS.text
    ctx.fillText(String(shown), cx, cy + r * 0.3)
    ctx.font = `500 ${Math.round(size * 0.04)}px ${FONT}`
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(kmh ? 'km/h' : 'mph', cx, cy + r * 0.44)

    // Needle.
    const a = angleOf(rpm)
    ctx.strokeStyle = COLORS.needle
    ctx.lineCap = 'round'
    ctx.lineWidth = size * 0.012
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66)
    ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9)
    ctx.stroke()
    ctx.lineCap = 'butt'
  }

  function draw(state = {}) {
    const s = {
      rpm: Number.isFinite(state.rpm) ? Math.max(0, state.rpm) : last.rpm,
      gear: state.gear !== undefined ? state.gear : last.gear,
      speedMph: Number.isFinite(state.speedMph) ? state.speedMph : last.speedMph,
      shifting: state.shifting !== undefined ? !!state.shifting : last.shifting,
      limiter: state.limiter !== undefined ? !!state.limiter : last.limiter,
    }
    if (state.units) unitMode = state.units
    last = s
    const resized = measure()
    const flashing = s.limiter || s.rpm >= shiftFlash
    const blink = flashing && Math.floor(performance.now() / 70) % 2 === 0
    // Quantize to what is visible so tiny jitter doesn't cost a repaint.
    const key = [
      Math.round(s.rpm / 5), gearLabel(s.gear), Math.round(s.speedMph * 10), s.shifting,
      flashing, blink, unitMode,
    ].join('|')
    if (!resized && key === lastKey) return false
    lastKey = key
    render(s, blink)
    return true
  }

  function invalidate() { lastKey = ''; draw() }

  let observer = null
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => invalidate())
    observer.observe(canvas)
  }

  return {
    draw,
    setUnits(u) { if (u === 'mph' || u === 'kmh') { unitMode = u; invalidate() } },
    resize: invalidate,
    destroy() { observer?.disconnect() },
  }
}

function gearLabel(gear) {
  if (gear === 0) return 'N'
  if (gear == null || gear === '') return '–'
  return String(gear)
}
