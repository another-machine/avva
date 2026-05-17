/**
 * modules/music.js
 *
 * Minimal music theory for AVVA.
 *
 * Maps hue (0–360° display/HSV) to diatonic scale degrees via a
 * perceptually-uniform sector layout.  The hue wheel is divided into
 * 7 equal arcs of 360/7° each in *oklch perceptual* space; the display
 * hue passed in is converted to perceptual first, then sector-looked-up,
 * then the output hue is converted back to display.  This keeps yellow's
 * narrow perceptual band from dominating the mapping.
 *
 * rootHue is stored in perceptual coordinates.  setRootHueFromDisplay()
 * converts from display before storing.
 *
 * Pure functions + Key class — no DOM, no Web Audio.
 *
 * Derived from amplib-music-theory (another-machine/public-library).
 */

import { toPerceptual, fromPerceptual } from "./hue-perception.js";

// Semitone steps from root for each mode
const SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

// Triad quality for each scale degree, per mode
const DEGREE_QUALITIES = {
  major: ["maj", "min", "min", "maj", "maj", "min", "dim"],
  minor: ["min", "dim", "maj", "min", "min", "maj", "maj"],
  dorian: ["min", "min", "maj", "maj", "min", "dim", "maj"],
  phrygian: ["min", "maj", "maj", "min", "dim", "maj", "min"],
  lydian: ["maj", "maj", "min", "dim", "maj", "min", "min"],
  mixolydian: ["maj", "min", "dim", "maj", "min", "min", "maj"],
  locrian: ["dim", "maj", "min", "min", "maj", "maj", "min"],
};

// Semitone offsets for each triad quality (root, third, fifth)
const TRIAD_OFFSETS = {
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
];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

// Diatonic circle-of-fifths order: each step is +4 scale degrees mod 7.
// Arrangement on hue wheel: I→V→II→VI→III→VII→IV→(wrap to I)
// Adjacent hues are a diatonic fifth apart, not a scale step apart.
const DIATONIC_FIFTHS = [0, 4, 1, 5, 2, 6, 3]; // sector→degree
const DIATONIC_FIFTHS_INV = [0, 2, 4, 6, 1, 3, 5]; // degree→sector

/** Equal-temperament frequency relative to A4 = 440 Hz. */
function noteFreq(chromaticIndex, octave) {
  return 440 * Math.pow(2, (chromaticIndex - 9 + (octave - 4) * 12) / 12);
}

export class Key {
  /**
   * @param {object} [params]
   * @param {string} [params.root='C']      Root note name
   * @param {string} [params.mode='major']  Mode name
   * @param {number} [params.octave=4]      Base octave
   * @param {number} [params.rootHue=0]     Perceptual (oklch) hue where the root (I)
   *                                        sector begins.  Use setRootHueFromDisplay()
   *                                        to set from a display/HSV hue instead.
   */
  constructor({ root = "C", mode = "major", octave = 4, rootHue = 0 } = {}) {
    this.root = root;
    this.mode = mode;
    this.octave = octave;
    this.rootHue = ((rootHue % 360) + 360) % 360;
    const rootIdx = NOTE_NAMES.indexOf(root);
    if (rootIdx === -1) throw new Error(`Unknown root note: "${root}"`);
    this._rootIdx = rootIdx;
    this._listeners = [];
    this.degrees = this._build();
  }

  get label() {
    return `${this.root} ${this.mode}`;
  }

  // ── Hue cache invalidation ────────────────────────────────────────────────

  _invalidateHueCache() {
    this._degreeHues = null;
    this._chromaticHues = null;
  }

  // ── Live rootHue mutation ─────────────────────────────────────────────────

  /**
   * Set the root hue in *perceptual* (oklch) coordinates and invalidate caches.
   * @param {number} p  Perceptual hue (any value; wraps to [0, 360))
   */
  setRootHue(p) {
    this.rootHue = ((p % 360) + 360) % 360;
    this._invalidateHueCache();
    this._emit();
  }

  /**
   * Set the root hue from a *display* (HSV) hue.  Converts to perceptual
   * internally so all hue math stays in the right space.
   * @param {number} h  Display/HSV hue (any value)
   */
  setRootHueFromDisplay(h) {
    this.setRootHue(toPerceptual(h));
  }

  // ── Change listeners ─────────────────────────────────────────────────────

  /**
   * Register a callback that fires whenever rootHue changes.
   * @param {function} fn
   * @returns {function} Unsubscribe function
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

  _build() {
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    const qualities = DEGREE_QUALITIES[this.mode] ?? DEGREE_QUALITIES.major;

    return steps.map((st, i) => {
      const abs = this._rootIdx + st;
      const cidx = abs % 12;
      const oct = this.octave + Math.floor(abs / 12);
      const name = NOTE_NAMES[cidx];
      const quality = qualities[i];
      const freq = noteFreq(cidx, oct);

      const triad = TRIAD_OFFSETS[quality].map((off) => {
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

  /**
   * Map a display hue (0–360°) to a scale degree.
   *
   * The display hue is first converted to perceptual (oklch) space, then
   * looked up in 7 equal-width sectors (360/7° each) offset by rootHue.
   * Equal perceptual sectors mean that equal angular shifts feel like
   * equally distinct color changes to the viewer.
   *
   * @param   {number} hue  Display hue 0–360 (wraps safely)
   * @returns {{ degree, name, octave, freq, quality, numeral, triad, t }}
   *          t: 0–1 position within this degree's sector
   */
  hueToNote(hue) {
    const p = (((toPerceptual(hue) - this.rootHue) % 360) + 360) % 360;
    const w = 360 / 7;
    const si = Math.min(6, Math.floor(p / w));
    const t = (p - si * w) / w;
    return { ...this.degrees[DIATONIC_FIFTHS[si]], t };
  }

  /**
   * Crossfade data for smooth sector-boundary blending in the synth.
   * Near a sector edge both the current degree and the adjacent degree
   * become active; blendFactor scales from 0 (sector centre) to 0.5
   * (exact boundary).
   *
   * @param {number} hue
   * @param {number} [crossZone=0.25]  fraction of sector width to crossfade (each side)
   * @returns {{ blendDegree: number, blendFactor: number }}
   */
  hueToBlend(hue, crossZone = 0.25) {
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

  /**
   * Inverse: map a scale degree (0–6) to a display hue.
   * Computes the perceptual hue for this sector position, then converts to display.
   *
   * @param   {number} degree  0–6 (wraps)
   * @param   {number} [t=0.5] 0=sector start, 0.5=center, 1=next sector start
   * @returns {number}         Display hue in [0, 360)
   */
  degreeToHue(degree, t = 0.5) {
    const d = ((degree % 7) + 7) % 7;
    const si = DIATONIC_FIFTHS_INV[d];
    const w = 360 / 7;
    const p = (((si * w + t * w + this.rootHue) % 360) + 360) % 360;
    return fromPerceptual(p);
  }

  /**
   * Chromatic pitch-class index (0=C..11=B) for a diatonic degree (0–6).
   * @param   {number} degree  0–6 (wraps)
   * @returns {number}         pitch class 0..11
   */
  pitchClassForDegree(degree) {
    const d = ((degree % 7) + 7) % 7;
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    return (this._rootIdx + steps[d]) % 12;
  }

  /**
   * Hue at the center of each diatonic degree's sector (0.5 t-value).
   * Cached; reuse freely.
   * @returns {Float32Array} length-7, indexed by degree 0..6
   */
  get degreeHues() {
    if (!this._degreeHues) {
      this._degreeHues = Float32Array.from({ length: 7 }, (_, i) =>
        this.degreeToHue(i, 0.5),
      );
    }
    return this._degreeHues;
  }

  /**
   * Hue for each absolute chromatic note class (0=C..11=B), under this key.
   *
   * In-scale notes land at the center of their degree's hue slice.
   * Out-of-scale chromatic notes are linearly interpolated between the
   * two adjacent in-scale degree centers — so a chromatic sweep produces
   * a smooth hue sweep, but in-scale notes always hit their canonical hue.
   *
   * @returns {Float32Array} length-12 array indexed by chromatic class 0..11
   */
  get chromaticHues() {
    if (!this._chromaticHues) this._chromaticHues = this._buildChromaticHues();
    return this._chromaticHues;
  }

  /**
   * Map a single chromatic note class (0=C..11=B) to its hue under this key.
   * Convenience accessor over chromaticHues[].
   */
  chromaticToHue(chromaticIndex) {
    const c = ((chromaticIndex % 12) + 12) % 12;
    return this.chromaticHues[c];
  }

  _buildChromaticHues() {
    const steps = SCALE_STEPS[this.mode] ?? SCALE_STEPS.major;
    // In-scale notes land at the center of their degree's hue sector (display hue).
    const semiToHue = new Map();
    for (let d = 0; d < 7; d++) semiToHue.set(steps[d], this.degreeToHue(d));

    const out = new Float32Array(12);
    for (let cIdx = 0; cIdx < 12; cIdx++) {
      const rel = (cIdx - this._rootIdx + 12) % 12;
      if (semiToHue.has(rel)) {
        out[cIdx] = semiToHue.get(rel);
      } else {
        // Find the two adjacent in-scale semitone neighbours.
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
        // Interpolate in *perceptual* space so the chromatic sweep stays visually linear.
        const loP = toPerceptual(semiToHue.get(loRel));
        const hiP = toPerceptual(semiToHue.get(hiRel));
        const span = (hiRel - loRel + 12) % 12 || 12;
        const pos = (rel - loRel + 12) % 12;
        let dP = hiP - loP;
        if (dP > 180) dP -= 360;
        if (dP < -180) dP += 360;
        const pInterp = (((loP + (pos / span) * dP) % 360) + 360) % 360;
        out[cIdx] = fromPerceptual(pInterp);
      }
    }
    return out;
  }
}

/** Exposed for tests / other modules that want chromatic name lookups. */
export const CHROMATIC_NAMES = NOTE_NAMES;
