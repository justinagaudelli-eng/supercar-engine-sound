# Tesla first-drive test checklist

Do steps 1–6 **parked**. Have a passenger do anything on screen while moving, or pull over first.
Note the result next to each step (✅ / ❌ / notes). Turn on **Record drive** before you start
moving (step 5) so you can replay the drive at your desk afterwards.

1. **Open the URL** in the Tesla browser (the live URL from the README). Bookmark it.
   - Does the page fill the window and look readable? Open the debug panel (bottom) and note
     *AudioContext state*, *sample rate* and *base latency*.
2. **Grant location.** Choose GPS as the input and accept the location prompt.
   - Does the status line go from `waiting` to `ok` within ~10 s? Note the **accuracy (m)** and
     **update rate (Hz)**. Does the debug panel show a *raw speed* value or `—` when parked?
     (`—` / 0 is fine parked; older Intel cars may never report a speed — the app then derives it from positions.)
3. **Tap Start Engine while parked.** You should hear the starter, the engine catching, a flare
   to ~2,500 rpm and then a settled idle around 900 rpm.
   - No sound? Tap **Test tone**. If the tone plays but the engine doesn't, note it. If neither
     plays, check the car's media volume and the selected media source.
   - Try each **preset** (Street / Track / Cabin) and adjust **Volume** to a comfortable level.
4. **Optional: "Rev in neutral"** (Simulator input, still parked): hold the button and check it
   revs and bounces off the limiter cleanly. Switch the input back to **GPS** afterwards.
5. **Tap Record drive, then drive slowly in a parking lot** (5–15 mph).
   - Does the RPM follow your speed? Pulling away should rise from idle; braking to a stop should
     fall back to idle. Note any lag (seconds) between the car moving and the sound reacting.
6. **Check that audio continues while moving.** Older firmware blocked video while driving; we
   need to confirm audio is not blocked. Drive past 20 mph and listen for gear changes.
7. **Normal road drive** (passenger watches the screen, or check afterwards):
   - Accelerating firmly: hear upshifts? Lifting off: overrun crackles?
   - Braking to a stop: hear downshift blips?
   - Steady cruise: no hunting between gears, no stuttering.
8. **Phone Bluetooth / other media.**
   - Start music from your phone or Spotify. Does it pause the engine sound, mix with it, or get
     paused by it?
   - Then tap the screen to come back. If the engine went silent, does the **Tap to resume audio**
     overlay appear and work?
9. **Navigation prompt.** With a route set, does a voice prompt duck or interrupt the engine sound?
   Does it come back on its own?
10. **Minimize the browser** (open the map full screen, or another app) for ~30 s while driving.
    - Does the sound keep playing? Does the RPM freeze?
    - When you return, is the page still there, or did it reload?
    - If audio stopped in the background: open **Settings → Audio output → Media element** and
      repeat this step.
11. **Shift into Reverse** (camera view takes over the screen). Does the audio continue?
12. **Tunnel or parking garage**, if you pass one. The status should show `stale`, then `lost` and
    decay to idle, then recover smoothly when the signal returns.
13. **At the end, tap Record drive again** to stop. The JSON downloads (or appears in the
    browser's downloads).
    - If the Tesla browser won't download files, note it. You can still test with the bundled
      replays at your desk.
14. **Tap Stop.** You should hear a shutdown. Park and leave the car. Next drive, does the page
    remember your settings (volume, preset, input)?

**Report back:** the GPS update rate and accuracy you saw; how much lag (seconds) there was
between the car and the sound; and the answers to 6, 8, 10 and 11. Those decide what to tune
first.
