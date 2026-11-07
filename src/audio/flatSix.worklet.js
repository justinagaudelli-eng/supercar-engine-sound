// Multi-cylinder engine synthesizer (AudioWorkletProcessor). SELF-CONTAINED: no imports.
// (File keeps its historical name; it now does 6/8/10/12 cylinders, optionally turbocharged.)
//
// Model (RESEARCH.md §2): a crank-angle phase accumulator integrates the per-sample-smoothed
// rpm. N cylinders fire every 720/N degrees (config.firingOrder, e.g. flat-six 1-6-2-4-3-5);
// each firing launches a combustion pulse into its bank. Bank pulse trains → header combs → collector/main pipe comb → muffler
// combs (flap) → twin tailpipe combs → rpm/load lowpass = EXHAUST. Slower induction pulses ×
// (tone + noise) → plenum/howl/runner band-passes = INTAKE. Higher orders, valve ticks and the
// starter motor = MECH. Optional TURBO (config.turbo): boost with spool lag, turbine whistle,
// boost whoosh and a blow-off/flutter burst on lift-off or upshift, mixed into the intake voice.
//
// Output: 1 output, 5 channels, mid/side per voice so the mono sum is exactly the mid:
//   [0] exhaust mid  [1] exhaust side  [2] intake mid  [3] intake side  [4] mech (centre)
// Exhaust side = difference of the two tailpipes + bank-A/B header difference; intake side =
// decorrelated induction air. The mixer builds L = mid + w·side, R = mid − w·side.
//
// AudioParams (k-rate; smoothed per sample here): rpm, load, cut, combustion, starter.
// All tunables arrive via processorOptions.config (src/audio/config.js → worklet block).
// No allocation inside process().

const TWO_PI = Math.PI * 2
const DEG = Math.PI / 180
const TINY = 1e-15               // flush-to-zero threshold for decaying states (denormals)
const ANTI_DENORMAL = 1e-20      // tiny DC injected into feedback loops / filters

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const smoothstep = (x, lo, hi) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
const lerp = (a, b, t) => a + (b - a) * t
const onePoleCoef = (tauS, sr) => (tauS <= 0 ? 1 : 1 - Math.exp(-1 / (tauS * sr)))
const decayCoef = (tauS, sr) => Math.exp(-1 / (tauS * sr))

// Feedback comb with a one-pole lowpass in the loop: y[n] = x[n] + g·LP(y[n−D]).
// D is fractional and may be scaled per sample (hot-gas speed of sound) — linear-interpolated
// reads, so a gliding D is a smooth Doppler-like shift, never a jump.
class Comb {
  constructor(delayS, feedback, lpHz, sr, minScale = 1) {
    this.base = Math.max(1, delayS * sr)
    this.len = Math.ceil(this.base) + 3
    this.buf = new Float32Array(this.len)
    this.w = 0
    this.g = feedback
    this.c = 1 - Math.exp(-TWO_PI * lpHz / sr)
    this.lp = 0
    this.minD = Math.max(1, this.base * minScale)
  }
  tick(x, scale = 1) {
    let d = this.base * scale
    if (d < this.minD) d = this.minD
    const di = d | 0, f = d - di
    let i0 = this.w - di
    if (i0 < 0) i0 += this.len
    let i1 = i0 - 1
    if (i1 < 0) i1 += this.len
    const v = this.buf[i0] + f * (this.buf[i1] - this.buf[i0])
    this.lp += this.c * (v - this.lp) + ANTI_DENORMAL
    const y = x + this.g * this.lp
    this.buf[this.w] = y
    if (++this.w >= this.len) this.w = 0
    return y
  }
}

// Topology-preserving-transform state-variable filter (stable under coefficient changes).
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.band = 0 }
  set(hz, q, sr) {
    const g = Math.tan(Math.PI * clamp(hz, 10, sr * 0.45) / sr)
    this.k = 1 / q
    this.a1 = 1 / (1 + g * (g + this.k))
    this.a2 = g * this.a1
    this.a3 = g * this.a2
  }
  copy(o) { this.k = o.k; this.a1 = o.a1; this.a2 = o.a2; this.a3 = o.a3 }
  tick(x) {
    const v3 = x + ANTI_DENORMAL - this.ic2
    const v1 = this.a1 * this.ic1 + this.a2 * v3
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    this.band = v1
    return v2
  }
  // Constant-peak-gain band-pass (unity at the centre frequency).
  bp(x) { this.tick(x); return this.k * this.band }
}

class DcBlock {
  constructor(r) { this.r = r; this.x1 = 0; this.y1 = 0 }
  tick(x) {
    let y = x - this.x1 + this.r * this.y1
    if (y < TINY && y > -TINY) y = 0
    this.x1 = x; this.y1 = y
    return y
  }
}

// C¹ pulse envelope: Σ A·e^(−t/τd)·(1 − e^(−t/τa))² over all triggered pulses. Zero value
// AND zero slope at each onset (a plain e^−t/τd − e^−t/τa has a slope jump that reads as a
// tiny click). Expanded into three decaying exponentials, so it is linear (overlapping pulses
// add), sub-sample accurate and allocation-free. Rates may change per block (states stay).
class Env {
  constructor() { this.s0 = 0; this.s1 = 0; this.s2 = 0; this.k0 = 0; this.k1 = 0; this.k2 = 0; this.ka = 0 }
  set(kd, ka) { this.k0 = kd; this.ka = ka; this.k1 = kd * ka; this.k2 = kd * ka * ka }
  add(amp, frac) {
    const f0 = Math.pow(this.k0, frac), fa = Math.pow(this.ka, frac)
    this.s0 += amp * f0; this.s1 += amp * f0 * fa; this.s2 += amp * f0 * fa * fa
  }
  decay() {
    this.s0 *= this.k0; this.s1 *= this.k1; this.s2 *= this.k2
    if (this.s0 < TINY && this.s0 > -TINY) { this.s0 = 0; this.s1 = 0; this.s2 = 0 }  // denormals
  }
  value() { return this.s0 - 2 * this.s1 + this.s2 }
}

// Block-rate controls are ramped linearly across each block (no zipper steps). Support sines
// are ramped as complex amplitudes (re/im) so phase offsets need no wrap handling.
const R_RASP = 0, R_FLAP = 1, R_HOLLOW = 2, R_INTAKE = 3, R_TURB = 4,
  R_S3C = 5, R_S3S = 6, R_S6C = 7, R_S6S = 8, R_S15C = 9, R_S15S = 10,
  R_WHINE = 11, R_WOBBLE = 12, R_DSCALE = 13, R_TWHINE = 14, R_TWHOOSH = 15, R_MECH0 = 16

class FlatSixProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'combustion', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'starter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'twoStep', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    const C = opts.config
    if (!C) throw new Error('flatSix worklet: processorOptions.config is required')
    this.C = C
    const sr = sampleRate
    this.sr = sr

    // Two independent xorshift32 streams: audio-rate noise, and event decisions.
    this.noiseState = ((opts.seed || 1) * 2654435761) | 0 || 1
    this.randState = ((opts.seed || 1) * 40503 + 0x5bd1e995) | 0 || 7

    // Smoothing coefficients.
    const S = C.smoothing
    this.aRpm = onePoleCoef(S.rpmTauS, sr)
    this.aLoad = onePoleCoef(S.loadTauS, sr)
    this.aCut = onePoleCoef(S.cutTauS, sr)
    this.aComb = onePoleCoef(S.combustionTauS, sr)
    this.aStart = onePoleCoef(S.starterTauS, sr)
    this.initialized = false
    this.rpmS = 0; this.loadS = 0; this.cutS = 0; this.combS = 0; this.startS = 0
    this.twoS = 0                    // launch-control 2-step amount (0..1), block rate

    // Firing order → cylinder per (720/N)° slot, bank per cylinder, fixed imbalance per
    // cylinder. Gain imbalance is stored as a unit random per cylinder and scaled by an
    // rpm-dependent spread (lumpier at idle).
    const N = C.firingOrder.length
    this.nCyl = N
    this.slotDeg = 720 / N
    // Crank phasor base order: half the firing order (1.5 for a six, 2 for a V8, 3 for a V12),
    // so the firing order is z² and the "half order" bank imbalance is z¹.
    this.bo = N / 4
    this.cylOfSlot = new Int32Array(N)
    this.bankOfCyl = new Int32Array(N + 1)
    this.imbDeg = new Float64Array(N + 1)
    this.imbUnit = new Float64Array(N + 1)
    this.bankGain = new Float64Array(N + 1)
    for (let s = 0; s < N; s++) this.cylOfSlot[s] = C.firingOrder[s]
    for (let c = 1; c <= N; c++) {
      this.bankOfCyl[c] = c >= C.bankBFirstCylinder ? 1 : 0
      const bankB = this.bankOfCyl[c] === 1
      this.imbDeg[c] = (this.rand() * 2 - 1) * C.imbalance.timingDeg + (bankB ? C.bankB.timingDeg : 0)
      this.imbUnit[c] = this.rand() * 2 - 1
      this.bankGain[c] = bankB ? C.bankB.gain : 1
    }
    this.imbSpread = C.imbalance.gainLo
    this.slotIdx = 0
    this.slotBase = 0               // nominal angle of the next slot
    this.nextFire = this.imbDeg[this.cylOfSlot[0]]
    // crank angle in degrees, 0..720 (one 4-stroke cycle); start just before the first firing
    this.theta = Math.min(0, this.nextFire) - 1
    this.tickAngle = 1e9            // pending second valve tick (crank angle)
    this.lump = 0                   // slow cycle-to-cycle amplitude wander (AR(1) per firing)
    this.lumpSigma = 0

    // Crank phasor z = e^{i·bo·θ}; engine order k = bo·m is z^m (no per-sample trig).
    this.zr = 0; this.zi = 0
    this.resyncPhasor()
    let maxM = 4
    this.mechPow = new Int32Array(C.mech.orders.length)
    this.mechTrig = false
    for (let i = 0; i < C.mech.orders.length; i++) {
      const m = C.mech.orders[i] / this.bo
      if (Math.abs(m - Math.round(m)) > 1e-9) this.mechTrig = true  // fallback: Math.sin
      this.mechPow[i] = Math.round(m)
      if (m > maxM) maxM = Math.round(m)
    }
    this.nPow = maxM + 1
    this.powR = new Float64Array(this.nPow)
    this.powI = new Float64Array(this.nPow)

    // Envelopes. Exhaust pulse per bank = (1+u)·D − u·U (U: slower rarefaction tail).
    this.envD = [new Env(), new Env()]
    this.envU = [new Env(), new Env()]
    this.envThump = new Env()        // starter compression thumps
    this.envIntake = new Env()       // induction pulses
    this.envPop = new Env()          // overrun afterfire
    this.envBlat = new Env()         // retarded-spark blat on ignition cut
    this.envTick = new Env()         // valvetrain
    this.popCountdown = -1; this.popPendingAmp = 0; this.popPendingDecay = 0.99
    this.burstLeft = 0; this.sinceBurst = 1e9
    this.energy = 0; this.energyTarget = 0
    this.armed = false; this.sinceLift = 1e9; this.wasLoaded = false
    this.nRamps = R_MECH0 + C.mech.orders.length
    this.rampCur = new Float64Array(this.nRamps)   // value at the start of the block
    this.rampInc = new Float64Array(this.nRamps)   // per-sample increment
    this.rampTgt = new Float64Array(this.nRamps)   // value at the end of the block
    this.firstBlock = true
    this.dScale = 1                 // smoothed pipe-delay scale (hot gas → faster sound)
    this.aDScale = onePoleCoef(C.exhaust.gasTemp.tauS, sr)

    // Exhaust pipes.
    const X = C.exhaust
    const minScale = 1 / (1 + X.gasTemp.amount * 1.2)
    this.hdrA = new Comb(X.headerA.delayS, X.headerA.feedback, X.headerA.lpHz, sr, minScale)
    this.hdrB = new Comb(X.headerB.delayS, X.headerB.feedback, X.headerB.lpHz, sr, minScale)
    this.main = new Comb(X.main.delayS, X.main.feedback, X.main.lpHz, sr, minScale)
    this.muf1 = new Comb(X.muffler1.delayS, X.muffler1.feedback, X.muffler1.lpHz, sr)
    this.muf2 = new Comb(X.muffler2.delayS, X.muffler2.feedback, X.muffler2.lpHz, sr)
    this.tailL = new Comb(X.tail.delayS, X.tail.feedback, X.tail.lpHz, sr)
    this.tailR = new Comb(X.tail2.delayS, X.tail2.feedback, X.tail2.lpHz, sr)
    this.exLp = new Svf()
    this.exLpSide = new Svf()
    this.dcPulseA = new DcBlock(C.pulseDcR)
    this.dcPulseB = new DcBlock(C.pulseDcR)
    this.dcEx = new DcBlock(C.dcR)
    this.dcExS = new DcBlock(C.dcR)
    this.dcIn = new DcBlock(C.dcR)
    this.dcInS = new DcBlock(C.dcR)
    this.dcMe = new DcBlock(C.dcR)
    this.turbLp = 0; this.turbLp2 = 0
    this.turbC = 1 - Math.exp(-TWO_PI * C.pulse.turbulenceLpHz / sr)
    this.turbNorm = 1 / Math.sqrt(this.turbC / (2 - this.turbC) / 3)  // → unit RMS
    this.raspHpLp = 0
    this.raspHpC = 1 - Math.exp(-TWO_PI * C.rasp.hpHz / sr)
    // 4th-order lowpass (two Butterworth sections): the shriek lives at 2–8 kHz; no fizz above
    this.raspLp = new Svf(); this.raspLp.set(C.rasp.lpHz, 0.5412, sr)
    this.raspLp2 = new Svf(); this.raspLp2.set(C.rasp.lpHz, 1.3066, sr)

    // Intake formants.
    this.plenum = new Svf(); this.plenum.set(C.intake.plenum.hz, C.intake.plenum.q, sr)
    this.runner = new Svf()
    this.howl = new Svf()
    this.inSide = new Svf(); this.inSide.set(C.intake.side.hz, C.intake.side.q, sr)
    this.inDirect = 0
    this.inDirectC = 1 - Math.exp(-TWO_PI * C.intake.directLpHz / sr)

    // Mech: two cascaded band-passes so a tick is a 'tik', not a full-band click.
    this.tickBp = new Svf(); this.tickBp.set(C.mech.tick.bpHz, C.mech.tick.q, sr)
    this.tickBp2 = new Svf(); this.tickBp2.set(C.mech.tick.bpHz, C.mech.tick.q, sr)
    this.envTick.set(decayCoef(C.mech.tick.decayS, sr), decayCoef(C.mech.tick.attackS, sr))
    this.nOrders = C.mech.orders.length
    this.starterPhase = 0

    // Per-block derived values.
    this.kA = decayCoef(C.pulse.attackS, sr); this.u = C.pulse.rarefaction
    this.kIA = decayCoef(C.intake.attackS, sr)
    this.aEnergy = 0
    this.pulseAmp = 0; this.fullAmp = 0
    this.jitDeg = 0; this.jitGain = 0; this.popProb = 0; this.tickAmp = 0
    this.thumpAmp = 0; this.whineInc = 0
    this.kPopA = decayCoef(C.overrun.attackS, sr)
    this.envThump.set(decayCoef(C.starter.thumpDecayS, sr), decayCoef(C.starter.thumpAttackS, sr))
    this.envBlat.set(decayCoef(C.cut.blatDecayS, sr), decayCoef(C.cut.blatAttackS, sr))
    this.envPop.set(0.99, this.kPopA)
    this.blockS = 128 / sr

    // Turbo (optional).
    const T = C.turbo
    this.turbo = !!T
    this.boost = 0; this.shaft = 0; this.tPhase = 0; this.tInc = 0
    this.bovArmed = false; this.sinceBov = 1e9; this.prevCut = 0
    this.flPhase = 0; this.flInc = 0
    this.envBov = new Env()
    if (T) {
      this.whooshBp = new Svf()
      this.bovBp = new Svf(); this.bovBp.set(T.bov.hzStart, T.bov.q, sr)
      this.envBov.set(decayCoef(T.bov.decayS, sr), decayCoef(T.bov.attackS, sr))
      this.bovPeak = 1e-9
    }
  }

  // xorshift32 → [0, 1)
  rand() {
    let s = this.randState
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    this.randState = s
    return (s >>> 0) / 4294967296
  }
  noise() {
    let s = this.noiseState
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    this.noiseState = s
    return (s >>> 0) / 2147483648 - 1
  }
  gauss() { return (this.rand() + this.rand() + this.rand() - 1.5) * 2 }

  // Exact phasor from the crank angle (on construction and once per cycle → no drift).
  resyncPhasor() {
    const a = this.bo * this.theta * DEG
    this.zr = Math.cos(a); this.zi = Math.sin(a)
  }

  // Fourier transform (complex) of the unit pulse shape at angular frequency w:
  //   p(t) = [(1+u)e^(−t/τd) − u·e^(−t/τu)]·(1 − e^(−t/τa))²
  // Each e^(−t/τ) term transforms to F(τ) = τ/(1 + jwτ); the squared attack expands to
  // G(τ) = F(τ) − 2F(τ ∥ τa) + F(τ ∥ τa/2), with τ ∥ τa = 1/(1/τ + 1/τa).
  // Result in this.pRe / this.pIm.
  pulseSpectrum(w, td, ta, tu, u) {
    this.pRe = 0; this.pIm = 0
    this.addG(w, td, ta, 1 + u)
    this.addG(w, tu, ta, -u)
  }
  addG(w, tau, ta, g) {
    this.addF(w, tau, g)
    this.addF(w, 1 / (1 / tau + 1 / ta), -2 * g)
    this.addF(w, 1 / (1 / tau + 2 / ta), g)
  }
  addF(w, tau, g) {
    const d = 1 + w * w * tau * tau
    this.pRe += g * tau / d
    this.pIm -= g * w * tau * tau / d
  }

  setRamp(i, v) { this.rampTgt[i] = v }
  // complex support amplitude a·e^{iφ} with φ = arg(pRe + i·pIm)
  setRampPhasor(iRe, a) {
    const m = Math.hypot(this.pRe, this.pIm) || 1
    this.rampTgt[iRe] = a * this.pRe / m
    this.rampTgt[iRe + 1] = a * this.pIm / m
  }

  // Per-block control computations (cheap enough at 375 Hz, keeps the sample loop lean).
  updateBlock() {
    const C = this.C, P = C.pulse, sr = this.sr
    const rpm = this.rpmS, load = this.loadS, red = C.redlineRpm
    const rpmN = clamp(rpm / red, 0, 1.2)
    const rpmN1 = clamp(rpmN, 0, 1)
    const fFire = rpm * this.nCyl / 120
    const T = fFire > 1 ? 1 / fFire : 1

    const td = clamp(lerp(P.decayFracLo, P.decayFracHi, rpmN1) * T, P.decayMinS, P.decayMaxS)
    const ta = P.attackS
    const tu = td * P.rarefactionTauMul
    const kA = this.kA
    this.envD[0].set(decayCoef(td, sr), kA); this.envD[1].set(decayCoef(td, sr), kA)
    this.envU[0].set(decayCoef(tu, sr), kA); this.envU[1].set(decayCoef(tu, sr), kA)
    this.envIntake.set(decayCoef(td * C.intake.decayMul, sr), this.kIA)

    // Turbo state first: boost (with lag) scales the combustion strength.
    if (this.turbo) this.updateTurbo(rpm, load, rpmN1)

    // Pulse amplitude: throttle gain with an idle floor (no fuel cut near idle).
    const idleFloor = P.idleLoad * (1 - smoothstep(rpm, P.idleLoadFadeRpm[0], P.idleLoadFadeRpm[1]))
    const tl = this.turbo ? C.turbo.torqueLag : 0
    const effLoad = Math.max(load * (1 - tl + tl * this.boost), idleFloor, P.minLoad)
    const rpmGain = lerp(P.rpmGainLo, P.rpmGainHi, rpmN1)
    this.pulseAmp = Math.pow(effLoad, P.loadExponent) * rpmGain
    this.fullAmp = rpmGain

    this.jitDeg = lerp(C.jitter.timingDegLo, C.jitter.timingDegHi, rpmN1)
    this.jitGain = lerp(C.jitter.gainLo, C.jitter.gainHi, rpmN1)
    this.imbSpread = lerp(C.imbalance.gainLo, C.imbalance.gainHi, rpmN1)
    this.lumpSigma = lerp(C.lump.sigmaLo, C.lump.sigmaHi, smoothstep(rpm, C.lump.fadeRpm[0], C.lump.fadeRpm[1]))
    this.setRamp(R_TURB, P.turbulence + P.turbulenceOffLoad * (1 - load))

    // Support sines: amplitude = ratio × (pulse train harmonic for a unit-amplitude pulse),
    // phase = the pulse train's own harmonic phase (they reinforce, never cancel).
    const w3 = TWO_PI * fFire
    const Su = C.support
    const s3 = lerp(Su.order3Lo, Su.order3Hi, rpmN1)
    this.pulseSpectrum(w3, td, ta, tu, this.u)
    const m3 = 2 * Math.hypot(this.pRe, this.pIm) / T
    this.setRampPhasor(R_S3C, s3 * m3)
    this.pulseSpectrum(2 * w3, td, ta, tu, this.u)
    const m6 = 2 * Math.hypot(this.pRe, this.pIm) / T
    this.setRampPhasor(R_S6C, Su.order6 * m6)
    this.pulseSpectrum(0.5 * w3, td, ta, tu, this.u)
    this.setRampPhasor(R_S15C, Su.order1_5 * m3 * (1 + s3))
    this.aEnergy = onePoleCoef(Math.max(Su.followerPeriods * T, Su.followerMinS), sr)

    // Exhaust tone.
    const X = C.exhaust
    const flapOpen = load * smoothstep(rpm, X.flapOpenRpm[0], X.flapOpenRpm[1])
    this.setRamp(R_FLAP, lerp(X.flapMixClosed, X.flapMixOpen, flapOpen))
    const L = X.lowpass
    const fc = Math.min(L.maxHz, L.baseHz + L.perRpmHz * rpm * (L.loadMin + (1 - L.loadMin) * load))
    this.exLp.set(fc, L.q, sr)
    this.exLpSide.copy(this.exLp)
    this.setRamp(R_HOLLOW, X.hollow * (1 - load) * smoothstep(rpm, X.hollowRpm[0], X.hollowRpm[1]))
    // Hot gas = faster sound = shorter pipes: delays ×1/(1 + k·load·rpmN), smoothed (seconds).
    this.setRamp(R_DSCALE, 1 / (1 + X.gasTemp.amount * load * rpmN))

    const R = C.rasp
    this.setRamp(R_RASP, R.level * smoothstep(rpm, R.startRpm, R.fullRpm) *
      (R.loadMin + (1 - R.loadMin) * load) * (1 + R.cutGain * this.cutS))

    // Intake.
    const I = C.intake
    let lvl = I.levelBase + I.levelRange * load * Math.pow(rpmN1, I.levelExp)
    let bump = 1
    for (let i = 0; i < I.flapBumps.length; i++) {
      const b = I.flapBumps[i]
      bump += b.gain * smoothstep(rpm, b.rpm - b.width, b.rpm + b.width)
    }
    this.setRamp(R_INTAKE, lvl * bump * I.gain * smoothstep(rpm, I.presenceRpm[0], I.presenceRpm[1]))
    this.runner.set(lerp(I.runner.hzLo, I.runner.hzHi, rpmN1), I.runner.q, sr)
    this.howl.set(lerp(I.howl.hzLo, I.howl.hzHi, rpmN1), I.howl.q, sr)

    // Mech.
    const M = C.mech
    const presence = smoothstep(rpm, 0, M.presenceRpm)
    const mr = Math.pow(rpmN1, M.ampRpmExp)
    for (let i = 0; i < this.nOrders; i++) this.setRamp(R_MECH0 + i, lerp(M.ampLo[i], M.ampHi[i], mr) * presence * M.gain)
    this.tickAmp = lerp(M.tick.levelLo, M.tick.levelHi, rpmN1) * presence

    // Overrun pop arming: lift-off after real load.
    const O = C.overrun
    if (load > O.armLoad) { this.wasLoaded = true; this.armed = false }
    else if (this.wasLoaded && load < O.liftLoad) { this.wasLoaded = false; this.armed = true; this.sinceLift = 0 }
    if (this.armed) {
      this.sinceLift += this.blockS
      const fade = Math.max(0, 1 - this.sinceLift / O.windowS)
      if (fade <= 0) this.armed = false
      this.popProb = (O.probBase + O.probPerRpm * rpmN) * fade * smoothstep(rpm, O.minRpm, O.fullRpm) *
        this.combS * (load < O.liftLoad ? 1 : 0)
    } else this.popProb = 0
    this.sinceBurst += this.blockS

    // Starter.
    const St = C.starter
    this.thumpAmp = St.thumpGain * this.startS * (1 - this.combS)
    this.whineInc = rpm * St.whineOrder / 60 / sr
    this.setRamp(R_WHINE, St.whineLevel * this.startS)
    this.setRamp(R_WOBBLE, St.wobble * this.startS * (1 - this.combS))

    // Ramps: from the current values to the new targets over this block.
    for (let i = 0; i < this.nRamps; i++) {
      if (this.firstBlock) this.rampCur[i] = this.rampTgt[i]
      this.rampInc[i] = (this.rampTgt[i] - this.rampCur[i]) / 128
    }
    if (this.firstBlock) this.dScale = this.rampTgt[R_DSCALE]
    this.firstBlock = false
  }

  // Turbo, block rate. boost: 0..1 manifold pressure (lags the throttle), shaft: 0..1 turbine
  // speed (spins down slower than boost dumps). A lift-off from real boost, or a loaded upshift
  // cut, fires the blow-off burst; its flutter (compressor surge) slows as it fades.
  updateTurbo(rpm, load, rpmN1) {
    const T = this.C.turbo, B = T.bov, dt = this.blockS
    const avail = smoothstep(rpm, T.spoolRpm[0], T.spoolRpm[1])
    const target = load * avail * this.combS * (1 - T.cutDump * this.cutS)
    const tauB = target > this.boost ? T.spoolTauS : T.dumpTauS
    this.boost += (target - this.boost) * (1 - Math.exp(-dt / tauB))
    const sTarget = Math.max(this.boost, T.shaftIdle * rpmN1 * this.combS)
    const tauS = sTarget > this.shaft ? T.shaftUpTauS : T.shaftDownTauS
    this.shaft += (sTarget - this.shaft) * (1 - Math.exp(-dt / tauS))

    // blow-off trigger
    this.sinceBov += dt
    if (load > B.armLoad && this.boost > B.armBoost) this.bovArmed = true
    let g = 0
    if (this.bovArmed && load < B.liftLoad) { g = 1; this.bovArmed = false }
    else if (this.prevCut < 0.5 && this.cutS >= 0.5 && this.boost > B.armBoost * 0.6) g = B.shiftGain
    this.prevCut = this.cutS
    if (g > 0 && this.sinceBov > B.minIntervalS) {
      const amp = B.level * g * clamp(this.boost / Math.max(B.armBoost, 1e-3), 0, 1.6)
      this.envBov.add(amp, 0)
      this.bovPeak = Math.max(amp, 1e-9)
      this.boost *= 1 - B.dump
      this.sinceBov = 0
    }
    const bovNorm = clamp(this.envBov.s0 / this.bovPeak, 0, 1)
    this.bovBp.set(lerp(B.hzEnd, B.hzStart, bovNorm), B.q, this.sr)
    this.flInc = TWO_PI * B.flutterHz * (0.45 + 0.55 * bovNorm) / this.sr

    // whistle + whoosh levels
    const W = T.whine, H = T.whoosh
    this.tInc = TWO_PI * lerp(W.hzLo, W.hzHi, this.shaft) / this.sr
    this.setRamp(R_TWHINE, W.level * Math.pow(this.shaft, 1.5) * (W.loadMin + (1 - W.loadMin) * load))
    this.whooshBp.set(lerp(H.hzLo, H.hzHi, this.shaft), H.q, this.sr)
    this.setRamp(R_TWHOOSH, H.level * this.boost)
  }

  // A firing slot was crossed `frac` samples ago (0..1).
  fire(frac) {
    const C = this.C
    const slot = this.slotIdx
    const cyl = this.cylOfSlot[slot]
    const bank = this.bankOfCyl[cyl]
    // slow cycle-to-cycle wander (AR(1) at firing rate): lumpy idle, smooth at speed
    this.lump = C.lump.rho * this.lump + Math.sqrt(1 - C.lump.rho * C.lump.rho) * this.lumpSigma * this.gauss()
    const cg = (1 + this.imbUnit[cyl] * this.imbSpread) * this.bankGain[cyl] *
      (1 + this.jitGain * this.gauss()) * Math.max(0, 1 + this.lump)

    // Combustion pulse, unless the ignition is cut.
    let amp = this.pulseAmp * this.combS * cg
    if (this.cutS > 0.001 && this.rand() < this.cutS) {
      // Skipped firing. Under load it may be a retarded-spark blat instead of silence.
      // On the 2-step, blats are more frequent and much harder, and unburnt fuel goes bang
      // in the exhaust.
      const T = C.twoStep, two = this.twoS
      if (this.loadS > 0.3 && this.rand() < lerp(C.cut.blatProb, T.blatProb, two)) {
        this.envBlat.add(this.fullAmp * lerp(C.cut.blatGain, T.blatGain, two) * this.loadS * this.combS * cg, frac)
      }
      if (two > 0.01 && this.popCountdown < 0 && this.sinceBurst > T.minBangSpacingS &&
          this.rand() < T.bangProb * two) {
        this.schedulePop(lerp(T.delayMinS, T.delayMaxS, this.rand()), T.bangGain * two)
        this.burstLeft = this.rand() < T.burstProb ? 1 + Math.floor(this.rand() * 2) : 0
        this.sinceBurst = 0
      }
      amp = 0
    }
    if (amp > 0) {
      this.envD[bank].add(amp, frac)
      this.envU[bank].add(amp, frac)
    }
    this.energyTarget = this.pulseAmp * this.combS * (this.cutS > 0.5 ? 0 : 1)

    // Starter compression thump (cylinder compressing, no combustion yet).
    if (this.thumpAmp > 1e-5) this.envThump.add(this.thumpAmp * cg, frac)

    // Induction pulse: air is pumped whether or not fuel burns; strength follows throttle.
    this.envIntake.add(cg, frac)

    // Valvetrain ticks: one now, one secondTickDeg later.
    if (this.tickAmp > 0) this.envTick.add(this.tickAmp * cg, frac)
    this.tickAngle = this.theta + C.mech.tick.secondTickDeg

    // Overrun afterfire pops (scheduled a few ms after the slot, downstream of the headers).
    if (this.popProb > 0 && this.popCountdown < 0 && this.sinceBurst > C.overrun.minBurstSpacingS &&
        this.rand() < this.popProb) {
      const O = C.overrun
      this.burstLeft = this.rand() < O.burstProb ? 1 + Math.floor(this.rand() * 2) : 0
      this.schedulePop(lerp(O.delayMinS, O.delayMaxS, this.rand()))
      this.sinceBurst = 0
    }

    // Advance to the next slot with fixed imbalance + per-cycle jitter.
    this.slotIdx = (slot + 1) % this.nCyl
    this.slotBase += this.slotDeg
    this.nextFire = this.slotBase + this.imbDeg[this.cylOfSlot[this.slotIdx]] + this.gauss() * this.jitDeg
  }

  schedulePop(delayS, gainMul = 1) {  // the pop fires after delayS (countdown in samples)
    const O = this.C.overrun
    this.popCountdown = Math.round(delayS * this.sr)
    this.popPendingAmp = this.fullAmp * lerp(O.gainMin, O.gainMax, this.rand()) * gainMul
    this.popPendingDecay = decayCoef(lerp(O.decayMinS, O.decayMaxS, this.rand()), this.sr)
  }

  process(inputs, outputs, params) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const chE = out[0], chES = out[1], chI = out[2], chIS = out[3], chM = out[4]
    const N = chE.length
    const C = this.C, sr = this.sr

    const rpmT = params.rpm[0], loadT = params.load[0], cutT = params.cut[0]
    const combT = params.combustion[0], startT = params.starter[0]
    this.twoS = params.twoStep ? params.twoStep[0] : 0
    if (!this.initialized) {
      this.rpmS = rpmT; this.loadS = loadT; this.cutS = cutT; this.combS = combT; this.startS = startT
      this.initialized = true
    }
    this.updateBlock()

    const u = this.u
    const X = C.exhaust, I = C.intake, O = C.overrun, St = C.starter
    const hdrWet = X.headerWet, mainWet = X.mainWet, popNoise = O.noiseMix, blatNoise = C.cut.blatNoise
    const sideTail = X.stereo.tailSide, sideBank = X.stereo.bankSide, inSideLvl = I.side.level
    const nOrders = this.nOrders, orders = C.mech.orders, mechPow = this.mechPow, mechTrig = this.mechTrig
    const rc = this.rampCur, ri = this.rampInc
    const nR = this.nRamps, nPow = this.nPow, powR = this.powR, powI = this.powI
    const eDA = this.envD[0], eDB = this.envD[1], eUA = this.envU[0], eUB = this.envU[1]
    const aDS = this.aDScale

    for (let n = 0; n < N; n++) {
      // 0) advance ramps (block-rate controls → per-sample)
      for (let i = 0; i < nR; i++) rc[i] += ri[i]

      // 1) smoothing + crank angle integration (phase is always continuous)
      this.rpmS += this.aRpm * (rpmT - this.rpmS)
      this.loadS += this.aLoad * (loadT - this.loadS)
      this.cutS += this.aCut * (cutT - this.cutS)
      this.combS += this.aComb * (combT - this.combS)
      this.startS += this.aStart * (startT - this.startS)
      const wobble = rc[R_WOBBLE]
      // sin(firing order·θ) = Im(z²) — from the phasor, no trig
      const rpmEff = wobble > 1e-9
        ? this.rpmS * (1 + wobble * 2 * this.zr * this.zi) : this.rpmS
      const dTh = rpmEff * 6 / sr          // degrees per sample
      this.theta += dTh
      // rotate the phasor by bo·dθ (4th-order Taylor; |a| ≤ 0.07 rad → error < 1e-10/step)
      const a = this.bo * dTh * DEG, a2 = a * a
      const ca = 1 - a2 * 0.5 + a2 * a2 / 24, sa = a * (1 - a2 / 6)
      const zr = this.zr * ca - this.zi * sa
      this.zi = this.zr * sa + this.zi * ca
      this.zr = zr

      // 2) decay all envelope states
      eDA.decay(); eDB.decay(); eUA.decay(); eUB.decay()
      this.envIntake.decay(); this.envThump.decay(); this.envPop.decay(); this.envBlat.decay()
      this.envTick.decay()
      if (this.turbo) this.envBov.decay()

      // 3) events at crank-angle crossings
      if (dTh > 0) {
        if (this.theta >= this.nextFire) this.fire((this.theta - this.nextFire) / dTh)
        if (this.theta >= this.tickAngle) {
          if (this.tickAmp > 0) this.envTick.add(this.tickAmp, (this.theta - this.tickAngle) / dTh)
          this.tickAngle = 1e9
        }
      }
      if (this.theta >= 720) {
        this.theta -= 720; this.nextFire -= 720; this.slotBase -= 720
        if (this.tickAngle < 1e8) this.tickAngle -= 720
        this.resyncPhasor()
      }
      if (this.popCountdown >= 0 && this.popCountdown-- === 0) {
        this.envPop.set(this.popPendingDecay, this.kPopA)
        this.envPop.add(this.popPendingAmp, 0)
        if (this.burstLeft > 0) {
          this.burstLeft--
          this.schedulePop(lerp(O.burstGapMinS, O.burstGapMaxS, this.rand()))
        }
      }
      this.energy += this.aEnergy * (this.energyTarget - this.energy)
      this.dScale += aDS * (rc[R_DSCALE] - this.dScale)

      // engine-order powers z^m: order 1.5·m → (powR, powI) = (cos, sin)(1.5·m·θ)
      powR[0] = 1; powI[0] = 0
      for (let m = 1; m < nPow; m++) {
        powR[m] = powR[m - 1] * this.zr - powI[m - 1] * this.zi
        powI[m] = powR[m - 1] * this.zi + powI[m - 1] * this.zr
      }

      // 4) synthesis
      const white = this.noise(), white2 = this.noise()
      this.turbLp += this.turbC * (white - this.turbLp)
      this.turbLp2 += this.turbC * (white2 - this.turbLp2)
      const nT = this.turbLp * this.turbNorm
      const nT2 = this.turbLp2 * this.turbNorm
      const tm = 1 + rc[R_TURB] * nT
      let pA = ((1 + u) * eDA.value() - u * eUA.value()) * tm
      let pB = ((1 + u) * eDB.value() - u * eUB.value()) * tm
      // support sines: Re(A·z^m) with A the ramped complex amplitude
      const E = this.energy
      const sup = E * (powR[2] * rc[R_S3C] - powI[2] * rc[R_S3S] + powR[4] * rc[R_S6C] -
        powI[4] * rc[R_S6S] + powR[1] * rc[R_S15C] - powI[1] * rc[R_S15S])
      const thump = this.envThump.value()
      const hollow = rc[R_HOLLOW]
      const pump = hollow > 1e-9 ? hollow * nT * (0.5 + 0.5 * powR[2]) : 0
      pA = this.dcPulseA.tick(pA + 0.5 * (sup + thump) + pump)
      pB = this.dcPulseB.tick(pB + 0.5 * (sup + thump) + pump)

      // exhaust pipes (header/main delays shortened by hot gas)
      const ds = this.dScale
      const hA = this.hdrA.tick(pA, ds), hB = this.hdrB.tick(pB, ds)
      let x = (pA + pB) * (1 - hdrWet) + (hA + hB) * hdrWet
      // afterfire pops / cut blats enter downstream of the headers
      x += this.envPop.value() * (1 - popNoise + popNoise * nT)
      x += this.envBlat.value() * (1 - blatNoise + blatNoise * nT)
      const m = this.main.tick(x, ds)
      x = x * (1 - mainWet) + m * mainWet
      const muff = 0.5 * (this.muf1.tick(x) + this.muf2.tick(x))
      const flap = rc[R_FLAP]
      x = x * (1 - flap) + muff * flap
      // twin tailpipes: mid = their mean, side = half their difference (+ bank difference)
      const tL = this.tailL.tick(x), tR = this.tailR.tick(x)
      const mid = 0.5 * (tL + tR)
      const side = sideTail * 0.5 * (tL - tR) + sideBank * (hA - hB)
      // rasp: high-passed, soft-clipped (analytic x/√(1+x²): smooth everywhere, unlike
      // x/(1+|x|) whose curvature jumps at zero), then a 4-pole lowpass. Centre only.
      this.raspHpLp += this.raspHpC * (mid - this.raspHpLp)
      const hp = (mid - this.raspHpLp) * C.rasp.drive
      const rasp = this.raspLp2.tick(this.raspLp.tick(hp / Math.sqrt(1 + hp * hp)))
      const ex = this.exLp.tick(mid) + rc[R_RASP] * rasp
      chE[n] = this.dcEx.tick(ex * X.gain)
      if (chES) chES[n] = this.dcExS.tick(this.exLpSide.tick(side) * X.gain)

      // intake: tone + low-passed (not raw white) noise through the formants
      const lvlI = rc[R_INTAKE]
      if (chI) {
        const env = this.envIntake.value()
        const src = env * (I.tonal + I.noise * nT2)
        this.inDirect += this.inDirectC * (src - this.inDirect)
        const y = this.plenum.bp(src) * I.plenum.gain + this.runner.bp(src) * I.runner.gain +
          this.howl.bp(src) * I.howl.gain + this.inDirect * I.direct
        let tb = 0, tbS = 0
        if (this.turbo) {
          // turbine whistle (pure-ish tone + 2nd harmonic), boost whoosh, blow-off with flutter
          this.tPhase += this.tInc
          if (this.tPhase > TWO_PI) this.tPhase -= TWO_PI
          const tw = rc[R_TWHINE]
          if (tw > 1e-7) tb += tw * (Math.sin(this.tPhase) + this.C.turbo.whine.h2 * Math.sin(2 * this.tPhase))
          const wh = rc[R_TWHOOSH]
          if (wh > 1e-7) tb += wh * this.whooshBp.bp(white2)
          const eb = this.envBov.value()
          if (eb > 1e-6 || eb < -1e-6) {
            this.flPhase += this.flInc
            if (this.flPhase > TWO_PI) this.flPhase -= TWO_PI
            const fd = this.C.turbo.bov.flutter, c = 0.5 + 0.5 * Math.cos(this.flPhase)
            const b = eb * (1 - fd + fd * c * c) * this.bovBp.bp(white)
            tb += b; tbS = 0.35 * b
          }
        }
        chI[n] = this.dcIn.tick(y * lvlI + tb)
        // side: decorrelated induction air (independent noise stream) — cancels in mono
        if (chIS) chIS[n] = this.dcInS.tick(this.inSide.bp(env * nT) * inSideLvl * lvlI + tbS)
      }

      // mechanical (centre)
      if (chM) {
        let mech = 0
        if (mechTrig) {
          const th = this.theta * DEG
          for (let k = 0; k < nOrders; k++) mech += rc[R_MECH0 + k] * Math.sin(orders[k] * th)
        } else {
          for (let k = 0; k < nOrders; k++) mech += rc[R_MECH0 + k] * powI[mechPow[k]]
        }
        mech += this.tickBp2.bp(this.tickBp.bp(this.envTick.value() * white))
        const whine = rc[R_WHINE]
        if (whine > 1e-6) {
          this.starterPhase += this.whineInc * (rpmEff / Math.max(this.rpmS, 1))
          if (this.starterPhase >= 1) this.starterPhase -= 1
          const sp = this.starterPhase * TWO_PI
          mech += whine * (Math.sin(sp) + St.whineHarmonic2 * Math.sin(2 * sp) + St.whineNoise * white * 10)
        }
        chM[n] = this.dcMe.tick(mech)
      }
    }
    // land exactly on the targets (no drift)
    for (let i = 0; i < nR; i++) rc[i] = this.rampTgt[i]
    return true
  }
}

registerProcessor('flat-six', FlatSixProcessor)
