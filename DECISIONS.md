# DECISIONS

Judgment calls made while building autonomously. Each: what was chosen, why, and the alternative.

## Project setup

1. **Project location: `~/Downloads/gt3rs-engine-sound/`** (next to the spec, which was in `~/Downloads`).
   Why: the spec said "this folder"; a dedicated subfolder keeps Downloads clean. Alt: build directly in Downloads.
2. **Vite 6 + Vitest 3 + Playwright (Chromium headless shell).** Matches the spec; all free. Alt: Jest — Vitest shares Vite's ESM handling, so no config split.
3. **`base: './'` in Vite.** Why: the build then works at `https://<user>.github.io/gt3rs-engine-sound/`, at any other path, and from `vite preview`. Alt: hard-coding `/gt3rs-engine-sound/` breaks local preview.

## Input

4. **Kalman filter on [speed, accel] (constant-acceleration model)** rather than an alpha-beta filter. Why: it handles irregular intervals (1 Hz GPS with jitter, 50–60 Hz simulator) and a per-measurement noise level (Doppler vs position-derived speed) naturally. Alt: alpha-beta has fixed gains, which suit only one update rate.
5. **Extrapolation fades the acceleration term** (`v = v0 + a·τ·(1−e^(−dt/τ))`, τ = 1.2 s). Why: pure constant-accel extrapolation overshoots badly when a fix is late. Alt: hold speed between fixes — that gives a staircase RPM.
6. **Glide-on-correction instead of snapping.** When a fix arrives, the visible speed glides from where it was onto the new track (τ = 0.35 s), never faster than 6 m/s² (so leaving a tunnel ramps instead of jumping). Why: this removes the 1 Hz "step" with minimal added lag. Alt: low-pass the output, which adds lag all the time.
7. **Position-derived speed is timestamped at the interval midpoint**, and arrival time is tracked separately (`receivedAt`). Why: distance/time is the *average* speed over the interval; timestamping it at arrival added ~0.5 s of lag. Arrival time still drives staleness and gliding.
8. **Derived-speed noise = 0.25 × combined fix accuracy / dt** (floor 0.8 m/s). Why: GPS position errors are strongly correlated between consecutive fixes, so the naive √2·accuracy/dt is far too pessimistic and caused ~5 mph of lag on the noisy fixture. Tunable: `derivedSigmaFactor`.
9. **Outlier rejection: accuracy > 50 m, speed > 100 m/s, implied |accel| > 15 m/s².** After 3 consecutive rejects the next fix is accepted (re-anchor), so a genuine change isn't rejected forever.
10. **Dropout policy: hold for 2.5 s ("stale"), then decay toward zero with τ = 4 s from 6 s ("lost").** This follows the spec's "hold then decay to idle". Alt: hold forever — in a long tunnel the engine would drone at a stale RPM.
11. **Load is estimated from acceleration with a speed-dependent full-throttle threshold** (3.2 m/s² near standstill → 1.4 m/s² at 35 m/s), plus a cruise load that rises with v² (aero). Why: a Tesla's acceleration at full pedal falls off with speed much like a car's; without this, highway overtakes would read as part throttle.
12. **The simulator reports throttle directly** and the bus uses it as load (the GPS path estimates it). Why: desk testing should feel responsive. The simulator still goes through the same filter + RPM model.
13. **Replay feeds raw fixes through the same `GpsFixProcessor` as live GPS**, so recorded drives exercise identical code. Recordings save raw fixes (`{t, lat, lon, speed, accuracy, heading}`), not processed samples.
14. **`dopplerLatencyMs` config (default 0).** Research says Tesla fixes may lag 0.5–2 s; we can't measure that at a desk, so it's a knob to tune after the first drive.

## Vehicle

15. **Gearing from Porsche's 992 GT3 RS data sheet: 3.75/2.38/1.72/1.34/1.11/0.96/0.84, final drive 4.27.** Rolling circumference 2.238 m (2.307 m unloaded − 3 %; the 3 % is an estimate).
16. **Idle 900 rpm** — no official figure exists (ESTIMATE, research gives 850–950).
17. **Shift map:**
    - Upshift point = 3,200 → 8,850 rpm, rising with load^1.4 between loads 0.2 and 0.92.
    - Downshift point = 1,400 → 4,800 rpm, rising with load².
    - Hysteresis: a downshift must land ≥ 900 rpm below the current upshift point.
    - Minimum 0.7 s between ordinary shifts, 0.32 s under braking, 0.25 s for kickdowns.

    Why: a squared load term on downshifts stopped the 3↔2 hunting we saw at half throttle on the noisy fixture. Alt: a linear curve — that hunted.
18. **Under braking (< −1.6 m/s²) the upshift ceiling rises to 4,600 rpm and downshifts happen at 2,900 rpm.** This gives a cascade of rev-matched blips like a real PDK in Sport. Without it, downshifts were blocked by the hysteresis rule and the car coasted to a stop in 3rd.
19. **Stopped or clutch-open → silent drop to the right gear** (no blip event), like a PDK opening its clutch.
20. **Upshift = 110 ms eased rpm drop + 70 ms ignition cut when load > 0.45. Downshift = 160 ms blip with a 260 rpm overshoot.** Research gives 40–80 ms for the blat and 150–250 ms for blips.
21. **Rev limiter only engages in "rev in neutral" (simulator) or if speed implies > 9,000 rpm.** At full throttle the PDK upshifts at 8,850, as the real car does. Limiter bounce: 11 Hz, 220 rpm deep.
22. **RPM slew limit of 16,000 rpm/s outside shifts.** This is a safety net so an input glitch (e.g. a replay starting at highway speed) sweeps the revs rather than teleporting them.
23. **Clutch slip at launch:** 1st gear holds 1,250–4,800 rpm (by load) until the wheels catch up. A real PDK launch flares to ~5,000; this avoids an unrealistic bog at idle.

## Research

24. **Research findings merged into one `RESEARCH.md`** with §1–§4, keeping every source link and confidence marker.
25. **CC samples are listed, not bundled** (spec). The top pick for slicing is jerry.berumen's CC BY 4.0 911 revving clip.
