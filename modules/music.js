/**
 * modules/music.js
 *
 * Minimal music theory for AVVA.
 *
 * Maps hue (0–360°) to diatonic scale degrees in a circular path:
 *   hue 0° and 360° both resolve to the tonic (degree 0),
 *   ascending through I→II→III→IV→V→VI→VII in between.
 *
 * The leading tone (VII) sits just below 360°, so the wrap at the
 * hue boundary IS the canonical cadential resolution (VII→I).
 *
 * Pure functions + Key class — no DOM, no Web Audio.
 *
 * Derived from amplib-music-theory (another-machine/public-library).
 */

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
const SECTOR_DEG = 360 / 7; // ≈ 51.43° per degree

/** Equal-temperament frequency relative to A4 = 440 Hz. */
function noteFreq(chromaticIndex, octave) {
  return 440 * Math.pow(2, (chromaticIndex - 9 + (octave - 4) * 12) / 12);
}

export class Key {
  /**
   * @param {object} [params]
   * @param {string} [params.root='C']     Root note: 'C','C#','D','D#','E','F','F#','G','G#','A','A#','B'
   * @param {string} [params.mode='major'] Mode: major | minor | dorian | phrygian |
   *                                            lydian | mixolydian | locrian
   * @param {number} [params.octave=4]     Base octave for the root (4 = middle C octave)
   */
  constructor({ root = "C", mode = "major", octave = 4 } = {}) {
    this.root = root;
    this.mode = mode;
    this.octave = octave;
    const rootIdx = NOTE_NAMES.indexOf(root);
    if (rootIdx === -1) throw new Error(`Unknown root note: "${root}"`);
    this._rootIdx = rootIdx;
    this.degrees = this._build();
  }

  get label() {
    return `${this.root} ${this.mode}`;
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
   * Map a hue angle (0–360°) to a scale degree.
   *
   * The hue circle is treated as a chromatic octave (30° per semitone).
   * Each diatonic degree owns the hue range from its own semitone offset to
   * the next degree's offset, so half-step intervals get a narrow 30° slice
   * and whole-step intervals get a 60° slice.  This keeps the hue distance
   * between two notes proportional to their musical interval.
   *
   * hue 0° = root, hue 360° wraps back to root (VII→I cadence preserved).
   *
   * @param   {number} hue  0–360 (wraps safely outside this range)
   * @returns {{ degree, name, octave, freq, quality, numeral, triad, t }}
   *          t: 0–1 interpolation position within this degree's hue slice
   */
  hueToNote(hue) {
    const h = ((hue % 360) + 360) % 360;
    // Divide the hue wheel into 7 equal sectors in circle-of-fifths order.
    // Adjacent sectors are a diatonic fifth apart, not a scale step.
    const si = Math.min(6, Math.floor(h / SECTOR_DEG));
    const chosen = DIATONIC_FIFTHS[si];
    const t = (h - si * SECTOR_DEG) / SECTOR_DEG;
    return { ...this.degrees[chosen], t };
  }

  /**
   * Inverse of hueToNote: map a scale degree (0–6) to a hue angle.
   * t=0 → start of the degree's chromatic slice, t=0.5 → center, t=1 → end.
   *
   * @param   {number} degree   0–6 (wraps)
   * @param   {number} [t=0.5]  0=slice start, 1=next slice start
   * @returns {number}          hue in [0, 360)
   */
  degreeToHue(degree, t = 0.5) {
    const i = ((degree % 7) + 7) % 7;
    return (DIATONIC_FIFTHS_INV[i] + t) * SECTOR_DEG;
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
    // In-scale notes land at the center of their hue sector.
    const semiToHue = new Map();
    for (let d = 0; d < 7; d++) semiToHue.set(steps[d], this.degreeToHue(d));

    const out = new Float32Array(12);
    for (let cIdx = 0; cIdx < 12; cIdx++) {
      const rel = (cIdx - this._rootIdx + 12) % 12;
      if (semiToHue.has(rel)) {
        out[cIdx] = semiToHue.get(rel);
      } else {
        // Interpolate between chromatic neighbours that are in-scale.
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
        const loHue = semiToHue.get(loRel);
        const hiHue = semiToHue.get(hiRel);
        const span = (hiRel - loRel + 12) % 12 || 12;
        const pos = (rel - loRel + 12) % 12;
        let dh = hiHue - loHue;
        if (dh > 180) dh -= 360; // shortest arc
        if (dh < -180) dh += 360;
        out[cIdx] = (((loHue + (pos / span) * dh) % 360) + 360) % 360;
      }
    }
    return out;
  }
}

/** Exposed for tests / other modules that want chromatic name lookups. */
export const CHROMATIC_NAMES = NOTE_NAMES;
