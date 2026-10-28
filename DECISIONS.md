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
7. **Position-derived speed (no Doppler) is a least-squares velocity fit over the last 4 s of fixes**, timestamped at the window's centre. Arrival time is tracked separately (`receivedAt`) and still drives staleness and gliding.
   - The first version used distance/time between two fixes. The independent review showed it hunted gears and revved the engine while parked (white jitter).
   - A median filter on top added lag and still let outliers in.
   - The fit uses every fix, so it averages jitter, and it is unbiased under constant acceleration.
   - Its own uncertainty gives a statistical "standing still" test: speed below 2σ = 0, with 1.6× hysteresis once stopped.
   - Alt: windowed two-point differences plus a median — rejected after measurement.
8. **Position noise per axis = 0.4 × reported accuracy** (speed sigma floor 0.8 m/s). Why: GPS errors are strongly correlated between nearby fixes, so treating reported accuracy as independent noise is far too pessimistic. Tunable: `derivedSigmaFactor`.
   - Cost: positions-only speed lags about 1 s more than Doppler (median error ≤ 5 mph on the hostile noisy fixture). That was accepted in exchange for a stable idle and no hunting.
9. **Outlier rejection:**
   - Reject accuracy > 50 m, speed > 100 m/s, or implied |accel| > 15 m/s².
   - Positions-only fixes also go through a *vector* gate: reject a fix that lands farther from where the last fitted velocity predicts than ½·a·dt² + accuracy. A magnitude-only check let sideways multipath jumps through.
   - After 3 consecutive rejects the next fix is accepted (re-anchor), so a genuine change isn't rejected forever.
10. **Dropout policy: hold for 2.5 s ("stale"), then decay toward zero with τ = 4 s from 6 s ("lost").** Above 15 m/s (~34 mph) the hold lasts 20 s, because at speed a dropout is almost always a tunnel. When the signal returns the catch-up glide runs at up to 12 m/s² instead of 6.
    - Why: the spec says "hold then decay to idle". The review pointed out that decaying at 70 mph and then gliding back up sounds like a phantom acceleration run.
    - Alt: hold forever — in a long tunnel the engine would drone at a stale RPM.
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

## Independent review follow-ups (see reports/SUMMARY.md §4)

26. **Doppler "0 while moving" detection.** Older Intel Teslas reportedly give `coords.speed = 0` while driving.
    - After 3 *consecutive* fixes where Doppler says 0 but the full-window position fit says > 2.5 m/s, and Doppler hasn't itself reported motion in the last ~6 s (so it isn't a real stop), Doppler is ignored for the session.
    - Alt: always prefer positions — that throws away the far better Doppler on newer cars.
27. **Anti-hunt rules:**
    - Shift decisions use a slower-smoothed load (τ 0.8 s). The upshift point uses max(fast, slow) load, so a spike can only delay an upshift; the downshift point uses the slow load, so a spike can't trigger one.
    - Reversing shift direction needs 1.6 s since the last shift, even under braking. A kickdown holds its gear for 1.5 s unless at the full-throttle shift point.
    - Cost: a hard stop within 1.6 s of an upshift delays its first downshift slightly.
28. **Load is 0 when stopped** (< 0.6 m/s and accel < 0.6 m/s²), so GPS jitter at a red light can't trigger the launch clutch-slip revs.
29. **Stop suspends the AudioContext** ~1.7 s after the shutdown sound. This releases the car's media source (your music can resume) and the CPU. Start resumes the same context and engine; it never builds a second one.
30. **Audio watchdog instead of trusting `ctx.state`.** If audio time advances less than half as fast as wall time for 2 s while the page is visible, or the media element pauses, the "Tap to resume" overlay appears. Why: the car can silence a page whose context still reports 'running'.
31. **Reload recovery.** A session marker in localStorage (10-minute window) means that after a mid-drive reload, one tap resumes straight to idle with no cranking.
    - Audio still needs that tap: browsers forbid starting audio without a gesture, so a fully automatic resume is impossible.
32. **Recordings are crash-safe.** The in-progress trace is flushed to localStorage every 10 s and recovered after a reload. The last 3 finished recordings are kept and listed under Replay, as well as downloaded.
    - Alt (from the review): QR-code export. Deferred: download plus in-car replay covers the first drives.
33. **Default audio route stays `direct`; `mediaElement` is an option.** It can't be A/B tested at a desk. The checklist (step 10) tells you to switch if background audio stops. Route changes apply on the next Start Engine.
    - Alt: default to mediaElement — riskier, because `play()` outside a fresh gesture can be rejected. It does fall back to direct with a message.
34. **Tach at DPR 1 and 30 fps.** The car's GPU/CPU is the bottleneck, and the gauge is read at arm's length.
35. **Stereo synth.** Exhaust banks are panned L/R and the intake is slightly wide. All analysis runs on the mono sum, so the mix stays mono-compatible.
36. **The audio agent's run ended early (API rate limit)** after it had implemented all eight requested audio fixes. I verified the work by re-running the full audio suite, which passed. Its last in-progress extra tests (gap/resume, mediaElement fallback) were not added; the e2e lifecycle tests cover resume.
37. **Publishing to GitHub was blocked by this session's permission policy** (creating a public repo is treated as an outward-facing action). Everything is committed locally; the README and the final message give the exact commands.
38. **Launch control (2-step), added on request.**
    - It's a tap-to-arm toggle, not a hold button, so the driver never has to touch the screen while moving. It only arms while stopped.
    - When the car moves off it becomes the launch itself: full load until the first upshift, ending early if the car isn't really accelerating. It disarms itself after 20 s armed.
    - The 2-step holds 6,000 rpm (the real 992 PDK launch holds roughly 5,000–6,500, an ESTIMATE). It bounces 480 rpm at 7.5 Hz with an 85 %-deep cut, so some cylinders still fire and crackle.
    - Sound: a new worklet param `twoStep` makes cut firings hard blats and adds exhaust bangs through the existing pop voice.
    - Strictly, a factory GT3 RS launch is a smooth hold; the aftermarket-style "2-step" crackle was what was asked for.
39. **Aggressive shift style, added on request, and the default.**
    - It holds gears longer (part-throttle upshifts from 5,200 rpm) and downshifts earlier (2,600–5,600, braking 3,900).
    - Upshifts use a 100 ms cut with a bang, applied above 20 % load. Downshift blips are bigger (650 rpm overshoot).
    - "Normal" keeps the original road map. The same anti-hunt rules apply, and tests show no hunting at seven speeds × three loads in either style.
