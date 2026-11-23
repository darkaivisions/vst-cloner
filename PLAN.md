# Plan: VST-Cloner (making effect plugins usable on Linux)

As of: 16 Nov 2026 (revised: original plan compared with what has been achieved)

## Goal
Use bought Windows effect plugins on Linux:
1. First check whether the original runs via **yabridge + Wine** (best solution, 100 % sound fidelity).
2. If not (iLok/PACE, crashes, CPU, GUI): measure the plugin by **black-box capture**,
   save it as an open profile (`.vcprofile`) and build a **free clone** (LV2/VST3/CLAP) from it.

Private use. No rewriting of decompiled code, no extraction of samples/assets.

## Principles
- **Black box first:** the clone is based on measured sound behaviour, not on code.
- **Clean-room separation:** REA provides only metadata/a functional specification (text, no code).
  The code-generating agent never gets decompiled code in its context (enforced technically).
- **Profiles are reusable:** capture once, rebuild as often as you like.
- **Platforms:** capture on Windows (licence/copy protection work natively) or on Linux via yabridge.
  Analysis, clone building and use on Linux (Windows supported as well).
- **Every clone is measured:** the finished clone goes through the same measurements as the original;
  part of the measurements (random combinations) serves only as a cross-check and is never used for fitting.

## Workflow
```
Windows PC (plugin licensed)           Linux PC
┌─────────────────────────┐  .vcprofile ┌───────────────────────────┐
│ Capture host            │ ──────────► │ App: analysis + clone     │
│ measures plugin offline │             │ build (VST3/LV2),         │
└─────────────────────────┘             │ comparison with the       │
                                         │ measurements              │
                                         └───────────────────────────┘
```

## Architecture
```
┌──────────── UI: Tauri v2 (Rust + web) ─────────────┐
│ Choose plugin → measure → clone · library · AI     │
└──────────────────────┬─────────────────────────────┘
                       │ JSON lines (jobs, progress, cancel)
┌──────────────────────▼─────────────────────────────┐
│ bridge (Node/TS)                                   │
├────────────┬───────────────────────┬───────────────┤
│ capture    │ clone                 │ agent         │
│ plan,      │ path A: fit + fixed   │ LLM providers,│
│ profile    │         C++ engine    │ roles         │
│            │ path B: builder agent │ (for path B)  │
│            │         + Faust (M7)  │               │
└─────┬──────┴──────────┬────────────┴───────────────┘
      │ stdio/JSON      │ CMake
┌─────▼──────────┐ ┌────▼─────────────────────────┐
│ vch-host,      │ │ plugin-template/<class>      │
│ vch-gui        │ │ C++/JUCE engine + model as   │
│ C++ / JUCE 9   │ │ data → VST3 + LV2            │
└────────────────┘ └──────────────────────────────┘
```

### Two paths to a clone
- **Path A – fixed engines (built):** for every effect class there is a parametric model, a
  deterministic fit in TypeScript (worker threads) and a C++/JUCE engine that computes sample-exactly like the
  TypeScript reference and receives the model as a data file. Fast (seconds to a few minutes),
  without an LLM, reproducible. Covers EQ, dynamics, distortion, delay and reverb.
- **Path B – universal clone (built, milestone 7):** for every plugin, whatever it is: a recurrent network
  conditioned on all controls (LSTM + FiLM) is trained with PyTorch on the GPU from measurements in which all
  controls are set at random, and runs in a C++ template that matches the PyTorch model exactly. Covers what no
  fixed engine covers – plugins without a class, multiband compressors, dynamic EQs, filters, bitcrushers,
  multi-effects – and is the fallback when path A only delivers "inaccurate".
- **Path C – builder agent (later):** an agent writes Faust code from `spec.md` and the measurements and
  improves it in a loop – readable, editable DSP where a network is not wanted.

### Components
- **UI:** Tauri v2 (`apps/desktop`): clone, library, AI models, live log.
- **bridge:** JSON-lines interface between the UI and the packages (jobs with progress/cancel).
- **vch-host / vch-gui:** C++20 with JUCE 9. Deliberately "dumb": loads a plugin, reads parameters, renders
  WAV input → WAV output per parameter set; `vch-gui` opens editors invisibly (Xvfb) and takes screenshots.
- **capture (Node/TS):** test signals (deterministic), measurement plan, driving vch-host, profile, CLI `vch`,
  plugin scanner.
- **clone (Node/TS):** measurement plans, fits, comparison and code generators per class (`eq/`, `dynamics/`,
  `distortion/`, `delay/`, `reverb/`), editor analysis (`gui/`), classification and batch run.
- **plugin-template:** C++/JUCE engines per class, shared parameter logic and clone editor in `common/`.
- **agent (Node/TS):** Vercel AI SDK for all LLM providers, later an MCP client for REA.
  Two separate roles: `analyst` (may use REA, produces `spec.md`) and
  `builder` (sees only `spec.md`, parameters, captures, metrics). So far only the setup, not yet part of the
  clone pipeline.
- **dsp/:** Faust templates (path B) and NAM training (milestone 5c) – still empty.
- TypeScript runs without a build step directly with Node ≥ 22.18 (type stripping).

## LLM integration
- Providers: OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter (cloud);
  Ollama, LM Studio, llama.cpp server, vLLM (local, OpenAI-compatible, auto-discovery).
- Model choice per role (e.g. analysis locally, code generation in the cloud).
- Capability test during setup: tool calling, context length, structured output.
- Token/cost display per job, API keys in the OS keychain (libsecret / Windows Credential Manager).
- REA bundled as a pinned version, update check via `rea update` (REA needs Node ≥ 22.23.4).

## Effect classes and methods
Classification by rules (`classifyPlugin`: parameter names, category, name), one place for the app and batch.
Instruments, multiband compressors and dynamic EQs deliberately get no class. Where the rules find
nothing, the LLM will decide later (milestone 7).

| Class | Measurement | Model (path A) | Status |
|---|---|---|---|
| EQ / filter | impulse response per band group and filter shape × frequency × gain × Q, plus several bands at once | biquad chain, elliptic brickwall slopes, fitted Q curve; bands with a fixed shape and sliders of graphic EQs: shape, frequency, Q and gain scale from the measurement | ✔ – open: linear phase |
| Compressor / limiter | level staircase, bursts, long pauses, 100 Hz steps, noise | detector (RMS/peak, FF/FB), curve with knee, attack/release, opto memory, saturation | ✔ |
| Gate / expander / ducker | like compressor | expander curve with range, inverted curve | ✔ |
| Distortion (pedals) | sine level staircases at several frequencies, noise, quiet sweep | Wiener-Hammerstein (pre-filter → clipping → post-filter) | ✔ – 73 plugins in the batch, 46 good or better |
| Amp / tape | noise + music over a parameter grid | NAM / RTNeural LSTM, parameter-conditioned | open (5c) |
| Delay / echo | impulse with long silence, noise burst | delay line with feedback, low-/high-pass in the loop and in the wet path | first version |
| Reverb | impulse and decay | FDN behind a pre-delay; level and decay time in three bands | first version |
| Modulation (chorus, flanger, phaser, tremolo) | long sweeps, LFO detection | – | open (6b) |
| everything else | universal plan: all controls at random, noise/sweeps/level steps/burst/impulse | path B: conditioned LSTM (FiLM), trained on the GPU | ✔ first version – GxBoss DS1 3.8 % error on unseen combinations, MaBitcrush 10 % |

- **Parameter grid:** single-parameter sweeps + random combinations as a cross-check; per control a table
  onto the model values (PCHIP), interactions (e.g. automatic make-up) as terms of their own.
- **Switches:** up to four positions get a model of their own, including its structure, when needed.
- **Working point probe:** the measurement plan looks for a setting in which the effect audibly works
  (compressor compresses, delay has an echo).
- **DAW compatibility:** the clone keeps parameter names and ranges (automation/projects carry over).

## Agent loop (builder, path B)
1. Generate Faust code (or a model config) from `spec.md` + measurements
2. Compile (errors go back to the agent)
3. Render with identical test signals
4. Metrics per parameter point: ESR, spectral distance (multi-resolution STFT), level/latency alignment;
   for plugins with a class also the metric of the class (as in path A, so that both paths are comparable)
5. Iterate until a threshold or the maximum number of iterations; quality report into the profile

Experience from milestone 3: Faust compiles slowly (≈ 11 s per EQ band). The loop therefore needs
small compilation units and a cache.

## Quality assurance
- **`vch batch --class <class>`** measures and clones every installed plugin of a class (currently 339 plugins,
  time limit 15 min per plugin, report `report.md`/`report.json`, resumes after a cancel). Serves as a
  regression test: every change to a fit or model is checked against the whole collection.
- **Metrics:** "clone vs. original" (all measurements) and "unseen combinations" (cross-check only).
  Rating in five levels from "excellent" to "inaccurate"; thresholds per class.
- Clones that output NaN or whose measurement does not show the effect at all ("no compression measured")
  are flagged instead of rated well.
- Tests first with free/open-source plugins, where the result can be checked.

State of the batch runs (16 Nov with the rebuilt host; delay 15 Nov):

| Class | Plugins | Result |
|---|---|---|
| Dynamics | 12 (9 compressors/limiters, 2 gates, 1 expander) | 0.34–3.62 dB (23 Nov); 3× excellent, 2× very good, 5× good, 1× usable (GxExpander 3.62 dB), 1× "no compression measured"; unseen combinations 0.43–10.2 dB |
| Delay | 12 | 3× very good (ZamDelay 1.43 dB, Gxdigital_delay 1.95/1.94 dB), 2× good (Tal-Dub-3 2.87 dB, GxEcho-Stereo 3.12 dB), 2× usable, 4× inaccurate, 1× "no echo measured"; unseen combinations 0.78–10.5 dB for seven plugins, otherwise 15–26 dB |
| Reverb | 19 | 1.48–6.97 dB; 5× very good, 7× good, 7× usable; unseen combinations 2–16 dB; 11 plugins not repeatable and measured in isolation (FdnReverb 13.0 → 4.08 dB, ZynReverb can now be measured) |
| Distortion | 73 (+4 failures: 3× crash while measuring, 1× clone does not load) | 0.06–18.4 dB (GxFuzzFaceFuller 13.95 after the fix, still 58.7 in the run of 16 Nov); 12× excellent, 20× very good, 14× good, 14× usable, 13× inaccurate; 17 plugins not repeatable and measured in isolation (dRowAudio Distortion 3.30 → 1.96); unseen combinations mostly close to the overall value, otherwise up to 28 dB |
| EQ | 5 (+1 failure: ZamEQ2 outputs only NaN in the capture host) | MultiEQ 0.04 dB (excellent), x42-eq 0.50 dB (very good, now with shelves and high/low-pass), ZamGEQ31 0.66 dB, GxBarkGraphicEQ 0.62 dB, GxGraphicEQ 0.83 dB (good); several bands at once 0.25–2.13 dB |

## Profile format `.vcprofile`
Details: [docs/profile-format.md](docs/profile-format.md). ZIP container, versioned JSON schema:
```
manifest.json        schema version, plugin info, capture settings, host/OS
parameters.json      parameters, ranges, defaults, value texts
test-signals.json    segments + seeds of the test signals (reproducible instead of stored) + SHA-256
captures.json        index: render ID → file, parameter values, latency, level
captures/*.wav       responses as WAV float32 (lossless, ZIP-compressed)
model/               model of the class (eq.json, …), gui.json; later Faust .dsp, .nam
report.json          quality metrics of the last build
spec.md              functional specification (no code)                (from M7)
checksums.sha256
```
- Import → rebuild of the clone without the original plugin.
- No binaries, samples or code of the original in the profile.

## Project structure (monorepo)
```
vst-cloner/
├─ apps/desktop/      Tauri v2 UI
├─ bridge/            JSON-lines interface UI ↔ packages
├─ host/              C++/JUCE vch-host and vch-gui (CMake, Win + Linux)
├─ capture/           Node/TS: test signals, measurement plan, plugin scanner, CLI `vch`
├─ profile/           JSON schema + reader/writer + WAV I/O (TS)
├─ clone/             Node/TS: fits, models, comparison, editor analysis, batch
├─ plugin-template/   C++/JUCE engines: eq, dynamics, distortion, delay, reverb, common
├─ agent/             Node/TS: AI SDK, roles; MCP→REA, analyst/builder agent (M7)
├─ dsp/               Faust templates, NAM training (M5c, M7)
└─ docs/
```

## Milestones
1. **Profile format + capture host** ✔
2. **LLM layer** ✔ – providers, auto-discovery, capability test, keychain, costs, roles; CLI `vch llm …`
3. **EQ/filter** ✔ – Pro-Q 3: 0.10 dB over 149 settings
   - Open: linear-phase mode
4. **Desktop UI** ✔ – clone, library, AI models, log; modes EQ, dynamics, distortion, delay, reverb, general
   - Measurement displays ✔ – preliminary steps in the progress bar (repeatability, working point, switch search), notes
     "not repeatable" and "detected as switches", EQ badge for graphic EQs/fixed shapes/band groups,
     result line "several bands at once"; checked in the window with ZamGEQ31 and Tal-Dub-3
   - Preliminary renders are counted; the delay hint names the switch search and "at least n settings" ✔
   - Links to folders and images work (hidden folders were refused by the opener scope), images open
     enlarged inside the app, "capture the editor again" and "fit the model again" as options; English UI ✔
   - **4b Editor reconstruction** (in progress) – wiggle test, OCR, needles, level bars, switch detection;
     74–82 % structural, 95–98 % colour similarity on four plugins
     - Knobs ✔ – rim and coloured outline, tick marks on mixed backgrounds, centre cap, direction of travel
       (anticlockwise, full turns), value arcs starting from a centre position
     - Bench ✔ – `vch gui-bench`: saved probes of 10 compressor/limiter/gate editors with hand-made labels, scored
       per element type; displays 19 % → 97 % right (0 extra), controls 84 % right
     - Meters ✔ – the editor is filmed while a sine rises from digital silence (and again with every threshold
       turned down): bars and LED chains in any direction, input or gain reduction, needles, LED rows a control
       switches; analyzers and time graphs (they keep moving at a held level), transfer curves (bent by
       threshold/ratio/knee)
     - App ✔ – replay of the recognition in the library details (controls moved, meter films, recognised
       elements over them) and a live preview while the original's editor is captured
     - Clone editor ✔ – level bars and LED chains in any direction (input, output, gain reduction), LEDs at the
       levels they light up at in the original's film (ZamComp: 40, 30, 20, 15 … at −39, −29, −18, −14 dB) and
       falling as fast; the transfer curve live from the clone's own curve, with the original's fill and a dot at
       the current level; analyzers/time graphs as a running history of level and gain reduction. Checked by
       filming the clone's editor like the original's (ZamComp, OmniCompressor)
     - Open: meter scales and labels inside displays; controls (45 extra detections, mostly LSP buttons);
       gain reduction of LSP Gate; XY points, knobs with a gradient and a small pointer (DS1), meter scales, font
       weights within a title, logos, frames/decoration; more editors in the bench
5. **Dynamics + distortion**
   - **5a Dynamics** ✔ – compressor, limiter, gate, expander, ducker; working point probe, interactions,
     models per switch position
     - Open: fit time (1–4 min per plugin), GxCompressor and DirectionalCompressor on unseen
       combinations (7–10 dB)
   - **5b Distortion (pedals)** ✔ – Wiener-Hammerstein; GxBoss DS1: fundamental 0.68 dB, harmonics 1.8 dB
     - Detection sharpened (97 → 77 hits: a gain control alone is no longer enough); batch over 77 plugins:
       73 cloned, 46 good or better
     - Silent default setting ✔ – the measurement plan looks for a working point (turn up the drive control) when
       nothing comes out at the default setting; silent control positions are modelled as "off"; the capture
       extends the pre-roll when the plugin still settles after loading (switch-on click, all classes);
       GxFuzzFaceFuller 58.7 → 13.95
     - Open: gate behaviour of fuzz pedals (GxFuzzFaceFuller does not let quiet signals through);
       fuzz pedals with fundamental errors above 10 dB (GxAxisFace, GxFuzzFaceFuller, GxSunFace, Hip2B),
       bitcrushers (Bitta, MaBitcrush – need another model), crashes while measuring (GxAmplifier-X,
       GxCabinet), time-domain term in the fit
   - **5c Amps with NAM** – local training (CPU/GPU), Swanky Amp, TONE3000
6. **Delay + reverb + modulation**
   - **6a Delay + reverb** ← in progress – first version in CLI, batch and app ✔
     - Delay combinations, first step ✔ – echo detection relative to the level and at the rise, time tables
       (points without a visible echo, controls linear in seconds or tempo), combination renders for the fit,
       sum rule for several time controls; ZamDelay 2.71 → 0.78 dB, GxDelay-Stereo 10.9 → 6.1 dB
     - Controls with many steps (0 … 127, Zyn plugins) are interpolated instead of being snapped to the nearest
       measured point like switches – all classes; ZynEcho 24.5 → 20.3 dB
     - Hidden switches ✔ – a preliminary scan (`survey`) finds selectors and buttons that the plugin reports as
       continuous controls; the first step of a selector ("off") gets a model of its own; Tal-Dub-3
       24.4 → 8.1 dB on unseen combinations
     - Repeatability ✔ – the capture checks per control whether the plugin keeps a state that is not a parameter
       value (buttons), and then loads a fresh instance for every render (`isolate` in the host, all classes)
     - Open for delays: modulation (LFO in GxEcho/GxDelay), filter slopes steeper than one pole
       (Gxdigital_delay), self-oscillation and resonant filters (Tal-Dub-3); outside the model: two
       lines with crosstalk (ZynEcho, "L/R Delay"), tape echo with several heads (GxEchoCat),
       tube saturation (GxTubeDelay), ducking (Gxduck_delay), DualDelay
     - Open: editor for delay and reverb
     - EQ detection extended ✔ – band groups with their own shapes (MultiEQ), named bands with a fixed shape
       (lowshelf, highpass, L/H), sliders of graphic EQs, switches reported as continuous; spatial effects
       (DirectivityShaper) excluded; cross-check with several bands at once
     - Open for EQs: high/low-pass of x42-eq (1.7 dB – the shape depends on the frequency), 24 dB slopes of
       MultiEQ (0.3 dB), ZamEQ2 (NaN in the capture host), EQs with controls without a dB display (Luftikus, EQinox) and
       crossover EQs (3 Band EQ) get no class
   - **6b Modulation** ← in progress – chorus, flanger, vibrato as the delay engine with an LFO on the delay time
     (`--class modulation`): a train of clicks (one every 40 ms) traces the LFO; centre, depth, rate per setting,
     delays beyond the click spacing unfolded with the impulse response, the LFO's start (phase, lead before the
     pre-roll) across all renders, then calibrated by measuring the model like the original. GxChorus: 4.0 dB
     clone vs. original (15 before the calibration), single controls 2.8 dB; the comparison aligns the LFO phase.
     Open: very fast and deep settings (9 Hz, 25 ms) let the repeats overtake each other – the clicks cannot follow
     them; phaser (allpass chain) and tremolo (the network already reaches 1 %) are not covered
   - **Night of 20 Nov: core functions per class** (each step measured before and after with `vch batch`, kept only
     where nothing got worse; results in `.vch-work/night/`):
     - Tremolo and phaser engines ✔ – the LFO also moves the level and the corner of an allpass chain with feedback;
       tremolo read off the dry part of the clicks, phaser off the notches of each click's spectrum. GxTremolo
       0.52, GxSwitchedTremolo 1.17, dRowAudio Tremolo 2.27, ZynPhaser 4.52, GxPhaser 7.83 dB. The network was
       better on GxTremolo (0.10 vs 0.44 dB spectral) and much better on GxPhaser (0.30 vs 5.2 dB): tremolos and
       phasers stay universal by default and get the engine in "engine vs. network". Chorus/flanger batch unchanged
     - Stereo delays ✔ – a model of its own for the right channel (ping-pong, stereo LFOs), both channels verified:
       DualDelay 26.1 → 7.8, GxDelay-Stereo 12.4 → 4.3, GxEcho-Stereo 12.3 → 3.5, Tal-Dub-3 8.5 → 2.9 dB,
       GxChorus-Stereo 7.5 → 3.7 dB; nothing worse
     - Reverb width ✔ – the clone's tails correlate as the original's (mono originals stay mono): width deviation
       MaFreeverb 42.8 → 0.0, GxReverb 33.2 → 1.1, Gxroom_simulator 32.2 → 0.0, MDA Ambience 10.5 → 1.6 dB
     - Dynamics: not changed. The batch (0.36–3.62 dB) is weak on unseen combinations (GxExpander 10.2,
       DirectionalCompressor 9.7, GxCompressor 7.7 dB); the worst combinations all have a long attack and a long
       release together. Limiting each control's sweep to the values it stands for helped by tenths only (and made
       single controls worse) – reverted. Checked on 23 Nov: an attack × release grid (3×3 renders, a correction
       table in the engine) was kept for no compressor – the tables already explain the grid. The worst
       GxCompressor combinations are a low threshold instead: the whole test signal lies above it, threshold and
       makeup cannot be told apart in the sweep (only threshold·(1−1/ratio)+makeup is measured), and the split
       chosen is wrong at another ratio (threshold + makeup refitted: 15.3 → 0.9 dB). Preferring "the control's own
       values" as a tie-break made darc and dpl worse (2.12 → 2.61, 0.36 → 0.68 dB) – reverted.
     - Dynamics ✔ (23 Nov): compressors get a test staircase from −96 dB instead of −60 dB, so a low threshold
       lies inside the signal and threshold and makeup separate. Unseen combinations GxCompressor 7.79 → 5.50,
       x42-comp 2.12 → 1.92, dpl 0.36 → 0.31, OmniCompressor 1.39 → 1.33 dB; ZamComp 1.02 → 1.22 (in the run-to-run
       spread: GxExpander moved 9.92 → 10.23 with an unchanged signal). Gates and expanders keep the −60 dB
       staircase (preset `gate`): with the quiet steps they got worse (GxExpander 9.9 → 11.3 dB). Also tried:
       fitting the quiet windows too (noise floor as limit) – worse for all, reverted
     - ZynChorus 16.98 → 2.89 dB with the tremolo/phaser commit: the capture is repeatable (two runs, 2.89 dB
       each) and the earlier capture refitted with the new code gives 2.89 dB too – the change is in the fit
       (which line exactly is not pinned down)
     - Editor (23 Nov): controls recognised 84 → 96 % (bench), scale numbers on curves and graphs (read from the
       original where tesseract manages – only LSP's time axis so far – else the clone's own)
     - GxPhaser: a wider search (16 stages, corners to 20 kHz) made it worse (7.8 → 18.1 dB) – the network stays
     - Open: GxPhaser topology (the allpass model misses it); ducking delays (level-dependent wet path)
7. **Universal clone (path B)** ← in progress – first version in CLI and app ✔
   - Capture plan `neural`, training (`dsp/neural/train.py`, PyTorch, CUDA), C++ template with the same network
     (~5 % of a core per channel), sample-rate adapter (other host rates, anti-alias filters, latency reported),
     verification by error-to-signal ratio, training environment set up from the app or `vch neural-setup`
   - Training recipe found by ablation on GxBoss DS1: 64 units, FiLM conditioning (validation error 0.16 instead of 0.30
     without), ESR normalised per render, no log-spectral loss term (it made training diverge), dry path
     initialised to pass the input; a plan with all controls at random cut the error on unseen combinations
     from 16 % to 3.8 %
   - Level on a logarithmic scale ✔ – the knobs set a gain exp(level) on the whole output (±104 dB), so volume
     controls spanning 100 dB and more can be learned; 50 random settings per control (128–400) instead of 12, 32 for
     the cross-check; errors measured against at least −60 dBFS (a turned-down setting no longer dominates the mean).
     Batch over five plugins, clone vs. original, all / unseen combinations (before → after):
     3BandEQ 2.5 → 0.56 % / 4.5 → 1.9 %, wolf-shaper 16.2 → 0.62 % / 3.7 → 4.2 %, gxtape 24 → 10.5 % / 124 → 14 %,
     ZamComp 81 → 21 % / 164 → 24 %, Tal-Filter-2 711 → 29 % / 92 → 70 %
   - Hidden switches ✔ – the survey (33 values per continuous control) finds selectors; the network sees the
     middle of a position in training and in the clone (Tal-Filter-2: filter type with 10 positions)
   - Training time: ZamComp 17 % after 6 min, 4.1 % after 20 (unseen 20 → 6.9 %) – 20 minutes by default
   - Captures 24-bit scaled to their peak (`scale` in captures.json): profiles about 40 % smaller
   - Transport in the capture host (optional per job: tempo, playing) ✔ – not used by captures yet; tempo-synced
     clones would have to read the host tempo themselves
   - Broad batch over 16 plugins (6 min each, clone vs. original, all / unseen combinations):
     very good: ZamAutoSat 0.00 % (no controls), gxts9 0.67 / 0.71 %, gx_tremolo 1.0 / 0.56 %, ZaMaximX2 1.8 / 2.2 %;
     usable: cheapdist 8.1 / 7.9 %, gx_bossds1 8.2 / 7.0 %, gxtilttone 9.7 / 10.8 %, gx_phaser 14.5 / 15.5 %;
     inaccurate: ZamGate 18 / 21 %, gx_chorus 19 / 19 %, ZynDistortion 20 / 22 %, ZamGEQ31 28 / 31 % (24 controls),
     gx_compressor 33 / 37 %, ZamDelay 40 / 38 % (long delay), MVerb 42 / 36 % (reverb tail), SwankyAmp 64 / 70 %
     (22 controls). Unseen ≈ training everywhere: the limit is capacity and training time, not overfitting.
     A plugin without controls failed to build (empty C++ array) – fixed
   - Tal-Filter-2 with the 24-bit capture and its 10 filter types: 89 / 84 %; the mean is set by a few settings with high
     resonance and the output turned down (one at 1077 %), the median render is at 22 %. Without snapping just as bad,
     so not caused by the positions; self-oscillation is hardly predictable sample by sample
   - Verdict by the typical setting (median) ✔ – mean and number of settings off by half the signal or more are
     reported next to it
   - 20 instead of 6 minutes for the inaccurate ones (typical setting / mean / unseen): ZynDistortion 2.2 / 16 / 22 %,
     ZamGate 4.2 / 17 / 20 %, ZamGEQ31 14 / 14 / 16 % (was 28 % mean), SwankyAmp 25 / 29 / 58 % (was 64 %),
     gx_compressor 24 / 28 / 32 %, gx_chorus 18 / 19 / 19 %, ZamDelay 33 / 40 / 38 %, MVerb 30 / 41 / 38 % – modulation,
     long delays and reverb tails do not gain from more time
   - Many controls, 20 min each (training / unseen): SwankyAmp 400 settings 64 units 27 / 58 %, 800 settings 27 / 46 %,
     128 units 67 / 70 % (800: 52 / 58 %); ZamGEQ31 15 / 17 %, 800 settings 15 / 16 %, 128 units 28 / 31 %. So up to
     800 settings (50 per control), the network stays at 64 units
   - Training no longer aborts on divergence: a batch with a non-finite gradient is skipped (ZamGate, gx_compressor
     had failed after 8 resets), and should it still keep diverging the best state so far is kept
   - Outliers of the typical-good clones share a cause: ZynDistortion at high drive + level + little high-pass (hard,
     loud clipping), ZamGate in "shut" mode with deep attenuation (hard switching). Drawing such settings more
     often in training (--focus 0.5) made both worse (median 2.2 → 4.2 %, 4.2 → 7.9 %) – removed again
   - Class engine or network ✔ – `vch compare` renders several clones with the settings of one profile and measures
     them alike, `vch best` clones a plugin both ways and keeps the better. The measure is the spectral deviation
     (third-octave levels in 85 ms frames, phase-blind, 40 dB floor: gxts9 at 0.65 % ESR shows 0.9 dB); the ESR
     prefers a network that leaves out the echoes. ZamDelay: delay engine 6.6 dB vs. network 13.2 dB, MVerb:
     reverb engine 3.3 vs. 9.7 dB, GxChorus: modulation engine 1.8 vs. 2.2 dB
   - Open: Tal-Filter-2 (its modulation follows a drawn curve stored in the plugin state – flat in the
     initial state, not a parameter), ZamComp (attack/release of a compressor, 21 %), wow/flutter/hiss of gxtape cannot match
     sample by sample
   - Open: long memory (reverb tails, long delays) and LFO modulation; stereo effects that treat the channels
     differently (one network for both channels now); plugins with more than 24 controls; hard staircase
     non-linearities (bitcrusher at few bits); AVX for a lower CPU load; editor reconstruction is shared with
     the class clones
   - Later: builder agent (Faust loop, analyst agent with REA and `spec.md`, clean-room separation)
8. **yabridge check** ✔ – selecting a Windows plugin runs a second of audio through it via yabridge and says
   whether the original already works (first finding: Pro-Q 3 is silent since Wine 11.22)
9. **Distribution** ← in progress – AppImage ✔ (`npm run app:appimage`, runtime unpacked on first start; needs
   CMake and a C++ compiler on the system); Windows on GitHub Actions ✔ – tests, host (MSVC), a clone built and
   verified through vch-host end to end, NSIS installer with the runtime (58 MB). Not yet tried on a real Windows
   machine: installing, unpacking with directory junctions, a capture of a real plugin. Open: a check in the app
   for CMake/compiler, updates, profile library, CLAP

## Deviations from the original plan
- **Fixed engines instead of generated Faust code** for the known classes (Faust code generated per clone was
  too slow to compile). Faust remains for path B.
- **Fits in TypeScript** instead of Python tools.
- **Classification by rules** instead of an LLM; the LLM only takes over the cases without a class.
- **Distortion as a Wiener-Hammerstein model** instead of NAM; NAM remains for amps.
- **Reverb as an FDN in C++** instead of convolution or Faust.
- **Class-specific metrics in dB** instead of ESR/MR-STFT; those remain for path B.
- **Batch run** and **editor reconstruction** were not planned and were added.
- **Universal clone as a neural network** instead of an LLM writing Faust code: it works for any plugin without
  knowing what it is, and its quality is measured the same way for all.
- Delay and reverb were started before amps/NAM.

## Risks / expectations
- Very well clonable: EQs, compressors, limiters, simple distortions (overdrive, distortion, boosters).
- Inaccurate with the current distortion model: fuzz with strong level dependence, bitcrushers, amps with several stages.
- Usable, but not yet faithful across all control combinations: delays, reverbs.
- Only approximated: strongly time-variant/random effects, complex multi-effects.
- Only with path B (universal clone): multiband compressors, dynamic EQs, plugins without a class – as exact as
  the network can learn them; long memory and modulation remain hard.
- Misclassification leads to clones with the wrong model; the rating catches this only partly.
- The GUI is rebuilt as a layout (shapes, colours, controls), not pixel-exact; graphics of the original are not taken over.
- NAM training without a GPU is slow (minutes to hours per model).
- yabridge solves many cases without a clone; the app should offer it first.
