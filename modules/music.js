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
   * The 7 degrees are spaced evenly across the circle. hue 0 and hue 360
   * both land on degree 0 (tonic), so the wrap at the spectrum boundary
   * IS the leading-tone-to-tonic cadence (VII→I).
   *
   * @param   {number} hue  0–360 (wraps safely outside this range)
   * @returns {{ degree, name, octave, freq, quality, numeral, triad, t }}
   *          t: 0–1 interpolation position within this degree's hue slice
   */
  hueToNote(hue) {
    const h = ((hue % 360) + 360) % 360; // normalise to [0, 360)
    const pos = (h / 360) * 7; // 0 to <7
    const i = Math.floor(pos) % 7;
    const t = pos - Math.floor(pos); // 0–1 within slice
    return { ...this.degrees[i], t };
  }

  /**
   * Inverse of hueToNote: map a scale degree (0–6) to a hue angle.
   * Degrees land at the center of their hue slice by default (t=0.5),
   * matching what hueToNote returns when given that hue back.
   *
   * @param   {number} degree   0–6 (wraps)
   * @param   {number} [t=0.5]  0=slice start, 1=next slice start
   * @returns {number}          hue in [0, 360)
   */
  degreeToHue(degree, t = 0.5) {
    const i = ((degree % 7) + 7) % 7;
    return ((i + t) * 360) / 7;
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
    // Center of each degree's hue slice
    const stepHues = steps.map((_, i) => ((i + 0.5) * 360) / 7);
    // Append wrap-around tonic so interpolation handles chromatic notes
    // above the last in-scale step (e.g. B♭ in C minor between deg 6 and tonic).
    const stepsExt = [...steps, steps[0] + 12];
    const huesExt = [...stepHues, stepHues[0] + 360];

    const out = new Float32Array(12);
    for (let cIdx = 0; cIdx < 12; cIdx++) {
      const rel = (cIdx - this._rootIdx + 12) % 12; // semitones above root
      let i = 0;
      while (i + 1 < stepsExt.length && stepsExt[i + 1] <= rel) i++;
      if (stepsExt[i] === rel) {
        out[cIdx] = stepHues[i];
      } else {
        const t = (rel - stepsExt[i]) / (stepsExt[i + 1] - stepsExt[i]);
        out[cIdx] = (huesExt[i] + t * (huesExt[i + 1] - huesExt[i])) % 360;
      }
    }
    return out;
  }
}

/** Exposed for tests / other modules that want chromatic name lookups. */
export const CHROMATIC_NAMES = NOTE_NAMES;
