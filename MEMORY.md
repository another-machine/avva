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

## Current state (v0.4)

**Program 1: CAM→AUDIO** — `va.html` (analysis + synth)

Three analysis passes per frame:

- **Hue** — saturation-weighted circular mean of vivid/lit pixels (HSV), EMA smoothed with shortest-arc interpolation
- **Brightness** — mean HSV value across frame
- **Activity** — weighted RGB Euclidean distance vs previous frame: `√(0.299·ΔR² + 0.587·ΔG² + 0.114·ΔB²)`. Captures chromatic motion (e.g. lava lamp blobs of similar brightness but different hue) that luma-only diffing misses.

HUD: hue histogram, sparklines for bri/act, motion heat-map, video calibration panel.

**Synth:** `modules/synth.js` + `modules/music.js`

- **`Key`** class maps hue (0–360°) → diatonic scale degree (I–VII) in a circular path
  - Degrees spaced evenly across the spectrum; 0° and 360° both resolve to the tonic
  - The VII (leading tone) at ~310–360° naturally cadences back to I — the wrap IS the resolution
  - Modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian
  - URL params: `?root=A&mode=dorian&octave=4`
- **`Synth`** class: 3 tiers × 3 triangle oscillators = 9 oscillators total
  - **Register tiers** (independent gain per tier):
    - Bass (octave −1): gain ← `lo` (bottom-third brightness)
    - Mid (octave 0): gain ← `bri` (overall brightness)
    - Treble (octave +1): gain ← `hi` (top-third brightness)
    - Combinations: dark bottom → bass silent; bright top only → treble only; both → full stack
  - **Glide via `setTargetAtTime`**: activity drives glide speed
    - act ≈ 0 → τ = glideMax/3 (slow, legato, up to ~3s)
    - act ≈ 1 → τ = glideMin/3 (fast, staccato, ~50ms)
  - Light dynamics compressor on master bus
  - **S key** toggles audio on/off (AudioContext requires user gesture)
  - URL params: `?glideMin=0.05&glideMax=3.0&masterGain=0.35`

**Analysis signals** (`frame.out`):
| Signal | Source | Synth role |
|--------|--------|------------|
| `hue` | saturation-weighted circular mean | chord target (scale degree) |
| `bri` | mean HSV value | mid-tier gain |
| `hi` | mean brightness, top ⅓ of frame | treble-tier gain |
| `lo` | mean brightness, bottom ⅓ of frame | bass-tier gain |
| `act` | weighted RGB Euclidean delta | glide speed |
| `sat` | mean saturation of vivid pixels | _available — unused in synth so far_ |

**Canvas layers:**

- `#heat` — 96×72 sample-resolution motion heatmap, CSS-scaled fullscreen, `image-rendering: pixelated`, `mix-blend-mode: screen`. Opacity driven by `--heat-opacity` typed property. Toggled with M key.
- `#hud` — full display-resolution (innerWidth × dpr), reserved for future audio HUD drawings. Currently wired but unused.

**Program 2: AUDIO→VIS** — in progress (`av.html` + `loop.html` harness).

Polyphonic, no monophonic pitch detection. Derived from old `DetectTone`:

- `AnalyserNode`, fftSize 32768, smoothingTimeConstant 0.95
  → ~0.67 Hz bin resolution at 44.1k. Enough to separate adjacent semitones from C2 up.
- 60 chromatic notes scanned (octaves 2–6). Per note: take the bin amplitude, but only if it dominates its harmonic neighbors (octave ±1, ±2 bins) — kills octave bleed.
- Asymmetric EMA per note (fast attack, slow release) on `pow(v/128, 50)` — sharp gating that keeps short staccato hits visible while sustaining chord sweeps.
- Aggregate by chromatic class → 12-element pitch class profile (`chroma[12]`).
- Sum across octaves into 3 EQ bands → `{lo, mid, hi}`.
- Top-N chromatic prominences + chord-template lookup (maj/min/dim/aug/7ths) gives a chord guess; sticky on previous chord for stability.

**Audio frame contract** (mirrors Program 1's `frame.out` so renderers are interchangeable):

| Signal     | Derivation                                          | Symmetric to video |
|------------|-----------------------------------------------------|--------------------|
| `chroma`   | Float32Array(12) — normalized per-class prominence  | (new — polyphonic) |
| `bands`    | `{lo, mid, hi}` — band-summed FFT energy            | hi / lo / bri      |
| `hue`      | circular mean of `chroma` mapped via `Key.degreeToHue` (in-scale) and chromatic position (out-of-scale) | hue |
| `spread`   | 1 − resultant length of circular mean              | spread             |
| `bri`      | total spectral RMS                                  | bri                |
| `act`      | frame-to-frame delta of chroma vector (L1 norm)     | act                |
| `sat`      | chord-template confidence (clean triad → 1, noise → 0) | sat             |
| `chord`    | best-match chord label + `{change: bool}`           | (new)              |

**Audio routing (closed-loop test) — Option 1 chosen:** single page harness `loop.html`.
Shared `AudioContext`. Program 1's `synth._master` gain is connected to both `destination` AND to `AudioAnalyzer.analyser` directly. No mic, no speakers, no OS routing, no feedback risk. Both programs render side-by-side for eyeballing. Other options (BlackHole virtual device, tab capture, real acoustic loop) noted but deferred.

Visuals: each of 12 chromatic classes gets a hue position (via `Key.degreeToHue` when in scale, chromatic-circle fallback when out). Per-class prominence drives intensity of that hue's band. `bands.lo/hi` drive bottom/top vertical brightness. `act` drives motion. Same `--accent-l/c/h` oklch plumbing as `va.css` so feedback stays in the palette.

---

## File structure

```
avva/
  va.html             Program 1 shell — no inline styles/scripts
  av.html             Program 2 shell — audio in, visuals out
  loop.html           dev harness — both programs in one page, audio bus wired direct
  va.css              shared CSS; @property typed custom properties
  main.js             Program 1 RAF loop, begin(), wires all modules
  main-av.js          Program 2 RAF loop
  MEMORY.md
  modules/
    config.js         CONFIG defaults + URL param parser
    color.js          rgbToHsv, luma, hueName — pure functions, no DOM
    video-source.js   VideoSource: camera vs looping file, same <video> element
    analyzer.js       Analyzer: video frame analysis, EMA, heatmap — source-agnostic
    audio-analyzer.js AudioAnalyzer: FFT → 12-class chroma + bands + chord — source-agnostic
    renderer.js       Renderer: all DOM mutations for Program 1
    audio-renderer.js AudioRenderer: visuals from audio frame, palette-matched
    controls.js       Controls: keyboard bindings, fires callbacks only
    calibration.js    Calibration (data + filterString) + CalibrationPanel (HUD)
    music.js          Key: hue↔scale degree mapping (both directions), triad data
    synth.js          Synth: 3 triangle oscillators, glide, activity→portamento speed
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

1. ✅ CAM→AUDIO analysis layer
2. ✅ Synthesizer — triad oscillators, glide, hue→pitch, activity→portamento speed
3. AUDIO→VIS:
   a. ✅ Decision: polyphonic chromatic detection (12-class chroma + bands), not monophonic pitch
   b. ✅ Decision: in-page audio bus harness (Option 1) for closed-loop dev
   c. `Key.degreeToHue()` + chromatic-fallback hue mapping
   d. `AudioAnalyzer` — port DetectTone, emit frame.out-shaped struct
   e. `AudioRenderer` — render chroma + bands as palette-matched visuals
   f. `loop.html` — wire synth master → AudioAnalyzer; both renderers side-by-side
4. Loop refinement — once stable, swap shared-AudioContext for BlackHole/tab-capture
5. Real acoustic loop (camera ↔ speakers ↔ mic)

---

## Open decisions

- Out-of-scale chromatic notes: render with chromatic-circle hue (12 evenly-spaced hues) OR desaturated grey? Currently planning chromatic-circle so the visual stays vivid even when audio strays out of key.
- Whether `loop.html` should also wire Program 2's canvas → Program 1's `<video>` via `canvas.captureStream()` for full closed loop. Not blocking initial build.
- URL param convention: `?root=G&scale=dorian&tempo=72` (still TBD; Program 2 should accept same `root`/`mode`/`octave` as Program 1 for inverse mapping to work).
