/**
 * src/harmony/harmony-source.ts
 *
 * HarmonySource is the unified type for the harmonic universe fed to
 * Synth, AudioAnalyzer, and AudioRendererGL. At runtime it is either a
 * diatonic Key or a custom Palette; callers that need to distinguish use
 * the type guards below.
 */

import { Key } from "./music.js";
import { Palette } from "./palette.js";

export type HarmonySource = Key | Palette;

export function isKey(src: HarmonySource): src is Key {
  return src instanceof Key;
}

export function isPalette(src: HarmonySource): src is Palette {
  return src instanceof Palette;
}
