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
}
