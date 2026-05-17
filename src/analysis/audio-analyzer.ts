/**
 * src/analysis/audio-analyzer.ts
 *
 * Polyphonic chromatic + EQ analysis from a Web Audio source.
 * Source-agnostic: connect any AudioNode (mic, synth master, tab capture).
 *
 * TypeScript port of modules/audio-analyzer.js. Behaviour is identical.
 *
 * Per-frame output (`tick()` return value):
 *   chroma[12]    pitch-class energy, normalised to sum 1 when signal present
 *   degrees[7]    diatonic degree energy aggregated from chroma
 *   degreeHues[7] energy-weighted hue per degree
 *   bands         { lo, mid, hi } octave-band energies 0..1
 *   hue           weighted circular mean hue of chroma
 *   spread        1 − resultant length  (0 = focused, 1 = full spectrum)
 *   bri           full-band RMS-ish loudness 0..1
 *   hi / lo       bands.hi / bands.lo
 *   act           L1 chroma delta vs previous frame
 *   sat           top-3 chroma share  (high = clean chord)
 *   chord         { label, key, change } — sticky best-template match
 *   notes[N]      per-(class,octave) prominence
 *   slots?        palette-mode slot weights (only when palette !== null)
 *   slotHues?     palette slot center hues  (only when palette !== null)
 */

import { Key } from "../harmony/music.js";
import { Palette, type ChordTemplate } from "../harmony/palette.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
] as const;

function noteFreq(c: number, o: number): number {
  return 440 * Math.pow(2, ((o - 4) * 12 + c - 9) / 12);
}

// ── Built-in chord templates (84 = 12 roots × 7 types) ───────────────────────

const CHORD_TYPES: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
};

const CHORD_SUFFIX: Record<string, string> = {
  maj: "",
  min: "m",
  dim: "°",
  aug: "+",
  maj7: "M7",
  min7: "m7",
  dom7: "7",
};

interface BuiltChordTemplate extends ChordTemplate {
  type: string;
  root: number;
}

function buildChordTemplates(): BuiltChordTemplate[] {
  const out: BuiltChordTemplate[] = [];
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AudioAnalyzerParams {
  audioContext: AudioContext;
  key?: Key;
  palette?: Palette | null;
  opts?: {
    fftSize?: number;
    smoothing?: number;
    attack?: number;
    release?: number;
    gateExp?: number;
    octaveLow?: number;
    octaveHigh?: number;
  };
}

export interface AudioBands {
  lo: number;
  mid: number;
  hi: number;
}

export interface AudioChord {
  label: string;
  key: string;
  change: boolean;
}

export interface AudioFrame {
  chroma: Float32Array;
  degrees: Float32Array;
  degreeHues: Float32Array;
  bands: AudioBands;
  hue: number;
  spread: number;
  bri: number;
  hi: number;
  lo: number;
  act: number;
  sat: number;
  chord: AudioChord;
  notes: Float32Array;
  slots?: Float32Array;
  slotHues?: Float32Array;
}

export interface NoteInfo {
  chromatic: number;
  octave: number;
  name: string;
  freq: number;
  bin: number;
}

// ── AudioAnalyzer ─────────────────────────────────────────────────────────────

export class AudioAnalyzer {
  key: Key;
  palette: Palette | null;
  readonly analyser: AnalyserNode;

  private readonly _actx: AudioContext;
  private readonly _attack: number;
  private readonly _release: number;
  private readonly _gateExp: number;
  private readonly _octL: number;
  private readonly _octH: number;
  private readonly _freqData: Uint8Array<ArrayBuffer>;
  private readonly _binHz: number;
  private _paletteUnsubscribe: (() => void) | null = null;
  private _slotsOut: Float32Array | null;

  readonly noteInfo: NoteInfo[];
  private readonly _N: number;
  private readonly _bins: Int32Array;
  private readonly _chromas: Int8Array;
  private readonly _octaves: Int8Array;

  private readonly _noteVals: Float32Array;
  private readonly _chroma: Float32Array;
  private readonly _chromaPrev: Float32Array;
  private readonly _degrees: Float32Array;
  private readonly _degreeHuesOut: Float32Array;

  private _chromaHues: Float32Array;
  private _pcSectorDeg: Int8Array;
  private _degreePCs: Int8Array;
  private _prevChordKey = "";
  private readonly _out: AudioFrame;

  constructor({
    audioContext,
    key,
    palette = null,
    opts = {},
  }: AudioAnalyzerParams) {
    this._actx = audioContext;
    this.key = key ?? new Key();
    this.palette = palette;

    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = opts.fftSize ?? 32768;
    this.analyser.smoothingTimeConstant = opts.smoothing ?? 0.85;

    this._attack = opts.attack ?? 0.25;
    this._release = opts.release ?? 0.06;
    this._gateExp = opts.gateExp ?? 50;
    this._octL = opts.octaveLow ?? 2;
    this._octH = opts.octaveHigh ?? 6;

    const bins = this.analyser.frequencyBinCount;
    this._freqData = new Uint8Array(bins) as Uint8Array<ArrayBuffer>;
    this._binHz = audioContext.sampleRate / this.analyser.fftSize;

    // Build per-note table (octaves × 12 classes)
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

    this._bins = new Int32Array(this._N);
    this._chromas = new Int8Array(this._N);
    this._octaves = new Int8Array(this._N);
    for (let i = 0; i < this._N; i++) {
      this._bins[i] = this.noteInfo[i].bin;
      this._chromas[i] = this.noteInfo[i].chromatic;
      this._octaves[i] = this.noteInfo[i].octave;
    }

    this._noteVals = new Float32Array(this._N);
    this._chroma = new Float32Array(12);
    this._chromaPrev = new Float32Array(12);
    this._degrees = new Float32Array(7);
    this._degreeHuesOut = new Float32Array(7);
    this._pcSectorDeg = new Int8Array(12);
    this._degreePCs = new Int8Array(7);
    this._chromaHues = this.key.chromaticHues;

    this._slotsOut = palette ? new Float32Array(palette.slots.length) : null;
    if (palette) {
      this._paletteUnsubscribe = palette.onChange(() => {
        const newN = palette.slots.length;
        if (!this._slotsOut || this._slotsOut.length !== newN) {
          this._slotsOut = new Float32Array(newN);
        }
      });
    }

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

  /** Connect any AudioNode as the analyser's input. */
  connect(node: AudioNode): void {
    node.connect(this.analyser);
  }

  /** Swap the Key (e.g. user changed root/mode mid-session). */
  setKey(key: Key): void {
    this.key = key;
    this._rebuildKeyTables();
  }

  /** Swap the Palette (pass null to revert to Key mode). */
  setPalette(p: Palette | null): void {
    if (this._paletteUnsubscribe) {
      this._paletteUnsubscribe();
      this._paletteUnsubscribe = null;
    }
    this.palette = p;
    if (p) {
      this._slotsOut = new Float32Array(p.slots.length);
      this._paletteUnsubscribe = p.onChange(() => {
        const newN = p.slots.length;
        if (!this._slotsOut || this._slotsOut.length !== newN) {
          this._slotsOut = new Float32Array(newN);
        }
      });
    } else {
      this._slotsOut = null;
    }
  }

  /** Rebuild key-dependent lookup tables (call after mutating key.rootHue). */
  rebuildKeyTables(): void {
    this._rebuildKeyTables();
  }

  private _rebuildKeyTables(): void {
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

  /** Analyze one audio frame. Call every RAF tick. */
  tick(): AudioFrame {
    this.analyser.getByteFrequencyData(this._freqData);

    const N = this._N;
    const data = this._freqData;
    const bins = this._bins;
    const gateExp = this._gateExp;
    const attack = this._attack;
    const release = this._release;

    // ── Per-note prominence with neighbor-peak gate ───────────────────────────
    // Reject ±1, ±2 semitone and octave±semitone neighbors; keep pure octaves
    // so the same pitch class across octaves still contributes.
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
      const raw = Math.pow(Math.min(1, gated / 128), gateExp);
      const prev = this._noteVals[i];
      this._noteVals[i] = prev + (raw - prev) * (raw < prev ? release : attack);
    }

    // ── Aggregate to 12-class chroma ──────────────────────────────────────────
    const chroma = this._chroma;
    chroma.fill(0);
    for (let i = 0; i < N; i++) chroma[this._chromas[i]] += this._noteVals[i];
    let chromaSum = 0;
    for (let c = 0; c < 12; c++) chromaSum += chroma[c];
    if (chromaSum > 1e-6) {
      const inv = 1 / chromaSum;
      for (let c = 0; c < 12; c++) chroma[c] *= inv;
    }

    // ── Aggregate to 7 diatonic degrees ──────────────────────────────────────
    const degrees = this._degrees;
    degrees.fill(0);
    for (let c = 0; c < 12; c++) degrees[this._pcSectorDeg[c]] += chroma[c];

    // Sub-sector weighted hue: energy-weighted circular centroid per degree
    const degreeHues = this._degreeHuesOut;
    for (let d = 0; d < 7; d++) {
      let wx = 0,
        wy = 0,
        wsum = 0;
      for (let c = 0; c < 12; c++) {
        if (this._pcSectorDeg[c] !== d) continue;
        const w = chroma[c];
        if (w <= 0) continue;
        const rad = (this._chromaHues[c] * Math.PI) / 180;
        wx += Math.cos(rad) * w;
        wy += Math.sin(rad) * w;
        wsum += w;
      }
      degreeHues[d] =
        wsum > 1e-6
          ? (() => {
              let a = (Math.atan2(wy, wx) * 180) / Math.PI;
              return a < 0 ? a + 360 : a;
            })()
          : this.key.degreeToHue(d, 0.5);
    }

    // ── Octave bands: lo / mid / hi ───────────────────────────────────────────
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
    const perOct = 12;
    lo = Math.min(1, lo / (perOct * cutLo));
    hi = Math.min(1, hi / (perOct * cutLo));
    mid = Math.min(1, mid / (perOct * Math.max(1, cutHi - cutLo)));

    // ── Full-band loudness ────────────────────────────────────────────────────
    let briSum = 0;
    for (let i = 0; i < data.length; i++) briSum += data[i];
    const bri = Math.min(1, briSum / (data.length * 180));

    // ── Hue: weighted circular mean of chroma in key's hue space ─────────────
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

    // ── Activity: L1 chroma delta ─────────────────────────────────────────────
    let actSum = 0;
    for (let c = 0; c < 12; c++) {
      actSum += Math.abs(chroma[c] - this._chromaPrev[c]);
      this._chromaPrev[c] = chroma[c];
    }
    const act = Math.min(1, actSum * 1.5);

    // ── Saturation: top-3 chroma share ────────────────────────────────────────
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

    // ── Chord template lookup ─────────────────────────────────────────────────
    type AnyTemplate = BuiltChordTemplate | ChordTemplate;
    let best: AnyTemplate;
    let bestScore = -1;

    if (this.palette) {
      const slotsOut = this._slotsOut!;
      const templates = this.palette.chordTemplates;
      best = templates[0];
      for (let i = 0; i < templates.length; i++) {
        const t = templates[i];
        let s = 0;
        for (let c = 0; c < 12; c++) s += t.vec[c] * chroma[c];
        s /= t.norm;
        slotsOut[i] = Math.max(0, s);
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
    } else {
      best = CHORD_TEMPLATES[0];
      for (const t of CHORD_TEMPLATES) {
        let s = 0;
        for (let c = 0; c < 12; c++) s += t.vec[c] * chroma[c];
        s /= t.norm;
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
      }
    }

    // Sticky: prefer the previous chord when it scores ≥ 90% of best
    const searchBank: readonly AnyTemplate[] = this.palette
      ? this.palette.chordTemplates
      : CHORD_TEMPLATES;
    let pick = best;
    if (this._prevChordKey) {
      const prev = searchBank.find((t) => t.key === this._prevChordKey);
      if (prev) {
        let s = 0;
        for (let c = 0; c < 12; c++) s += prev.vec[c] * chroma[c];
        s /= prev.norm;
        if (s >= bestScore * 0.9) pick = prev;
      }
    }
    const change = pick.key !== this._prevChordKey;
    this._prevChordKey = pick.key;

    // ── Assemble output ───────────────────────────────────────────────────────
    if (this.palette) {
      this._out.slots = this._slotsOut!;
      this._out.slotHues = this.palette.slotHues;
    } else {
      this._out.slots = undefined;
      this._out.slotHues = undefined;
    }
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
