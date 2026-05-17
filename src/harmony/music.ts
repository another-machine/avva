/**
 * src/harmony/music.ts
 *
 * Minimal music theory for AVVA.
 *
 * Maps hue (0–360° display/HSV) to diatonic scale degrees via a
 * perceptually-uniform sector layout.  The hue wheel is divided into
 * 7 equal arcs of 360/7° each in *oklch perceptual* space.
 *
 * rootHue is stored in perceptual coordinates.  setRootHueFromDisplay()
 * converts from display before storing.
 */

import { toPerceptual, fromPerceptual } from "./hue-perception.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SCALE_STEPS: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

const DEGREE_QUALITIES: Record<string, readonly string[]> = {
  major: ["maj", "min", "min", "maj", "maj", "min", "dim"],
  minor: ["min", "dim", "maj", "min", "min", "maj", "maj"],
  dorian: ["min", "min", "maj", "maj", "min", "dim", "maj"],
  phrygian: ["min", "maj", "maj", "min", "dim", "maj", "min"],
  lydian: ["maj", "maj", "min", "dim", "maj", "min", "min"],
  mixolydian: ["maj", "min", "dim", "maj", "min", "min", "maj"],
  locrian: ["dim", "maj", "min", "min", "maj", "maj", "min"],
};

const TRIAD_OFFSETS: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
};

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
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

// Diatonic circle-of-fifths order on the hue wheel (sector→degree / degree→sector).
const DIATONIC_FIFTHS = [0, 4, 1, 5, 2, 6, 3] as const; // sector → degree
const DIATONIC_FIFTHS_INV = [0, 2, 4, 6, 1, 3, 5] as const; // degree → sector

function noteFreq(chromaticIndex: number, octave: number): number {
  return 440 * Math.pow(2, (chromaticIndex - 9 + (octave - 4) * 12) / 12);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScaleMode = keyof typeof SCALE_STEPS;
export type TriadQuality = "maj" | "min" | "dim" | "aug";

export interface TriadNote {
  name: string;
  freq: number;
}

export interface DegreeInfo {
  degree: number;
  name: string;
  octave: number;
  freq: number;
  quality: string;
  numeral: string;
  triad: TriadNote[];
}

export interface HueToNoteResult extends DegreeInfo {
  t: number;
}

export interface BlendResult {
  blendDegree: number;
  blendFactor: number;
}

export interface KeyParams {
  root?: string;
  mode?: string;
  octave?: number;
  rootHue?: number;
}

// ── Key class ─────────────────────────────────────────────────────────────────

export class Key {
  root: string;
  mode: string;
  octave: number;
  rootHue: number;
  degrees: DegreeInfo[];

  private _rootIdx: number;
  private _listeners: Array<(key: Key) => void>;
  private _degreeHues: Float32Array | null = null;
  private _chromaticHues: Float32Array | null = null;

  constructor({
    root = "C",
    mode = "major",
    octave = 4,
    rootHue = 0,
  }: KeyParams = {}) {
    this.root = root;
    this.mode = mode;
    this.octave = octave;
    this.rootHue = ((rootHue % 360) + 360) % 360;
    const rootIdx = NOTE_NAMES.indexOf(root as (typeof NOTE_NAMES)[number]);
    if (rootIdx === -1) throw new Error(`Unknown root note: "${root}"`);
    this._rootIdx = rootIdx;
    this._listeners = [];
    this.degrees = this._build();
  }

  get label(): string {
    return `${this.root} ${this.mode}`;
  }

  // ── Hue cache invalidation ────────────────────────────────────────────────

  private _invalidateHueCache(): void {
    this._degreeHues = null;
    this._chromaticHues = null;
  }

  // ── Live rootHue mutation ─────────────────────────────────────────────────

  setRootHue(p: number): void {
    this.rootHue = ((p % 360) + 360) % 360;
    this._invalidateHueCache();
    this._emit();
  }

  setRootHueFromDisplay(h: number): void {
    this.setRootHue(toPerceptual(h));
  }

  // ── Change listeners ─────────────────────────────────────────────────────

  onChange(fn: (key: Key) => void): () => void {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  private _emit(): void {
    for (const fn of this._listeners) fn(this);
  }

  private _build(): DegreeInfo[] {
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    const qualities = DEGREE_QUALITIES[this.mode] ?? DEGREE_QUALITIES.major;

    return steps.map((st, i) => {
      const abs = this._rootIdx + st;
      const cidx = abs % 12;
      const oct = this.octave + Math.floor(abs / 12);
      const name = NOTE_NAMES[cidx];
      const quality = qualities[i];
      const freq = noteFreq(cidx, oct);

      const triad = (TRIAD_OFFSETS[quality] ?? TRIAD_OFFSETS.maj).map((off) => {
        const ti = (cidx + off) % 12;
        const to = oct + Math.floor((cidx + off) / 12);
        return { name: NOTE_NAMES[ti], freq: noteFreq(ti, to) };
      });

      const numeral =
        quality === "maj"
          ? ROMAN[i]
          : quality === "min"
            ? ROMAN[i].toLowerCase()
            : quality === "dim"
              ? ROMAN[i].toLowerCase() + "°"
              : ROMAN[i] + "+";

      return { degree: i, name, octave: oct, freq, quality, numeral, triad };
    });
  }

  // ── Hue ↔ degree mapping ──────────────────────────────────────────────────

  hueToNote(hue: number): HueToNoteResult {
    const p = (((toPerceptual(hue) - this.rootHue) % 360) + 360) % 360;
    const w = 360 / 7;
    const si = Math.min(6, Math.floor(p / w));
    const t = (p - si * w) / w;
    return { ...this.degrees[DIATONIC_FIFTHS[si]], t };
  }

  hueToBlend(hue: number, crossZone = 0.25): BlendResult {
    const p = (((toPerceptual(hue) - this.rootHue) % 360) + 360) % 360;
    const w = 360 / 7;
    const si = Math.min(6, Math.floor(p / w));
    const t = (p - si * w) / w;
    if (t < crossZone) {
      return {
        blendDegree: DIATONIC_FIFTHS[(si + 6) % 7],
        blendFactor: ((crossZone - t) / crossZone) * 0.5,
      };
    }
    if (t > 1 - crossZone) {
      return {
        blendDegree: DIATONIC_FIFTHS[(si + 1) % 7],
        blendFactor: ((t - (1 - crossZone)) / crossZone) * 0.5,
      };
    }
    return { blendDegree: DIATONIC_FIFTHS[si], blendFactor: 0 };
  }

  degreeToHue(degree: number, t = 0.5): number {
    const d = ((degree % 7) + 7) % 7;
    const si = DIATONIC_FIFTHS_INV[d];
    const w = 360 / 7;
    const p = (((si * w + t * w + this.rootHue) % 360) + 360) % 360;
    return fromPerceptual(p);
  }

  pitchClassForDegree(degree: number): number {
    const d = ((degree % 7) + 7) % 7;
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    return (this._rootIdx + steps[d]) % 12;
  }

  // ── Cached arrays ─────────────────────────────────────────────────────────

  get degreeHues(): Float32Array {
    if (!this._degreeHues) {
      this._degreeHues = Float32Array.from({ length: 7 }, (_, i) =>
        this.degreeToHue(i, 0.5),
      );
    }
    return this._degreeHues;
  }

  get chromaticHues(): Float32Array {
    if (!this._chromaticHues) this._chromaticHues = this._buildChromaticHues();
    return this._chromaticHues;
  }

  chromaticToHue(chromaticIndex: number): number {
    const c = ((chromaticIndex % 12) + 12) % 12;
    return this.chromaticHues[c];
  }

  private _buildChromaticHues(): Float32Array {
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    const semiToHue = new Map<number, number>();
    for (let d = 0; d < 7; d++) semiToHue.set(steps[d], this.degreeToHue(d));

    const out = new Float32Array(12);
    for (let cIdx = 0; cIdx < 12; cIdx++) {
      const rel = (cIdx - this._rootIdx + 12) % 12;
      if (semiToHue.has(rel)) {
        out[cIdx] = semiToHue.get(rel)!;
      } else {
        let loRel = rel,
          hiRel = rel;
        for (let s = 1; s <= 12; s++) {
          if (semiToHue.has((rel - s + 12) % 12)) {
            loRel = (rel - s + 12) % 12;
            break;
          }
        }
        for (let s = 1; s <= 12; s++) {
          if (semiToHue.has((rel + s) % 12)) {
            hiRel = (rel + s) % 12;
            break;
          }
        }
        const loP = toPerceptual(semiToHue.get(loRel)!);
        const hiP = toPerceptual(semiToHue.get(hiRel)!);
        const span = (hiRel - loRel + 12) % 12 || 12;
        const pos = (rel - loRel + 12) % 12;
        let dP = hiP - loP;
        if (dP > 180) dP -= 360;
        if (dP < -180) dP += 360;
        out[cIdx] = fromPerceptual(
          (((loP + (pos / span) * dP) % 360) + 360) % 360,
        );
      }
    }
    return out;
  }
}

/** Chromatic note names (C=0 … B=11). */
export const CHROMATIC_NAMES = NOTE_NAMES;
