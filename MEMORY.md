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

## Current state (v0.3)

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

**Program 2: AUDIO→VIS** — not started.

---

## File structure

```
avva/
  va.html             shell only — no inline styles/scripts
  va.css              all CSS; @property typed custom properties
  main.js             RAF loop, begin(), wires all modules
  MEMORY.md
  modules/
    config.js         CONFIG defaults + URL param parser
    color.js          rgbToHsv, luma, hueName — pure functions, no DOM
    video-source.js   VideoSource: camera vs looping file, same <video> element
    analyzer.js       Analyzer: frame analysis, EMA, heatmap — source-agnostic
    renderer.js       Renderer: all DOM mutations, CSS var updates, canvas draws
    controls.js       Controls: keyboard bindings, fires callbacks only
    calibration.js    Calibration (data + filterString) + CalibrationPanel (HUD)
    music.js          Key: hue→scale degree mapping, circular loop, triad data
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
3. Wire analysis → synth refinement (hue histogram peaks for polyphony, timbre from saturation)
4. AUDIO→VIS — mic input, FFT, generative visuals designed to feed back
5. Loop test — point at each other, tune feedback behavior

---

## Open decisions

- Polyphony from hue histogram peaks vs single dominant hue (monophonic first?)
- Share old chord-detection JS when synth step begins
- URL param convention: `?root=G&scale=dorian&tempo=72`
