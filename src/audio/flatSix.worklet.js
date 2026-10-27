// Flat-six engine synthesizer (AudioWorkletProcessor). SELF-CONTAINED: no imports.
//
// Model (RESEARCH.md §2): a crank-angle phase accumulator integrates the per-sample-smoothed
// rpm. Six cylinders fire every 120° (order 1-6-2-4-3-5); each firing launches a combustion
// pulse into its bank. Bank pulse trains → header combs → collector/main pipe comb → muffler
// combs (flap) → tailpipe comb → rpm/load lowpass = EXHAUST. Slower induction pulses ×
// (tone + noise) → plenum/runner band-passes = INTAKE. Higher orders, valve ticks and the
// starter motor = MECH. Output: 1 output with 3 channels [exhaust, intake, mech].
//
// AudioParams (k-rate; smoothed per sample here): rpm, load, cut, combustion, starter.
// All tunables arrive via processorOptions.config (src/audio/config.js → worklet block).
// No allocation inside process().

const TWO_PI = Math.PI * 2
const DEG = Math.PI / 180

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
const smoothstep = (x, lo, hi) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
const lerp = (a, b, t) => a + (b - a) * t
const onePoleCoef = (tauS, sr) => (tauS <= 0 ? 1 : 1 - Math.exp(-1 / (tauS * sr)))
const decayCoef = (tauS, sr) => Math.exp(-1 / (tauS * sr))

// Feedback comb with a one-pole lowpass in the loop: y[n] = x[n] + g·LP(y[n−L]).
class Comb {
  constructor(delayS, feedback, lpHz, sr) {
    this.len = Math.max(1, Math.round(delayS * sr))
    this.buf = new Float32Array(this.len)
    this.idx = 0
    this.g = feedback
    this.c = 1 - Math.exp(-TWO_PI * lpHz / sr)
    this.lp = 0
  }
  tick(x) {
    const d = this.buf[this.idx]
    this.lp += this.c * (d - this.lp)
    const y = x + this.g * this.lp
    this.buf[this.idx] = y
    if (++this.idx >= this.len) this.idx = 0
    return y
  }
}

// Topology-preserving-transform state-variable filter (stable under coefficient changes).
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.band = 0; this.low = 0 }
  set(hz, q, sr) {
    const g = Math.tan(Math.PI * clamp(hz, 10, sr * 0.45) / sr)
    this.k = 1 / q
    this.a1 = 1 / (1 + g * (g + this.k))
    this.a2 = g * this.a1
    this.a3 = g * this.a2
  }
  tick(x) {
    const v3 = x - this.ic2
    const v1 = this.a1 * this.ic1 + this.a2 * v3
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    this.band = v1
    this.low = v2
    return v2
  }
  // Constant-peak-gain band-pass (unity at the centre frequency).
  bp(x) { this.tick(x); return this.k * this.band }
}

class DcBlock {
  constructor(r) { this.r = r; this.x1 = 0; this.y1 = 0 }
  tick(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y }
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
  decay() { this.s0 *= this.k0; this.s1 *= this.k1; this.s2 *= this.k2 }
  value() { return this.s0 - 2 * this.s1 + this.s2 }
}

// Block-rate controls are ramped linearly across each block (no zipper steps).
const R_RASP = 0, R_FLAP = 1, R_HOLLOW = 2, R_INTAKE = 3, R_TURB = 4, R_SUP3 = 5, R_SUP6 = 6,
  R_SUP15 = 7, R_PH3 = 8, R_PH6 = 9, R_PH15 = 10, R_WHINE = 11, R_WOBBLE = 12, R_MECH0 = 13

class FlatSixProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'combustion', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'starter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
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

    // Firing order → cylinder per 120° slot, bank per cylinder, fixed imbalance per cylinder.
    this.cylOfSlot = new Int32Array(6)
    this.bankOfCyl = new Int32Array(7)
    this.imbDeg = new Float64Array(7)
    this.imbGain = new Float64Array(7)
    for (let s = 0; s < 6; s++) this.cylOfSlot[s] = C.firingOrder[s]
    for (let c = 1; c <= 6; c++) {
      this.bankOfCyl[c] = c >= C.bankBFirstCylinder ? 1 : 0
      const bankB = this.bankOfCyl[c] === 1
      this.imbDeg[c] = (this.rand() * 2 - 1) * C.imbalance.timingDeg + (bankB ? C.bankB.timingDeg : 0)
      this.imbGain[c] = (1 + (this.rand() * 2 - 1) * C.imbalance.gain) * (bankB ? C.bankB.gain : 1)
    }
    this.slotIdx = 0
    this.slotBase = 0               // nominal angle of the next slot
    this.nextFire = this.imbDeg[this.cylOfSlot[0]]
    // crank angle in degrees, 0..720 (one 4-stroke cycle); start just before the first firing
    this.theta = Math.min(0, this.nextFire) - 1
    this.tickAngle = 1e9            // pending second valve tick (crank angle)

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

    // Exhaust pipes.
    const X = C.exhaust
    this.hdrA = new Comb(X.headerA.delayS, X.headerA.feedback, X.headerA.lpHz, sr)
    this.hdrB = new Comb(X.headerB.delayS, X.headerB.feedback, X.headerB.lpHz, sr)
    this.main = new Comb(X.main.delayS, X.main.feedback, X.main.lpHz, sr)
    this.muf1 = new Comb(X.muffler1.delayS, X.muffler1.feedback, X.muffler1.lpHz, sr)
    this.muf2 = new Comb(X.muffler2.delayS, X.muffler2.feedback, X.muffler2.lpHz, sr)
    this.tail = new Comb(X.tail.delayS, X.tail.feedback, X.tail.lpHz, sr)
    this.exLp = new Svf()
    this.dcPulseA = new DcBlock(C.pulseDcR)
    this.dcPulseB = new DcBlock(C.pulseDcR)
    this.dcEx = new DcBlock(C.dcR)
    this.dcIn = new DcBlock(C.dcR)
    this.dcMe = new DcBlock(C.dcR)
    this.turbLp = 0
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
    this.inDirect = 0
    this.inDirectC = 1 - Math.exp(-TWO_PI * C.intake.directLpHz / sr)

    // Mech.
    // two cascaded band-passes: steep skirts so a tick is a 'tik', not a full-band click
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

  // Per-block control computations (cheap enough at 375 Hz, keeps the sample loop lean).
  updateBlock() {
    const C = this.C, P = C.pulse, sr = this.sr
    const rpm = this.rpmS, load = this.loadS, red = C.redlineRpm
    const rpmN = clamp(rpm / red, 0, 1.2)
    const fFire = rpm / 20
    const T = fFire > 1 ? 1 / fFire : 1

    const td = clamp(lerp(P.decayFracLo, P.decayFracHi, clamp(rpmN, 0, 1)) * T, P.decayMinS, P.decayMaxS)
    const ta = P.attackS
    const tu = td * P.rarefactionTauMul
    const kA = this.kA
    this.envD[0].set(decayCoef(td, sr), kA); this.envD[1].set(decayCoef(td, sr), kA)
    this.envU[0].set(decayCoef(tu, sr), kA); this.envU[1].set(decayCoef(tu, sr), kA)
    this.envIntake.set(decayCoef(td * C.intake.decayMul, sr), this.kIA)

    // Pulse amplitude: throttle gain with an idle floor (no fuel cut near idle).
    const idleFloor = P.idleLoad * (1 - smoothstep(rpm, P.idleLoadFadeRpm[0], P.idleLoadFadeRpm[1]))
    const effLoad = Math.max(load, idleFloor, P.minLoad)
    const rpmGain = lerp(P.rpmGainLo, P.rpmGainHi, clamp(rpmN, 0, 1))
    this.pulseAmp = Math.pow(effLoad, P.loadExponent) * rpmGain
    this.fullAmp = rpmGain

    this.jitDeg = lerp(C.jitter.timingDegLo, C.jitter.timingDegHi, clamp(rpmN, 0, 1))
    this.jitGain = lerp(C.jitter.gainLo, C.jitter.gainHi, clamp(rpmN, 0, 1))
    this.setRamp(R_TURB, P.turbulence + P.turbulenceOffLoad * (1 - load))

    // Support sines: amplitude = ratio × (pulse train harmonic for a unit-amplitude pulse).
    const w3 = TWO_PI * fFire
    this.pulseSpectrum(w3, td, ta, tu, this.u)
    const m3 = 2 * Math.hypot(this.pRe, this.pIm) / T
    this.setRamp(R_PH3, Math.atan2(this.pIm, this.pRe))
    this.pulseSpectrum(2 * w3, td, ta, tu, this.u)
    const m6 = 2 * Math.hypot(this.pRe, this.pIm) / T
    this.setRamp(R_PH6, Math.atan2(this.pIm, this.pRe))
    this.pulseSpectrum(0.5 * w3, td, ta, tu, this.u)
    this.setRamp(R_PH15, Math.atan2(this.pIm, this.pRe))
    const Su = C.support
    const s3 = lerp(Su.order3Lo, Su.order3Hi, clamp(rpmN, 0, 1))
    this.setRamp(R_SUP3, s3 * m3)
    this.setRamp(R_SUP6, Su.order6 * m6)
    this.setRamp(R_SUP15, Su.order1_5 * m3 * (1 + s3))
    this.aEnergy = onePoleCoef(Math.max(Su.followerPeriods * T, Su.followerMinS), sr)

    // Exhaust tone.
    const X = C.exhaust
    const flapOpen = load * smoothstep(rpm, X.flapOpenRpm[0], X.flapOpenRpm[1])
    this.setRamp(R_FLAP, lerp(X.flapMixClosed, X.flapMixOpen, flapOpen))
    const L = X.lowpass
    const fc = Math.min(L.maxHz, L.baseHz + L.perRpmHz * rpm * (L.loadMin + (1 - L.loadMin) * load))
    this.exLp.set(fc, L.q, sr)
    this.setRamp(R_HOLLOW, X.hollow * (1 - load) * smoothstep(rpm, X.hollowRpm[0], X.hollowRpm[1]))

    const R = C.rasp
    this.setRamp(R_RASP, R.level * smoothstep(rpm, R.startRpm, R.fullRpm) *
      (R.loadMin + (1 - R.loadMin) * load) * (1 + R.cutGain * this.cutS))

    // Intake.
    const I = C.intake
    let lvl = I.levelBase + I.levelRange * load * Math.pow(clamp(rpmN, 0, 1), I.levelExp)
    let bump = 1
    for (let i = 0; i < I.flapBumps.length; i++) {
      const b = I.flapBumps[i]
      bump += b.gain * smoothstep(rpm, b.rpm - b.width, b.rpm + b.width)
    }
    this.setRamp(R_INTAKE, lvl * bump * I.gain * smoothstep(rpm, I.presenceRpm[0], I.presenceRpm[1]))
    this.runner.set(lerp(I.runner.hzLo, I.runner.hzHi, clamp(rpmN, 0, 1)), I.runner.q, sr)
    this.howl.set(lerp(I.howl.hzLo, I.howl.hzHi, clamp(rpmN, 0, 1)), I.howl.q, sr)

    // Mech.
    const M = C.mech
    const presence = smoothstep(rpm, 0, M.presenceRpm)
    const mr = Math.pow(clamp(rpmN, 0, 1), M.ampRpmExp)
    for (let i = 0; i < this.nOrders; i++) this.setRamp(R_MECH0 + i, lerp(M.ampLo[i], M.ampHi[i], mr) * presence * M.gain)
    this.tickAmp = lerp(M.tick.levelLo, M.tick.levelHi, clamp(rpmN, 0, 1)) * presence

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
      let d = this.rampTgt[i] - this.rampCur[i]
      if (i === R_PH3 || i === R_PH6 || i === R_PH15) {
        // shortest way round for phase offsets
        while (d > Math.PI) d -= TWO_PI
        while (d < -Math.PI) d += TWO_PI
      }
      this.rampInc[i] = d / 128
    }
    this.firstBlock = false
  }

  // A firing slot was crossed `frac` samples ago (0..1).
  fire(frac) {
    const C = this.C
    const slot = this.slotIdx
    const cyl = this.cylOfSlot[slot]
    const bank = this.bankOfCyl[cyl]
    const cg = this.imbGain[cyl] * (1 + this.jitGain * this.gauss())

    // Combustion pulse, unless the ignition is cut.
    let amp = this.pulseAmp * this.combS * cg
    if (this.cutS > 0.001 && this.rand() < this.cutS) {
      // Skipped firing. Under load it may be a retarded-spark blat instead of silence.
      if (this.loadS > 0.3 && this.rand() < C.cut.blatProb) {
        this.envBlat.add(this.fullAmp * C.cut.blatGain * this.loadS * this.combS * cg, frac)
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
    this.slotIdx = (slot + 1) % 6
    this.slotBase += 120
    this.nextFire = this.slotBase + this.imbDeg[this.cylOfSlot[this.slotIdx]] + this.gauss() * this.jitDeg
  }

  schedulePop(delayS) {  // the pop fires after delayS (countdown in samples)
    const O = this.C.overrun
    this.popCountdown = Math.round(delayS * this.sr)
    this.popPendingAmp = this.fullAmp * lerp(O.gainMin, O.gainMax, this.rand())
    this.popPendingDecay = decayCoef(lerp(O.decayMinS, O.decayMaxS, this.rand()), this.sr)
  }

  process(inputs, outputs, params) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const chE = out[0], chI = out[1], chM = out[2]
    const N = chE.length
    const C = this.C, sr = this.sr

    const rpmT = params.rpm[0], loadT = params.load[0], cutT = params.cut[0]
    const combT = params.combustion[0], startT = params.starter[0]
    if (!this.initialized) {
      this.rpmS = rpmT; this.loadS = loadT; this.cutS = cutT; this.combS = combT; this.startS = startT
      this.initialized = true
    }
    this.updateBlock()

    const u = this.u
    const X = C.exhaust, I = C.intake, O = C.overrun, St = C.starter
    const hdrWet = X.headerWet, mainWet = X.mainWet, popNoise = O.noiseMix, blatNoise = C.cut.blatNoise
    const nOrders = this.nOrders, orders = C.mech.orders
    const rc = this.rampCur, ri = this.rampInc
    const nR = this.nRamps
    const eDA = this.envD[0], eDB = this.envD[1], eUA = this.envU[0], eUB = this.envU[1]

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
      const rpmEff = this.rpmS * (1 + wobble * Math.sin(3 * this.theta * DEG))
      const dTh = rpmEff * 6 / sr          // degrees per sample
      this.theta += dTh

      // 2) decay all envelope states
      eDA.decay(); eDB.decay(); eUA.decay(); eUB.decay()
      this.envIntake.decay(); this.envThump.decay(); this.envPop.decay(); this.envBlat.decay()
      this.envTick.decay()

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

      // 4) synthesis
      const white = this.noise()
      this.turbLp += this.turbC * (white - this.turbLp)
      const nT = this.turbLp * this.turbNorm
      const th = this.theta * DEG
      const tm = 1 + rc[R_TURB] * nT
      let pA = ((1 + u) * eDA.value() - u * eUA.value()) * tm
      let pB = ((1 + u) * eDB.value() - u * eUB.value()) * tm
      // support sines (phase-locked to the crank and to the pulse train's own harmonics)
      const E = this.energy
      const sup = E * (rc[R_SUP3] * Math.cos(3 * th + rc[R_PH3]) + rc[R_SUP6] * Math.cos(6 * th + rc[R_PH6]) +
        rc[R_SUP15] * Math.cos(1.5 * th + rc[R_PH15]))
      const thump = this.envThump.value()
      const pump = rc[R_HOLLOW] * nT * (0.5 + 0.5 * Math.cos(3 * th))
      pA = this.dcPulseA.tick(pA + 0.5 * (sup + thump) + pump)
      pB = this.dcPulseB.tick(pB + 0.5 * (sup + thump) + pump)

      // exhaust pipes
      const hA = this.hdrA.tick(pA), hB = this.hdrB.tick(pB)
      let x = (pA + pB) * (1 - hdrWet) + (hA + hB) * hdrWet
      // afterfire pops / cut blats enter downstream of the headers
      x += this.envPop.value() * (1 - popNoise + popNoise * nT)
      x += this.envBlat.value() * (1 - blatNoise + blatNoise * nT)
      const m = this.main.tick(x)
      x = x * (1 - mainWet) + m * mainWet
      const muff = 0.5 * (this.muf1.tick(x) + this.muf2.tick(x))
      const flap = rc[R_FLAP]
      x = x * (1 - flap) + muff * flap
      x = this.tail.tick(x)
      // rasp: high-passed, soft-clipped (analytic x/√(1+x²): smooth everywhere, unlike
      // x/(1+|x|) whose curvature jumps at zero), then a 4-pole lowpass
      this.raspHpLp += this.raspHpC * (x - this.raspHpLp)
      const hp = (x - this.raspHpLp) * C.rasp.drive
      const rasp = this.raspLp2.tick(this.raspLp.tick(hp / Math.sqrt(1 + hp * hp)))
      const ex = this.exLp.tick(x) + rc[R_RASP] * rasp
      chE[n] = this.dcEx.tick(ex * X.gain)

      // intake
      if (chI) {
        const src = this.envIntake.value() * (I.tonal + I.noise * white)
        this.inDirect += this.inDirectC * (src - this.inDirect)
        const y = this.plenum.bp(src) * I.plenum.gain + this.runner.bp(src) * I.runner.gain +
          this.howl.bp(src) * I.howl.gain + this.inDirect * I.direct
        chI[n] = this.dcIn.tick(y * rc[R_INTAKE])
      }

      // mechanical
      if (chM) {
        let mech = 0
        for (let k = 0; k < nOrders; k++) mech += rc[R_MECH0 + k] * Math.sin(orders[k] * th)
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
    // land exactly on the targets (no drift); phases kept wrapped
    for (let i = 0; i < nR; i++) rc[i] = this.rampTgt[i]
    return true
  }
}

registerProcessor('flat-six', FlatSixProcessor)
