/**
 * src/harmony/music.ts
 *
 * Minimal music theory helpers for AVVA.
 *
 * Exports:
 *   SCALE_MODES          — tuple of mode names
 *   ScaleMode            — union type of mode names
 *   buildTriadsForMode   — build 7 diatonic triad strings from a root + mode
 */

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

const FLAT_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

const _ROOT_PC: Record<string, number> = {
  C: 0,
  "C#": 1,
  Cb: 11,
  D: 2,
  "D#": 3,
  Db: 1,
  E: 4,
  "E#": 5,
  Eb: 3,
  F: 5,
  "F#": 6,
  Fb: 4,
  G: 7,
  "G#": 8,
  Gb: 6,
  A: 9,
  "A#": 10,
  Ab: 8,
  B: 11,
  "B#": 0,
  Bb: 10,
};

// ── Public exports ─────────────────────────────────────────────────────────────

export const SCALE_MODES = [
  "major",
  "minor",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "locrian",
] as const;

export type ScaleMode = (typeof SCALE_MODES)[number];

/**
 * Build 7 diatonic triad strings for a root + mode.
 * Each string is the concatenation of the 3 note names (e.g. "CEG", "ACE").
 * Uses flat names when root contains "b", sharp names otherwise.
 *
 * Example: buildTriadsForMode("A", "minor") →
 *   ["ACE", "BDF", "CEG", "DFA", "EGB", "FAC", "GBD"]
 */
export function buildTriadsForMode(root: string, mode: ScaleMode): string[] {
  const useFlats = root.includes("b");
  const names = useFlats ? FLAT_NAMES : NOTE_NAMES;

  const rootPC = _ROOT_PC[root];
  if (rootPC === undefined) throw new Error(`Unknown root: "${root}"`);

  const steps = SCALE_STEPS[mode] ?? SCALE_STEPS.major;
  const qualities = DEGREE_QUALITIES[mode] ?? DEGREE_QUALITIES.major;

  return steps.map((step, d) => {
    const degPC = (rootPC + step) % 12;
    const offsets = TRIAD_OFFSETS[qualities[d]] ?? TRIAD_OFFSETS.maj;
    return offsets.map((off) => names[(degPC + off) % 12]).join("");
  });
}
