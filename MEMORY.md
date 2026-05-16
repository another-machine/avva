# AVVA: Memory

IMPORTANT: use this for historical context but keep it updated and cleaned as you go.

---

## Concept

Closed-loop video-audio feedback instrument. Two browser pages pointed at each other:

```
[ SCREEN: AUDIO→VIS ] ←── camera ──[ CAM→AUDIO ] ──── speakers ───┐
         └───────────────────────── microphone ──[ AUDIO→VIS ] ◄───┘
```

A human stepping in front of the camera breaks the loop and injects new signal.

---

## Current state (v0.7)

**Program 1: CAM→AUDIO** — `va.html` (analysis + synth)

Three analysis passes per frame:

- **Hue** — saturation-weighted circular mean of vivid/lit pixels (HSV), EMA smoothed with shortest-arc interpolation
- **Brightness** — mean HSV value across frame
- **Activity** — weighted RGB Euclidean distance vs previous frame: `√(0.299·ΔR² + 0.587·ΔG² + 0.114·ΔB²)`. Captures chromatic motion (e.g. lava lamp blobs of similar brightness but different hue) that luma-only diffing misses.
- **actBg** — background-subtraction activity (bgK=0.03 EMA model). Catches slow movers that frame-diff misses.
- **spread** — 1 − resultant length of circular hue mean. 0 = monochromatic, 1 = full rainbow.
- **histBins** — Float32Array(30), each bin weighted by `sat × value`. Vivid bright pixels vote louder.

HUD: hue histogram, sparklines (ACT/SLOW/BRI/CTST/VPOS), motion heat-map, signal monitor panel (right), video calibration panel.

Signal monitor panel sections: SYNTH (dot, key, numeral, note, quality) · MOTION (act, actBg/SLOW, actEdge, vy) · TEXTURE (bri, contrast, spread, sat) · REGISTER (hi, lo).

**Synth:** `modules/synth.js` + `modules/music.js` + `modules/fm-voice.js`

- **`Key`** class maps hue (0–360°) → diatonic scale degree (I–VII)
  - **Circle-of-fifths hue ordering**: hue wheel divided into 7 equal sectors (≈51.4° each) in the order I→V→II→VI→III→VII→IV. Adjacent hues are a diatonic fifth apart, not a scale step — harmonically organic traversal as hue shifts.
  - For A locrian: 0°–51° = A (I), 51°–103° = Eb (V), 103°–154° = Bb (II), 154°–206° = F (VI), 206°–257° = C (III), 257°–309° = G (VII), 309°–360° = D (IV)
  - `hueToNote(hue)` → `{ degree, name, freq, triad, t }` using `DIATONIC_FIFTHS = [0,4,1,5,2,6,3]` sector table
  - `degreeToHue(degree, t=0.5)` → hue at center of that degree's sector (inverse)
  - `_buildChromaticHues()` → out-of-scale chromatic notes interpolated between nearest in-scale neighbors on the fifths-ordered wheel
  - Modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian
  - URL params: `?root=A&mode=locrian&octave=4` (current default: A locrian)

- **`FMVoice`** — 2-operator FM primitive
  - `modulator (sine) → modGain → carrier.frequency`, `carrier (sine) → outGain → dest`
  - `modGain.gain = index × current modulator freq` — keeps timbre stable across pitch
  - Methods: `glideTo(fc, tau)` · `setIndex(i, tau)` · `setRatio(r, tau)` · `setGain(g, tau)` · `pluck(fc, opts)`
  - Pluck schedules mod-depth and amp-gain envelopes independently — mod decays faster than amp → warm mallet/pluck arc

- **`Synth`** — 15 FM pads + 3 FM plucks + 1 sub-bass oscillator
  - Signal graph: `15 FM pads → per-voice panners → master gain → delay send (→ LPF → feedback → comp) → comp → destination`; `3 plucks → panners → master`; `sub-bass → master`; `tremolo LFO → master.gain`
  - **3 tiers × 5 voices** (root, 3rd, 5th, 7th*, 9th*); per-tier base FM ratio:
    - Bass (oct −1) ratio 2 — even harmonics only → fat, woody; index ← contrast
    - Mid (oct 0) ratio 1 — full harmonic; index ← sat
    - Treble (oct +1) ratio 1 — full harmonic, brighter index range; index ← sat
    - \*7th extension fades in at sat > 0.35 (seventhW); 9th at sat > 0.65 (ninthW). Frequencies pushed above the 5th by octave-doubling; capped at 6 kHz / 8 kHz.
  - **Voice-led drop-5th**: mid-tier voice 2 (5th) compares its close-position frequency and a dropped-octave version against `_prevRootFreq`. Picks whichever is logarithmically closer to the previous root — smooths chord changes, produces natural open voicing.
  - **Tier crossfade by `vy`** (vertical brightness centroid) — unchanged from v0.5
  - **Triad voice gating by `spread`** — root always on; 3rd fades in at spread > 0.15; 5th at spread > 0.4
  - **`sat` → pad modulation index** — vivid color = bright timbre
  - **`contrast` → bass modulation index** — structured frames add growl in the low end
  - **`spread` → ratio drift** — voices 0/1/2 drift +0/+δ/−δ (δ = spread × fmRatioDrift). Monochromatic = harmonic; rainbow = chorusy beating.
  - **Stereo width** — `widthScale = 0.25 + spread × fmStereoWidth`. Bass ±0.18, mid ±0.42, treble ±0.70. Extensions at ±0.12/0.32/0.55.
  - **Delay chain** — tap off master → 320 ms delay → LPF (3800 Hz) → feedback loop → wet mix. `actBg` drives feedback (0.05→0.60) and wet (0→0.35). Slow/ambient scenes = reverberant; fast motion = dry.
  - **Tremolo LFO** — sine oscillator → master.gain. `|dContrast| × 0.12` drives depth; `act` drives rate (5–9 Hz). Structure forming/dissolving = flutter.
  - **Sub-bass** — sine oscillator 2 octaves below root; `lo × 0.25` drives amplitude (bottom-screen brightness = sub weight).
  - **Glide** — `setTargetAtTime`; activity drives speed (act≈0 → glideMax/3, act≈1 → glideMin/3). Index and ratio use slowTau (4× freq tau) to feel like timbre evolution.
  - **3 polyphonic pluck voices** (round-robin by idle time):
    - Ratio 2 (octave harmonic, warm mallet character); `fmPluckRatio` URL-overridable
    - Note selection: degrees ordered by consonance [root→5th→3rd→7th→6th→4th→2nd]; `spread` gates how many are reachable (spread=0 → root only, spread=1 → all 7)
    - Octave snapped to nearest integer: slowness 0–0.25 → +1 oct, 0.25–0.75 → same, 0.75–1 → −1 oct
    - **Activity-driven spatial character**: `spacious = 1 − quickness`
      - Still scene: peak ~0.04, attack 14 ms (breath), long decay (×2.8), wide pan (×1.45 width), cooldown up to 560 ms
      - Active scene: peak ~0.17, attack 3 ms (snap), tight decay, centred pan (×0.35), cooldown 60 ms
    - `indexPeak = (0.3 + quickness×0.7 + edge×0.6) × (1 − slowness×0.3)`; mod collapses to sine very quickly
  - Light dynamics compressor on master bus
  - **S key** toggles audio on/off
  - `window._avva = { synth, analyzer, renderer, videoSource, testTone(), gains, signals }` debug global

**Analysis signals** (`frame.out`):
| Signal | Source | Synth role |
|--------|--------|------------|
| `hue` | saturation-weighted circular mean | chord target (scale degree via circle-of-fifths mapping) |
| `bri` | mean HSV value | pad tier gains (via vy crossfade) |
| `hi` / `lo` | top/bottom ⅓ brightness | `lo` → sub-bass amplitude |
| `vy` | vertical brightness centroid (0=top, 1=bottom) | tier bass↔treble crossfade |
| `act` | weighted RGB Euclidean delta | glide speed + pluck trigger (quickness) + pluck spatial character |
| `actBg` | background-subtraction delta | delay feedback + wet (slowness) |
| `spread` | 1 − hue circular-mean resultant | triad voice gating + FM ratio drift + stereo width + pluck note range |
| `sat` | mean saturation of vivid pixels | pad/treble FM index; extension voice gating (7th/9th) |
| `contrast` | brightness std-dev within frame | bass FM index |
| `actEdge` | activity at spatial edges | pluck FM index peak |
| `dContrast` | frame-to-frame contrast delta | tremolo LFO depth |

`frame.histBins` — Float32Array(30) passed into `synth.update()` but not used for note selection (pluck note selection uses consonance order + spread gate instead).

**Canvas layers:**

- `#heat` — 96×72 sample-resolution motion heatmap, CSS-scaled fullscreen, `image-rendering: pixelated`, `mix-blend-mode: screen`. Opacity driven by `--heat-opacity` typed property. Toggled with M key.
- `#hud` — full display-resolution (innerWidth × dpr), reserved for future audio HUD drawings.

**Program 2: AUDIO→VIS** — in progress (`av.html` + `loop.html` harness).

Polyphonic, no monophonic pitch detection:

- `AnalyserNode`, fftSize 32768, smoothingTimeConstant 0.95 → ~0.67 Hz bin resolution at 44.1k
- 60 chromatic notes scanned (octaves 2–6); per note: dominates harmonic neighbors → kills octave bleed
- Asymmetric EMA per note: `pow(v/128, 50)` — sharp gating, sustains chord sweeps
- Aggregate by chromatic class → 12-element pitch class profile (`chroma[12]`)
- Sum into 3 EQ bands `{lo, mid, hi}`. Chord template lookup gives chord guess.

**Audio frame contract:**

| Signal   | Derivation                                           |
| -------- | ---------------------------------------------------- |
| `chroma` | Float32Array(12) — normalized per-class prominence   |
| `bands`  | `{lo, mid, hi}` — band-summed FFT energy             |
| `hue`    | circular mean of chroma mapped via `Key.degreeToHue` |
| `spread` | 1 − resultant length of circular mean                |
| `bri`    | total spectral RMS                                   |
| `act`    | frame-to-frame delta of chroma vector (L1 norm)      |
| `sat`    | chord-template confidence                            |
| `chord`  | best-match chord label + `{change: bool}`            |

**Audio routing:** `loop.html` single-page harness. `synth._master` connects to both `destination` and `AudioAnalyzer.analyser`. No mic/OS routing/feedback risk.

`loop.html` left pane now shows a **chord strip**: Roman numeral + 3 note pills (root/3rd/5th) whose opacity mirrors the spread-based voice gates — live visual of what the synth is playing.

---

## File structure

```
avva/
  va.html             Program 1 shell
  loop.html           dev harness — both programs side-by-side, audio bus direct
  loop.js             loop harness logic
  loop.css            loop harness styles (extends va.css)
  va.css              shared CSS; @property typed custom properties
  main.js             Program 1 RAF loop; window._avva debug global
  MEMORY.md
  modules/
    config.js         CONFIG defaults + URL param parser
    color.js          rgbToHsv, luma, hueName — pure functions, no DOM
    video-source.js   VideoSource: camera vs looping file array, same <video> element
    analyzer.js       Analyzer: video frame → all signals + histBins + heatmap
    audio-analyzer.js AudioAnalyzer: FFT → 12-class chroma + bands + chord
    renderer.js       Renderer: all DOM mutations for Program 1 (signal monitor, sparklines)
    audio-renderer.js AudioRenderer: visuals from audio frame
    controls.js       Controls: keyboard bindings, fires callbacks only
    calibration.js    Calibration (data + filterString) + CalibrationPanel (HUD)
    music.js          Key: hue↔scale degree, hueToNote, degreeToHue, chromaticHues, triad data
    fm-voice.js       FMVoice: 2-op FM primitive (sine carrier + sine modulator)
    synth.js          Synth: 9 FM pads + 1 FM pluck, per-voice stereo panning, sat→index, spread→ratio drift + width
```

---

## CSS architecture

`@property` typed registrations for:

- `--accent-l` (`<number>`) · `--accent-c` (`<number>`) · `--accent-h` (`<number>`)
  → oklch components set on `:root` each frame by Renderer.
  CSS derives: `--color-accent: oklch(var(--accent-l) var(--accent-c) var(--accent-h))`
  Typed so CSS can interpolate between frames.
- `--hue-marker-pos` (`<percentage>`) — set on `.huebar__marker`; CSS transitions it.
- `--heat-opacity` (`<number>`) — set on `#heat`; CSS transitions it.

Design tokens in `:root`: palette, typography, spacing, transitions, component dimensions.
BEM class names throughout. No inline styles in HTML.

---

## Video source abstraction

`VideoSource` decouples source from processing:

- `?source=camera` → getUserMedia, device cycling with C key
- `?source=./assets/clip.mp4` → sets `<video src>`, loops, auto-starts without gate
- Downstream (Analyzer) gets only a `<video>` element — source-agnostic

Jake's current dev default: `source: "assets/lavalamp.mp4"` in config.js DEFAULTS.

**Requires a local HTTP server** (not `file://`) for ES modules:

```
cd avva && npx serve .
# or: python3 -m http.server 8080
```

---

## Video calibration

`Calibration` class holds four parameters and produces a CSS/canvas filter string:

- `brightness` (0.1–3.0, default 1.0)
- `contrast` (0.1–3.0, default 1.0)
- `saturation` (0.0–4.0, default 1.0)
- `hueRotate` (-180–180°, default 0)

The SAME filter string is applied to both:

1. `videoEl.style.filter` — so you see what the analyzer sees
2. `this._ctx.filter` before `drawImage` in Analyzer — analysis matches display

URL params seed initial values: `?brightness=1.2&contrast=1.1&saturation=0.9&hueRotate=15`
`cal.urlDiff` returns the non-default params for copy-pasting into the URL bar.

**V key** → toggle calibration panel (top-right HUD overlay)
While panel is open: ↑↓ adjust · Tab cycle params · 0 reset · V/Esc close

---

## Hue/color — oklch

Hue spectrum bar and histogram bars use `oklch(0.65 0.2 h)` instead of HSL.
This gives perceptually uniform lightness across all hues (no blinding yellow / dim blue).

Hue bar CSS: `linear-gradient(in oklch 90deg, oklch(0.65 0.2 0), ..., oklch(0.65 0.2 360))`
Histogram bars: `oklch(0.65 0.2 h)` built inline in `buildHistBars()`.
Accent color: `oklch(l c h)` where l/c are derived from brightness/saturation analysis.

---

## Build order (remaining)

1. ✅ CAM→AUDIO analysis layer (all signals: hue, bri, act, actBg, spread, vy, contrast, hi, lo, actEdge, histBins)
2. ✅ Synthesizer:
   a. ✅ Triangle pads + sine pluck (v0.5)
   b. ✅ 2-op FM pads + FM pluck (v0.6) — sat→index timbre, spread→ratio drift + stereo width, per-voice panning
3. ✅ AUDIO→VIS:
   a. ✅ Polyphonic chromatic detection (12-class chroma + bands + chord)
   b. ✅ In-page audio bus harness `loop.html` — synth.\_master → AudioAnalyzer tap
   c. ✅ AudioRenderer — chroma + bands palette-matched visuals
   d. ✅ loop.html chord strip — live note pills for visual comparison
4. Loop refinement — once stable, swap shared-AudioContext for BlackHole/tab-capture
5. Real acoustic loop (camera ↔ speakers ↔ mic)

---

## Open decisions

- Out-of-scale chromatic notes in AudioRenderer: chromatic-circle hue vs desaturated grey. Currently planning chromatic-circle so visual stays vivid even when audio strays out of key.
- Whether `loop.html` should wire Program 2's canvas → Program 1's `<video>` via `canvas.captureStream()` for full closed loop.
- URL param convention: `?root=G&mode=dorian` (synth accepts `root`/`mode`/`octave`; Program 2 should share same key params for inverse mapping).
- FM tuning knobs all URL-overridable: `?fmIndexBase=0.15&fmIndexScale=2.4&fmRatioDrift=0.04&fmStereoWidth=0.75&fmPluckRatio=2`. The pluckRatio is the most expressive single knob — 2 = warm mallet/pluck, 3 = clarinet, 5 = wooden, 7 = DX bell, 11+ = pure metallic.
- AudioRenderer in `loop.html` will need updating to react to FM-driven timbre changes (currently only reacts to chroma/bands, doesn't know about the synth's brightness/width). Not urgent — Program 2 reads the actual audio, so timbre changes already flow through chroma analysis.
- `loop.html` chord strip may need updating to reflect the circle-of-fifths hue ordering for accurate color-to-note visualization (currently unknown if it was updated).
