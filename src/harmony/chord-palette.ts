/**
 * src/harmony/chord-palette.ts
 *
 * The seam between the hue wheel in ./palette and what AVVA does with it.
 *
 * The wheel is generic — it divides hue into slots and never inspects them.
 * Deciding that a slot is a chord, and how to match live audio against one, is
 * this application's job, so it lives here rather than in the wheel. Both sides
 * of that seam are now in this directory, which makes the separation a
 * convention rather than something the module system enforces — keep it anyway,
 * since it is what would let the wheel be extracted again.
 *
 * Note the slot syntax. The wheel has no bias field: a slot is wider because it
 * appears more than once, so "CEG, CEG, FAC" gives CEG half the wheel. AVVA's
 * old `chord:bias` syntax is gone, but nothing used it — every preset and the
 * default were plain comma-separated lists, which parse identically either way.
 */

import { Palette, type HueBlendResult } from "./palette";
import { parseChord, type ParsedChord } from "@amplib/music-theory";

/** A hue wheel whose slots are parsed chords. */
export type ChordPalette = Palette<ParsedChord>;

export type ChordSlotBlend = HueBlendResult<ParsedChord>;

export interface ChordTemplate {
  label: string;
  key: string;
  /** Twelve-element chroma vector, weighted by position in the chord. */
  vec: Float32Array;
  norm: number;
}

const SHARP_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export interface ChordPaletteParams {
  rootHue?: number;
  crossZone?: number;
}

/**
 * Build a palette from a comma-separated chord list.
 *
 * `map` is what attaches meaning, and it memoises by input — so a chord written
 * twice becomes the same parsed object, which is what lets the wheel recognise
 * the two sectors as one band rather than crossfading a chord with itself.
 */
export function createChordPalette(
  input: string,
  { rootHue = 0, crossZone = 0.15 }: ChordPaletteParams = {},
): ChordPalette {
  return Palette.fromString(input, { rootHue, crossZone }).map(parseChord);
}

// Templates are derived from the slots, so they are cached against the palette
// that produced them — the audio analyzer asks for them every frame.
const templateCache = new WeakMap<ChordPalette, ChordTemplate[]>();

/**
 * Chroma vectors for matching audio against a palette.
 *
 * Notes are weighted by position, root highest, falling off linearly. That is
 * what lets a one-note slot beat a three-note slot when only that note is
 * sounding — with flat weights the longer chord wins on sheer overlap.
 */
export function chordTemplates(palette: ChordPalette): ChordTemplate[] {
  const cached = templateCache.get(palette);
  if (cached) return cached;

  const templates = palette.slots.map((slot) => {
    const pitchClasses = slot.value.pitchClasses;
    const vec = new Float32Array(12);
    const count = pitchClasses.length;
    for (let i = 0; i < count; i++) {
      vec[pitchClasses[i]] = (count - i) / count;
    }
    let normSquared = 0;
    for (let i = 0; i < 12; i++) normSquared += vec[i] * vec[i];
    return {
      label: slot.value.label,
      key: pitchClasses
        .map((pitchClass) => SHARP_NAMES[pitchClass])
        .sort()
        .join("-"),
      vec,
      norm: Math.sqrt(normSquared),
    };
  });

  templateCache.set(palette, templates);
  return templates;
}
