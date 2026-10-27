# Architecture

Vanilla JS ES modules, built with Vite. No runtime dependencies.

```
GPS / Simulator / Replay ──► inputBus (Kalman speed+accel filter, extrapolation, dropout)
                                  │  estimate(t) → { speedMps, accelMps2, load, status }
                                  ▼
                         vehicle/rpmModel (PDK gearbox, shift logic, idle, limiter, startup)
                                  │  step(dt, input) → { rpm, gear, load, cut, combustion, starter, events[] }
                                  ▼
                         audio/engine (AudioWorklet flat-six synth + optional sample layer → mixer → limiter)
                                  ▲
                         ui/ (tach, controls, debug) reads the same frame state
```

## Data contracts

### Input sample (every source produces these)
```js
{ speedMps, accelMps2 /* may be null */, timestamp /* ms, performance.now() timebase */, source: 'gps'|'sim'|'replay', accuracy /* m, 1-sigma-ish */ }
```

### Raw GPS fix (what `watchPosition` gives, what Record saves, what Replay plays)
```js
{ t /* ms since trace start */, lat, lon, speed /* m/s or null */, accuracy /* m */, heading /* deg or null */ }
```
Replay feeds fixes through the **same** `GpsFixProcessor` that live GPS uses, so the pipeline is identical.

Fixture / recording file:
```json
{ "name": "launch-to-60", "description": "...", "version": 1, "fixes": [ { "t": 0, "lat": 37.0, "lon": -122.0, "speed": 0, "accuracy": 5, "heading": 90 } ], "gaps": [] }
```
A fix with `"lost": true` (or a gap in `t`) represents no signal.

### inputBus
```js
const bus = createInputBus(config)
bus.push(sample)                 // from any source
bus.estimate(nowMs) → { speedMps, accelMps2, rawSpeedMps, load, status, source, accuracy, ageMs, updateHz }
// status: 'ok' | 'stale' (holding) | 'lost' (decaying to 0) | 'waiting'
bus.reset()
```

### rpmModel
```js
const model = createRpmModel(vehicleConfig, { seed })
model.start(); model.stop()      // startup / shutdown sequences
model.step(dtSec, { speedMps, accelMps2, load }) → frame
frame = { rpm, gear /* 1..7, 0 = N */, load /* 0..1 smoothed */, throttle /* 0..1 */,
          cut /* 0..1 ignition cut */, combustion /* 0..1 */, starter /* 0..1 */,
          engineState /* 'off'|'cranking'|'running'|'stopping' */, shifting, events: [{type, ...}] }
// event types: 'upshift','downshift','limiter','startup','catch','shutdown'
```

### Audio engine (`audio/engine.js`)
Works with both `AudioContext` and `OfflineAudioContext` (tests render offline).
```js
const engine = await createEngine(ctx, audioConfig)   // loads the worklet module
engine.connect(ctx.destination)                        // or engine.output
engine.setFrame(frame, when = ctx.currentTime)         // schedules smoothed params
engine.setPreset('street'|'track'|'cabin'); engine.setVolume(0..1); engine.setMix(0..1)
await engine.loadSamples(manifestUrl)                  // optional; silently no-op if missing
engine.levels() → { exhaust, intake, mech, sample, master } (dBFS, from analysers)
engine.dispose()
```
Everything time-varying is an AudioParam on the worklet (`rpm`, `load`, `cut`, `combustion`, `starter`) driven with `setTargetAtTime`, plus per-sample one-pole smoothing inside the worklet, so playback is click-free and offline rendering is deterministic.

## Config
All tunables: `src/vehicle/config.js`, `src/audio/config.js`, `src/input/config.js`.

## Sample manifest (`/samples/manifest.json`) — shared by slicer (writer) and sampleLayer (reader)
```json
{
  "version": 1,
  "name": "my-gt3rs",
  "loops": [
    { "file": "on_3000.wav", "rpm": 3000, "layer": "on",  "loopStart": 0.0, "loopEnd": 0.42, "gain": 1.0 },
    { "file": "off_3000.wav", "rpm": 3000, "layer": "off", "loopStart": 0.0, "loopEnd": 0.40 }
  ]
}
```
- `file` is relative to the manifest URL. `rpm` = engine rpm the loop was recorded at.
- `layer`: `"on"` (on throttle / load) or `"off"` (overrun / lift-off). Either layer may be missing; then the other one is used for both.
- `loopStart` / `loopEnd` in seconds (optional; default whole file). `gain` optional (default 1).
- Playback: equal-power crossfade between the two loops nearest the current rpm (per layer), `playbackRate = rpm / loop.rpm`; on/off layers blended equal-power by load.
- Parser: `parseManifest(json, baseUrl)` in `src/audio/manifest.js` — validates, sorts by rpm, resolves URLs, throws descriptive errors.

## Tesla constraints that shape the code (see RESEARCH.md §3)
- Layout must work at ~773×601 CSS px (window while driving) up to ~1900×1100; DPR 1; no backdrop-filter / heavy effects.
- `AudioContext({ latencyHint: 'playback' })`; resume only from a tap; show a big "Tap to resume" overlay if the context is ever suspended or the page reloads.
- Optional output route: worklet → `MediaStreamAudioDestinationNode` → `<audio>` element (+ Media Session), selectable in settings, in case pure Web Audio is paused in the background.
- Sound must not depend on main-thread timer cadence: params are scheduled with smoothing, the worklet smooths per sample.
