/**
 * modules/audio-analyzer.js
 *
 * Polyphonic chromatic + EQ analysis from a Web Audio source.
 * Source-agnostic: accepts any AudioNode as input (mic, tab capture,
 * or — in the closed-loop test — Program 1's synth master gain).
 *
 * Per-frame output mirrors video Analyzer's `frame.out` shape so the
 * audio + video renderers can be swapped:
 *
 *   chroma[12]    pitch-class prominence (0..1), sums to 1 when signal present
 *   bands         { lo, mid, hi } band energies (0..1)
 *   hue           weighted circular mean of chroma via Key.chromaticHues
 *   spread        1 − resultant length of that circular mean  (0=focused, 1=spread)
 *   bri           full-band RMS-ish loudness
 *   hi, lo        bands.hi / bands.lo  (mirrors video out.hi/lo for renderer reuse)
 *   act           L1 norm of chroma delta vs previous frame
 *   sat           top-3 chroma share  (high = clean chord, low = noisy/chromatic)
 *   chord         { label, key, change } best chord-template match, sticky
 *   notes[60]     per-(note,octave) prominence; metadata in `noteInfo`
 *
 * Derived from amplib DetectTone:
 *   - 60-note FFT bin lookup (C2..B6 at 5 octaves × 12 classes)
 *   - Per-note neighbor-peak gate (skips pure octave neighbors so same
 *     pitch class across octaves still contributes; rejects ±semitone and
 *     ±octave±semitone bleed)
 *   - Asymmetric EMA (fast attack, slow release) for visual snappiness on
 *     staccato hits while sustaining chord sweeps
 *   - Pitch-class aggregation across octaves → 12-element chroma
 *   - Top-N chroma → chord-template lookup with sticky preference
 */

import { Key } from "./music.js";

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

/** Equal-tempered frequency for chromatic class c (0..11) at octave o. */
function noteFreq(c, o) {
  return 440 * Math.pow(2, ((o - 4) * 12 + c - 9) / 12);
}

// Chord interval templates (semitones from root)
const CHORD_TYPES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
};

const CHORD_SUFFIX = {
  maj: "",
  min: "m",
  dim: "°",
  aug: "+",
  maj7: "M7",
  min7: "m7",
  dom7: "7",
};

/** Pre-build all (root × type) chord templates as 12-element pitch-class vectors. */
function buildChordTemplates() {
  const out = [];
  for (const [type, intervals] of Object.entries(CHORD_TYPES)) {
    for (let root = 0; root < 12; root++) {
      const v = new Float32Array(12);
      for (const i of intervals) v[(root + i) % 12] = 1;
      const classes = intervals.map((i) => NOTE_NAMES[(root + i) % 12]);
      out.push({
        type,
        root,
        label: NOTE_NAMES[root] + CHORD_SUFFIX[type],
        key: [...classes].sort().join("-"),
        vec: v,
        norm: Math.sqrt(intervals.length),
      });
    }
  }
  return out;
}

const CHORD_TEMPLATES = buildChordTemplates();

export class AudioAnalyzer {
  /**
   * @param {object} params
   * @param {AudioContext} params.audioContext
   * @param {Key}          [params.key]      Key for hue mapping (must match Program 1's key)
   * @param {object}       [params.opts]
   * @param {number}       [params.opts.fftSize=32768]     ~1.35 Hz/bin at 44.1k
   * @param {number}       [params.opts.smoothing=0.85]    AnalyserNode.smoothingTimeConstant
   * @param {number}       [params.opts.attack=0.25]       EMA factor on rising signal
   * @param {number}       [params.opts.release=0.06]      EMA factor on falling signal
   * @param {number}       [params.opts.gateExp=50]        Nonlinearity exponent on byte/128
   * @param {number}       [params.opts.octaveLow=2]
   * @param {number}       [params.opts.octaveHigh=6]
   */
  constructor({ audioContext, key, opts = {} }) {
    this._actx = audioContext;
    this.key = key ?? new Key();

    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = opts.fftSize ?? 32768;
    this.analyser.smoothingTimeConstant = opts.smoothing ?? 0.85;

    this._attack = opts.attack ?? 0.25;
    this._release = opts.release ?? 0.06;
    this._gateExp = opts.gateExp ?? 50;
    this._octL = opts.octaveLow ?? 2;
    this._octH = opts.octaveHigh ?? 6;

    const bins = this.analyser.frequencyBinCount;
    this._freqData = new Uint8Array(bins);
    this._binHz = audioContext.sampleRate / this.analyser.fftSize;

    // Build per-note index table (5 octaves × 12 classes = 60 notes)
    this.noteInfo = [];
    for (let o = this._octL; o <= this._octH; o++) {
      for (let c = 0; c < 12; c++) {
        const f = noteFreq(c, o);
        const idx = Math.floor(f / this._binHz);
        this.noteInfo.push({
          chromatic: c,
          octave: o,
          name: NOTE_NAMES[c],
          freq: f,
          bin: Math.min(idx, bins - 1),
        });
      }
    }
    this._N = this.noteInfo.length;

    // Flat arrays for hot-loop perf
    this._bins = new Int32Array(this._N);
    this._chromas = new Int8Array(this._N);
    this._octaves = new Int8Array(this._N);
    for (let i = 0; i < this._N; i++) {
      this._bins[i] = this.noteInfo[i].bin;
      this._chromas[i] = this.noteInfo[i].chromatic;
      this._octaves[i] = this.noteInfo[i].octave;
    }

    // Per-note smoothed prominence and aggregated chroma
    this._noteVals = new Float32Array(this._N);
    this._chroma = new Float32Array(12);
    this._chromaPrev = new Float32Array(12);

    // Diatonic degree aggregation (7 degrees from 12-class chroma)
    // _pcSectorDeg: for each chromatic PC, which diatonic degree owns its hue sector
    // This drives both degrees[] weighting and sub-sector hue centering.
    const _chHues = this.key.chromaticHues;
    this._chromaHues = _chHues;
    this._pcSectorDeg = new Int8Array(12);
    for (let c = 0; c < 12; c++) {
      this._pcSectorDeg[c] = this.key.hueToNote(_chHues[c]).degree;
    }
    // Primary pitch-class per degree (stored for external callers)
    this._degreePCs = new Int8Array(7);
    for (let d = 0; d < 7; d++) {
      this._degreePCs[d] = this.key.pitchClassForDegree(d);
    }
    this._degrees = new Float32Array(7);
    this._degreeHuesOut = new Float32Array(7);

    // Sticky chord state
    this._prevChordKey = "";

    // Output struct — reused across frames to avoid allocation
    this._out = {
      chroma: this._chroma,
      degrees: this._degrees,
      degreeHues: this._degreeHuesOut,
      bands: { lo: 0, mid: 0, hi: 0 },
      hue: 0,
      spread: 1,
      bri: 0,
      hi: 0,
      lo: 0,
      act: 0,
      sat: 0,
      chord: { label: "—", key: "", change: false },
      notes: new Float32Array(this._N),
    };
    this._rebuildKeyTables();
  }

  /**
   * Connect any AudioNode as the analyser's input.
   * For a MediaStream, wrap with audioContext.createMediaStreamSource first.
   * @param {AudioNode} node
   */
  connect(node) {
    node.connect(this.analyser);
  }

  /** Swap the key (e.g. user changed root/mode mid-session). */
  setKey(key) {
    this.key = key;
    this._rebuildKeyTables();
  }

  /** Rebuild key-dependent lookup tables (call after changing key or rootHue). */
  rebuildKeyTables() {
    this._rebuildKeyTables();
  }

  _rebuildKeyTables() {
    const chHues = this.key.chromaticHues;
    this._chromaHues = chHues;
    this._pcSectorDeg = new Int8Array(12);
    for (let c = 0; c < 12; c++) {
      this._pcSectorDeg[c] = this.key.hueToNote(chHues[c]).degree;
    }
    this._degreePCs = new Int8Array(7);
    for (let d = 0; d < 7; d++) {
      this._degreePCs[d] = this.key.pitchClassForDegree(d);
    }
  }

  /**
   * Analyze one frame. Call every RAF tick.
   * @returns {object} frame.out (see file header for shape)
   */
  tick() {
    this.analyser.getByteFrequencyData(this._freqData);

    const N = this._N;
    const data = this._freqData;
    const bins = this._bins;
    const gateExp = this._gateExp;
    const attack = this._attack;
    const release = this._release;

    // ── Per-note prominence with neighbor-peak gate ─────────────
    // Skip pure octave neighbors (±12) — same chromatic class should
    // continue contributing. Reject only adjacent semitones and
    // octave-±-semitone neighbors which catch out-of-tune harmonics.
    const SKIP = [-2, -1, 1, 2, -14, -13, 13, 14];

    for (let i = 0; i < N; i++) {
      const self = data[bins[i]];

      let neighborMax = 0;
      for (let k = 0; k < SKIP.length; k++) {
        const j = i + SKIP[k];
        if (j >= 0 && j < N) {
          const v = data[bins[j]];
          if (v > neighborMax) neighborMax = v;
        }
      }
      const gated = self > neighborMax ? self : 0;

      // Sharp nonlinearity acts as a noise gate; byte 128 ≈ -65 dB at defaults
      const raw = Math.pow(Math.min(1, gated / 128), gateExp);

      const prev = this._noteVals[i];
      const factor = raw < prev ? release : attack;
      this._noteVals[i] = prev + (raw - prev) * factor;
    }

    // ── Aggregate to 12-class chroma ────────────────────────────
    const chroma = this._chroma;
    chroma.fill(0);
    for (let i = 0; i < N; i++) {
      chroma[this._chromas[i]] += this._noteVals[i];
    }
    let chromaSum = 0;
    for (let c = 0; c < 12; c++) chromaSum += chroma[c];
    if (chromaSum > 1e-6) {
      const inv = 1 / chromaSum;
      for (let c = 0; c < 12; c++) chroma[c] *= inv;
    }

    // ── Aggregate to 7 diatonic degrees ─────────────────────────
    // Sum chroma energy by the degree that owns each PC's hue sector.
    const degrees = this._degrees;
    degrees.fill(0);
    for (let c = 0; c < 12; c++) {
      degrees[this._pcSectorDeg[c]] += chroma[c];
    }

    // Sub-sector weighted hue: energy-weighted circular centroid of all
    // chromatic PCs that map into each degree's hue sector.
    // Falls back to sector center when no energy is present.
    const degreeHues = this._degreeHuesOut;
    for (let d = 0; d < 7; d++) {
      let wx = 0,
        wy = 0,
        wsum = 0;
      for (let c = 0; c < 12; c++) {
        if (this._pcSectorDeg[c] !== d) continue;
        const w = chroma[c];
        if (w <= 0) continue;
        const h = this._chromaHues[c];
        const rad = (h * Math.PI) / 180;
        wx += Math.cos(rad) * w;
        wy += Math.sin(rad) * w;
        wsum += w;
      }
      if (wsum > 1e-6) {
        let a = (Math.atan2(wy, wx) * 180) / Math.PI;
        if (a < 0) a += 360;
        degreeHues[d] = a;
      } else {
        degreeHues[d] = this.key.degreeToHue(d, 0.5);
      }
    }

    // ── Bands: lo/mid/hi octave slices ──────────────────────────
    const span = this._octH - this._octL + 1;
    const cutLo = Math.max(1, Math.floor(span / 3));
    const cutHi = span - cutLo;
    let lo = 0,
      mid = 0,
      hi = 0;
    for (let i = 0; i < N; i++) {
      const oRel = this._octaves[i] - this._octL;
      if (oRel < cutLo) lo += this._noteVals[i];
      else if (oRel >= cutHi) hi += this._noteVals[i];
      else mid += this._noteVals[i];
    }
    const perOct = 12; // notes per octave
    lo = Math.min(1, lo / (perOct * cutLo));
    hi = Math.min(1, hi / (perOct * cutLo));
    mid = Math.min(1, mid / (perOct * Math.max(1, cutHi - cutLo)));

    // ── Derived single-value signals ────────────────────────────
    let briSum = 0;
    for (let i = 0; i < data.length; i++) briSum += data[i];
    const bri = Math.min(1, briSum / (data.length * 180));

    // hue: weighted circular mean of chroma in `key`'s hue space
    const hues = this.key.chromaticHues;
    let sx = 0,
      sy = 0,
      sw = 0;
    for (let c = 0; c < 12; c++) {
      const w = chroma[c];
      if (w <= 0) continue;
      const rad = (hues[c] * Math.PI) / 180;
      sx += Math.cos(rad) * w;
      sy += Math.sin(rad) * w;
      sw += w;
    }
    let hue = this._out.hue;
    let spread = 1;
    if (sw > 1e-6) {
      let a = (Math.atan2(sy, sx) * 180) / Math.PI;
      if (a < 0) a += 360;
      hue = a;
      spread = 1 - Math.sqrt(sx * sx + sy * sy) / sw;
    }

    // act: total movement of the chroma vector frame-to-frame
    let actSum = 0;
    for (let c = 0; c < 12; c++) {
      actSum += Math.abs(chroma[c] - this._chromaPrev[c]);
      this._chromaPrev[c] = chroma[c];
    }
    const act = Math.min(1, actSum * 1.5);

    // sat: top-3 share of normalized chroma (clean chord → high)
    let s0 = 0,
      s1 = 0,
      s2 = 0;
    for (let c = 0; c < 12; c++) {
      const v = chroma[c];
      if (v > s0) {
        s2 = s1;
        s1 = s0;
        s0 = v;
      } else if (v > s1) {
        s2 = s1;
        s1 = v;
      } else if (v > s2) {
        s2 = v;
      }
    }
    const sat = s0 + s1 + s2;

    // ── Chord template lookup ──────────────────────────────────
    let best = CHORD_TEMPLATES[0];
    let bestScore = -1;
    for (const t of CHORD_TEMPLATES) {
      let s = 0;
      for (let c = 0; c < 12; c++) s += t.vec[c] * chroma[c];
      s /= t.norm;
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    // Sticky: prefer the previous chord if it's within 90% of best
    let pick = best;
    if (this._prevChordKey) {
      const prev = CHORD_TEMPLATES.find((t) => t.key === this._prevChordKey);
      if (prev) {
        let s = 0;
        for (let c = 0; c < 12; c++) s += prev.vec[c] * chroma[c];
        s /= prev.norm;
        if (s >= bestScore * 0.9) pick = prev;
      }
    }
    const change = pick.key !== this._prevChordKey;
    this._prevChordKey = pick.key;

    // ── Assemble output ────────────────────────────────────────
    this._out.bands.lo = lo;
    this._out.bands.mid = mid;
    this._out.bands.hi = hi;
    this._out.bri = bri;
    this._out.hi = hi;
    this._out.lo = lo;
    this._out.hue = hue;
    this._out.spread = spread;
    this._out.act = act;
    this._out.sat = sat;
    this._out.chord.label = pick.label;
    this._out.chord.key = pick.key;
    this._out.chord.change = change;
    for (let i = 0; i < N; i++) this._out.notes[i] = this._noteVals[i];

    return this._out;
  }
}
