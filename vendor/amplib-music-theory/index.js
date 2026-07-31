/* Vendored from @amplib/music-theory @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
// src/Note.ts
var Note = class _Note {
  /**
   * Frequency hz for this note
   */
  frequency;
  /**
   * A unique identifier for this note
   */
  id;
  /**
   * Global index of the note on a keyboard (
   * 0 through 107
   */
  index;
  /**
   * Primary notation for the note
   */
  notation;
  /**
   * Optional secondary notation for the note
   */
  notationAlternate;
  /**
   * Global octave number for the note
   * 0 through 8
   */
  octave;
  /**
   * Index of the note within the octave
   * 0 through 11
   */
  octaveIndex;
  constructor({ octave, step }) {
    const notation = _Note.notations[step];
    const alternate = _Note.notationsAlternate[step];
    this.frequency = _Note.octaveStepFrequencies[octave][step];
    this.id = _Note.noteIdFromNotationAndOctave(notation, octave);
    this.index = step + octave * 12;
    this.notation = notation;
    this.notationAlternate = alternate === this.notation ? void 0 : alternate;
    this.octave = octave;
    this.octaveIndex = step;
  }
  static notationIndex(notation) {
    const notationsIndex = _Note.notations.indexOf(notation);
    if (notationsIndex !== -1) {
      return notationsIndex;
    }
    const notationsAlternateIndex = _Note.notationsAlternate.indexOf(
      notation
    );
    if (notationsAlternateIndex !== -1) {
      return notationsAlternateIndex;
    }
    return -1;
  }
  static noteIdFromNotationAndOctave(notation, octave) {
    return `${notation}${octave}`;
  }
  static get notations() {
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  }
  static get notationsAlternate() {
    return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  }
  static get notationsUnique() {
    return Array.from(/* @__PURE__ */ new Set([..._Note.notations, ..._Note.notationsAlternate]));
  }
  // prettier-ignore
  static get octaveStepFrequencies() {
    return {
      0: { 0: 16.352, 1: 17.324, 2: 18.354, 3: 19.445, 4: 20.602, 5: 21.827, 6: 23.125, 7: 24.5, 8: 25.957, 9: 27.5, 10: 29.135, 11: 30.868 },
      1: { 0: 32.703, 1: 34.648, 2: 36.708, 3: 38.891, 4: 41.203, 5: 43.654, 6: 46.249, 7: 48.999, 8: 51.913, 9: 55, 10: 58.27, 11: 61.735 },
      2: { 0: 65.406, 1: 69.296, 2: 73.416, 3: 77.782, 4: 82.407, 5: 87.307, 6: 92.499, 7: 97.999, 8: 103.826, 9: 110, 10: 116.541, 11: 123.471 },
      3: { 0: 130.813, 1: 138.591, 2: 146.832, 3: 155.563, 4: 164.814, 5: 174.614, 6: 184.997, 7: 195.998, 8: 207.652, 9: 220, 10: 233.082, 11: 246.942 },
      4: { 0: 261.626, 1: 277.183, 2: 293.665, 3: 311.127, 4: 329.628, 5: 349.228, 6: 369.994, 7: 391.995, 8: 415.305, 9: 440, 10: 466.164, 11: 493.883 },
      5: { 0: 523.251, 1: 554.365, 2: 587.33, 3: 622.254, 4: 659.255, 5: 698.456, 6: 739.989, 7: 783.991, 8: 830.609, 9: 880, 10: 932.328, 11: 987.767 },
      6: { 0: 1046.502, 1: 1108.731, 2: 1174.659, 3: 1244.508, 4: 1318.51, 5: 1396.913, 6: 1479.978, 7: 1567.982, 8: 1661.219, 9: 1760, 10: 1864.655, 11: 1975.533 },
      7: { 0: 2093.005, 1: 2217.461, 2: 2349.318, 3: 2489.016, 4: 2637.02, 5: 2793.826, 6: 2959.955, 7: 3135.963, 8: 3322.438, 9: 3520, 10: 3729.31, 11: 3951.066 },
      8: { 0: 4186.01, 1: 4434.92, 2: 4698.63, 3: 4978.03, 4: 5274.04, 5: 5587.65, 6: 5919.91, 7: 6271.93, 8: 6644.88, 9: 7040, 10: 7458.62, 11: 7902.13 }
    };
  }
  static stringIsNotation(string) {
    return _Note.notations.includes(string) || _Note.notationsAlternate.includes(string);
  }
};

// src/Interval.ts
var Interval = class _Interval {
  /**
   * Common representation of the interval
   */
  label;
  /**
   * Metadata
   */
  meta;
  /**
   * Primary identifier of the interval root note
   */
  notation;
  /**
   * Optional secondary identifier of the interval root note
   */
  notationAlternate;
  /**
   * Interval triad notes
   */
  notes;
  /**
   * Octave relative octave to first interval's root note.
   * 0 | 1
   */
  octave;
  /**
   * Interval step in the mode
   * 0 through 6
   */
  step;
  constructor(step, offset, type) {
    const index = offset % Note.notations.length;
    const octave = offset > Note.notations.length - 1 ? 1 : 0;
    const notation = Note.notations[index];
    const alternate = Note.notationsAlternate[index];
    this.label = `${notation} ${type}`;
    this.notation = notation;
    this.notationAlternate = alternate === notation ? void 0 : alternate;
    this.notes = _Interval.notesFromIndexOctaveAndType(index, octave, type);
    this.octave = octave;
    this.step = step;
    this.meta = {
      name: _Interval.nameFromType(type),
      numeral: _Interval.numeralFromType(step, type),
      type
    };
  }
  static intervalsFromModeType(mode) {
    switch (mode) {
      case "melodic":
        return ["min", "min", "aug", "maj", "maj", "dim", "dim"];
      case "harmonic":
        return ["min", "dim", "aug", "min", "maj", "maj", "dim"];
    }
  }
  static intervalsFromOffset(offset) {
    const base = [
      "maj",
      "min",
      "min",
      "maj",
      "maj",
      "min",
      "dim"
    ];
    const triads = [];
    for (let i = 0; i < base.length; i++) {
      triads.push(base[(i + offset) % base.length]);
    }
    return triads;
  }
  static nameFromType(type) {
    switch (type) {
      case "maj":
        return "Major";
      case "min":
        return "Minor";
      case "aug":
        return "Augmented";
      case "dim":
        return "Diminished";
    }
  }
  static numeralFromType(step, type) {
    const notation = ["i", "ii", "iii", "iv", "v", "vi", "vii"][step];
    switch (type) {
      case "maj":
        return notation.toUpperCase();
      case "min":
        return notation;
      case "aug":
        return `${notation.toUpperCase()}+`;
      case "dim":
        return `${notation}\xB0`;
    }
  }
  static notesFromIndexOctaveAndType(offset, octave, type) {
    const steps = {
      maj: [0, 4, 7],
      min: [0, 3, 7],
      dim: [0, 3, 6],
      aug: [0, 4, 8]
    }[type];
    const notes = [];
    const roots = Note.notations;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const idx = (offset + step) % roots.length;
      const relative = offset + step > roots.length - 1 ? octave + 1 : octave;
      notes.push({ notation: roots[idx], octave: relative });
    }
    return notes;
  }
};

// src/Chord.ts
var Chord = class _Chord {
  // Assigned through initializeFromNotes, which every branch of the
  // constructor calls. TypeScript cannot see definite assignment through a
  // method call, so these are asserted rather than left to look optional.
  key;
  label;
  typeLabel;
  notation;
  notes;
  type;
  constructor(step, type) {
    this.typeLabel = _Chord.labelFromType(type);
    if (type === "maj7") {
      const notes = Interval.notesFromIndexOctaveAndType(step, 0, "maj");
      const min = Interval.notesFromIndexOctaveAndType(
        Note.notationIndex(notes[1].notation),
        notes[1].octave,
        "min"
      );
      this.initializeFromNotes(notes.concat(min[2]));
    } else if (type === "min7") {
      const notes = Interval.notesFromIndexOctaveAndType(step, 0, "min");
      const min = Interval.notesFromIndexOctaveAndType(
        Note.notationIndex(notes[1].notation),
        notes[1].octave,
        "min"
      );
      this.initializeFromNotes(notes.concat(min[2]));
    } else if (type === "dom7") {
      const notes = Interval.notesFromIndexOctaveAndType(step, 0, "maj");
      const dim = Interval.notesFromIndexOctaveAndType(
        Note.notationIndex(notes[1].notation),
        notes[1].octave,
        "dim"
      );
      this.initializeFromNotes(notes.concat(dim[2]));
    } else {
      this.initializeFromNotes(
        Interval.notesFromIndexOctaveAndType(step, 0, type)
      );
    }
  }
  initializeFromNotes(notes) {
    this.label = notes[0].notation + this.typeLabel;
    this.notation = notes[0].notation;
    this.key = _Chord.keyFromNotations(notes.map(({ notation }) => notation));
    this.notes = notes;
  }
  static keyFromNotations(notations) {
    return notations.sort().join("-");
  }
  static labelFromType(type) {
    switch (type) {
      case "maj":
        return "";
      case "min":
        return "m";
      case "min7":
        return "m7";
      case "maj7":
        return "M7";
      case "aug":
        return "+";
      case "dim":
        return "\xB0";
      case "dom7":
        return "7";
    }
  }
  static get types() {
    return ["maj", "min", "maj7", "min7", "dom7", "aug", "dim"];
  }
};

// src/Mode.ts
var Mode = class _Mode {
  intervals;
  name;
  steps;
  type;
  constructor({ type }) {
    this.type = type;
    this.name = _Mode.nameFromType(type);
    this.steps = _Mode.stepsFromType(type);
    this.intervals = _Mode.intervalsFromType(type);
  }
  static get types() {
    return [
      "ionian",
      "dorian",
      "phrygian",
      "lydian",
      "mixolydian",
      "aeolian",
      "locrian",
      "melodic",
      "harmonic",
      "major",
      "minor"
    ];
  }
  static intervalsFromType(type) {
    switch (type) {
      case "major":
      case "ionian":
        return Interval.intervalsFromOffset(0);
      case "dorian":
        return Interval.intervalsFromOffset(1);
      case "phrygian":
        return Interval.intervalsFromOffset(2);
      case "lydian":
        return Interval.intervalsFromOffset(3);
      case "mixolydian":
        return Interval.intervalsFromOffset(4);
      case "minor":
      case "aeolian":
        return Interval.intervalsFromOffset(5);
      case "locrian":
        return Interval.intervalsFromOffset(6);
      case "melodic":
        return Interval.intervalsFromModeType("melodic");
      case "harmonic":
        return Interval.intervalsFromModeType("harmonic");
    }
  }
  static nameFromType(type) {
    switch (type) {
      case "major":
      case "ionian":
        return "Ionian";
      case "dorian":
        return "Dorian";
      case "phrygian":
        return "Phrygian";
      case "lydian":
        return "Lydian";
      case "mixolydian":
        return "Mixolydian";
      case "minor":
      case "aeolian":
        return "Aeolian";
      case "locrian":
        return "Locrian";
      case "melodic":
        return "Melodic Minor";
      case "harmonic":
        return "Harmonic Minor";
    }
  }
  static stepsFromType(type) {
    switch (type) {
      case "major":
      case "ionian":
        return _Mode.stepsFromIncrements([2, 2, 1, 2, 2, 2, 1]);
      case "dorian":
        return _Mode.stepsFromIncrements([2, 1, 2, 2, 2, 1, 2]);
      case "phrygian":
        return _Mode.stepsFromIncrements([1, 2, 2, 2, 1, 2, 2]);
      case "lydian":
        return _Mode.stepsFromIncrements([2, 2, 2, 1, 2, 2, 1]);
      case "mixolydian":
        return _Mode.stepsFromIncrements([2, 2, 1, 2, 2, 1, 2]);
      case "minor":
      case "aeolian":
        return _Mode.stepsFromIncrements([2, 1, 2, 2, 1, 2, 2]);
      case "locrian":
        return _Mode.stepsFromIncrements([1, 2, 2, 1, 2, 2, 2]);
      case "melodic":
        return _Mode.stepsFromIncrements([2, 1, 2, 2, 2, 2, 1]);
      case "harmonic":
        return _Mode.stepsFromIncrements([2, 1, 2, 2, 1, 3, 1]);
    }
  }
  static stepsFromIncrements(increments) {
    const steps = [0];
    let step = 0;
    for (let i = 0; i < increments.length - 1; i++) {
      step += increments[i];
      steps.push(step);
    }
    return steps;
  }
  static stringIsModeType(string) {
    return _Mode.types.includes(string);
  }
};

// src/Scale.ts
var OCTAVES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
var STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
var Scale = class _Scale {
  /**
   * Array of 7 intervals in the scale
   */
  intervals;
  /**
   * Common label for the scale's key.
   */
  label;
  /**
   * Library of all notes
   */
  library = _Scale.buildLibrary();
  /**
   * Scale's mode. Can be a vanity mode (minor, major)
   */
  mode;
  /**
   * Array of playable note ids in the scale
   */
  noteIds;
  /**
   * Notation or alternative notation for the root of the scale.
   */
  root;
  /**
   * Index of the root
   */
  rootOffset;
  constructor(params) {
    this.root = params.root;
    this.label = "";
    this.intervals = [];
    this.noteIds = [];
    this.mode = new Mode({ type: params.mode });
    this.root = params.root;
    this.rootOffset = Note.notationIndex(params.root);
    this.update(params);
  }
  update({ root, mode }) {
    this.mode = new Mode({ type: mode });
    this.root = root;
    this.rootOffset = Note.notationIndex(root);
    this.label = `${root} ${this.mode.name}`;
    this.intervals = this.mode.steps.map(
      (step, index) => new Interval(index, this.rootOffset + step, this.mode.intervals[index])
    );
    this.noteIds = [];
    const lastOctave = OCTAVES[OCTAVES.length - 1];
    OCTAVES.forEach((mainOctave) => {
      this.intervals.forEach(({ notation, octave }) => {
        const relOctave = octave + mainOctave;
        if (relOctave <= lastOctave) {
          this.noteIds.push(
            Note.noteIdFromNotationAndOctave(notation, relOctave)
          );
        }
      });
    });
  }
  static buildLibrary() {
    return OCTAVES.reduce((library, octave) => {
      STEPS.forEach((step) => {
        const note = new Note({ octave, step });
        library[note.id] = note;
      });
      return library;
    }, {});
  }
  /**
   * Array of playable notes in the scale.
   */
  get notes() {
    return this.noteIds.map((noteId) => this.library[noteId]);
  }
};

// src/parseChord.ts
var THEORETICAL_NOTATIONS = {
  Cb: 11,
  "B#": 0,
  Fb: 4,
  "E#": 5
};
var CHORD_INTERVALS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  aug: [0, 4, 8],
  dim: [0, 3, 6]
};
function pitchClassFromName(name) {
  const index = Note.notationIndex(name);
  if (index !== -1) return index;
  return THEORETICAL_NOTATIONS[name];
}
function chordFromPitchClasses(pitchClasses) {
  const unique = Array.from(new Set(pitchClasses));
  for (const root of unique) {
    for (const type of Chord.types) {
      const intervals = CHORD_INTERVALS[type];
      if (intervals.length !== unique.length) continue;
      const expected = intervals.map((step) => (root + step) % 12);
      if (expected.every((pitchClass) => unique.includes(pitchClass))) {
        return new Chord(root, type);
      }
    }
  }
  return void 0;
}
function parseChord(letters) {
  const trimmed = letters.trim();
  if (!trimmed) throw new Error(`Empty chord: "${letters}"`);
  const seen = /* @__PURE__ */ new Set();
  const pitchClasses = [];
  const notations = [];
  let position = 0;
  while (position < trimmed.length) {
    const letter = trimmed[position];
    if (!/[A-G]/.test(letter)) {
      throw new Error(
        `Unexpected character "${letter}" in chord "${letters}" (position ${position}). Use letters A\u2013G with optional # or b.`
      );
    }
    let name = letter;
    position++;
    const accidental = trimmed[position];
    if (accidental === "#" || accidental === "b") {
      name += accidental;
      position++;
    }
    const pitchClass = pitchClassFromName(name);
    if (pitchClass === void 0) {
      throw new Error(`Unknown note "${name}" in chord "${letters}"`);
    }
    if (!seen.has(pitchClass)) {
      seen.add(pitchClass);
      pitchClasses.push(pitchClass);
      notations.push(Note.notations[pitchClass]);
    }
  }
  if (pitchClasses.length === 0) {
    throw new Error(`No notes in chord: "${letters}"`);
  }
  return {
    pitchClasses,
    notations,
    label: trimmed,
    chord: chordFromPitchClasses(pitchClasses)
  };
}
export {
  Chord,
  Interval,
  Mode,
  Note,
  OCTAVES,
  STEPS,
  Scale,
  chordFromPitchClasses,
  parseChord
};
//# sourceMappingURL=index.js.map