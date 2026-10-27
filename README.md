# GT3 RS Engine Sound for the Tesla browser

A free, single-page web app that plays a **procedurally synthesized Porsche 992 GT3 RS flat-six**
through your Tesla's speakers, synced to how you're actually driving, using the car's GPS.

- **Zero audio files.** The engine is synthesized live in an AudioWorklet from modelled combustion
  pulses, exhaust-pipe resonators, intake howl and mechanical noise. There are no game rips and no
  YouTube rips. You can optionally add your own CC-licensed recordings (see below).
- **Real gearing.** The 992 GT3 RS 7-speed PDK ratios and 4.27 final drive come from Porsche's data
  sheet, with load-dependent shift points, ~100 ms upshifts with an ignition-cut blat,
  rev-matched downshift blips, a 900 rpm idle with a slight wobble, and a 9,000 rpm limiter.
- **Hands-off.** Tap **Start Engine** once while parked, then never touch it.
- **Static site** on GitHub Pages. No accounts, no server, no paid anything.

Live URL: **https://justinagaudelli-eng.github.io/gt3rs-engine-sound/**

> In-cabin audio only. Volume is capped. Set everything up while parked; the app never needs
> interaction while the car is moving.

---

## Using it in the Tesla

1. Open the browser and go to the live URL above. Bookmark it.
2. Select **GPS** as the input and allow location when asked.
3. **While parked**, tap **Start Engine**. That tap also unlocks audio. You'll hear the starter,
   the catch, a flare to ~2,500 rpm and then idle.
4. Drive. The RPM follows your speed, the gearbox shifts by itself, and lifting off crackles.
5. If the sound ever stops (e.g. another media source took over), a full-screen **Tap to resume
   audio** button appears. Tap it when it's safe.

Your first drive: follow [`TESLA_TEST_CHECKLIST.md`](TESLA_TEST_CHECKLIST.md). Several Tesla
browser behaviours (background audio, Bluetooth interplay) are undocumented and must be checked
in the car.

**Controls:** volume · synth/sample mix · sound preset (**Street** balanced, **Track** raw and
exhaust-forward, **Cabin** muffled through-the-firewall) · input (**GPS / Simulator / Replay**) ·
**Record drive** · **Test tone** · speed units · audio output route. There is also a collapsible
debug panel showing raw vs filtered speed, load, RPM, gear, audio levels and CPU.

If audio stops whenever the browser is minimized, try **Audio output → Media element**. It routes
the engine through an `<audio>` element, which some Tesla firmware treats as "real" media.

---

## Tuning the sound

Every tunable number lives in three files. There are no magic numbers in the code.

| File | What's in it |
|---|---|
| `src/audio/config.js` | Voice levels, pulse shape, exhaust pipe lengths and feedback, intake resonances, rasp, overrun pop rate, drive/saturation, compressor/limiter, the three presets, volume cap |
| `src/vehicle/config.js` | Gear ratios, final drive, tyre circumference, idle, limiter, shift points vs load, shift timing, blips, launch slip, startup sequence, simulator physics |
| `src/input/config.js` | GPS rejection thresholds, Kalman filter noise, extrapolation, dropout timings, load-from-acceleration mapping, `dopplerLatencyMs` |

The most likely things to adjust after a first drive:

- **Lag between car and sound:** `input/config.js` → `gps.dopplerLatencyMs` (raise it if the sound
  trails the car), `filter.jerkPsd` (higher = more responsive but jumpier).
- **"It feels like part throttle when I floor it":** `input/config.js` → `load.fullAccelLowSpeed` /
  `fullAccelHighSpeed` (lower = reaches full load sooner).
- **Shift points:** `vehicle/config.js` → `shift.upshiftLightRpm` (cruise shift point),
  `shift.upshiftFullRpm`.
- **Pops and crackles:** `audio/config.js` → `overrun.probBase`, `overrun.probPerRpm`.
- **Too buzzy or too dull:** `audio/config.js` → `intake.gain`, `mixer.drive.amount`, and the preset EQs.

Test changes at a desk with **Simulator** (throttle/brake pads plus "Rev in neutral") or **Replay**.

---

## Recording and replaying drives

- Select **GPS**, tap **Record drive**, drive, and tap it again. A `drive-<timestamp>.json` file
  downloads. It holds the raw GPS fixes: time, position, speed and accuracy.
- At your desk, select **Replay** and either choose a bundled fixture or **Load JSON** with your
  recording, then tap **Play**. Replay feeds the fixes through exactly the same pipeline as live
  GPS (fix rejection → Kalman filter → gearbox → synth).
- To add a recording as a permanent fixture, drop it in `fixtures/` and add it to
  `fixtures/index.json`.

Bundled synthetic fixtures (`node scripts/gen-fixtures.mjs` regenerates them): launch to 60 mph,
highway merge, steady cruise, stop-and-go, hard braking, GPS dropout (tunnel), and noisy fixes
(position only, with outliers).

---

## Adding your own samples (optional)

The synth is the default, so you never need samples. If you have a legally usable recording
(see RESEARCH.md §4 for CC-licensed Porsche clips you can download yourself):

1. Open **`/tools/slicer.html`** (linked from the app, or `<live URL>/tools/slicer.html`).
2. Load one **rev sweep** recording, ideally a stationary run from idle to redline.
3. Either enter its start and end RPM, or tap **Estimate**. It pitch-tracks the recording,
   firing frequency = rpm / 20, and plots RPM against time. Use the octave correction if the
   curve is half or double.
4. Choose the RPM step (default 500), loop length and layer (`on` = throttle, `off` = overrun),
   then tap **Slice**. It cuts RPM-tagged loops that are a whole number of firing cycles long,
   start and end on rising zero crossings, and are seam-crossfaded. All loops share one gain.
5. Download the ZIP. Unzip it into `public/samples/` so you have `public/samples/manifest.json`
   plus WAVs, then commit and push. The site redeploys.
6. In the app, raise the **Synth ↔ Sample** slider. The engine crossfades between the two nearest
   RPM loops (equal power), pitch-shifts them to the exact RPM, and blends on/off layers by load.
   With no manifest present it silently stays synth-only.

`manifest.json` format: see [ARCHITECTURE.md](ARCHITECTURE.md#sample-manifest-samplesmanifestjson--shared-by-slicer-writer-and-samplelayer-reader).
Respect the recording's license; CC-BY needs attribution and NC means non-commercial only.

---

## Development

```bash
npm install
npx playwright install chromium   # once, for the audio + e2e tests
npm run dev                        # http://localhost:5173
npm test                           # unit tests (Vitest)
npm run build && npx playwright test   # offline audio analysis + end-to-end
```

- **Unit tests:** gearbox math, shift logic and hysteresis, GPS filter on noisy and dropout
  fixtures, every fixture through the full pipeline, manifest parsing, crossfade weights, slicer
  loop-point math, pitch tracking, WAV/ZIP encoding, settings.
- **Audio analysis** (`tests/audio`): renders the real engine with `OfflineAudioContext` in headless
  Chromium for fixed RPMs, shifts, blips, limiter, pops, start/stop, presets, the sample layer and
  every replay fixture. It then asserts:
  - the firing peak is within ±3 % of rpm/20
  - no clipping (≤ −1 dBFS)
  - no clicks
  - spectral centroid rises with RPM
  - on-load vs off-load difference ≥ 6 dB

  Spectrograms land in `reports/` and results in `reports/SUMMARY.md`.
- **End-to-end** (`tests/e2e`): the built site in Chromium. It checks start via a real click,
  that audio stays locked until then, the simulator, every replay fixture, settings persistence
  and the slicer page.

See [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md) and [RESEARCH.md](RESEARCH.md).

## Deploying your own copy

A GitHub Actions workflow (`.github/workflows/deploy.yml`) tests, builds and publishes to GitHub
Pages on every push to `main`. One-time setup with the GitHub CLI:

```bash
gh repo create gt3rs-engine-sound --public --source . --push
gh api -X POST repos/{owner}/gt3rs-engine-sound/pages -f build_type=workflow
```

Pushing workflow files needs the `workflow` token scope: `gh auth refresh -s workflow`.

## License

Code: MIT. No third-party audio is included.
