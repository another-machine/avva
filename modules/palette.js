/**
 * modules/palette.js
 *
 * A Palette is the runtime harmonic universe when `?palette=...` is set.
 * It replaces `Key` as the source of chord/hue data for Synth, AudioAnalyzer,
 * and AudioRendererGL.
 *
 * Holds N slots, each with a parsed chord and a bias (sector-width multiplier).
 * Sector boundaries are computed in perceptual (oklch) hue space, proportional
 * to each slot's bias.  `rootHue` (perceptual coords) rotates the entire wheel.
 *
 * Exports:
 *   Palette  — class
 *
 * Palette.fromURLParam(str, opts) is the standard entry point for URL-driven
 * instantiation.
 */

import { parseChord, parseChordList } from "./chord-parser.js";
import { toPerceptual, fromPerceptual } from "./hue-perception.js";

export class Palette {
  /**
   * @param {object} params
   * @param {{ chord: string, bias?: number, gain?: number }[]} params.slots
   * @param {number} [params.rootHue=0]    Perceptual hue where slot 0 begins (°)
   * @param {number} [params.crossZone=0.15]  Fraction of sector width used for edge overlap
   */
  constructor({ slots, rootHue = 0, crossZone = 0.15 }) {
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

    // Cached derived data — invalidated by any setter that changes geometry
    this._slotHues = null;
    this._slotBoundaryHues = null;
    this._chordTemplates = null;
    this._pitchClassSet = null;

    this._buildSectorAngles();
  }

  // ── Sector geometry ───────────────────────────────────────────────────────

  _buildSectorAngles() {
    const totalBias = this._slots.reduce((a, s) => a + s.bias, 0);
    this._sectorAngles = new Float64Array(this._N + 1);
    let a = 0;
    for (let i = 0; i < this._N; i++) {
      this._sectorAngles[i] = a;
      a += (this._slots[i].bias / totalBias) * 360;
    }
    this._sectorAngles[this._N] = 360;
  }

  _invalidateCache() {
    this._slotHues = null;
    this._slotBoundaryHues = null;
    this._chordTemplates = null;
    this._pitchClassSet = null;
  }

  // ── Core lookup API ──────────────────────────────────────────────────────

  /**
   * Map a display hue to the active slot and position within it.
   * @param   {number} displayHue
   * @returns {{ slot: object, t: number }}  t is 0..1 position in the sector
   */
  hueToSlot(displayHue) {
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

  /**
   * Map a display hue to a weighted list of active slots (for edge overlap).
   *
   * Returns [{slot, weight}, ...] with weights summing to 1.
   * Deep in a sector: one entry with weight 1.
   * Near a boundary (within crossZone × sectorWidth): two entries.
   * N=1: always one entry, weight 1.
   *
   * @param   {number} displayHue
   * @returns {{ slot: object, weight: number }[]}
   */
  hueToBlend(displayHue) {
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

  /**
   * Inverse: map a slot index and position within it to a display hue.
   * @param   {number} idx  Slot index (wraps)
   * @param   {number} [t=0.5]  0=start, 0.5=center, 1=next-sector start
   * @returns {number}  Display hue in [0, 360)
   */
  slotToHue(idx, t = 0.5) {
    const i = ((idx % this._N) + this._N) % this._N;
    const start = this._sectorAngles[i];
    const width = this._sectorAngles[i + 1] - start;
    const p = (((start + t * width + this.rootHue) % 360) + 360) % 360;
    return fromPerceptual(p);
  }

  // ── Getters (lazy, cached) ────────────────────────────────────────────────

  /** Array of N slot objects with {index, chord, bias, gain} */
  get slots() {
    return this._slots;
  }

  /** Float32Array(N): display hue at center of each slot's sector */
  get slotHues() {
    if (!this._slotHues) {
      this._slotHues = Float32Array.from({ length: this._N }, (_, i) =>
        this.slotToHue(i, 0.5),
      );
    }
    return this._slotHues;
  }

  /** Float32Array(N+1): display hues at slot sector boundaries */
  get slotBoundaryHues() {
    if (!this._slotBoundaryHues) {
      this._slotBoundaryHues = Float32Array.from(
        { length: this._N + 1 },
        (_, i) => {
          if (i === this._N) return this.slotToHue(0, 0); // wrap: same as slot 0 start
          return this.slotToHue(i, 0);
        },
      );
    }
    return this._slotBoundaryHues;
  }

  /**
   * Array of N chord templates matching AudioAnalyzer's template shape:
   * { label, key, vec: Float32Array(12), norm: number }
   * `vec[pc] = 1` for each pitch class in the chord; `norm = sqrt(|PCs|)`.
   */
  get chordTemplates() {
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

  /**
   * Float32Array(12): each entry is the max gain across all slots that
   * contain that pitch class.  Useful for "which PCs are anywhere in the
   * palette" queries.
   */
  get pitchClassSet() {
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

  /**
   * Set rootHue in perceptual (oklch) coordinates.
   * @param {number} p  Perceptual hue (any value; wraps to [0, 360))
   */
  setRootHue(p) {
    this.rootHue = ((p % 360) + 360) % 360;
    this._invalidateCache();
    this._emit();
  }

  /** Replace all slots (rebuilds sector geometry). */
  setSlots(newSlots) {
    this._slots = newSlots.map((s, i) => ({
      index: i,
      chord: parseChord(s.chord),
      bias: Math.max(0.001, s.bias ?? 1),
      gain: s.gain ?? 1,
    }));
    this._N = this._slots.length;
    this._buildSectorAngles();
    this._invalidateCache();
    this._emit();
  }

  /** Adjust one slot's bias weight (rebuilds sector geometry). */
  setSlotBias(idx, bias) {
    this._slots[idx].bias = Math.max(0.001, bias);
    this._buildSectorAngles();
    this._invalidateCache();
    this._emit();
  }

  /** Set the crossZone fraction. */
  setCrossZone(z) {
    this._crossZone = Math.max(0, Math.min(0.5, z));
    this._emit();
  }

  /**
   * Register a callback that fires whenever the palette changes.
   * @param   {function} fn
   * @returns {function}  Unsubscribe function
   */
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Parse a URL-param palette string into a Palette instance.
   * @param   {string} str   e.g. "Cmaj7:2,F:1,Am7:1"
   * @param   {object} [opts]
   * @param   {number} [opts.rootHue=0]
   * @param   {number} [opts.crossZone=0.15]
   * @returns {Palette}
   */
  static fromURLParam(str, opts = {}) {
    const slots = parseChordList(str);
    return new Palette({
      slots,
      rootHue: opts.rootHue ?? 0,
      crossZone: opts.crossZone ?? 0.15,
    });
  }
}

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
];
