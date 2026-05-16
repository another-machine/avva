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

## Current state (v0.6)

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

- **`Key`** class maps hue (0–360°) → diatonic scale degree (I–VII) in a circular path
  - Degrees spaced evenly across the spectrum; 0° and 360° both resolve to the tonic
  - The VII (leading tone) at ~310–360° naturally cadences back to I — the wrap IS the resolution
  - Modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian
  - URL params: `?root=A&mode=locrian&octave=4` (current default: A locrian)
- **`FMVoice`** — 2-operator FM primitive
  - `modulator (sine) → modGain → carrier.frequency`, `carrier (sine) → outGain → dest`
  - `modGain.gain = index × current modulator freq` — keeps timbre stable across pitch
  - Methods: `glideTo(fc, tau)` · `setIndex(i, tau)` · `setRatio(r, tau)` · `setGain(g, tau)` · `pluck(fc, opts)`
  - Pluck schedules mod-depth and amp-gain envelopes independently — mod decays faster than amp → classic DX "metallic ping → pure tone" arc
- **`Synth`** — 9 FM pads + 1 FM pluck (replaced triangle/sine v0.5 build)
  - 3 tiers × 3 chord-tone voices (root/3rd/5th); per-tier base FM ratio:
    - Bass (oct −1) ratio 2 — even harmonics only → fat, woody
    - Mid (oct 0) ratio 1 — full harmonic
    - Treble (oct +1) ratio 1 — full harmonic, slightly brighter index range
  - **Tier crossfade by `vy`** (vertical brightness centroid) — unchanged from v0.5
  - **Triad voice gating by `spread`** — unchanged from v0.5 (root → 3rd → 5th fade-in)
  - **`sat` → pad modulation index** — vivid color = bright timbre (idxBase + sat × idxScale)
  - **`contrast` → bass modulation index** — structured frames grow growl in the low end
  - **`spread` → ratio drift** — voices 0/1/2 drift +0/+δ/−δ off integer ratio (δ = spread × fmRatioDrift). Monochromatic frames stay perfectly harmonic; rainbow frames produce chorusy beating sidebands.
  - **Stereo width — per-voice StereoPannerNode** chained after each FMVoice.outGain
    - Base pan positions widen from bass (±0.18) → mid (±0.42) → treble (±0.7); voice 1 (3rd) sits center
    - Whole field scaled by `0.25 + spread × fmStereoWidth` (default 0.75 max width). Monochromatic = near-center, rainbow = open field.
    - Pan glides at slowTau (~4× freq tau) to avoid frame-rate twitching
  - **Glide via `setTargetAtTime`**: activity drives glide speed (act≈0 → glideMax/3, act≈1 → glideMin/3). Index and ratio glides use slowTau to feel like timbre evolution rather than per-frame jitter.
  - **Pluck voice** — FMVoice with ratio 7 (DX-style):
    - `trigProb = max(quickness×0.4, slowness×0.2)`, histogram-driven note pick (or chord-tones × spread fallback)
    - Octave by slowness: `Math.pow(2, 1 − slowness×2)`
    - Index peak boosted by `actEdge` (sharp edges → sharper ping); mod-decay shorter than amp-decay
    - Pan from chosen scale degree: tonic = leftmost, leading tone = rightmost, scaled by current width × 0.75
  - Light dynamics compressor on master bus
  - **S key** toggles audio on/off (AudioContext requires user gesture)
  - Each pad voice carries v0.5-compat aliases `voice.gain = fm.outGain` and `voice.osc = fm.carrier` so `window._avva.gains` debug tap still works
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
| `spread` | 1 − hue circular-mean resultant | triad voice gating + FM ratio drift + stereo width |
| `sat` | mean saturation of vivid pixels | pad/treble FM modulation index (timbre brightness) |
| `contrast` | brightness std-dev within frame | bass FM modulation index (low-end growl) |
| `actEdge` | activity at spatial edges | pluck FM index peak (ping sharpness) |

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
- FM tuning knobs all URL-overridable: `?fmIndexBase=0.15&fmIndexScale=2.4&fmRatioDrift=0.04&fmStereoWidth=0.75&fmPluckRatio=7`. The pluckRatio is the most expressive single knob — 3 = clarinet, 5 = wooden, 7 = DX bell, 11+ = pure metallic.
- AudioRenderer in `loop.html` will need updating to react to FM-driven timbre changes (currently only reacts to chroma/bands, doesn't know about the synth's brightness/width). Not urgent — Program 2 reads the actual audio, so timbre changes already flow through chroma analysis.
