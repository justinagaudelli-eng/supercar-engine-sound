# GT3 RS Engine Sound for the Tesla Browser — Full-Auto Build

You are building this project end to end, autonomously. I will not be
watching. Do not stop to ask me questions. When something is ambiguous,
pick the most reasonable option, write it down in `DECISIONS.md` (what you
chose, why, and what the alternative was), and keep going. Only stop
early if you hit something that truly cannot continue without me (for
example, a GitHub login), and in that case finish everything else first.

Spend effort freely. Use subagents for parallel work (research, audio
engine, UI, tests) and for independent review. Quality matters more than
speed or token usage.

---

## 1. What I want

A free, single-page web app that I open in my Tesla's built-in browser
(Chromium). It plays a realistic Porsche 992 GT3 RS engine sound through
the car's speakers, synced to how I'm actually driving, using the car's
GPS through the browser.

Hard rules:
- 100% free. No paid APIs, libraries, hosting, or audio.
- No copyrighted or ripped audio (no game rips, no YouTube rips). The
  engine must sound good with **zero audio files** via procedural
  synthesis. Real samples are an optional add-on layer I supply myself.
- Static site only, hosted on GitHub Pages over HTTPS.
- Works with zero interaction once started: I tap Start once while
  parked, then never need to touch it while driving.

---

## 2. Phase 0 — Research (do this first, use subagents)

Research and record findings with source links in `RESEARCH.md`:

1. **992 GT3 RS specs:** engine (4.0 L naturally aspirated flat-six),
   redline and rev limiter, idle RPM, 7-speed PDK gear ratios, final
   drive, rear tire size (to compute rolling circumference). If exact
   ratios can't be confirmed, use the closest documented values and
   flag them as estimates.
2. **Flat-six sound character:** firing order, why a flat-plane-style
   boxer six sounds smooth/howling rather than burbly, which engine
   orders dominate (3rd order = RPM/60 × 3 is the firing frequency for a
   4-stroke six), intake vs exhaust character, what changes near
   redline.
3. **Procedural engine synthesis techniques** for the Web Audio API
   (additive harmonics, pulse-train/combustion-impulse models, waveguide
   exhaust resonance, granular approaches). Pick the approach most
   likely to sound convincing and justify it.
4. **Tesla in-car browser constraints:** geolocation behavior and update
   rate, whether browser audio plays while driving, autoplay/user-gesture
   rules, whether the page reloads when minimized, screen wake behavior,
   known workarounds. Note anything uncertain so my in-car test
   checklist covers it.
5. **Free CC-licensed Porsche sounds** (e.g. Freesound) that I could
   optionally download myself: list title, author, license, link. Do
   not download or bundle them.

---

## 3. Phase 1 — Architecture

Vanilla JS (ES modules) + Vite, no frameworks needed. Suggested layout
(adjust if research suggests better):

```
src/
  input/        gps.js, simulator.js, replay.js, inputBus.js
  vehicle/      gearbox.js, rpmModel.js, config.js
  audio/        engine.js, synthFlatSix.js, sampleLayer.js,
                events.js (startup, limiter, shifts, pops), mixer.js
  ui/           tach.js, controls.js, debugPanel.js
  tools/        slicer.html + slicer.js
tests/          unit + audio analysis + end-to-end
fixtures/       synthetic GPS drive traces (JSON)
```

All inputs implement one interface (`{ speedMps, accelMps2, timestamp,
source, accuracy }`) so GPS, simulator, and replay are interchangeable.
All tunable numbers live in `vehicle/config.js` and `audio/config` —
nothing magic buried in code.

---

## 4. Phase 2 — Input

**GPS (primary):**
- `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`,
  `maximumAge: 0`.
- Use `coords.speed` when present; fall back to distance/time between
  fixes (haversine). Reject fixes with poor accuracy or impossible jumps.
- GPS updates ~1 Hz, so run a filter (e.g. a small Kalman or
  alpha-beta filter on speed + acceleration) and **extrapolate between
  fixes at audio-frame rate** so RPM moves smoothly, never in steps.
- Estimate throttle load from filtered longitudinal acceleration:
  strong positive accel = full load, steady cruise = light load,
  negative = lift-off/braking.
- Handle permission denied, GPS loss, and tunnels gracefully (hold
  then decay to idle; show status on screen).

**Simulator:** throttle and brake sliders driving a simple vehicle
physics model (mass, drag, power curve) so I can test at a desk.

**Replay:** play a recorded or synthetic GPS trace through the exact
same pipeline. Ship fixtures: launch to 60 mph, highway merge, steady
cruise, stop-and-go traffic, hard braking, GPS dropout, noisy fixes.
Also add a "Record drive" button that saves the live GPS trace as JSON
so I can replay real drives later at my desk.

---

## 5. Phase 3 — Vehicle model

- 7-speed PDK using researched ratios. RPM from speed via gear ratio,
  final drive, and tire circumference.
- Shift logic depends on load: full throttle shifts at ~8800–9000 rpm;
  light throttle shifts early (~3000–4000); downshift on deceleration
  with rev-matched blips. Add hysteresis so it never hunts between
  gears.
- Shifts take realistic time (PDK ~100 ms) with an RPM drop curve, not
  an instant jump.
- Idle ~900 rpm when stopped, with a subtle idle wobble.
- Rev limiter bounce if load stays high at redline.

---

## 6. Phase 4 — Sound engine (the most important part)

**Procedural flat-six synth (must sound great with no files):**
- Model combustion events, not just a sine. Fundamental firing
  frequency = RPM / 60 × 3. Include sub-harmonics and upper engine
  orders with level curves that change with RPM and load.
- Tiny per-cylinder timing and amplitude variation so it sounds
  mechanical, not like a synth pad.
- Separate **intake**, **engine/mechanical**, and **exhaust** voices,
  each with its own filtering; exhaust gets a resonant body (comb or
  waveguide) to imitate pipe resonance.
- Filtered noise for air/induction texture.
- Waveshaper distortion and brightness that ramp up toward redline —
  the GT3 RS gets raspier and more metallic above ~7000 rpm.
- Load-aware: on throttle = full, loud, raw; off throttle = hollow,
  quieter, overrun crackles and pops above ~5000 rpm.

**Event sounds:** startup (crank + catch + flare to ~2500 then settle
to idle), shutdown, rev limiter, upshift ignition cut, downshift blip.

**Optional sample layer:**
- `/samples/manifest.json` describes loops (file, rpm, layer on/off,
  loop points). Equal-power crossfade between the two nearest RPM
  loops, pitch-shifted to exact RPM; blend on/off layers by load.
- Synth/sample mix slider. With no samples present, it silently uses
  synth only.

**Slicer tool (`/tools/slicer.html`):** I load one rev-sweep recording,
enter its start and end RPM (or it estimates them via pitch tracking),
and it cuts RPM-tagged, zero-crossing-aligned, seamless loops and
downloads them plus a ready `manifest.json`.

**Audio quality rules:**
- Every parameter change goes through smoothing (`setTargetAtTime` or
  per-frame ramps). No clicks, zipper noise, or gaps.
- Master limiter/compressor so nothing ever clips.
- Keep CPU low; the car's computer is not a gaming PC. Prefer native
  nodes or a lightweight AudioWorklet over heavy per-sample JS on the
  main thread.

---

## 7. Phase 5 — UI

- Dark theme, landscape-first, huge touch targets, readable at a
  glance. Nothing that needs attention while driving.
- Big tachometer with redline zone, speed (mph), current gear, small
  GPS status (accuracy, update rate, source).
- Controls: Start Engine (also unlocks audio), Stop, volume, synth/sample
  mix, sound character presets (Street / Track / Cabin), input source
  selector (GPS / Simulator / Replay), Record drive, test tone.
- Request a screen wake lock where supported.
- Persist settings in localStorage, wrapped in try/catch.
- Collapsible debug panel: raw vs filtered speed, estimated load, RPM,
  gear, audio node levels, CPU estimate.

---

## 8. Phase 6 — Verification (do not skip; loop until it passes)

You can't hear, so verify with measurement:

1. **Unit tests (Vitest):** gearbox ratios and RPM math, shift logic
   and hysteresis, GPS filter behavior on noisy and dropout fixtures,
   manifest parsing, slicer loop-point math.
2. **Offline audio analysis:** render engine output with
   `OfflineAudioContext` (in headless Chromium via Playwright) for fixed
   RPMs and for each replay fixture. Run an FFT and assert:
   - Dominant firing-frequency peak within ±3% of RPM/60 × 3.
   - No clipping (peak below 0 dBFS after limiter).
   - No discontinuities (no sample-to-sample jumps above a threshold)
     across shifts, loops, and crossfades.
   - Brightness (spectral centroid) increases with RPM.
   - Level difference between on-load and off-load is audible.
   Save spectrograms as PNGs in `reports/` so I can look at them.
3. **End-to-end (Playwright):** load the built site, start the engine
   with a simulated gesture, run each replay fixture, confirm no
   console errors, UI updates, and audio context stays running.
4. **Independent review:** spawn a separate subagent that has not seen
   the code being written to review architecture, audio realism
   approach, and Tesla-browser risks. Fix what it finds.
5. Fix every failure and re-run until everything passes. Record the
   final results in `reports/SUMMARY.md`.

---

## 9. Phase 7 — Deploy

- GitHub Actions workflow that builds and deploys to GitHub Pages.
- If the `gh` CLI is authenticated, create a public repo named
  `gt3rs-engine-sound`, push, enable Pages, and confirm the live URL
  loads. If not authenticated, stop at this step only and leave exact
  copy-paste commands in the README.

---

## 10. Deliverables / definition of done

- Working site, all tests passing, spectrogram reports generated.
- `README.md`: what it is, how to open it in the Tesla, how to tune the
  sound, how to add my own samples with the slicer, how to record and
  replay drives.
- `TESLA_TEST_CHECKLIST.md`, short and ordered, for my first in-car
  test: open URL, grant location, tap Start while parked, check audio
  plays, drive slowly in a lot, check RPM follows speed, check audio
  continues while moving, check whether phone Bluetooth overrides it,
  check behavior when minimizing the browser.
- `DECISIONS.md`, `RESEARCH.md`, `reports/SUMMARY.md`.
- A final message to me: live URL (or deploy commands), what passed,
  known limitations, and the top 3 things to tune after my first drive.

Safety note for the app: in-cabin audio only, keep the volume cap
reasonable, and never require interaction while the car is moving.
