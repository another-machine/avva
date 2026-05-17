/**
 * src/harmony/chord-parser.ts
 *
 * Pure chord-name parser.  No DOM, no Web Audio, no external dependencies.
 *
 * Exports:
 *   QUALITIES            — map of quality string → semitone offset array
 *   parseChord(name)     — "Cmaj7" → ParsedChord
 *   parseChordList(str)  — "Cmaj7:2,F:1" → ChordSlotInput[]
 */

// ── Note name tables ──────────────────────────────────────────────────────────
export const SHARP_NAMES = [
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

const _ROOT_MAP: Record<string, number> = {
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

// ── Quality table ─────────────────────────────────────────────────────────────
export const QUALITIES: Record<string, readonly number[]> = {
  // Triads
  "": [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  // Sevenths
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  ø: [0, 3, 6, 10],
  // Sixths
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  // Extensions
  "9": [0, 4, 7, 10, 2],
  maj9: [0, 4, 7, 11, 2],
  m9: [0, 3, 7, 10, 2],
  add9: [0, 4, 7, 2],
  "11": [0, 4, 7, 10, 2, 5],
  "13": [0, 4, 7, 10, 2, 9],
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedChord {
  root: number;
  rootName: string;
  quality: string;
  pitchClasses: number[];
  label: string;
}

export interface ChordSlotInput {
  chord: string;
  bias: number;
  gain: number;
}

// ── parseChord ────────────────────────────────────────────────────────────────

export function parseChord(name: string): ParsedChord {
  const trimmed = name.trim();
  const m = trimmed.match(/^([A-G])([#b]?)(.*)$/);
  if (!m) throw new Error(`Cannot parse chord name: "${name}"`);

  const rootName = m[1] + m[2];
  const quality = m[3];

  const root = _ROOT_MAP[rootName];
  if (root === undefined)
    throw new Error(`Unknown root note: "${rootName}" in "${name}"`);

  const offsets = QUALITIES[quality];
  if (!offsets)
    throw new Error(`Unknown chord quality: "${quality}" in "${name}"`);

  const seen = new Set<number>();
  const pitchClasses: number[] = [];
  for (const off of offsets) {
    const pc = (root + off) % 12;
    if (!seen.has(pc)) {
      seen.add(pc);
      pitchClasses.push(pc);
    }
  }
  pitchClasses.sort((a, b) => a - b);

  return { root, rootName, quality, pitchClasses, label: rootName + quality };
}

// ── parseChordList ────────────────────────────────────────────────────────────

/**
 * Parse a comma- or pipe-separated list of `chord[:bias[:gain]]` entries.
 * e.g. "Cmaj7:2,F:1,Am7:1"
 */
export function parseChordList(str: string): ChordSlotInput[] {
  return str
    .split(/[,|]/)
    .map((entry) => {
      const parts = entry.trim().split(":");
      const chord = parts[0].trim();
      const bias =
        parts.length > 1 ? Math.max(0.001, Number(parts[1]) || 1) : 1;
      const gain = parts.length > 2 ? Number(parts[2]) || 1 : 1;
      return { chord, bias, gain };
    })
    .filter((e) => e.chord.length > 0);
}
