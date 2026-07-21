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

import { Palette, type ChordTemplate } from "../harmony/palette.js";
import { AUDIO_EQ_FREQS } from "../store/schema.js";
import { AutoRange } from "./auto-range.js";

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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AudioAnalyzerParams {
  audioContext: AudioContext;
  palette: Palette;
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

export interface ChordCandidate {
  slotIdx: number;
  score: number;
  label: string;
}

export interface AudioFrame {
  chroma: Float32Array;
  slots: Float32Array;
  slotHues: Float32Array;
  slotBoundaryHues: Float32Array;
  /**
   * Per-slot directional edge bias in [-1, +1] derived from where the
   * continuous audio hue sits within / relative to each slot's arc.
   *   -1 → bias toward the slot's left boundary
   *   +1 → bias toward the slot's right boundary
   *    0 → centered (or audio hue is too far away to influence this slot)
   */
  slotEdge: Float32Array;
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
  /** Top-3 chord template matches by raw dot-product score. */
  candidates: ChordCandidate[];
  /** How centered the audio hue is within the winning slot: 1=dead-center, 0=at edge. */
  bandClarity: number;
  /** True when the 90%-sticky rule overrode the highest-scoring template. */
  stickyApplied: boolean;
  /** Per-(octave, class) note metadata — same indexing as notes[]. */
  noteInfo: NoteInfo[];
  // canonical aligned axes (audio side ↔ video side)
  tilt: number;  // spectral centroid 0..1 (low→high); mirrors video tilt (vy)
  pos: number;   // stereo L/R balance 0..1 (left→right); mirrors video pos (mx)
  ctr: number;   // spectral peakiness 0..1; mirrors video contrast
  /** Un-normalized loudness — auto-range never touches this. The renderer's
   *  extremes depths (true black / white wash) key off it. */
  briRaw?: number;
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
  palette: Palette;
  readonly analyser: AnalyserNode;
  /** EQ head — connect input sources here (feeds the 8-band EQ → analyser). */
  readonly input: AudioNode;

  private readonly _actx: AudioContext;
  private readonly _eq: BiquadFilterNode[];
  private readonly _attack: number;
  private readonly _release: number;
  private readonly _gateExp: number;
  private readonly _octL: number;
  private readonly _octH: number;
  private readonly _freqData: Uint8Array<ArrayBuffer>;
  private readonly _binHz: number;
  private _paletteUnsubscribe: (() => void) | null = null;
  private _slotsOut: Float32Array;
  private _slotEdgeOut: Float32Array;
  private _splitter: ChannelSplitterNode | null = null;
  private _analyserL: AnalyserNode | null = null;
  private _analyserR: AnalyserNode | null = null;
  private _freqDataL: Uint8Array<ArrayBuffer> | null = null;
  private _freqDataR: Uint8Array<ArrayBuffer> | null = null;
  private _posSmooth = 0.5;

  readonly noteInfo: NoteInfo[];
  private readonly _N: number;
  private readonly _bins: Int32Array;
  private readonly _chromas: Int8Array;
  private readonly _octaves: Int8Array;

  private readonly _noteVals: Float32Array;
  private readonly _chroma: Float32Array;
  private readonly _chromaPrev: Float32Array;

  // Static chroma hues: pc * 30 degrees
  private readonly _chromaHues: Float32Array = Float32Array.from(
    { length: 12 },
    (_, pc) => pc * 30,
  );

  private _prevChordKey = "";
  private readonly _out: AudioFrame;

  // Auto-range ("forgiving constraints") — set from the store via setAutoRange.
  private readonly _autoRange = new AutoRange();
  private _autoRangeAmt = 0;
  private _autoRangeWin = 75;

  constructor({ audioContext, palette, opts = {} }: AudioAnalyzerParams) {
    this._actx = audioContext;
    this.palette = palette;

    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = opts.fftSize ?? 32768;
    this.analyser.smoothingTimeConstant = opts.smoothing ?? 0.85;

    // ── 8-band pre-analysis EQ (device-local calibration) ──────
    // input → peaking(b0) → … → peaking(b7) → analyser. At 0 dB the chain is
    // transparent; gains are driven live by the audioEq.* store keys via
    // setEqGain(). This shapes what the analyser hears, not the audio output.
    this.input = audioContext.createGain();
    this._eq = AUDIO_EQ_FREQS.map((f) => {
      const b = audioContext.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = 1.0;
      b.gain.value = 0;
      return b;
    });
    let eqPrev: AudioNode = this.input;
    for (const b of this._eq) {
      eqPrev.connect(b);
      eqPrev = b;
    }
    eqPrev.connect(this.analyser);

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

    this._slotsOut = new Float32Array(palette.slots.length);
    this._slotEdgeOut = new Float32Array(palette.slots.length);
    this._paletteUnsubscribe = palette.onChange(() => {
      const newN = palette.slots.length;
      if (this._slotsOut.length !== newN) {
        this._slotsOut = new Float32Array(newN);
        this._slotEdgeOut = new Float32Array(newN);
      }
    });

    this._out = {
      chroma: this._chroma,
      slots: this._slotsOut,
      slotHues: palette.slotHues,
      slotBoundaryHues: palette.slotBoundaryHues,
      slotEdge: this._slotEdgeOut,
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
      candidates: [],
      bandClarity: 0,
      stickyApplied: false,
      noteInfo: this.noteInfo,
      tilt: 0.5,
      pos: 0.5,
      ctr: 0,
    };
  }

  /** Connect any AudioNode as the analyser's input (through the EQ). */
  connect(node: AudioNode): void {
    node.connect(this.input);
  }

  /** Set one EQ band's gain in dB (0 = flat). Band index 0..7. */
  setEqGain(band: number, db: number): void {
    const b = this._eq[band];
    if (b) b.gain.value = db;
  }

  /** Auto-range amount (0 = raw, 1 = fully normalized) and window in seconds. */
  setAutoRange(amount: number, windowSec: number): void {
    this._autoRangeAmt = Math.max(0, Math.min(1, amount));
    this._autoRangeWin = Math.max(1, windowSec);
  }

  /** Connect a stereo source for L/R balance analysis (pos axis). */
  connectStereo(node: AudioNode): void {
    const splitter = this._actx.createChannelSplitter(2);
    const analyserL = this._actx.createAnalyser();
    const analyserR = this._actx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserR.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.7;
    analyserR.smoothingTimeConstant = 0.7;
    node.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    this._splitter = splitter;
    this._analyserL = analyserL;
    this._analyserR = analyserR;
    this._freqDataL = new Uint8Array(analyserL.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this._freqDataR = new Uint8Array(analyserR.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  /** Swap the Palette. */
  setPalette(p: Palette): void {
    if (this._paletteUnsubscribe) {
      this._paletteUnsubscribe();
      this._paletteUnsubscribe = null;
    }
    this.palette = p;
    this._slotsOut = new Float32Array(p.slots.length);
    this._slotEdgeOut = new Float32Array(p.slots.length);
    this._out.slots = this._slotsOut;
    this._out.slotEdge = this._slotEdgeOut;
    this._out.slotHues = p.slotHues;
    this._out.slotBoundaryHues = p.slotBoundaryHues;
    this._paletteUnsubscribe = p.onChange(() => {
      const newN = p.slots.length;
      if (this._slotsOut.length !== newN) {
        this._slotsOut = new Float32Array(newN);
        this._slotEdgeOut = new Float32Array(newN);
        this._out.slots = this._slotsOut;
        this._out.slotEdge = this._slotEdgeOut;
      }
      this._out.slotHues = p.slotHues;
      this._out.slotBoundaryHues = p.slotBoundaryHues;
    });
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

    // ── Canonical axes: tilt (raw FFT energy split), ctr (peakiness), pos (stereo) ─
    // Tilt: ratio of high-frequency to total energy, split at ~1.5 kHz.
    // Cap loop at 12 kHz — bins above that are always empty for synth content,
    // and including them only adds noise to the ratio with no signal benefit.
    const crossBin = Math.min(data.length - 1, Math.round(1500 / this._binHz));
    const tiltBinMax = Math.min(data.length, Math.ceil(12000 / this._binHz));
    let tiltLo = 0, tiltHi = 0;
    for (let i = 0; i < tiltBinMax; i++) {
      if (i < crossBin) tiltLo += data[i];
      else tiltHi += data[i];
    }
    const rawTilt = tiltHi / (tiltHi + tiltLo + 1);

    let valSum = 0, logSum = 0, logN = 0;
    for (let i = 0; i < N; i++) {
      const v = this._noteVals[i];
      if (v > 1e-9) { valSum += v; logSum += Math.log(v); logN++; }
    }
    const arith = logN > 0 ? valSum / logN : 0;
    const geom = logN > 0 ? Math.exp(logSum / logN) : 0;
    const ctr = arith > 1e-9 ? Math.max(0, 1 - geom / arith) : 0;

    let rawPos = 0.5;
    if (this._freqDataL && this._freqDataR && this._analyserL && this._analyserR) {
      this._analyserL.getByteFrequencyData(this._freqDataL);
      this._analyserR.getByteFrequencyData(this._freqDataR);
      let sumL = 0, sumR = 0;
      for (let i = 0; i < this._freqDataL.length; i++) {
        sumL += this._freqDataL[i];
        sumR += this._freqDataR[i];
      }
      rawPos = 0.5 + 0.5 * (sumR - sumL) / (sumR + sumL + 1);
    }
    this._posSmooth += (rawPos - this._posSmooth) * 0.15;

    // ── Full-band loudness ────────────────────────────────────────────────────
    // Cap at 10 kHz. For tonal (synth) content only a tiny fraction of bins
    // carry energy, so dividing by all briBinMax bins produces a ~90× underestimate.
    // Dividing by (briBinMax * 2) corrects for ~1% active bin density while
    // still scaling gracefully for broadband (mic/voice) input.
    const briBinMax = Math.min(data.length, Math.ceil(10000 / this._binHz));
    let briSum = 0;
    for (let i = 0; i < briBinMax; i++) briSum += data[i];
    const bri = Math.min(1, briSum / (briBinMax * 4));
    const hasSignal = bri > 0.015;

    // ── Hue: weighted circular mean of chroma (static pc*30 hue space) ────────
    const hues = this._chromaHues;
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
    let best: ChordTemplate;
    let bestScore = -1;

    // Track top-3 candidates by score for the monitor
    const candidateHeap: { slotIdx: number; score: number; label: string }[] = [];

    {
      const slotsOut = this._slotsOut;
      const templates = this.palette.chordTemplates;
      best = templates[0];
      for (let i = 0; i < templates.length; i++) {
        const t = templates[i];
        let s = 0;
        for (let c = 0; c < 12; c++) s += t.vec[c] * chroma[c];
        s /= t.norm;
        if (hasSignal) slotsOut[i] = Math.max(0, s);
        if (s > bestScore) {
          bestScore = s;
          best = t;
        }
        candidateHeap.push({ slotIdx: i, score: hasSignal ? Math.max(0, s) : slotsOut[i], label: t.label });
      }
    }
    candidateHeap.sort((a, b) => b.score - a.score);
    const topCandidates = candidateHeap.slice(0, 3);
    const bandClarity = topCandidates.length >= 2 && topCandidates[0].score > 0
      ? Math.max(0, (topCandidates[0].score - topCandidates[1].score) / topCandidates[0].score)
      : topCandidates.length > 0 && topCandidates[0].score > 0 ? 1 : 0;

    // Sticky: prefer the previous chord when it scores ≥ 90% of best
    const searchBank = this.palette.chordTemplates;
    let pick = best;
    let stickyApplied = false;
    if (this._prevChordKey) {
      const prev = searchBank.find((t) => t.key === this._prevChordKey);
      if (prev) {
        let s = 0;
        for (let c = 0; c < 12; c++) s += prev.vec[c] * chroma[c];
        s /= prev.norm;
        if (s >= bestScore * 0.9) {
          pick = prev;
          stickyApplied = pick !== best;
        }
      }
    }
    const change = hasSignal && pick.key !== this._prevChordKey;
    if (hasSignal) this._prevChordKey = pick.key;

    // ── Per-slot directional edge bias ───────────────────────────────────────
    // Derived from the chord-template slot weights (NOT audio.hue, which lives
    // in chroma-class space and is unrelated to the palette's display-hue
    // arrangement). For the winning slot, the bias points toward whichever
    // neighbor has more template weight, scaled by how ambiguous the win is.
    // Immediate neighbors carry a fixed ±1 toward the boundary they share with
    // the winner, so when crossZone lights them up their blob colors pull
    // toward the winner's hue.
    const slotEdge = this._slotEdgeOut;
    const nSlots = this.palette.slots.length;
    if (hasSignal && nSlots > 0) {
      let winnerIdx = 0;
      let winnerScore = -1;
      for (let i = 0; i < nSlots; i++) {
        const s = this._slotsOut[i];
        if (s > winnerScore) { winnerScore = s; winnerIdx = i; }
      }
      const rightIdx = (winnerIdx + 1) % nSlots;
      const leftIdx = (winnerIdx - 1 + nSlots) % nSlots;
      const wR = this._slotsOut[rightIdx];
      const wL = this._slotsOut[leftIdx];
      const neighborSum = wR + wL;
      // Direction: -1 = pure-left lean, +1 = pure-right lean
      const dir = neighborSum > 1e-6 ? (wR - wL) / neighborSum : 0;
      // Ambiguity: how much energy is in neighbors vs. winner (0 = clean win, 1 = even)
      const ambiguity = winnerScore > 1e-6
        ? Math.min(1, neighborSum / winnerScore)
        : 0;
      const winnerBias = dir * ambiguity;
      for (let i = 0; i < nSlots; i++) {
        if (i === winnerIdx) slotEdge[i] = winnerBias;
        else if (i === rightIdx) slotEdge[i] = -1;
        else if (i === leftIdx) slotEdge[i] = +1;
        else slotEdge[i] = 0;
      }
    }

    // ── Assemble output ───────────────────────────────────────────────────────
    this._out.slots = this._slotsOut;
    this._out.slotEdge = this._slotEdgeOut;
    this._out.slotHues = this.palette.slotHues;
    this._out.slotBoundaryHues = this.palette.slotBoundaryHues;
    this._out.bands.lo = lo;
    this._out.bands.mid = mid;
    this._out.bands.hi = hi;
    this._out.bri = bri;
    this._out.hi = hi;
    this._out.lo = lo;
    if (hasSignal) this._out.hue = hue;
    if (hasSignal) this._out.spread = spread;
    this._out.act = act;
    this._out.sat = sat;
    this._out.chord.label = pick.label;
    this._out.chord.key = pick.key;
    this._out.chord.change = change;
    this._out.candidates = topCandidates;
    this._out.bandClarity = bandClarity;
    this._out.stickyApplied = stickyApplied;
    this._out.noteInfo = this.noteInfo;
    for (let i = 0; i < N; i++) this._out.notes[i] = this._noteVals[i];
    this._out.tilt += (rawTilt - this._out.tilt) * 0.15;
    this._out.pos = this._posSmooth;
    this._out.ctr = ctr;

    // Auto-range projection ("forgiving constraints"): the snapshot's six
    // canonical axes are adaptively normalized so the visuals see full-range
    // swings from whatever this mix actually produces; _out stays raw
    // smoothing state and briRaw carries the absolute loudness for extremes.
    const amt = this._autoRangeAmt;
    const win = this._autoRangeWin;
    this._autoRange.tick(performance.now());

    // Return a snapshot with deep-copied typed arrays so per-frame probes
    // (telemetry, pipeline stages) hold immutable data after the next tick.
    return {
      chroma: new Float32Array(this._out.chroma),
      slots: new Float32Array(this._out.slots),
      slotHues: this._out.slotHues,
      slotBoundaryHues: this._out.slotBoundaryHues,
      slotEdge: new Float32Array(this._out.slotEdge),
      bands: { ...this._out.bands },
      hue: this._out.hue,
      spread: this._autoRange.apply("spread", this._out.spread, amt, win),
      bri: this._autoRange.apply("bri", this._out.bri, amt, win),
      briRaw: this._out.bri,
      hi: this._out.hi,
      lo: this._out.lo,
      act: this._autoRange.apply("act", this._out.act, amt, win),
      sat: this._out.sat,
      chord: { ...this._out.chord },
      notes: new Float32Array(this._out.notes),
      candidates: this._out.candidates,
      bandClarity: this._out.bandClarity,
      stickyApplied: this._out.stickyApplied,
      noteInfo: this._out.noteInfo,
      tilt: this._autoRange.apply("tilt", this._out.tilt, amt, win),
      pos: this._autoRange.apply("pos", this._out.pos, amt, win),
      ctr: this._autoRange.apply("ctr", this._out.ctr, amt, win),
    };
  }
}
