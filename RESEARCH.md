# RESEARCH

Phase 0 research for the GT3 RS engine-sound web app. Four research passes ran in parallel (2026-10-27);
each section keeps its own sources and confidence markers. Where this project deviates from a finding,
the reason is in DECISIONS.md.

| Spec item | Section |
|---|---|
| 1. 992 GT3 RS specs (engine, redline, idle, PDK ratios, final drive, tyre) | §1 Part A |
| 2. Flat-six sound character | §1 Part B |
| 3. Procedural synthesis techniques + chosen approach | §2 |
| 4. Tesla in-car browser constraints | §3 |
| 5. Free CC-licensed Porsche recordings (not bundled) | §4 |

**Numbers used in code** (`src/vehicle/config.js`): ratios 3.75 / 2.38 / 1.72 / 1.34 / 1.11 / 0.96 / 0.84,
final drive 4.27 (Porsche data sheet, high confidence); rear 335/30 ZR21 → 2.307 m unloaded, 2.238 m
rolling (3 % loaded-radius reduction is an ESTIMATE); redline = limiter = 9,000 rpm; idle ~900 rpm (ESTIMATE,
no official figure); 386 kW @ 8,500 rpm, 465 Nm @ 6,300 rpm; 1,450 kg; Cd 0.39 × 2.21 m².


---

## §1 Porsche 992 GT3 RS: Specs and Flat-Six Sound Character

Research date: 2026-10-27. Values with a primary Porsche source are marked **[OFFICIAL]**. Values derived by arithmetic from official data are marked **[DERIVED]**. Values that are guesses or come from forums or secondary sources are marked **ESTIMATE**.

Primary sources:
- **[S1]** Porsche Technical Data, 911 GT3 RS, MY P 08/2022 (EU): https://newsroom.porsche.com/dam/jcr:1d390f77-93c3-49c0-89c7-634f5f02b26a/S22_3515_en.pdf
- **[S2]** Porsche USA Press Kit, "The new Porsche 911 GT3 RS (992)": https://newsroom.porsche.com/dam/jcr:46a23375-e7ee-4507-a577-d9761b784d33/992%20911%20GT3%20RS%20Press%20Kit%201.pdf
- **[S3]** Porsche Technical Data, 911 GT3 with Touring Package (PDK), MY S 10/2024 (992.2): https://newsroom.porsche.com/dam/jcr:f7d86a8e-1490-4881-8e46-142600dc84e6/pag-911-gt3-touring-package-pdk-en.pdf
- **[S4]** Porsche press kit, new 911 GT3 (992.2, 2024): https://newsroom.porsche.com/dam/jcr:94dbeef5-0a13-4fd2-95e7-9f05de55d62d/PAG_Porsche_911_GT3_EN.pdf
- **[S5]** Porsche Technical Data, 2019 911 GT3 RS (991.2, US): https://newsroom.porsche.com/dam/jcr:e00c2789-42c7-4dab-a818-a732003194b0/2019_911_GT3_RS_Technical_Specifications.pdf

---

### Part A — 992 GT3 RS specifications

#### A1. Engine [OFFICIAL, S1 unless noted]
| Item | Value |
|---|---|
| Type | Naturally aspirated 6-cyl boxer, 4 valves/cyl, dry sump, GPF |
| Displacement | 3,996 cm³ |
| Bore × stroke | 102.0 mm × 81.5 mm (oversquare, ratio 1.25) |
| Compression | 13.3:1 |
| Max power | 386 kW (525 PS; 518 hp US) at **8,500 rpm** |
| Max torque | 465 Nm (343 lb-ft) at **6,300 rpm** |
| Specific output | 96.6 kW/L |
| Max engine speed (rev limit) | **9,000 rpm**. S2 calls it a "9,000 rpm redline", and S4 says the GT3's "rev limit of 9,000 rpm" |
| Valvetrain | VarioCam on intake and exhaust; DLC rocker arms; solid cam followers (no hydraulic lifters) |
| Intake | "Variable intake manifold made of plastic with two switchable resonance valves and six individual throttle valves" |
| Exhaust | Stainless-steel lightweight sports exhaust from the GT3, "internal structure extensively modified" (S2 p.13) |
| Air intake location | "exclusively via the air intakes located under the double rear wing" (S2 p.13) |

- Engine family. Listings give the 992.1 GT3 engine as **MA1.76 / MDG.G** (lapmeta, secondary source: https://www.lapmeta.com/ja/model/470). The RS uses the same 4.0 L base with new cam profiles. Porsche's description is "increase in power ... achieved primarily via new camshafts with modified cam profiles" (S2 p.6). RS engine code: not confirmed.
- **Redline vs limiter.** Porsche gives a single figure of 9,000 rpm as "maximum engine speed", "redline" and "rev limit". ESTIMATE for the simulator: put the redline marker at 9,000 and fuel cut at about 9,000 to 9,050, bouncing roughly 100 to 200 rpm. The PDK upshifts automatically at about 9,000 in manual mode on the limiter.
- **Idle.** No official figure found. Searches of Porsche docs and Rennlist turned up only older 911s at 700 to 850 rpm (https://rennlist.com/forums/911-forum/216774-idle-speed.html, https://rennlist.com/forums/996-forum/186168-idle.html). **ESTIMATE: warm idle ≈ 900 rpm (range 850–950), cold-start fast idle ≈ 1,200–1,400 rpm for 20–60 s.** Confidence is low to medium.

#### A2. Transmission: 7-speed PDK, 992 GT3 RS [OFFICIAL, S1]
| Gear | Ratio |
|---|---|
| 1 | 3.75 |
| 2 | 2.38 |
| 3 | 1.72 |
| 4 | 1.34 |
| 5 | 1.11 |
| 6 | 0.96 |
| 7 | 0.84 |
| R | 3.42 |
| **Final drive (rear-axle ratio)** | **4.27** |

Context and cross-checks:
- The individual gear ratios are the same across the GT3 family. Only the final drive changes:
  - 991.2 GT3 RS: 3.75 / 2.381 / 1.70 / 1.344 / 1.114 / 0.957 / 0.844, final drive **4.188** (S5).
  - 992.2 GT3 PDK: same ratios as the RS, final drive **4.54** (S3). The 992.2 is "eight per cent shorter" than the 992.1 (S4 p.7, p.16). 4.54 / 1.08 ≈ 4.20, which implies the 992.1 GT3 used about 4.19 to 4.20 [DERIVED].
  - The RS's 4.27 is therefore shorter than the 992.1 GT3 (≈4.19), matching S2: "Compared to the 911 GT3 gearbox, the overall ratio has been reduced". It is longer than the 992.2 GT3's 4.54.
- Rennlist owners independently report 4.27 for the RS (https://rennlist.com/forums/992-gt3-and-gt2rs-forum/1386170-992-gt3-rs-gear-and-final-drive-ratios.html).
- **Confidence: high.** The values are from Porsche's own data sheet.

#### A3. Tyres and rolling circumference
- OE tyres [OFFICIAL, S1]: front 275/35 ZR 20 on 10J×20, rear **335/30 ZR 21** on 13J×21. Michelin's OE fitment is the Pilot Sport Cup 2 R N0 in the same sizes (https://www.michelinman.com/auto/browse-tires/by-vehicle/2024/porsche/911/gt3-rs-center-lock/275---35ZR20---XL-102(Y)_335---30ZR21---XL-109(Y)).
- Rear tyre math [DERIVED]:
  - Sidewall height = 0.30 × 335 mm = 100.5 mm
  - Rim diameter = 21 in × 25.4 = 533.4 mm
  - Unloaded diameter = 533.4 + 2 × 100.5 = **734.4 mm**
  - Unloaded circumference = π × 0.7344 = **2.307 m**
  - Effective rolling circumference: a tyre under load and at speed rolls on a dynamic radius slightly smaller than its free radius. **I applied a ~3% reduction, an ESTIMATE that is typical for low-profile UHP tyres:** 2.307 × 0.97 = **2.238 m** (dynamic radius ≈ 0.356 m).
- **Use C = 2.238 m in the simulator.** The real value probably lies between 2.22 and 2.26 m depending on wear, pressure and speed, because tyre growth at high speed partly cancels the loaded deflection.

#### A4. Speed per gear at 9,000 rpm [DERIVED from S1 ratios, C = 2.238 m]
Formula: `v_kmh = rpm / (gear × 4.27) × 2.238 × 60 / 1000`; inverse: `rpm = v_kmh × 1000/60 / 2.238 × gear × 4.27`.

| Gear | Ratio | Overall (×4.27) | km/h per 1000 rpm | km/h @ 9000 | mph @ 9000 |
|---|---|---|---|---|---|
| 1 | 3.75 | 16.013 | 8.39 | 75.5 | 46.9 |
| 2 | 2.38 | 10.163 | 13.21 | 118.9 | 73.9 |
| 3 | 1.72 | 7.344 | 18.28 | 164.5 | 102.2 |
| 4 | 1.34 | 5.722 | 23.47 | 211.2 | 131.2 |
| 5 | 1.11 | 4.740 | 28.33 | 255.0 | 158.4 |
| 6 | 0.96 | 4.099 | 32.76 | 294.8 | 183.2 |
| 7 | 0.84 | 3.587 | 37.44 | 336.9* | 209.4* |

\*Theoretical only. The car is drag-limited to **296 km/h (184 mph)**, and Porsche says it "reaches a top track speed of 184 mph in seventh gear" (S2 p.6). At 296 km/h in 7th the engine turns about **7,900 rpm** [DERIVED], which is consistent.

Checks:
- 6th gear at the limiter (≈295 km/h) almost equals Vmax, so the 6→7 shift occurs right at top speed. This is consistent with the published data.
- 0–60 mph needs a 1→2 shift (1st ends at about 47 mph), consistent with 3.0 s.
- At idle in 1st: 900 rpm ≈ 7.5 km/h. For the GPS mapping, any speed below about 8 km/h should be treated as "clutch slipping / creeping at idle".
- In 7th at 100 km/h: ≈ 2,670 rpm. At 130 km/h: ≈ 3,470 rpm.

#### A5. Performance, mass, aero [OFFICIAL, S1 unless noted]
| Item | Value |
|---|---|
| Top speed | 296 km/h (184 mph), DRS-dependent |
| 0–60 mph / 0–100 / 0–160 / 0–200 km/h | 3.0 s / 3.2 s / 6.9 s / 10.6 s |
| Unladen weight (DIN, EU) | 1,450 kg; US "lightest version" 3,268 lb ≈ 1,482 kg (S2) |
| Permissible gross | 1,795 kg |
| Drag coefficient Cd | **0.39** (low-downforce/DRS position; S2 p.9 "minimum Cd value (0.39)") |
| Frontal area A | **2.21 m²** |
| Cd·A | **0.862 m²** |
| Downforce | 409 kg @ 200 km/h; 860 kg @ 285 km/h (S2: 901 lb @ 124 mph, 1,896 lb @ 177 mph) |
| Wheelbase / length | 2,457 mm / 4,572 mm |

Simulator physics suggestion (ESTIMATE): m = 1,520 kg (DIN mass plus a 75 kg driver), Cd·A = 0.86 m² in DRS/low mode and about 1.0 m² with high downforce, Crr ≈ 0.012, ρ = 1.2 kg/m³, and driveline efficiency η ≈ 0.88. Check: at 296 km/h, aero drag power = 0.5 × 1.2 × 0.862 × 82.2³ ≈ 287 kW, plus rolling ≈ 15 kW, divided by η ≈ 0.88 gives about 343 kW needed. The engine makes about 360 kW at 7,900 rpm, so the model is consistent with the official Vmax.

#### A6. Power and torque curve
No published dyno for a stock 992 GT3 RS was found. Only the factory peaks are confirmed: 386 kW @ 8,500 and 465 Nm @ 6,300 (S1). Porsche's US page lists the same peaks (https://www.porsche.com/uk/models/911/911-gt3-rs/). For reference, a dyno of the previous 520 hp 991.2 RS measured about 430 whp (MotorTrend, via the search summary). Rule of thumb: ~15% drivetrain loss.

**ESTIMATE torque curve** (crank). It is shaped to the official peaks and typical high-revving NA 4.0 behaviour, with a broad plateau of 430–465 Nm from 4,500 to 8,500 rpm:

| rpm | 1000 | 2000 | 3000 | 4000 | 5000 | 6000 | 6300 | 7000 | 8000 | 8500 | 9000 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Nm | 300 | 340 | 375 | 410 | 440 | 462 | **465** | 458 | 445 | **434** | 405 |
| kW | 31 | 71 | 118 | 172 | 230 | 290 | 307 | 336 | 373 | **386** | 382 |

(kW = Nm × rpm / 9549. The 8,500 rpm point is pinned to the official 386 kW.)

---

### Part B — Flat-six sound character

#### B1. Firing order and interval
- **Firing order 1-6-2-4-3-5** is the long-standing Porsche flat-six order. I did not find a Porsche document stating it. It is corroborated by an enthusiast forum ("162435"): https://www.valkyrieforum.com/bbs/index.php?msg=277265. Confidence: medium-high, since it is widely documented for 911 engines.
- With Porsche numbering, cylinders 1–2–3 are on one bank and 4–5–6 on the other. The order therefore **alternates banks on every firing event** (L-R-L-R-L-R).
- **Even firing interval = 720° / 6 = 120° crank.** Wikipedia's flat-six article gives the 120° firing interval and says a boxer six "is able to have perfect primary and secondary balance" and "does not have a rocking couple" (https://en.wikipedia.org/wiki/Flat-six_engine).
- Per bank, each bank fires every **240°**, also perfectly evenly. This is the key structural difference from a crossplane V8, discussed in B2 below.

#### B2. Why it howls instead of burbling
- **Crossplane V8.** The firing order is L-R-L-L-R-L-R-R. Wikipedia says this "results in uneven intake and exhaust pulse spacing" within each bank, and that this uneven pulsing produces the "rumbling" V8 sound (https://en.wikipedia.org/wiki/V8_engine). Within each bank the intervals are 180-90-180-270°. Background on the V8 contrast: https://jalopnik.com/1878133/why-flat-plane-crank-v8-engines-sound-different/.
- **Porsche flat-six.** Pulses are evenly spaced overall (120°) and within each bank (240°). The exhaust pressure waveform is therefore close to periodic at the firing frequency. Spectrally, the energy concentrates in the firing order (3rd) and its integer multiples (6th, 9th, 12th...), with relatively little sub-harmonic or half-order content. The ear hears a clean, pitched, "singing" tone, a howl, rather than an amplitude-modulated rumble. At 9,000 rpm the 3rd-order fundamental is 450 Hz, inside the most sensitive vocal-like band. (Analysis based on the sources above.)
- **Headers.** Unequal-length runners add half-order irregularity and a "rumble". Many boxer engines use them for packaging, which gives the classic Subaru burble (https://discourse.automationgame.com/t/dumb-questions-someone-else-might-answer/18689?page=5). Aftermarket 992 GT3/RS equal-length headers are marketed as producing a "sharper, higher-frequency tone" (vendor claim: https://cencalmotorsport.com/collections/popular-exhausts/products/porsche-992-gt3-gt3rs-high-flow-race-headers-cencalmotorsport). The OE system has 2 GPFs and 4 catalysts (S4 p.16), which strongly attenuate high-frequency exhaust content. That is one reason the RS's **intake** is so prominent.

#### B3. Engine orders and frequencies
Definitions: order 1 = crank rotation frequency = rpm/60. For a 4-stroke, each cylinder fires every 2 revolutions, which is order 0.5. Six cylinders give the **firing order = 3rd order** (https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10161287). An engineering summary says a 6-cyl "fundamental frequency includes the third order and orders that are multiples of 3", and that half orders such as 1.5 and 4.5 come from cylinder-to-cylinder or runner-length irregularities and are "major factors in determining a vehicle's exhaust tone" (search summary of eng-tips thread https://eng-tips.com/threads/3rd-order-noise.129842 and the US patent texts above).

| Order | Source / meaning | Hz @ 900 | @ 3000 | @ 6000 | @ 9000 |
|---|---|---|---|---|---|
| 0.5 | single-cylinder cycle (any cylinder mismatch) | 7.5 | 25 | 50 | 75 |
| 1 | crank rotation, imbalance | 15 | 50 | 100 | 150 |
| **1.5** | **per-bank firing (240° spacing)**, strong in each bank's pipe before merging | 22.5 | 75 | 150 | 225 |
| **3** | **firing frequency (fundamental)** | 45 | 150 | 300 | **450** |
| 4.5 | half-order; tonal "edge" from runner mismatch | 67.5 | 225 | 450 | 675 |
| **6** | 2nd harmonic of firing; dominant in intake/induction howl | 90 | 300 | 600 | **900** |
| 9 | 3rd harmonic; adds "rasp" | 135 | 450 | 900 | 1350 |
| 12+ | upper harmonics, valvetrain, gear whine | 180 | 600 | 1200 | 1800+ |

Quick formula: **f_firing (Hz) = rpm / 20**.

What typically dominates where. This is general automotive-acoustics practice, applied by analysis to this engine; it is not RS-specific measured data.
- **Exhaust (tailpipe).** The 3rd order is the fundamental. The 1.5 order appears if the per-bank systems remain separate long enough. An Akrapovič patent shows that opening or closing a cross-bank connection makes "lower harmonic orders ... namely the 1.5 and 2.0 order" audible or inaudible, and that for its V8 example "the most dominant harmonic orders are 3.0 and 3.5" (https://patents.google.com/patent/US10605133B2/en). The 911 exhaust has a per-bank (3-into-1) layout that merges at the rear silencer. Expect a 3rd-order fundamental with a modest 1.5 component at low rpm, which gives an idle "lope", and a 6th/9th-order buildup as rpm rises. Valve and flap open states raise the low orders and overall level.
- **Intake (the GT3 RS signature).** Six individual throttle bodies feed a plenum with two resonance flaps (S1). The intake noise is the pulsating induction of each cylinder at 3rd order plus strong 6th and 9th harmonics, filtered by plenum and runner resonances. The variable-resonance flaps change which harmonic band is reinforced at different rpm. The intake is right behind the cabin and fed by the rear-wing intakes (S2 p.13). It is the source of the "howl/wail" inside the car.
- **Mechanical.** Solid followers, gear-driven parts and the PDK produce broadband ticking and whine above about 2 kHz. Mix this at a low level, rising with rpm.

#### B4. Intake vs exhaust character, and what changes near redline
- Porsche spec: "Variable intake manifold ... two switchable resonance valves and six individual throttle valves" (S1). The 992 GT3 also has "six individual throttle valves" (S4 p.16; S3).
- Reviews (mostly 991-generation RS, the same engine concept):
  - Auto123 heard a "deep intake howl" that "becomes a wail" with the hip intakes feeding sound into the cabin (https://www.auto123.com/en/car-reviews/2016-porsche-gt3-rs-review/61209/).
  - Car Throttle described "a shriek rather than a howl" from about 3,000 rpm to the redline, plus reduced sound deadening (https://www.carthrottle.com/reviews/porsche-911-gt3-rs-review-whats-500bhp-track-monster-road).
  - Top Gear SA described an "8,000–9,000 rpm mechanical shrill" (https://topgear.co.za/reviews/porsche-911-gt3-rs).
  - 992-specific: an owner forum says the 992 RS cabin is "far less muffled and insulated" than the GT3 and sounds much better on the stock exhaust (https://911uk.com/porsche/did-i-get-a-bad-car-gt3-or-is-it-normal-how-it-drives-in-track-mode.127993/latest; anecdotal).
- The resonance-flap switch points for the 992 RS are not published. **ESTIMATE for synthesis:**
  - **Below ~2,500 rpm:** exhaust-dominated, mellow. The 3rd order is strong, with some 1.5 order and a slight lope at idle.
  - **2,500–5,000 rpm:** the first resonance flap opens and the intake gets louder. Hard, "busy" boxer timbre.
  - **~5,000–7,000 rpm:** the second flap opens and the cam profile comes "on cam". Intake howl dominates and 6th/9th orders rise sharply. This is where "howl" turns into "wail".
  - **7,000–9,000 rpm:** metallic rasp and a "shriek". Upper harmonics (9th–15th) and mechanical content increase. The tone resembles a race car.
  - Model the changes as smooth crossfades or EQ shifts centred at about 3,000 and 5,500 rpm, with ±300 rpm blend widths.
- **Exhaust flaps.** Porsche GT exhausts use electrically controlled flaps; Porsche describes the flap position as "continuously controlled by engine speed and load" on its sports exhausts (https://newsroom.porsche.com/en_US/technology/porsche-cayenne-gts-coupe-sport-exhaust-system-21752.html). ESTIMATE: in Sport/Track the flaps are open at all rpm. In Normal they open above about 4,000 to 5,000 rpm or at high load. Opening adds roughly 3–6 dB and more low-order (1.5/3) content.

#### B5. Transients: overrun, upshift, downshift
- **Overrun / lift-off.** Modern GT3s are comparatively restrained. Car Throttle notes there are no artificial "pops or bangs" on the 991 RS (link above). Owners report overrun pops on 718 and 911 cars mostly in Sport mode (https://www.porscheclubgb.com/forum/threads/exhaust-pops.160296/). **ESTIMATE:** on a lift above about 4,000 rpm, apply a deceleration fuel cut. The volume drops by about 10–15 dB within roughly 150 ms. A hollow intake "suck" or whoosh and a burbly exhaust remain, with sparse, quiet crackles (a few per second for 0.5–1.5 s, randomized, 1–4 kHz transients). Avoid exaggerated "pop-tune" bangs. As revs fall, the pitch glides down at the rate the car decelerates.
- **PDK upshift under load.** Porsche: PDK shifts "in milliseconds without interruption in drive" (S4 / Porsche GT3 press material). The ECU cuts or retards torque briefly during the clutch handover. Porsche does not document the exact mechanism, so treat this as **ESTIMATE**. Audibly: a short **"blat"/bark** lasting about 40–80 ms, with a level dip and rasp from the retarded spark, plus the instant rpm drop. Ratio steps: 1→2 −37%, 2→3 −28%, 3→4 −22%, 4→5 −17%, 5→6 −14%, 6→7 −12% [DERIVED from S1]. For example, a 9,000 rpm shift from 1→2 lands at about 5,710 rpm and 2→3 at about 6,500. Model the rpm fall as roughly an exponential settle over 100–150 ms, not an instant step.
- **PDK downshift.** The ECU blips the throttle to rev-match. The manual gearbox has "Auto Blip" (S4 p.16), and PDK always rev-matches. Audibly: a sharp throttle stab lasting about 150–250 ms that raises rpm by the ratio step (for example 3→2 at 5,000 rpm rises to about 6,920). Usually 1–2 crackles follow on the overrun.
- **Rev limiter.** At 9,000 rpm, a hard fuel/ignition cut makes a stutter at about 10–20 Hz with an rpm bounce of about 100–200 (ESTIMATE). PDK in auto mode upshifts before the limiter.

---

### Summary of key simulator constants
| Constant | Value | Confidence |
|---|---|---|
| Gear ratios 1–7 | 3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84 | High (S1) |
| Final drive | 4.27 | High (S1) |
| Rear tyre | 335/30 ZR21; unloaded C = 2.307 m; **rolling C ≈ 2.238 m** | High / Medium (−3% estimate) |
| Redline = rev limit | 9,000 rpm | High (S1, S2) |
| Peak power / torque | 386 kW @ 8,500 / 465 Nm @ 6,300 | High (S1) |
| Idle | ~900 rpm warm (ESTIMATE), 1,200–1,400 cold | Low–Medium |
| Firing frequency | rpm/20 Hz (3rd order); firing order 1-6-2-4-3-5, even 120° | High |
| Vmax | 296 km/h in 7th (~7,900 rpm) | High |
| Mass / Cd / A | 1,450 kg DIN / 0.39 / 2.21 m² | High (S1) |

---

## §2 Procedural engine-sound synthesis: techniques and recommended design

Target: a Porsche 992 GT3 RS (4.0 L naturally aspirated flat-six, 9,000 rpm redline, individual throttle bodies), built in the Web Audio API with no audio files, running in Tesla's Chromium on a modest CPU.

### Key engine facts that drive the DSP
- Four-stroke six-cylinder: 3 firings per crank revolution, evenly spaced 120° apart (firing order 1-6-2-4-3-5).
  - **Firing frequency = rpm / 20 Hz** (engine order 3). Idle at ~950 rpm gives ~48 Hz. 4,000 rpm gives 200 Hz. 9,000 rpm gives **450 Hz**.
- Each bank fires every 240° (order 1.5). Small differences between cylinders and between banks put energy at the half-orders (0.5, 1, 1.5, ...). This is what gives a flat-six its "lumpy" low-rpm texture. At high rpm the even order 3/6/9 series dominates and you get the clean, hard GT3 wail.
- The engine cycle (720° of crank angle) runs at rpm/120 Hz. Model every cylinder's phase on this 720° cycle.

---

### 1. Technique survey

#### 1.1 Additive / engine-order synthesis
A bank of sine oscillators, one per engine order k (0.5, 1, 1.5, ... 24), each at f = k·rpm/60, with amplitudes from an order table that depends on rpm and load.
- **Realism, good:** perfectly smooth sweeps. Precise control of the order balance, which is how NVH engineers describe engine sound. Easy to emphasise orders 3 and 6 for the GT3 character.
- **Realism, bad:** sounds sterile and organ-like. It has none of the per-firing transients, cycle-to-cycle variation or gas-flow noise that our ears read as "combustion". Getting the bright edge at idle needs 30+ partials, because 48 Hz × 40 is about 2 kHz. Additive synthesis is described as the "Holy Grail ... but it remains a challenging task" ([CRIWARE blog](https://blog.criware.com/?p=2070)).
- **CPU:** native `OscillatorNode`s are cheap (C++), but 30–50 of them plus gains is a lot of graph. A worklet sine bank costs about 50 sin() calls per sample unless you use a recursive oscillator.
- **Verdict:** use only as a **support layer**: 2–4 sines at orders 1.5, 3 and 6 for chest weight and a stable pitch centre, plus a quiet high-order whine.

#### 1.2 Pulse-train / combustion-impulse models
Each cylinder emits a short pressure pulse when its exhaust valve opens, triggered at its crank angle. The sum of the six cylinders is a pulse train at the firing frequency. Small per-cylinder timing and amplitude offsets, plus per-cycle jitter, create the half-orders and the roughness.
- Doerfler & Wyse 2026 ("Physics-Informed Neural Engine Sound Modeling with Differentiable Pulse-Train Synthesis", [arXiv 2603.09391](https://arxiv.org/html/2603.09391)) state the core point: engine sound comes from *sequential exhaust pressure pulses, not sustained harmonic oscillations*. Their Pulse-Train-Resonator (PTR) model makes:
  - per-cylinder pulses `P_i = E_i · c_i · Σ_k a_k sin(k·φ̃_i)`;
  - an envelope `E = (1 − e^{−αφ}) · e^{−βφ}`;
  - harmonic rolloff `a_k ∝ e^{−0.5·k·λ}`;
  - a "thermodynamic pitch" warp `φ̃ = 2π(φ/2π)^ν` with ν ≤ 1, which gives a downward chirp inside each pulse;
  - per-cylinder timing offsets of up to ±40° crank angle;
  - a throttle gain `g_thr = max(torque, 0.02)^0.7` and an overrun (DFCO) noise gain `max(−torque, ε)`.

  Banks are summed separately and fed through Karplus-Strong resonators (one per bank, then a shared one for the common pipe). This beat a harmonic-plus-noise baseline by 21% on harmonic reconstruction. ([project page](https://rdoerfler.github.io/ptr-model-page))
- **Realism:** the best single ingredient. Transients, roughness and natural harmonic richness come for free, and the spectrum tracks rpm automatically.
- **CPU:** very low. At most one or two pulses overlap at any time, and each costs an exp-envelope and a few multiplies per sample. It must run in an AudioWorklet to get crank-angle (sample-accurate) triggering.
- **Risks:** aliasing if the pulse attack is shorter than about 2 samples (keep the attack ≥ 0.15 ms). The output has a positive DC offset, so a DC blocker is mandatory.

#### 1.3 Waveguide / comb-filter exhaust resonance
Pipes are modelled as delay lines with reflection at their ends. A feedback comb `y[n] = x[n] + g·LP(y[n−L])` puts resonances at multiples of fs/L. These resonances are **fixed-frequency formants** that do not track rpm, which matches physics: the pipe stays the same length.
- **Baldan, Lachambre, Delle Monache & Boussard 2015**, "Physically informed car engine sound synthesis for virtual and augmented environments" (SIVE@IEEE VR, pp. 21–26; [ResearchGate](https://www.researchgate.net/publication/280086598_Physically_informed_car_engine_sound_synthesis_for_virtual_and_augmented_environments)). The model is a set of pipes excited by combustion. Digital waveguides represent the intake, cylinders, extractors, exhaust pipe, muffler chambers and outlet. Piston motion, ignition and valve timing control each waveguide's input, length and feedback. There are three outputs (intake/front, block vibration/cabin, outlet/rear), and the model includes backfire. Its parameters are documented in the Sound Design Toolkit `SDTMotor` API ([SDT docs](https://sdt.lim.di.unimi.it/docs/API/v2.2-078/group__motor.html)): intake/extractor/exhaust/muffler/outlet sizes in metres, muffler feedback, cycle asymmetry, spark time and backfire probability.
- **Antonio-R1 `engine-sound-generator`** ([GitHub](https://github.com/Antonio-R1/engine-sound-generator), [demo](http://antonio-r1.github.io/engine-sound-generator/src/engine_sound_generator/sounds_worklet_wasm.htm), fork [SpudzzDev/en](https://github.com/SpudzzDev/en)) is a Web Audio port of Baldan. Its first version used a buffer-scheduling approach that glitched in some browsers. It moved to an **AudioWorklet**, then to C++/WASM "to improve efficiency and remove glitches".

  Example configuration (4-cylinder):
  - intake, exhaust and extractor waveguides of 100 samples each;
  - open-end reflection 0.01, closed-end reflection 0.95;
  - straight pipe of 128 samples;
  - muffler elements of [10, 15, 20, 25] samples;
  - outlet of 5 samples;
  - `ignitionTime` 0.016.
- **DasEtwas `enginesound`** (Rust; [GitHub](https://github.com/DasEtwas/enginesound)) is "loosely based on" the same paper. It does pipe/chamber simulation with speed of sound and end reflections, and mixes intake, exhaust and vibration.
- **Farnell, *Designing Sound*** (MIT Press 2010), "Cars" chapter (Ch. 45): a ramp/phasor drives cylinder pulses multiplied by noise for jitter. A "warping circular waveguide" uses anti-phase, frequency-modulated delays for the exhaust, and a parabolic waveshaper handles low-frequency body resonance. A survey describes this as heuristic rather than rigorously derived ([Four Decades of Digital Waveguides, arXiv 2604.12878](https://arxiv.org/pdf/2604.12878); community Pd port on [sccode](https://sccode.org/tag/class/DelayC?by=dsastre)).
- **AngeTheGreat `engine-sim`**: a full physical simulation of gas dynamics running at an effective rate of about 80 kHz, with exhaust and intake flow turned into audio through an "audio approximation" stage ([The Drive](https://www.thedrive.com/news/new-3d-engine-sim-can-synthesize-super-realistic-exhaust-sounds-in-real-time)). It is very convincing, which validates the "pulses + pipes" idea, but it is far too heavy for a Tesla browser, and the engine has to be tuned like a real one.
- **Realism:** fixed pipe formants are what make the result sound "like a car in a space" rather than a synth. Too much feedback sounds metallic or kazoo-like. Full Baldan-style models are fiddly to tune.
- **CPU:** cheap. Each comb is one delay read/write plus a one-pole filter. **Web Audio constraint:** a feedback loop in a native node graph must contain a `DelayNode`, and that delay is clamped to at least one render quantum (128 frames ≈ 2.67 ms at 48 kHz). Header and muffler combs are 0.3–3 ms, so **short combs must live inside the worklet.**

#### 1.4 Granular (grains from recordings)
Commercial game engines (AudioMotors, REV, Wwise) slice recorded on-board or dyno ramps into rpm-indexed grains and crossfade between them. This is the industry's realism benchmark and cheap at runtime ([Audiokinetic](https://www.audiokinetic.com/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise), [GDC 2017](https://gdcvault.com/play/1023987/Data-Driven-Granular-Synthesis-for), [Square Enix DAFx-15](https://www.ntnu.edu/documents/1001201110/1266017954/DAFx-15_submission_7.pdf/e66b153c-1b7b-4c29-b13c-83197d5c7c92), [MCV](https://www.mcvuk.com/development/how-to-make-racing-car-engines-roar-using-audiomotors-fmod)). **Excluded by our zero-file rule.** One idea is to self-granulate our *own* synthesized output: render a few rpm points offline at startup and granulate those. That gains nothing over running the synth live. Keep granular only as an optional future layer if recordings are ever allowed.

#### 1.5 Practical Web Audio notes
- **AudioWorklet vs native graph.** Use the worklet for anything that needs sample-accurate triggering, per-sample state, or short feedback loops: the pulse train, combs and jitter. Use native nodes for "static" processing that is cheap in C++: `BiquadFilterNode`, `WaveShaperNode`, `DynamicsCompressorNode` and gains.
  - Use one worklet node with 3 output channels (or 3 outputs) for the exhaust, intake and mechanical voices. One worklet is cheaper than several.
- **No allocation in `process()`.** The GC runs on the worklet thread and blocks it ([web.dev profiling guide](https://web.dev/articles/profiling-web-audio-apps-in-chrome), [Mozilla Hacks](https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/)).
  - Preallocate every `Float32Array` delay line in the constructor.
  - No closures or array literals per block.
  - Keep `port.postMessage` traffic minimal; it allocates.
- **Parameters:** declare `rpm`, `throttle` and `load` as **k-rate** AudioParams (one value per 128 frames, cheapest). Smooth them **inside the worklet** with a per-sample one-pole filter (time constant ~15 ms for rpm, ~30 ms for throttle). The phase accumulator then integrates a smooth frequency, so phase stays continuous and nothing clicks. From the main thread, drive the params with `setTargetAtTime` (never with `.value =` jumps).
  - Every gain or filter-frequency change on native nodes should also go through `setTargetAtTime(v, t, 0.02)`.
- **Master chain:** DC blocker (in the worklet: `y = x − x1 + 0.995·y1`) → `WaveShaperNode` with a tanh curve (`oversample: '2x'` only if CPU allows; '2x' costs little in C++) → `DynamicsCompressorNode` (threshold −14 dB, knee 6, ratio 4, attack 0.003, release 0.15) → a second compressor used as a brickwall (threshold −1.5, knee 0, ratio 20, attack 0.001, release 0.05) → destination.
- **Testing:** `OfflineAudioContext` exposes `audioWorklet.addModule()` in Chromium, so render scripted rpm sweeps faster than real time. Then automatically check:
  1. NaN/Inf;
  2. peak ≤ 1;
  3. click detection: |x[n] − x[n−1]| outliers against a running median;
  4. DC mean;
  5. spectral centroid vs rpm, which should rise monotonically.

  Profile with `chrome://tracing` (audio category) as described in the web.dev guide.
- **Latency:** if the Tesla CPU glitches, create the context with `{latencyHint: 'playback'}` for larger buffers.

---

### 2. Recommendation: hybrid "pulse train → pipes" (PTR-style) in one AudioWorklet

**Why:** the pulse train supplies the correct time structure: transients, firing-order half-orders and jitter. Short waveguide combs supply the fixed formants of headers, muffler and tailpipe. Both are physically motivated (Baldan/SDT, Doerfler & Wyse 2026, engine-sim), both run in tens of operations per sample, and both scale to 9,000 rpm with no change of method. Additive covers only what pulses do weakly (clean low-order weight), and granular is ruled out.

```
             ┌─ bank A pulses (cyl 1,2,3) ─► comb HdrA ─┐
crank phase ─┤                                           ├─► comb Main ─► comb Muffler ─► LP(rpm,load) ─► EXHAUST
(smoothed    └─ bank B pulses (cyl 4,5,6) ─► comb HdrB ─┘        ▲ overrun pops injected here
 rpm)        ├─ firing envelope × noise ─► BP formants (plenum/ITB) ───────────────────────────────► INTAKE
             └─ orders 6/9/12 sines + cam-rate tick noise ───────────────────────────────────────► MECH
EXHAUST + INTAKE + MECH (+ order 1.5/3 sines) ─► DC block ─► drive(rpm,load) tanh ─► compressor ─► limiter
```

#### 2.1 Combustion pulse (per cylinder, per firing)
- Shape: `p(t) = A · (1 − e^{−t/τa}) · e^{−t/τd} · (1 + 0.35·n(t)) − u·e^{−t/τu}`.
  - n(t) is white noise lowpassed at about 3 kHz. It is the gas turbulence: it gives grit without destroying pitch.
  - The small negative tail (u ≈ 0.15·A, τu ≈ 2·τd) models the post-blowdown rarefaction and reduces DC.
- `τa` = 0.15–0.3 ms (fixed).
- `τd` = clamp(0.30 × firing period, 0.35 ms, 4 ms). That is ~4 ms at idle (period 21 ms, so pulses are separated and "putty") and ~0.7 ms at 9k (period 2.2 ms, so pulses overlap into a tone).
- Optional PTR pitch warp: read the envelope at `t' = T·(t/T)^ν` with ν ≈ 0.8 for a slight downward chirp per pulse.
- Amplitude: `A = g_thr · (0.6 + 0.4·rpm/9000)`, with `g_thr = max(throttle, 0.02)^0.7`.
- **Fixed per-cylinder imbalance** (chosen once per engine with a seeded RNG): gain ±4%, timing ±1.5° crank angle. Make bank B's header comb 5–10% longer than bank A's. This produces the half-orders.
- **Per-cycle jitter:** timing σ = 0.6° crank angle and amplitude σ = 6% at idle, falling linearly to 0.15° and 2% at 9k. Real engines smooth out at high rpm. Jitter is what turns "buzzer" into "engine" at idle.
  - Use a cheap xorshift RNG and a Gaussian approximation (sum of 3 uniforms).
- Bandlimiting: start each pulse at its fractional sample position (sub-sample onset `frac`). With τa ≥ 0.15 ms there is no audible aliasing at 48 kHz.

#### 2.2 Exhaust voice (combs inside the worklet)
Hot exhaust has c ≈ 500–550 m/s. A comb delay equals the round-trip time 2L/c, and resonances fall at multiples of c/2L.

| Section | L (approx.) | Delay | Feedback g | Loop LP (one-pole) |
|---|---|---|---|---|
| Header bank A (equal-length primaries) | 0.65 m | 2.4 ms | 0.55 | 5 kHz |
| Header bank B | 0.70 m | 2.6 ms | 0.55 | 5 kHz |
| Main pipe / collector to muffler | 1.6 m | 6.2 ms | 0.45 | 2.5 kHz |
| Muffler chamber (2 short combs, different lengths) | 0.25 / 0.35 m | 1.0 / 1.35 ms | −0.35 / 0.3 | 3 kHz |
| Tailpipe / outlet | 0.2 m | 0.8 ms | 0.2 | 8 kHz |

- **Valve flap:** the GT3 RS exhaust flaps open with load. Model this as muffler-comb feedback that falls (0.35 → 0.15) and a muffler mix that gets drier as throttle × rpm rises. The open-flap sound is louder and more raw.
- **Brightness:** final exhaust lowpass at `fc = 700 + 0.55·rpm·(0.35 + 0.65·load)` Hz, clamped to 7.5 kHz, with Q 0.7. That is about 1.2 kHz at idle and about 5.5–7 kHz at 9k under full load.
  - Add a gentle peaking EQ at 120–180 Hz (+3 dB, Q 1), the body/boom formant (native Biquad).
- **Saturation:** `drive = 1 + 3·(rpm/9000)^1.5·(0.4 + 0.6·load)`, then `y = tanh(drive·x)/tanh(drive)`. Use a WaveShaper curve and pre-gain it with a GainNode (smoothed) rather than rebuilding the curve each time.

#### 2.3 Intake voice (essential for GT3 ITB "induction howl")
- Source: white noise × the summed firing envelope. Use a slower envelope here (τd × 1.5) so the noise is amplitude-modulated at the firing frequency. Mix in a little of the raw pulse train (−12 dB) so the intake has pitch.
- Formants, two native band-passes in parallel:
  1. airbox/plenum Helmholtz resonance at 350–500 Hz, Q 3;
  2. ITB/runner resonance at 1.6–2.4 kHz, Q 2.5.

  Glide formant 2's centre up by about 15% with rpm (`setTargetAtTime`) for a "wail".
- Level: `0.15 + 0.85·throttle·(rpm/9000)^1.2`, relative to exhaust 1.0. That is nearly silent at idle and up to about −4 dB vs exhaust at full throttle and high rpm. Add a little high-shelf boost (+4 dB > 3 kHz) at wide-open throttle.

#### 2.4 Mechanical voice
- Order 6, 9 and 12 sines (recursive oscillators in the worklet, phase from the same accumulator) at −30 to −24 dB, rising with rpm.
- Valvetrain tick: short noise bursts (0.3 ms decay) band-passed at 5–7 kHz, Q 4, triggered at each intake/exhaust valve event (12 per cycle, i.e. 2 per firing), at about −34 dB. Audible mainly at idle and low load.
- Support layer: sines at order 1.5 (−20 dB) and order 3 (−14 dB) added before the master. They anchor pitch and weight on small speakers.

#### 2.5 Overrun / pops (DFCO + afterfire)
- Conditions: throttle < 0.05, rpm > 2,500, and rpm falling (or a "sport" flag).
- Normal pulses drop to `g_DFCO` ≈ 0.08 (fuel cut). Add more turbulence noise through the exhaust combs (a hollow "whoosh-burble").
- At each firing slot, fire a **pop** with probability `p = 0.04 + 0.10·(rpm/9000)`, decaying to 0 within about 2.5 s of lift-off. A pop is:
  - amplitude 2–3.5 × a normal pulse;
  - τa 0.3 ms, τd 6–15 ms (random);
  - its noise portion boosted (n-mix 0.8);
  - a random 2–15 ms delay after the slot;
  - injected **after the header combs**, before the main pipe/muffler (afterfire happens downstream).
- Occasionally (20% of pops) fire 2–3 pops in a 40 ms burst (crackle). Cap at one burst every 120 ms.
- Rev-limiter at 9,000 rpm: cut fuel to random cylinders (skip ~50% of firings, re-randomised each cycle). This gives the characteristic stutter without any rpm discontinuity.

#### 2.6 Rpm/load mapping summary
| Param | Idle (950) | 4,000 / part | 9,000 / WOT |
|---|---|---|---|
| Firing freq | 48 Hz | 200 Hz | 450 Hz |
| τd | 4 ms | 1.5 ms | 0.7 ms |
| Exhaust LP | ~1.2 kHz | ~2.5 kHz | ~6.5 kHz |
| Drive | 1.0 | 1.4 | 4.0 |
| Intake level | −16 dB | −9 dB | −4 dB |
| Jitter (timing / amp) | 0.6° / 6% | 0.4° / 4% | 0.15° / 2% |

---

### 3. Worklet process-loop sketch
```js
class EngineProc extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name:'rpm', defaultValue:950, minValue:0, maxValue:9500, automationRate:'k-rate' },
    { name:'throttle', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate' } ]; }
  constructor() { super();
    this.theta = 0;                          // cycle phase in degrees, 0..720
    this.rpmS = 950; this.thrS = 0;          // smoothed values
    this.aR = 1 - Math.exp(-1/(0.015*sampleRate));  // ~15 ms one-pole
    this.aT = 1 - Math.exp(-1/(0.030*sampleRate));
    this.fireAt = [0,120,240,360,480,600];   // slots for firing order 1-6-2-4-3-5
    this.cylOfSlot = [0,5,1,3,2,4];          // cylinder index per slot
    this.imbAng = seededTable(±1.5); this.imbGain = seededTable(±0.04);
    this.nextAng = this.fireAt.map((a,i)=>a + this.imbAng[i]); // jittered angle for next firing
    this.env = new Float32Array(6); this.att = new Float32Array(6); // per-cylinder envelope state
    this.hdrA = new Comb(2.4e-3*sampleRate, 0.55, 5000); /* hdrB, main, muff1, muff2, tail... preallocated */
  }
  process(_, outputs, p) {
    const out = outputs[0], N = out[0].length;
    const rpmT = p.rpm[0], thrT = p.throttle[0];
    for (let n = 0; n < N; n++) {
      this.rpmS += this.aR * (rpmT - this.rpmS);          // per-sample smoothing
      this.thrS += this.aT * (thrT - this.thrS);
      const dTheta = this.rpmS * 6 / sampleRate;          // deg/sample = rpm/60*360/fs
      const prev = this.theta;
      this.theta += dTheta;                               // integrate frequency => continuous phase
      const wrapped = this.theta >= 720; if (wrapped) this.theta -= 720;
      for (let s = 0; s < 6; s++) {                       // crossing test (cheap: 6 compares)
        const a = this.nextAng[s];
        const hit = wrapped ? (a > prev || a <= this.theta) : (a > prev && a <= this.theta);
        if (hit && !this.fuelCut(s)) {
          const c = this.cylOfSlot[s];
          const frac = ((a - prev + 720) % 720) / dTheta;     // sub-sample onset 0..1
          this.trigger(c, frac, this.ampFor(c));             // sets env[c], att[c] (pop logic inside)
          this.nextAng[s] = wrapAngle(this.fireAt[s] + this.imbAng[c] + gauss()*this.jitterDeg());
        }
      }
      const tauD = clamp(0.30 * 20 / Math.max(this.rpmS, 300), 3.5e-4, 4e-3); // 0.3 x firing period
      const kD = Math.exp(-1 / (tauD * sampleRate)), kA = this.kAttack;
      let bankA = 0, bankB = 0, envSum = 0;
      for (let c = 0; c < 6; c++) {
        if (this.env[c] < 1e-5) continue;                 // skip idle cylinders
        this.env[c] *= kD; this.att[c] *= kA;
        const v = this.env[c] * (1 - this.att[c]) * (1 + 0.35 * this.turb());
        envSum += this.env[c];
        if (c < 3) bankA += v; else bankB += v;
      }
      let ex = this.main.tick(this.hdrA.tick(bankA) + this.hdrB.tick(bankB) + this.popOut());
      ex = this.tail.tick(this.muffMix(ex));
      out[0][n] = this.dcEx(ex);                          // exhaust
      out[1][n] = this.dcIn(envSum * this.noise() * this.intakeLvl()); // intake (formants native)
      out[2][n] = this.mech(this.theta);                  // orders 6/9/12 + valve ticks
    }
    return true;
  }
}
```
Notes:
- `rpmS` changes smoothly and `theta` only ever integrates it, so pitch glides never produce phase jumps.
- Envelopes decay naturally when rpm or throttle changes mid-pulse, so nothing is truncated.
- Every helper (`Comb.tick`, `turb`, `gauss`) must be allocation-free.
- Changes to native-node filter frequencies and gains go through `setTargetAtTime` from a ~30 Hz control loop on the main thread.

### 4. CPU estimate
Per sample: about 2 active envelopes, 6 combs (each a read, a write and a one-pole), 3 recursive sines, 2 RNG draws and a few DC blockers, so roughly 80–120 flops. At 48 kHz that is about 5 Mflop/s, well under 5% of one core even on a weak ARM/x86 in plain JS. The native biquads, waveshaper and two compressors add very little. If the Tesla struggles, try these in order:
1. `oversample:'none'`;
2. drop the mechanical sines;
3. run the context at 32 kHz (`new AudioContext({sampleRate: 32000})`), since the highest content needed is ~8 kHz;
4. port to WASM like Antonio-R1 did.

### Sources
- Doerfler & Wyse 2026, PTR model: https://arxiv.org/html/2603.09391 · https://rdoerfler.github.io/ptr-model-page
- Baldan et al. 2015: https://www.researchgate.net/publication/280086598_Physically_informed_car_engine_sound_synthesis_for_virtual_and_augmented_environments
- SDT `SDTMotor` API: https://sdt.lim.di.unimi.it/docs/API/v2.2-078/group__motor.html
- Antonio-R1 engine-sound-generator: https://github.com/Antonio-R1/engine-sound-generator (fork with README: https://github.com/SpudzzDev/en)
- DasEtwas enginesound: https://github.com/DasEtwas/enginesound
- Farnell's warping waveguide, as described in a review: https://arxiv.org/pdf/2604.12878 ; Pd port: https://sccode.org/tag/class/DelayC?by=dsastre
- engine-sim coverage: https://www.thedrive.com/news/new-3d-engine-sim-can-synthesize-super-realistic-exhaust-sounds-in-real-time
- Granular/industry: https://www.audiokinetic.com/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise · https://gdcvault.com/play/1023987/Data-Driven-Granular-Synthesis-for · https://blog.criware.com/?p=2070
- AudioWorklet performance: https://web.dev/articles/profiling-web-audio-apps-in-chrome · https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/
- CrankLab (Web Audio worklet engine demo): https://discourse.threejs.org/t/cranklab-interactive-engine-explorer-with-procedural-geometry-and-sound/95093

---

## §3 Tesla in-car browser: platform constraints for a GPS-driven Web Audio engine sound

Researched 2026-10-27. Confidence tags: **confirmed** (Tesla release notes or manual, or several independent
in-car reports), **likely** (one or two credible developer reports, or follows from Chromium behaviour),
**uncertain** (conflicting or missing evidence, so it must be tested in the car).

Caveat on sources: a lot of the detailed 2026 knowledge comes from developer changelogs and READMEs
(codriver.io, tesbox, teslaradar, tesla-cloud, tesla-video-drive). The tesbox repo's
`docs/research/2026-10-05-platform-research.json` is a secondary compilation, probably AI-assisted. I re-checked
its key claims against the primary pages where I could and say so below.

---

### 1. Browser engine and version; MCU2 vs MCU3

| Firmware | Chromium | Evidence |
|---|---|---|
| 2019.40 (v10) | ~75 | first Chromium browser; earlier cars ran QtCarBrowser/WebKit 534 |
| 2020.x | 79 | UA strings (user-agents.net, trunc.org) |
| 2021.x | 88 | UA `... Chrome/88.0.4324.150 Safari/537.36 Tesla/2021.36.5.5-...` |
| 2022.20 | 100 | UA `... Chrome/100.0.4896.127 ... Tesla/feature-2022.20.9-...` |
| early 2026 | 136 | |
| 2026.14.3 / .6 (Apr 2026) | **140** | release note: "The browser was updated to version 140, up from version 136" (**confirmed**) |
| 2026.26 Summer Update (Jul–Aug 2026) | **148** | codriver measured it; Tesla gave no number (**likely**) |

- Engine: QtWebEngine (embedded Chromium) on x86_64 Linux. Tesla ships months behind upstream Chrome. AudioWorklet
  (Chrome 66+) is therefore in the engine, but **nobody has published an in-car AudioWorklet test** (uncertain).
  It needs HTTPS.
- 2026.26 broke a few things (**likely**, codriver changelog plus tesla-cloud PR #435 and a TMC thread):
  - The `Tesla/<firmware>` UA token was removed, so you can't detect the car from the UA.
  - Default zoom on Model 3/Y went from devicePixelRatio 1.0 to about 1.53. The parked viewport is about 1254×784 CSS px.
  - **The browser window shrinks while driving**: about 773×601 CSS px on 3/Y and 804×638 on the new Model Y. The
    layout must work at that size.
- MCU2 (Intel Atom: 3/Y before about Dec 2021, S/X 2018–21) vs MCU3 (AMD Ryzen: 3/Y from about Dec 2021, refresh
  S/X, Cybertruck): codriver reports about 60 fps WebGL on a 2023 Model Y and 10–35 fps on a 2019 Model 3 or 2017
  Model S. Developers report memory pressure on Intel (teslaradar caps DPR at 1× and cache sizes). Telling them apart
  needs the WebGL renderer string plus screen size, not the UA. Audio DSP cost on the Atom has **not** been measured
  (**uncertain**). Budget conservatively and keep the UI lightweight (no heavy canvas or backdrop-filter while driving).
- Sources: https://www.notateslaapp.com/software-updates/version/2026.14.3/release-notes ·
  https://codriver.io/changelog · https://codriver.io/guides/tesla-browser-summer-2026-update ·
  https://www.notateslaapp.com/news/4621/tesla-adds-bookmark-syncing-larger-content-full-screen-video-and-camera-support-to-browser-in-202626-update ·
  https://user-agents.net/browsers/tesla-car-browser · https://github.com/jonbirge/tesla-cloud/pull/435 ·
  https://www.notateslaapp.com/news/745/tesla-updates-its-browser-with-autocomplete-browsing-history-and-more

### 2. Geolocation

- **Works** over HTTPS with a Chromium permission prompt (**confirmed**). It has existed since firmware 5.9 but has
  broken and been fixed more than once (for example an instant "User denied Geolocation" on 2020.16, fixed in 2022.4.5).
  Every current speed-based Tesla web app depends on it: Rombo, TeslaSound.io, EV·ENGINE, tesbox, codriver.
  Permission is stored **per origin** (`www.` and the bare domain are different origins). If it gets stuck, the user
  resets it from the lock icon in the address bar or checks Controls > Software > Data Sharing (teslasound.io FAQ).
- **Source of the fix:** on AMD cars the browser gets the car's own fused position (GNSS plus wheel odometry, the same
  as the native map). In tunnels it keeps updating as "Position estimated" (**likely**, codriver 20 Sep 2026). On
  Intel MCU2 cars updates **stop** when the satellite fix drops (**likely**).
- **Rate:** about **1 Hz** (**likely**). Rombo, teslasound.io, tesbox and codriver (23 Aug) all say "once a second".
  One codriver entry (27 Oct 2026) says about 10 Hz on MCU2, which conflicts (**uncertain**: measure it).
- **Latency:** teslasound says revs trail speed by about 0.5 s in a Tesla (about 0.25 s of that is audio-system
  latency). tesbox says sudden speed changes arrive 1–2 s late. Both extrapolate between fixes.
- **`coords.speed`:** on AMD/MCU3 cars it holds the car's own speed (**likely**). On some pre-2022 Intel cars it reads
  **0 or null while moving** (**likely**, codriver 11 Aug and 5 Sep 2026; tesbox README: "On MCU2 (Intel) cars, the
  browser gives no usable GPS speed, only positions"). Fallback: work out speed from haversine distance between fixes
  over time, and filter parked jitter (codriver had to stop GPS noise from reading as walking pace).
- **`coords.accuracy`:** no published values (**uncertain**). Log it.
- **watchPosition stability:** teslaradar and tesla-cloud report watchPosition (and DeviceOrientation) **crashing
  the Tesla tab** on highway drives. They poll `getCurrentPosition` every 2–4 s instead (**uncertain**: the reports
  are from 2026 but anecdotal, and 2–4 s polling is far too slow for engine sound). Plan: use watchPosition with a
  watchdog, and if no fix arrives for more than about 3 s, fall back to `getCurrentPosition` with maximumAge 0 on a
  1 s timer.
- Per the W3C spec, geolocation updates **stop while the document is hidden**. tesbox confirms this happens when the
  map goes full-screen or the camera opens.
- Old bug: ABRP lost the car's position when the native navigation started (2023.26.7). It is closed, but check for it.
- Sources: https://codriver.io/changelog · https://github.com/Atvriders/tesbox ·
  https://github.com/chrisremboldt/teslaradar · https://github.com/jonbirge/tesla-cloud ·
  https://teslasound.io/ · https://getrombo.com/ · https://www.w3.org/TR/geolocation/ ·
  https://abrp.featurebase.app/p/tesla-gps-location-does-not-refresh-in-built-in-browser-2 ·
  https://teslatap.com/desired-features/support-geolocation-api-in-browser/

### 3. Audio

- **Plays while in Drive and moving** (**confirmed**). Video *pictures* are suppressed in Drive (the `<video>` pauses
  or freezes and a banner reads "only audio can be played"), but audio continues. tesla-video-drive says "Tesla
  doesn't block audio". Music Assistant users stream music while driving. Canvas and WebGL are not suppressed.
- **Output:** cabin speakers, through the car's media channel and volume (**confirmed**). It **cannot** use the
  external Pedestrian Warning System or Boombox speaker. Boombox has been Park-only since the Feb 2022 NHTSA recall of
  578,607 cars (FMVSS 141).
- **Car-side processing:** the manual says media volume "may be adjusted based on your driving speed and climate
  settings" (speed-dependent gain sits on top of ours), and that volume may dip briefly when shifting into Reverse.
  The user's EQ and subwoofer settings probably apply too (**likely**).
- **Autoplay:** an AudioContext starts `suspended` until a user gesture, so call `resume()` inside a tap handler
  (**confirmed**: Chromium policy, and every Tesla engine app has a "Start engine" button). There's no PWA install,
  so the install-based autoplay exemption doesn't apply. **After any reload, audio needs another tap.**
- **Interaction with other media:** the owner's manual says browser audio is its own media source, shows in the
  Miniplayer, and "if other media was playing before browser audio started, the media resumes after you pause or end
  browser audio". Starting our engine therefore probably **pauses the user's Spotify, radio or Bluetooth** (tesbox
  README agrees: "the car's music pauses while Tesbox plays"). **Conflict:** teslasound.io claims "Your music or radio
  keeps playing alongside the engine sound". The difference may depend on HTMLMediaElement vs pure Web Audio, or on
  firmware (**uncertain**: top test item). In the other direction, starting another source (or a Bluetooth phone
  taking over) probably pauses or kills browser audio. tesbox shows "Tap to resume" when that happens. One guide also
  says a phone on Bluetooth "can override the audio".
- **Navigation prompts and ducking:** no evidence found either way (**uncertain**). Nav voice has its own volume
  slider. Test whether nav prompts duck the browser, mute it, or speak over it.
- **Steering-wheel buttons:** the left scroll wheel's press and tilt send play/pause and prev/next to the active media
  source. tesbox and TeslaSound map tilt or scroll to gear shifts, but whether the buttons reach
  `navigator.mediaSession` handlers is not documented (**uncertain**). A press could **pause our engine**.
- Stability: Music Assistant's Web Audio player had buffer-underrun crackle in the Tesla browser (Dec 2025), fixed in
  the app by Apr 2026. Use a generous `latencyHint` ('playback') and keep worklet CPU low.
- Sources: https://github.com/Dailroy/tesla-video-drive · https://github.com/orgs/music-assistant/discussions/4563 ·
  https://teskas.net/t/topic/16892?tl=en · https://www.tesla.com/ownersmanual/modely/en_us/GUID-7A85FB6B-9DF6-4C55-A2F9-793207E48E9D.html
  (archived: https://web.archive.org/web/20250319094023/https://www.tesla.com/ownersmanual/modely/en_us/GUID-7A85FB6B-9DF6-4C55-A2F9-793207E48E9D.html) ·
  https://electrek.co/2022/02/10/tesla-disable-boombox-when-drive-nhtsa-safety-risk/ ·
  https://developer.chrome.com/blog/autoplay · https://www.technologybloggers.org/t/

### 4. Is the browser usable while driving?

- **Yes, with restrictions** (**confirmed**). The browser opens and runs in Drive: no full-screen, video picture
  blocked, smaller window. Theater and Arcade are blocked in motion, and the Fullscreen and "go full screen" buttons
  only work in P. The manual warns against using the touchscreen while moving. Old forum reports of the browser
  "disappearing" on shifting to Drive: the user can bring it back.
- Recent changes: 2024.14 added a full-screen button (Park). 2026.14 brought Chromium 140. 2026.20 added **Parental
  Controls that can block the browser** with a PIN. 2026.26 changed zoom and UA, added camera and mic (camera
  Park-only, AMD only), and auto-full-screen for some streaming sites in Park. 2026.32 added an optional ad blocker
  that strips third-party scripts (so self-host everything). 2026.38 blocked the rear-screen browser streaming
  workaround. Tesla has **no developer terms** for browser apps and could restrict them later (**uncertain**).
- Sources: https://www.notateslaapp.com/news/4226/tesla-improves-parental-controls-in-update-202620 ·
  https://www.notateslaapp.com/news/4671/tesla-adds-ad-blocker-to-browser-in-update-202632 ·
  https://www.notateslaapp.com/news/4821/tesla-blocks-rear-screen-browser-workaround-for-unsupported-streaming-apps ·
  https://teslamotorsclub.com/tmc/threads/model-3-browser.293362/ ·
  https://autoedgeview.com/ev-reviews/tesla-internet-browser-ev-infotainment-guide

### 5. Minimise, other apps, sleep, throttling

- "Minimised" covers several cases: the user opens another app, the **reverse camera** comes up (every time you shift
  to R), or the **map goes full-screen**.
- **Official manual:** audio played in the browser continues in the background when the browser is minimised and can
  be controlled from the Miniplayer.
- **Field reports conflict.** teslasound.io: "The sound stops when the browser goes to the background". Rombo: "keep
  the browser open". tesbox: "the car may stop audio … with the map full screen or the camera up, the engine idles or
  stops". A Pandora user on Model 3 had audio stop on minimise. webspeak3 #8 (Model Y, Sep 2026): Web Audio and WebRTC
  output **stopped** on minimise and the radio took over, while Discord Web kept playing.
- **Best hypothesis** (webspeak3 author, *not yet confirmed in the car*): Tesla keeps browser audio alive in the
  background only if Chromium exposes a **controllable media session**, which is what puts the page in the
  Miniplayer. Pure Web Audio and WebRTC output counts as "one-shot" and isn't controllable. A file-backed `<audio>`
  element becomes controllable only if it's **longer than 5 s**, so a 1 s silent loop failed. The suggested fix is a
  looping near-silent `<audio>` file longer than 5 s, plus `navigator.mediaSession` play/pause handlers (**uncertain**).
- Even if audio survives, geolocation stops while hidden (spec, plus tesbox). So the engine has no speed input while
  minimised: freeze RPM or decay to idle, and resync on `visibilitychange`.
- **Timers:** Chromium throttles hidden-page timers to 1 s (and to 1 min after 5 min hidden and silent; audible pages
  are exempt). Run DSP in the AudioWorklet or in scheduled audio params, not in main-thread `setTimeout`.
  `requestAnimationFrame` stops when hidden.
- **Reloads:** developers report the page **reloading mid-drive** (codriver, several entries, including a reload when
  the car switches between day and night themes, which they had to work around). After sleep or a firmware update,
  expect a cold start. Persist settings, and after a reload show one big "Tap to restart engine" button, since
  autoplay rules block automatic resume (**likely**).
- Sources: https://github.com/Moepchi/webspeak3/issues/8 · https://community.pandora.com/t5/Automotive/Tesla-Browser-Can-it-run-pandora/td-p/91626 ·
  https://teslasound.io/ · https://getrombo.com/ · https://github.com/Atvriders/tesbox ·
  https://developer.chrome.com/blog/timer-throttling-in-chrome-88 · https://codriver.io/changelog

### 6. Screen Wake Lock and dimming

- No Tesla-specific evidence about `navigator.wakeLock` (**uncertain**). It's in Chromium 84+, so the call probably
  exists. Feature-detect it and ignore failures.
- The touchscreen stays on while the car is in Drive, and brightness follows the car's auto and night setting, not the
  page (**likely**, from general Tesla behaviour; nothing documents a browser API). In Park, the screen turns off on
  the car's own idle and Energy Saving schedule, which wake lock probably can't override (**uncertain**). Wake lock
  doesn't matter for the driving use case.

### 7. localStorage, cache, service workers

- **localStorage persists across drives** in practice: teslaradar keeps its last GPS fix and preferences, and
  tesla-cloud keeps device data (**likely**). The owner can wipe it via Clear Browser Data. Storage is per origin, so
  keep one canonical host.
- **HTTP cache:** tesbox reports a long-lived HTML cache and adds `?b=<sha>` to bust it (**likely**). Send
  `Cache-Control: no-cache` on `index.html` and use hashed asset names.
- **Service workers:** unverified in the car (**uncertain**). Production Tesla apps (codriver, teslas.cloud,
  teslabrowserapps, teslaradar) ship none. TeslaSound (aranelpalantir) and tesbox ship one but treat it as optional, and
  tesbox's diagnostics report `registered` or `unsupported`. Connectivity is needed for first load: Wi-Fi, a hotspot,
  or Premium Connectivity (**confirmed**). Once loaded, a running engine needs no network, because GPS is local.
- Sources: https://github.com/chrisremboldt/teslaradar · https://github.com/jonbirge/tesla-cloud ·
  https://github.com/aranelpalantir/TeslaSound · https://github.com/Atvriders/tesbox

### 8. Known workarounds used by Tesla web apps

- **Full screen:** the `youtube.com/redirect?q=<url>` interstitial trick ("Go to site" opens full-screen) and the
  "ABetterTheater" wrappers. Both work only in **Park**, are partly broken, and don't help in Drive, where the window
  shrinks anyway. Not worth relying on. (https://alvarotrigo.com/blog/tesla-model-y-browser/ ·
  https://getchannels.com/2020/01/22/watch-in-tesla)
- **Keeping audio alive:** a looping silent or near-silent `<audio>` file **longer than 5 s** plus Media Session
  handlers, to get a Miniplayer entry and background survival (webspeak3 hypothesis, **uncertain**). A 1 s silent loop
  is reported **not** to work. Another option worth testing: route the Web Audio graph through
  `MediaStreamAudioDestinationNode` into an `<audio>` element (unknown whether Tesla treats that as controllable).
- **Keeping the page in front:** every engine-sound app says to start it **while parked** and leave the browser in
  front. Rombo and teslasound also offer a parked "test drive" or demo mode.
- **GPS robustness:** extrapolate between 1 Hz fixes. Derive speed from positions when `coords.speed` is 0 or null.
  Filter parked jitter. Watchdog the fixes. Store the last fix in localStorage.
- **Rendering:** DPR capped at 1×, no backdrop-filter, minimal DOM updates (MCU2).
- **Updates:** check for a new build at start and every 30 min, and prompt only when parked with the engine off (tesbox).

### 9. Existing engine-sound apps and Tesla's own features

- **Tesla Boombox:** external speaker, custom sounds. Park-only since the 2022 recall. There is no engine-sound
  feature in Tesla's native software. Ioniq 5 N "N Active Sound+" is the OEM reference.
- **Commercial or hosted web apps:** Rombo (getrombo.com: GPS, virtual gearbox, trim selection, lookahead smoothing),
  TeslaSound.io (V8/V12/flat-six, free for 5 min a day, ~0.5 s lag, "keep the page open"), EV·ENGINE (ev-engine.com),
  EngineV1 (evenginev1.com). EV Sound FX (evsoundfx.com) is a hardware product.
- **Open source:** Atvriders/tesbox (in-car probe page plus detailed in-car checklist, the best reference for test
  design). starbadboy/engine-sound (AudioWorklet synthesis). alexmiguel19/tesla-sound (AudioWorklet, firing order).
  aranelpalantir/TeslaSound (60 FPS physics loop, service worker, steering-wheel gear shift).
  ogcastaneda-crypto/teslaenginesound.
- **What they've learned:** HTTPS required. Tap to start. About 1 Hz GPS with 0.5–2 s lag, so smooth and predict.
  Audio stops or is at risk when the browser goes to the background. Set up while parked. Speed is broken on MCU2.
  Volume masks sirens, so keep it sensible.

---

### In-car test checklist (unknowns to resolve)

1. UA, Chromium version, WebGL renderer, DPR, and viewport (parked vs driving) on each test car (MCU2 and MCU3).
2. AudioWorklet loads and runs glitch-free for 30 min in Drive; check CPU headroom on MCU2.
3. Geolocation: fix interval (Hz), `coords.speed` populated or 0/null, `accuracy` values, behaviour in tunnels,
   watchPosition stability over a 30+ min highway drive.
4. Does starting the engine **pause the user's music**, or does it mix? Does starting Spotify, radio or Bluetooth
   kill the engine? Does a phone call stop it?
5. Do nav voice prompts duck, mute, or talk over the engine?
6. Shift to **R** (camera full-screen), open the full-screen map, open another app: does audio continue? Does the
   Miniplayer show it? Compare (a) pure Web Audio, (b) a >5 s silent `<audio>` loop plus Media Session,
   (c) MediaStreamDestination into `<audio>`.
7. Do fixes arrive while hidden? Is the 1 s timer throttling observed?
8. Steering-wheel press and tilt: does it pause the page or call mediaSession handlers?
9. Mid-drive reload frequency, and restore-after-reload UX (tap to resume).
10. localStorage and service worker survive overnight sleep and a firmware update.
11. Wake lock call accepted? (Low priority.)
12. Car's speed-dependent volume: does the perceived engine level rise or fall with speed?

---

## §4 Freely licensed Porsche engine recordings (for an optional sample layer)

Researched 2026-10-27. I opened every link below and checked the license, author and duration against the live page: the Freesound sound page, or the Wikimedia Commons file metadata through the Commons API. **No audio was downloaded.** You need to download the files yourself. Freesound needs a free account to download.

Rating scale ("Loop" column) for building RPM-tagged loops:
- ★★★★★ clean stationary rev sweep or steady-RPM holds, close mic
- ★★★★ stationary revs or close-mic idle, but short, or with some noise or a stated low RPM range
- ★★★ usable fragments: idle only, or onboard with gear changes; needs manual slicing
- ★★ drive-by or pull-away; Doppler and distance make it hard to tag
- ★ ambience or trackside mix; reference listening only

"NC" = NonCommercial. That's fine for a personal app, but it's **flagged**.

### Candidate table

| # | Title | Author | License (exact) | Link | Dur. | Contents | Car (as stated) | Loop |
|---|---|---|---|---|---|---|---|---|
| 1 | Porsche 911 GT3 RS (991) - engine and exhaust sound (YouTube otznJ2rBoks) | Automotion Media (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_RS_(991)_-_engine_and_exhaust_sound_(YouTube_otznJ2rBoks).opus | 2:30 | Start-up, stationary revs, then hard acceleration (source title: "StartUp, Revs, CRAZY Acceleration!") | 991 GT3 RS, 4.0 NA flat-six | ★★★★ |
| 2 | Porsche 718 Cayman GT4 - engine and exhaust sound (YouTube kkIs6pcgVBo) | Automotion Media (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_718_Cayman_GT4_-_engine_and_exhaust_sound_(YouTube_kkIs6pcgVBo).opus | 1:41 | Nürburgring testing: drive-bys and full-throttle pulls | 718 Cayman GT4, 4.0 NA flat-six | ★★ |
| 3 | Porsche 992 - engine and exhaust sound (YouTube PqvY5ONBjxw) | Mr.Alexandre (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_992_-_engine_and_exhaust_sound_(YouTube_PqvY5ONBjxw).opus | 0:48 | Revving / acceleration (source title: "Porsche 911 GT3 992 Insane sound") | 992 GT3 | ★★★ (listen first) |
| 4 | Porsche 911 GT3 RS - engine and exhaust sound (YouTube 1t2wz1iLHJ4) | Supercars67 (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_RS_-_engine_and_exhaust_sound_(YouTube_1t2wz1iLHJ4).opus | 5:11 | "HARD Driving SOUND": track/road passes and pulls | 2019 991.2 GT3 RS | ★★ |
| 5 | Porsche 911 GT3 RS - engine and exhaust sound (YouTube hpwTF8TXcaA) | NEW CARS 2015 Official (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_RS_-_engine_and_exhaust_sound_(YouTube_hpwTF8TXcaA).opus | 1:53 | "On Hot Road - Sound Exhaust": driving / exhaust | 911 GT3 RS (generation not stated, probably 991) | ★★ |
| 6 | Porsche 911 GT3 (997) - engine and exhaust sound (YouTube 3WHXKH_Ouc) | ProRallyVids (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_(997)_-_engine_and_exhaust_sound_(YouTube_3WHXKH_Ouc).opus | 7:32 | Rally stage passes at full throttle, gravel/tarmac | 997 GT3 rally car | ★ |
| 7 | Porsche 911 GT3 (997) - engine and exhaust sound (YouTube Eh89UkPfUfA) | CARSMANIA (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_(997)_-_engine_and_exhaust_sound_(YouTube_Eh89UkPfUfA).opus | 8:12 | Rally stage passes at full throttle | 997 GT3 rally car | ★ |
| 8 | Porsche 991 - engine and exhaust sound (YouTube dIqHpt2gySA) | ThePetrolHeart (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_991_-_engine_and_exhaust_sound_(YouTube_dIqHpt2gySA).opus | 0:50 | Exhaust sound check (start-up / revs) | 991 Carrera S with PSE sport exhaust, 3.8 flat-six | ★★★ |
| 9 | Porsche 996 - engine and exhaust sound (YouTube axY2PGvMPdk) | Robin (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_996_-_engine_and_exhaust_sound_(YouTube_axY2PGvMPdk).opus | 4:39 | "PURE exhaust sound": start-up, revs, driving | 996 Carrera, NA flat-six | ★★★ |
| 10 | Porsche 911 GT2 - engine and exhaust sound (YouTube JyuTsneBJy8) | timur_kiev_carspotter (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911_GT2_-_engine_and_exhaust_sound_(YouTube_JyuTsneBJy8).opus | 0:57 | "Start Up and Revs!!": stationary | 991.2 GT2 RS Weissach (twin-turbo flat-six, so the timbre differs from a GT3) | ★★★★ |
| 11 | Porsche 997 GT3 RS | Edvvc | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_997_GT3_RS.ogg | 0:11 | Launch / pull-away from the start line, Goodwood FoS hillclimb 2010 | 2009 997 GT3 RS | ★★ |
| 12 | 2006 Porsche Cayman S engine sound | John64 | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:2006_Porsche_Cayman_S_engine_sound.wav | 0:33 | **Onboard, car-mounted mic**: brisk acceleration from standstill to highway speed, through the gears | 2006 987 Cayman S, 3.4 flat-six | ★★★ |
| 13 | vehicle car porsche 911 revving engine motor boxer | jerry.berumen (Freesound) | Attribution 4.0 (CC BY 4.0) | https://freesound.org/people/jerry.berumen/sounds/772802/ | 0:53 | **Stationary revving** at a dealership, Sony PCM-A10 | Porsche 911 (generation not stated) | ★★★★★ |
| 14 | porsche001.wav | djbono (Freesound) | Sampling+ (CC Sampling Plus 1.0) | https://freesound.org/people/djbono/sounds/18773/ | 0:03 | **Stationary rev sweep 600 → 5200 rpm**, SM58 mono next to the tailpipes | 1989 911 (911T per uploader), air-cooled flat-six | ★★★★ (RPM range documented; very short) |
| 15 | porsche002.wav | djbono (Freesound) | Sampling+ (CC Sampling Plus 1.0) | https://freesound.org/people/djbono/sounds/18774/ | 0:02 | **Stationary rev sweep 600 → 5600 rpm**, same setup | 1989 911 | ★★★★ |
| 16 | Porsche 911 GT3 Cup Car Engine Ticking Over | FritzSounds (Alex Fritz) | Attribution NonCommercial 4.0 (CC BY-NC 4.0), **NC** | https://freesound.org/people/FritzSounds/sounds/570258/ | 0:16 | **Idle** in the pit lane, stereo clip mics | 911 GT3 Cup race car | ★★★★ (idle loop) |
| 17 | Porsche 911 GT3 Cup Car Leaving Pitstop | FritzSounds | CC BY-NC 4.0, **NC** | https://freesound.org/people/FritzSounds/sounds/570255/ | 0:09 | Pull-away from the pits | 911 GT3 Cup | ★★ |
| 18 | Porsche 911 GT3 Cup Car Approaching A Tight S Bend | FritzSounds | CC BY-NC 4.0, **NC** | https://freesound.org/people/FritzSounds/sounds/570257/ | 0:22 | Trackside: approach, lift/downshift, full-throttle exit (stereo pan) | 911 GT3 Cup | ★★ (good for overrun/downshift FX) |
| 19 | Porsche 911 GT3 Cup Car Approaching Corner | FritzSounds | CC BY-NC 4.0, **NC** | https://freesound.org/people/FritzSounds/sounds/570254/ | 0:23 | Trackside drive-by, L→R | 911 GT3 Cup | ★★ |
| 20 | Porsche idle.aif | victormalloy (Freesound) | Creative Commons 0 (CC0 1.0) | https://freesound.org/people/victormalloy/sounds/113216/ | 0:17 | **Idle**, 96 kHz | "Porsche" (model not stated) | ★★★★ (CC0 idle loop) |
| 21 | Porsche Exhaust.aif | victormalloy | CC0 1.0 | https://freesound.org/people/victormalloy/sounds/113214/ | 0:33 | Exhaust recording, 96 kHz (same pack as #20: "Porsche fire ignition" /113215/, "Porsche off growl" /113217/, "Ignition Porsche growl 3" /113199/) | "Porsche" | ★★★ |
| 22 | porsche 911 carrera s autobahn.mp3 | mrpeet (Freesound) | CC BY-NC 4.0, **NC** | https://freesound.org/people/mrpeet/sounds/148780/ | 0:41 | **Onboard / interior** on the Autobahn up to full speed | 2011 997.2 Carrera S | ★★ (cabin noise, wind) |
| 23 | Sports car starting | Urbandroid (Freesound) | CC BY-NC 4.0, **NC** | https://freesound.org/people/Urbandroid/sounds/400871/ | 0:10 | Cold start + idle, Zoom H6 | Porsche Boxster S | ★★★ |
| 24 | Porsche.MP3 | mmplisskin (Freesound) | CC0 1.0 | https://freesound.org/people/mmplisskin/sounds/90404/ | 0:08 | Engine revving (tagged "revving") | "Porsche" (model not stated) | ★★★ |
| 25 | porsche_911.wav | mharo (Freesound) | CC0 1.0 | https://freesound.org/people/mharo/sounds/55727/ | 0:10 | Street recording, likely a pass-by | Porsche 911 | ★★ |
| 26 | S07-11 1972 Porsche in fast; idle; stop.wav | craigsmith (Freesound) | CC0 1.0 | https://freesound.org/people/craigsmith/sounds/675268/ | 0:15 | Arrive fast, idle, shut-off (vintage optical/mag film SFX) | 1972 Porsche (likely 911) | ★★ |
| 27 | PORSCHE 912 engine sound after 9 years of restauration (imperfect) | vukongs (Freesound) | CC0 1.0 | https://freesound.org/people/vukongs/sounds/808983/ | 1:32 | Stationary running engine, wind pops at 0:04 and 0:09–0:10 | Porsche 912 (**flat-four**, not a flat-six) | ★★★ |
| 28 | Porsche 718 Cayman GTS - engine and exhaust sound (YouTube 8jk6DNg59o0) | Life In Motion (YouTube), on Commons | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_718_Cayman_GTS_-_engine_and_exhaust_sound_(YouTube_8jk6DNg59o0).opus | 10:00 | Review-style sound check; start-up, revs, driving | 718 Cayman GTS (engine not stated: 2018 GTS is a 2.5 turbo **flat-four**, 2020+ GTS 4.0 is a flat-six; check) | ★★★ |
| 29 | Porsche 911R (1967) | Edvvc | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Porsche_911R_(1967).ogg | 0:22 | Pull-away from the start, Goodwood FoS 2009 | 1967 911 R | ★★ |
| 30 | Moscow Raceway GT Race sounds | Walking.With.Microphones (Freesound) | CC0 1.0 | https://freesound.org/people/Walking.With.Microphones/sounds/556039/ | 0:57 | Trackside GT3 field; pass #16 is a Porsche 997 GT3-R | 997 GT3-R (one pass among many cars) | ★ |

Excluded after checking: the Porsche Cayenne clips by Robo9418 (CC0; V6/V8, not a flat-six), "Porsche 928 sounds" (V8, BY-NC), the BBC Sound Effects archive (its only Porsche entries are 31 clips of a **1979 Porsche 924**, which is inline-4; RemArc personal/educational license), the Boxster GTS / 718 (2018) Commons clips (turbo flat-four), and generic "sports car" passes such as the kevp888 balcony recordings, where no model is identified.

### Top picks for RPM-tagged loops

1. **#13 jerry.berumen, "porsche 911 revving" (CC BY 4.0)**: 53 s of stationary revving recorded close on a PCM-A10. This is the best single source for slicing RPM holds, with a non-NC license.
2. **#14/#15 djbono 911 rev sweeps (Sampling+)**: the uploader documents the RPM range (600→5200 and 600→5600 rpm), so you can tag RPM directly. They are short, mono and air-cooled, and the sweeps stop well short of a GT3's redline. Pitch-shifting or time-stretching will be needed above roughly 5.5k.
3. **#1 991 GT3 RS start-up and revs (CC BY 3.0)**: the right engine (4.0 NA, 9k rpm), with a stationary rev section before the acceleration. It's YouTube-derived (lossy Opus) and may include talking or crowd noise.
4. **#16 FritzSounds GT3 Cup idle (CC BY-NC 4.0)**: a clean, close-mic idle from a GT3-family flat-six, ideal for the idle loop. NC.
5. **#20 victormalloy "Porsche idle" (CC0)**: a 96 kHz idle with no attribution needed. Use it as a fallback idle layer when you want zero license strings.

Also worth a listen: #12 (Cayman S onboard sweep through the gears, BY-SA), #10 (GT2 RS stationary revs), #2 (GT4 4.0, the closest engine to a GT3 in a 718).

### Attribution and license notes

- **CC0 (Freesound #20, 21, 24–27, 30)**: no attribution required. Credit is courteous but optional.
- **CC BY 3.0 / 4.0 (Freesound #13; Commons YouTube-derived #1–10, 28)**: you must credit the author, give the title and a link to the source, name the license with a link, and say whether you changed the file (e.g. "sliced/looped"). A suggested format: `"<title>" by <author>, <source URL>, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); trimmed and looped.` For the Commons YouTube extracts, credit the **YouTube channel** named in the table. The Commons page links the original video and an archive.org snapshot of the CC-BY tag. The license comes from the YouTube uploader's CC-BY setting, so it's only as reliable as that upload. Before relying on one, check the archived snapshot linked on the Commons page.
- **CC BY-SA 3.0 (Commons #11, 12, 29)**: attribution as above. **ShareAlike**: if you distribute the adapted audio (e.g. your loops), you must release it under BY-SA too. For a purely personal app that you don't distribute, this doesn't come into play.
- **CC BY-NC 4.0 (FritzSounds #16–19, mrpeet #22, Urbandroid #23), NC flag**: attribution plus **no commercial use**. FritzSounds asks for this exact credit: *"Porsche 911 GT3 Cup Car Engine Ticking Over provided by Alex Fritz @ https://freesound.org/people/FritzSounds/"*. They also sell a paid royalty-free licence if you ever need commercial use.
- **Sampling+ (djbono #14, 15)**: this is a retired CC license (Sampling Plus 1.0). It allows sampling and transforming the clip into a new work, including commercially, with attribution. Noncommercial copying of the whole clip is also allowed. Advertising use is not allowed. Credit "djbono (freesound.org)".
- **Freesound in general**: you need to log in to download. The license shown on each sound page is authoritative, and Freesound's "Attribution list" under your profile can generate the credits for everything you download.
- **Sources with nothing usable**: Pixabay sound-effects search returned HTTP 403 to automated fetches, so I couldn't verify any Porsche clips there. Check it by hand at https://pixabay.com/sound-effects/search/porsche/ (Pixabay Content License: free, no attribution, but no redistributing the files on their own). archive.org had only podcasts and no Porsche engine audio. The Sonniss GDC free bundles are royalty-free, but I found no Porsche-specific files I could verify. Sonniss's Porsche library ("Porsche 911 ST 1972", Pole Position) is a paid product.
