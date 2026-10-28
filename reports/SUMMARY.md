# Verification summary

Final run: 2026-10-27, macOS / Node 26 / headless Chromium (Playwright 1.64).
**All tests pass: 127 unit + 29 Playwright (audio analysis + end-to-end) = 156.**
The Playwright suite was run three times in a row with no flakes.

Re-run: `npm test && npm run build && npx playwright test`.

| Suite | Tests | Result |
|---|---|---|
| Unit (Vitest) `tests/unit` | 127 | ✅ all pass |
| Offline audio, engine (`tests/audio/engine.spec.js`) | 12 | ✅ all pass |
| Offline audio, every replay fixture through the real pipeline (`tests/audio/replay-fixtures.spec.js`) | 7 | ✅ all pass |
| End-to-end on the production build (`tests/e2e/app.spec.js`) | 10 | ✅ all pass |

## 1. Unit tests (127)

- **Gearbox:** researched ratios and final drive; speed at 9,000 rpm per gear matches RESEARCH.md; speed↔rpm round trip.
- **Shift logic:**
  - Full throttle shifts at 8,600–9,050 rpm; light throttle at 2,900–4,100.
  - Upshifts last about 110 ms with a smooth drop and an ignition cut.
  - Braking gives rev-matched blip downshifts down to 1st.
  - No hunting at seven steady speeds × three loads.
  - Kickdown, limiter bounce, launch clutch slip, idle wobble, startup flare to ~2,500 and shutdown all behave as specified.
- **GPS filter:**
  - Kalman convergence; Doppler preferred; positions-only least-squares speed.
  - Outlier, jump, duplicate and accuracy rejection.
  - Hold → decay → recover through a dropout, holding up to 20 s at speed (tunnels).
  - No visible steps between 1 Hz fixes.
- **Tesla GPS quirks (from the independent review):**
  - `coords.speed` stuck at 0 while moving: switches to position-derived speed.
  - A real stop still reads 0.
  - A backwards clock jump re-anchors.
  - Re-emitted identical positions are ignored.
  - Parked position jitter (±1.5 / ±3 / ±6 m) causes no shifts and no revving. ±6 m white jitter is held under 2,500 rpm; smaller jitter keeps idle under 1,200 rpm.
- **Every fixture through replay → filter → rpm model,** both with Doppler and positions-only: rpm stays between idle and the limiter, no steps outside shifts, no gear hunting, and rpm agrees with speed × gear.
- **Launch control (2-step):**
  - Holds 5,520–6,000 rpm in 1st with the cut at the configured duty and full load.
  - Cancelling while stopped returns to idle.
  - Driving off launches at full load until the first upshift, with no drop to idle.
  - Ignored while moving.
- **Aggressive shift style:** no hunting at seven speeds × three loads; part-throttle upshifts more than 1,000 rpm later than Normal; upshift cut with bang; bigger blips; still brakes down to 1st.
- **Other:** manifest parsing, equal-power crossfade weights, slicer loop-point math, pitch tracking (< 3 % rpm error), WAV/ZIP encoding, settings with broken storage.

## 2. Offline audio analysis

Rendered with `OfflineAudioContext` at 48 kHz through the full graph: worklet, mixer, saturation, compressor and limiter, at **maximum volume**. Analysis uses the stereo mix's mono sum, which also checks mono compatibility. Definitions are in `reports/audio-metrics.json`.

**Firing frequency (rpm/60 × 3), full load:**

| rpm | expected Hz | measured Hz | error | strongest tonal line | spectral centroid | peak |
|---|---|---|---|---|---|---|
| 900 | 45 | 44.98 | −0.05 % | order 3 | 789 Hz | −3.5 dBFS |
| 2000 | 100 | 100.02 | +0.02 % | order 3 | 1,283 Hz | −3.6 dBFS |
| 3500 | 175 | 175.01 | +0.01 % | order 3 | 1,753 Hz | −4.1 dBFS |
| 5000 | 250 | 249.98 | −0.01 % | order 3 | 2,196 Hz | −4.7 dBFS |
| 7000 | 350 | 349.99 | −0.00 % | order 3 | 2,759 Hz | −4.8 dBFS |
| 8500 | 425 | 425.02 | +0.00 % | order 3 | 3,396 Hz | −4.9 dBFS |

- **Firing peak within ±3 %:** ✅ worst error 0.05 %, at full and light load.
- **No clipping:** ✅ every render peaks between −3.5 and −5.4 dBFS (the ceiling is −1 dBFS).
- **Brightness rises with rpm:** ✅ centroid 789 → 3,396 Hz at full load and 1,056 → 3,146 Hz at light load, both monotonic.
- **On-load vs off-load level is audible:** ✅ full vs off is 13.3–14.3 dB from 2,000 rpm up (7.6 dB at idle); full vs light is 6.0–8.4 dB.
- **No discontinuities:** ✅ zero clicks in the rpm sweep, upshifts, downshift blips, limiter, overrun pops, start/stop, launch control (2-step plus launch) and aggressive shifts (rendered from the real vehicle model), and sample-layer loop points and crossfades.
- **2-step bangs:** 10 detected bangs over 1.9 s on the 2-step, vs 5 on the plain 9,000 rpm limiter; peak −3.2 dBFS.
  - The detector flags spikes above 16 kHz that exceed 9× the local level.
  - Its sensitivity is proven on every render by injecting synthetic steps; it catches steps of −24 to −36 dBFS in the as-heard render.
  - Every scenario is also rendered "linear" (noise off, nonlinear stages neutral). That render has zero clicks, and the detector catches steps as small as −60 dBFS in it.
- **Rpm sweep tracking:** 97.7 % of frames have the firing line within ±3 %. The misses are mid-glide frames, worst 3.5 %.
- **Presets at 6,000 rpm** (spectral centroid): Cabin 1,112 Hz < Street 2,445 Hz < Track 2,895 Hz.
- **Sample layer:** synthetic test loops load; 3,000 rpm plays at 150.02 Hz; no clicks at loop points or crossfades; a missing manifest stays silent.
- **CPU:** the full graph renders 10 s in 0.22 s, about 2.2 % of one core on the test Mac (synth alone 1.5 %). The Tesla is slower; the budget is under 15 %.
- **Determinism:** two renders with the same seed differ by at most −130 dBFS.

**Every replay fixture** through the real pipeline (startup included), rendered and analysed (`reports/replay-metrics.json`):

| fixture | seconds | shifts | max rpm | peak dBFS | clicks | steady windows | firing within ±3 % | CPU |
|---|---|---|---|---|---|---|---|---|
| launch-to-60 | 25.2 | 5 | 8746 | −4.33 | 0 | 18 | 100% | 2.3% |
| highway-merge | 30.2 | 6 | 6525 | −4.33 | 0 | 43 | 100% | 2.2% |
| steady-cruise | 44.2 | 0 | 2460 | −4.33 | 0 | 113 | 100% | 2.1% |
| stop-and-go | 42.2 | 2 | 4610 | −4.33 | 0 | 36 | 100% | 2.1% |
| hard-braking | 17.4 | 6 | 3678 | −4.33 | 0 | 28 | 100% | 2.3% |
| gps-dropout | 34.2 | 0 | 2460 | −4.33 | 0 | 89 | 100% | 2.2% |
| noisy-fixes | 28.2 | 5 | 3491 | −4.33 | 0 | 21 | 100% | 2.2% |

The −4.33 dBFS peak is the same in every row because it is the startup "catch" bark, which is identical in each render. Max rpm 2,460 is the startup flare.

**Spectrograms** are in `reports/*.png`: log frequency, with the expected firing line overlaid.
- `spectrogram-fixed-<rpm>.png`
- `spectrogram-rpm-sweep.png`, `-upshifts`, `-downshiftBlips`, `-limiter`, `-overrunPops`, `-startStop`
- `spectrogram-preset-*.png`, `spectrogram-sample-layer-sweep.png`
- `spectrogram-replay-<fixture>.png`

Listenable renders are in `reports/audio/*.wav`.

## 3. End-to-end (production build in Chromium)

All 10 pass:
- No console errors on load.
- No AudioContext exists before the tap; Start via a real click → running → idle; Stop → off.
- The simulator pulls through the gears.
- All 7 fixtures replay in the app (at 4× speed) with the status line updating and audio running throughout.
- Rapid Start/Stop/Start builds exactly one engine, and Stop suspends the audio.
- A reload mid-drive shows "Tap to resume", which goes straight to idle without a cold start.
- Settings persist across reloads.
- Launch control: disabled until the engine runs; the 2-step holds 5,300–6,000 rpm with cuts; flooring the simulator launches and the button disarms itself.
- The shift style setting defaults to Aggressive and persists.
- The slicer page loads.

Screenshots of the built app: `reports/screenshots/`.

## 4. Independent review

A separate agent that had not seen the code reviewed the architecture, the audio approach and Tesla risks. Every Critical and High finding was fixed and has a test.

| # | Finding | Fix |
|---|---|---|
| C1 | Older Teslas report `coords.speed = 0` while moving, so the engine would idle all drive | Cross-check against position-derived speed; after 3 consecutive disagreements, use positions for the session. A real stop is still trusted |
| C2 | Position-only speed was noisy: gear hunting and parked revving | Least-squares velocity over a 4 s window with a statistical "standing still" test plus hysteresis; vector outlier gate; slow load for shift decisions; 1.6 s anti-hunt rule for reversing shift direction; 1.5 s kickdown hold; zero load when parked |
| H1 | Fast Start/Stop/Start could build two engines | One shared build promise, and every await re-checks that the engine is still wanted (e2e test) |
| H2 | Stop never released the audio device | Context suspended after the shutdown sound (e2e test) |
| H3 | Silent failure in the background | Watchdog: if audio time stalls for 2 s while visible, show "Tap to resume"; media-element pause → overlay |
| H4 | Media-element route failed silently | Falls back to direct output with an on-screen message |
| H5 | Recordings lost on a reload, and downloads doubtful in the car | Flushed to localStorage every 10 s, recovered after a reload, last 3 kept and replayable from the Replay list |
| M1–M3 | Clock jumps, repeated fixes, tunnel "phantom pull" | Re-anchor, ignore repeats, 20 s hold at speed with a faster recovery glide |
| M4 | No reload recovery | Session marker → one-tap warm resume (e2e test) |
| M5 | Main-thread cost | Tach at DPR 1, drawn at 30 fps; unchanged audio params not re-scheduled; only active sample voices automated |
| M6 | Mono sound | Stereo: exhaust banks panned L/R, intake slightly wide, mono-compatible |
| R1–R5 | Idle hum, static resonances, intake hiss, CPU, denormals | Lower order-3 support at idle and lumpier cylinders; exhaust delays scale with hot-gas speed of sound; low-passed intake noise; guards on idle trig; anti-denormal |
| L2, L3 | Overlapping GPS polls; wrong tach redline | In-flight guard; redline from `vehicle/config.js` |

Not done:
- The review suggested a QR-code export of recordings for the car. It wasn't done: download plus in-car replay covers the need for now.
- A live (mid-drive) switch of the audio output route wasn't done: the route changes on the next Start Engine.

## 5. What can't be verified at a desk

Real-car behaviour is covered by `TESLA_TEST_CHECKLIST.md`:
- whether audio keeps playing in the background or in Reverse
- how it interacts with Bluetooth and navigation prompts
- the real GPS rate, latency and accuracy
- CPU headroom on MCU2

Nobody has listened to the synth; its realism is supported by measurement only.
