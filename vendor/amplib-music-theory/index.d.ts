/* Vendored from @amplib/music-theory @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
type Notation = "C" | "C#" | "D" | "D#" | "E" | "F" | "F#" | "G" | "G#" | "A" | "A#" | "B";
type NotationAlternate = "C" | "Db" | "D" | "Eb" | "E" | "F" | "Gb" | "G" | "Ab" | "A" | "Bb" | "B";
declare class Note {
    /**
     * Frequency hz for this note
     */
    frequency: number;
    /**
     * A unique identifier for this note
     */
    id: string;
    /**
     * Global index of the note on a keyboard (
     * 0 through 107
     */
    index: number;
    /**
     * Primary notation for the note
     */
    notation: Notation;
    /**
     * Optional secondary notation for the note
     */
    notationAlternate?: NotationAlternate;
    /**
     * Global octave number for the note
     * 0 through 8
     */
    octave: number;
    /**
     * Index of the note within the octave
     * 0 through 11
     */
    octaveIndex: number;
    constructor({ octave, step }: {
        octave: number;
        step: number;
    });
    static notationIndex(notation: Notation | NotationAlternate): number;
    static noteIdFromNotationAndOctave(notation: Notation, octave: number): string;
    static get notations(): Notation[];
    static get notationsAlternate(): NotationAlternate[];
    static get notationsUnique(): (Notation | NotationAlternate)[];
    static get octaveStepFrequencies(): {
        [K in number]: {
            [K in number]: number;
        };
    };
    static stringIsNotation(string: string): string is Notation | NotationAlternate;
}

type IntervalName = "Augmented" | "Diminished" | "Major" | "Minor";
type IntervalType = "aug" | "dim" | "maj" | "min";
interface IntervalNote {
    /**
     * Notation for the note
     */
    notation: Notation;
    /**
     * Octave relative to the first interval's root octave.
     * 0 | 1 | 2
     */
    octave: number;
}
declare class Interval {
    /**
     * Common representation of the interval
     */
    label: string;
    /**
     * Metadata
     */
    meta: {
        /**
         * Interval name
         */
        name: IntervalName;
        /**
         * Interval roman numeral syntax
         */
        numeral: string;
        /**
         * Interval type
         */
        type: IntervalType;
    };
    /**
     * Primary identifier of the interval root note
     */
    notation: Notation;
    /**
     * Optional secondary identifier of the interval root note
     */
    notationAlternate?: NotationAlternate;
    /**
     * Interval triad notes
     */
    notes: IntervalNote[];
    /**
     * Octave relative octave to first interval's root note.
     * 0 | 1
     */
    octave: number;
    /**
     * Interval step in the mode
     * 0 through 6
     */
    step: number;
    constructor(step: number, offset: number, type: IntervalType);
    static intervalsFromModeType(mode: "melodic" | "harmonic"): IntervalType[];
    static intervalsFromOffset(offset: number): IntervalType[];
    static nameFromType(type: IntervalType): IntervalName;
    static numeralFromType(step: number, type: IntervalType): string;
    static notesFromIndexOctaveAndType(offset: number, octave: number, type: IntervalType): IntervalNote[];
}

type ChordType = "maj" | "min" | "maj7" | "min7" | "dom7" | "aug" | "dim";
type ChordTypeLabel = "" | "m" | "m7" | "M7" | "+" | "°" | "7";
declare class Chord {
    key: string;
    label: string;
    typeLabel: string;
    notation: Notation;
    notes: IntervalNote[];
    type: ChordType;
    constructor(step: number, type: ChordType);
    initializeFromNotes(notes: IntervalNote[]): void;
    static keyFromNotations(notations: Notation[]): string;
    static labelFromType(type: ChordType): ChordTypeLabel;
    static get types(): ChordType[];
}

type ModeType = "ionian" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "aeolian" | "locrian" | "melodic" | "harmonic";
type ModeTypeVanity = "major" | "minor";
interface ModeParams {
    type: ModeType | ModeTypeVanity;
}
declare class Mode {
    intervals: IntervalType[];
    name: string;
    steps: number[];
    type: ModeType | ModeTypeVanity;
    constructor({ type }: ModeParams);
    static get types(): (ModeType | ModeTypeVanity)[];
    static intervalsFromType(type: ModeType | ModeTypeVanity): IntervalType[];
    static nameFromType(type: ModeType | ModeTypeVanity): "Ionian" | "Dorian" | "Phrygian" | "Lydian" | "Mixolydian" | "Aeolian" | "Locrian" | "Melodic Minor" | "Harmonic Minor";
    static stepsFromType(type: ModeType | ModeTypeVanity): number[];
    static stepsFromIncrements(increments: (1 | 2 | 3)[]): number[];
    static stringIsModeType(string: string): string is ModeType | ModeTypeVanity;
}

declare const OCTAVES: number[];
declare const STEPS: number[];
interface ScaleParams {
    /**
     * The root of the scale. Can be alternative format (flat instead of sharp).
     */
    root: Notation | NotationAlternate;
    /**
     * The scale mode, can provide vanity modes (major, minor).
     */
    mode: ModeParams["type"];
}
declare class Scale {
    /**
     * Array of 7 intervals in the scale
     */
    intervals: Interval[];
    /**
     * Common label for the scale's key.
     */
    label: string;
    /**
     * Library of all notes
     */
    library: {
        [noteId: string]: Note;
    };
    /**
     * Scale's mode. Can be a vanity mode (minor, major)
     */
    mode: Mode;
    /**
     * Array of playable note ids in the scale
     */
    noteIds: string[];
    /**
     * Notation or alternative notation for the root of the scale.
     */
    root: Notation | NotationAlternate;
    /**
     * Index of the root
     */
    rootOffset: number;
    constructor(params: ScaleParams);
    update({ root, mode }: ScaleParams): void;
    static buildLibrary(): {
        [noteId: string]: Note;
    };
    /**
     * Array of playable notes in the scale.
     */
    get notes(): Note[];
}

interface ParsedChord {
    /** Deduped pitch classes, 0–11, in the order they were written. */
    pitchClasses: number[];
    /** Primary notation for each pitch class, in the same order. */
    notations: Notation[];
    /** The input, trimmed. */
    label: string;
    /**
     * The matching `Chord` when the notes form a recognised quality, otherwise
     * undefined. Most inputs are not: a `Chord` is always a triad or a seventh,
     * whereas this parser accepts any set of notes, including one or two.
     */
    chord?: Chord;
}
/**
 * Find the `Chord` whose notes are exactly this set, if there is one.
 *
 * An augmented triad is symmetric under transposition — C, E and G# augmented
 * are the same three pitch classes — so the root is taken to be the first note
 * written rather than guessed.
 */
declare function chordFromPitchClasses(pitchClasses: number[]): Chord | undefined;
/**
 * Parse concatenated note letters into pitch classes.
 *
 *   parseChord("CEG")  // [0, 4, 7], recognised as C major
 *   parseChord("ACBb") // [9, 0, 10], no chord
 *   parseChord("CG")   // [0, 7], no chord
 *
 * Each note is a letter A–G with an optional `#` or `b`. Quality suffixes are
 * deliberately not accepted: "Cm" and "C7" throw rather than parse, because
 * the notation here spells out every note it means. Construct a `Chord`
 * directly if you want to name a quality instead of spelling it.
 *
 * Duplicates collapse to their first occurrence, so order carries meaning —
 * the first note written is the root.
 */
declare function parseChord(letters: string): ParsedChord;

export { Chord, type ChordType, type ChordTypeLabel, Interval, type IntervalName, type IntervalNote, type IntervalType, Mode, type ModeParams, type ModeType, type ModeTypeVanity, type Notation, type NotationAlternate, Note, OCTAVES, type ParsedChord, STEPS, Scale, type ScaleParams, chordFromPitchClasses, parseChord };
