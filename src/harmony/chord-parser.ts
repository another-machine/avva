/**
 * src/harmony/chord-parser.ts
 *
 * Letter-notation chord parser. No DOM, no Web Audio, no external dependencies.
 *
 * Notation: concatenated note letters with optional accidentals.
 *   "CEG"  → [0,4,7]   "ACBb" → [9,0,10]   "C" → [0]   "CG" → [0,7]
 *
 * Exports:
 *   Chord              — { pitchClasses, label }
 *   ChordSlotInput     — { chord, bias, gain }
 *   parseChord(str)    — letter sequence → Chord  (throws on non-letter chars)
 *   parseChordList(str) — "CEG:2,FAC:1" → ChordSlotInput[]
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Chord {
  pitchClasses: number[]; // deduped, in user-written order, values 0–11
  label: string; // original input, trimmed
}

export interface ChordSlotInput {
  chord: string;
  bias: number;
  gain: number;
}

// ── parseChord ────────────────────────────────────────────────────────────────

/**
 * Parse a letter-notation chord string into pitch classes.
 * Each note is one letter [A-G] followed by an optional accidental [#b].
 * Throws on any non-letter, non-accidental character (e.g. "m", "7", digits).
 */
export function parseChord(letters: string): Chord {
  const trimmed = letters.trim();
  if (!trimmed) throw new Error(`Empty chord: "${letters}"`);

  const seen = new Set<number>();
  const pitchClasses: number[] = [];
  let pos = 0;

  while (pos < trimmed.length) {
    const ch = trimmed[pos];
    if (!/[A-G]/.test(ch))
      throw new Error(
        `Unexpected character "${ch}" in chord "${letters}" (position ${pos}). Use letters A–G with optional # or b.`,
      );

    let noteName = ch;
    pos++;
    if (
      pos < trimmed.length &&
      (trimmed[pos] === "#" || trimmed[pos] === "b")
    ) {
      noteName += trimmed[pos];
      pos++;
    }

    const pc = _ROOT_MAP[noteName];
    if (pc === undefined)
      throw new Error(`Unknown note "${noteName}" in chord "${letters}"`);

    if (!seen.has(pc)) {
      seen.add(pc);
      pitchClasses.push(pc);
    }
  }

  if (pitchClasses.length === 0)
    throw new Error(`No notes in chord: "${letters}"`);

  return { pitchClasses, label: trimmed };
}

// ── parseChordList ────────────────────────────────────────────────────────────

/**
 * Parse a comma- or pipe-separated list of `chord[:bias[:gain]]` entries.
 * e.g. "CEG:2,FAC:1,GBD"
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
