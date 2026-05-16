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

## Current state (v0.5)

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

**Synth:** `modules/synth.js` + `modules/music.js`

- **`Key`** class maps hue (0–360°) → diatonic scale degree (I–VII) in a circular path
  - Degrees spaced evenly across the spectrum; 0° and 360° both resolve to the tonic
  - The VII (leading tone) at ~310–360° naturally cadences back to I — the wrap IS the resolution
  - Modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian
  - URL params: `?root=A&mode=locrian&octave=4` (current default: A locrian)
- **`Synth`** class: 3 tiers × 3 triangle oscillators (pads) + 1 pluck oscillator = 10 total
  - **Register tiers** — driven by vertical brightness centroid (`vy`):
    - `vt = vy * 2`; bassW/midW/trebleW are a triangular crossfade of `safeBri`
    - Bass (oct −1) ↔ treble (oct +1) driven by whether brightness is bottom/top/spread
  - **Triad voice gating by spread** (color diversity):
    - spread 0–0.15 → root only; 0.15–0.40 → 3rd fades in; 0.40–0.65 → 5th fades in
    - `voiceWeights = [1.0, thirdW, fifthW]`; each tier voice multiplied per slot
  - **Glide via `setTargetAtTime`**: activity drives glide speed
    - act ≈ 0 → τ = glideMax/3 (slow, legato); act ≈ 1 → τ = glideMin/3 (staccato)
  - **Pluck voice** — probabilistic melodic strike on motion:
    - `trigProb = max(quickness*0.4, slowness*0.2)` per frame
    - **Note selection: histogram-driven.** `histBins` (30 bins, `sat×val` weighted) summed into 7 degree buckets → normalized weights with 4% floor → used directly as RNG probabilities. So a red-dominant frame plucks near the red degree; a multicolor frame roams all 7.
    - Fallback (no histBins): chord tones (root/3rd/5th) weighted 1.0, non-chord × `spread*0.8`
    - **Octave by slowness**: `Math.pow(2, 1−slowness*2)` → fast motion = bright/high, slow = deep/resonant
    - Attack τ: 3–20 ms (quickness → slowness); decay τ: 40–550 ms
    - Cooldown prevents overlap; longer for resonant (slow) strikes
  - `cancelAndHoldAtTime` used for glide; falls back to `cancelScheduledValues + setValueAtTime` for older browsers
  - Light dynamics compressor on master bus
  - **S key** toggles audio on/off (AudioContext requires user gesture)
  - `window._avva = { synth, analyzer, renderer, videoSource, testTone(), gains, signals }` debug global

**Analysis signals** (`frame.out`):
| Signal | Source | Synth role |
|--------|--------|------------|
| `hue` | saturation-weighted circular mean | chord target (scale degree) |
| `bri` | mean HSV value | pad tier gains (via vy crossfade) |
| `hi` / `lo` | top/bottom ⅓ brightness | available; tier crossfade uses vy |
| `vy` | vertical brightness centroid (0=top, 1=bottom) | tier bass↔treble crossfade |
| `act` | weighted RGB Euclidean delta | glide speed + pluck trigger (quickness) |
| `actBg` | background-subtraction delta | pluck trigger (slowness) |
| `spread` | 1 − hue circular-mean resultant | triad voice gating |
| `sat` | mean saturation of vivid pixels | available |
| `contrast` | brightness std-dev within frame | available |
| `actEdge` | activity at spatial edges | available |

`frame.histBins` — Float32Array(30) passed separately into `synth.update({ ...frame.out, histBins: frame.histBins })`.

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
    synth.js          Synth: pads (3×3 triangle) + pluck (1 sine), glide, spread-gated triad, histogram-driven note selection
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
2. ✅ Synthesizer — pads (spread-gated triad), pluck (histogram-driven note selection), glide, slowness/quickness differentiation
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
