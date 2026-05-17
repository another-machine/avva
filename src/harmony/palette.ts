/**
 * src/harmony/palette.ts
 *
 * A Palette is the runtime harmonic universe when `?palette=...` is set.
 * Replaces `Key` as the source of chord/hue data for Synth, AudioAnalyzer,
 * and AudioRendererGL.
 *
 * Holds N slots, each with a parsed chord and a bias (sector-width multiplier).
 * Sector boundaries are computed in perceptual (oklch) hue space, proportional
 * to each slot's bias.  `rootHue` (perceptual coords) rotates the entire wheel.
 */

import {
  parseChord,
  parseChordList,
  type ParsedChord,
  type ChordSlotInput,
} from "./chord-parser.js";
import { toPerceptual, fromPerceptual } from "./hue-perception.js";

// ── Module-private helpers ────────────────────────────────────────────────────

const _SHARP_NAMES = [
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaletteSlot {
  index: number;
  chord: ParsedChord;
  bias: number;
  gain: number;
}

export interface HueSlotResult {
  slot: PaletteSlot;
  t: number;
}

export interface HueBlendResult {
  slot: PaletteSlot;
  weight: number;
}

export interface ChordTemplate {
  label: string;
  key: string;
  vec: Float32Array;
  norm: number;
}

export interface PaletteParams {
  slots: ChordSlotInput[];
  rootHue?: number;
  crossZone?: number;
}

// ── Palette class ─────────────────────────────────────────────────────────────

export class Palette {
  rootHue: number;

  private _slots: PaletteSlot[];
  private _N: number;
  private _crossZone: number;
  private _sectorAngles: Float64Array;
  private _listeners: Array<(p: Palette) => void>;

  // Lazy caches
  private _slotHues: Float32Array | null = null;
  private _slotBoundaryHues: Float32Array | null = null;
  private _chordTemplates: ChordTemplate[] | null = null;
  private _pitchClassSet: Float32Array | null = null;

  constructor({ slots, rootHue = 0, crossZone = 0.15 }: PaletteParams) {
    if (!slots || slots.length < 1)
      throw new Error("Palette requires at least one slot.");

    this._slots = slots.map((s, i) => ({
      index: i,
      chord: parseChord(s.chord),
      bias: Math.max(0.001, s.bias ?? 1),
      gain: s.gain ?? 1,
    }));
    this._N = this._slots.length;
    this.rootHue = ((rootHue % 360) + 360) % 360;
    this._crossZone = Math.max(0, Math.min(0.5, crossZone));
    this._listeners = [];
    this._sectorAngles = new Float64Array(this._N + 1);
    this._buildSectorAngles();
  }

  // ── Sector geometry ───────────────────────────────────────────────────────

  private _buildSectorAngles(): void {
    const totalBias = this._slots.reduce((a, s) => a + s.bias, 0);
    let a = 0;
    for (let i = 0; i < this._N; i++) {
      this._sectorAngles[i] = a;
      a += (this._slots[i].bias / totalBias) * 360;
    }
    this._sectorAngles[this._N] = 360;
  }

  private _invalidateCache(): void {
    this._slotHues = null;
    this._slotBoundaryHues = null;
    this._chordTemplates = null;
    this._pitchClassSet = null;
  }

  // ── Core lookup API ───────────────────────────────────────────────────────

  hueToSlot(displayHue: number): HueSlotResult {
    const p = (((toPerceptual(displayHue) - this.rootHue) % 360) + 360) % 360;
    let si = this._N - 1;
    for (let i = 0; i < this._N - 1; i++) {
      if (p < this._sectorAngles[i + 1]) {
        si = i;
        break;
      }
    }
    const w = this._sectorAngles[si + 1] - this._sectorAngles[si];
    const t = w > 0 ? (p - this._sectorAngles[si]) / w : 0;
    return { slot: this._slots[si], t };
  }

  hueToBlend(displayHue: number): HueBlendResult[] {
    if (this._N === 1) return [{ slot: this._slots[0], weight: 1 }];

    const { slot, t } = this.hueToSlot(displayHue);
    const sIdx = slot.index;

    if (t < this._crossZone) {
      const neighborIdx = (sIdx - 1 + this._N) % this._N;
      const w = ((this._crossZone - t) / this._crossZone) * 0.5;
      return [
        { slot: this._slots[sIdx], weight: 1 - w },
        { slot: this._slots[neighborIdx], weight: w },
      ];
    }
    if (t > 1 - this._crossZone) {
      const neighborIdx = (sIdx + 1) % this._N;
      const w = ((t - (1 - this._crossZone)) / this._crossZone) * 0.5;
      return [
        { slot: this._slots[sIdx], weight: 1 - w },
        { slot: this._slots[neighborIdx], weight: w },
      ];
    }
    return [{ slot: this._slots[sIdx], weight: 1 }];
  }

  slotToHue(idx: number, t = 0.5): number {
    const i = ((idx % this._N) + this._N) % this._N;
    const start = this._sectorAngles[i];
    const width = this._sectorAngles[i + 1] - start;
    const p = (((start + t * width + this.rootHue) % 360) + 360) % 360;
    return fromPerceptual(p);
  }

  // ── Getters (lazy, cached) ────────────────────────────────────────────────

  get slots(): PaletteSlot[] {
    return this._slots;
  }

  get slotHues(): Float32Array {
    if (!this._slotHues)
      this._slotHues = Float32Array.from({ length: this._N }, (_, i) =>
        this.slotToHue(i, 0.5),
      );
    return this._slotHues;
  }

  get slotBoundaryHues(): Float32Array {
    if (!this._slotBoundaryHues) {
      this._slotBoundaryHues = Float32Array.from(
        { length: this._N + 1 },
        (_, i) => {
          if (i === this._N) return this.slotToHue(0, 0);
          return this.slotToHue(i, 0);
        },
      );
    }
    return this._slotBoundaryHues;
  }

  get chordTemplates(): ChordTemplate[] {
    if (!this._chordTemplates) {
      this._chordTemplates = this._slots.map((s) => {
        const pcs = s.chord.pitchClasses;
        const vec = new Float32Array(12);
        for (const pc of pcs) vec[pc] = 1;
        const keyStr = pcs
          .map((pc) => _SHARP_NAMES[pc])
          .sort()
          .join("-");
        return {
          label: s.chord.label,
          key: keyStr,
          vec,
          norm: Math.sqrt(pcs.length),
        };
      });
    }
    return this._chordTemplates;
  }

  get pitchClassSet(): Float32Array {
    if (!this._pitchClassSet) {
      const out = new Float32Array(12);
      for (const s of this._slots) {
        for (const pc of s.chord.pitchClasses) {
          if (s.gain > out[pc]) out[pc] = s.gain;
        }
      }
      this._pitchClassSet = out;
    }
    return this._pitchClassSet;
  }

  // ── Live update API ───────────────────────────────────────────────────────

  setRootHue(p: number): void {
    this.rootHue = ((p % 360) + 360) % 360;
    this._invalidateCache();
    this._emit();
  }

  setSlots(newSlots: ChordSlotInput[]): void {
    this._slots = newSlots.map((s, i) => ({
      index: i,
      chord: parseChord(s.chord),
      bias: Math.max(0.001, s.bias ?? 1),
      gain: s.gain ?? 1,
    }));
    this._N = this._slots.length;
    this._sectorAngles = new Float64Array(this._N + 1);
    this._buildSectorAngles();
    this._invalidateCache();
    this._emit();
  }

  setSlotBias(idx: number, bias: number): void {
    this._slots[idx].bias = Math.max(0.001, bias);
    this._buildSectorAngles();
    this._invalidateCache();
    this._emit();
  }

  setCrossZone(z: number): void {
    this._crossZone = Math.max(0, Math.min(0.5, z));
    this._emit();
  }

  onChange(fn: (p: Palette) => void): () => void {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  private _emit(): void {
    for (const fn of this._listeners) fn(this);
  }

  // ── Static factory ────────────────────────────────────────────────────────

  static fromURLParam(
    str: string,
    opts: { rootHue?: number; crossZone?: number } = {},
  ): Palette {
    return new Palette({
      slots: parseChordList(str),
      rootHue: opts.rootHue ?? 0,
      crossZone: opts.crossZone ?? 0.15,
    });
  }
}
