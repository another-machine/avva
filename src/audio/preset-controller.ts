/**
 * src/audio/preset-controller.ts
 *
 * PresetController: applies scene presets and detects divergence.
 *
 * Applying a preset:
 *   1. Set _applying guard to prevent divergence detection from firing during apply
 *   2. Patch all keys from the preset's params (excluding those tagged as local)
 *   3. Clear guard
 *
 * Divergence detection:
 *   When any sound-relevant key changes while _applying is false and the
 *   current scenePreset is not "custom", switch scenePreset to "custom".
 *   Re-entrant writes from BroadcastChannel echoes carry origin "broadcast" or
 *   "ws" — those are ignored (same-tab state sync shouldn't flip to custom).
 */

import { store } from "../store/store.js";
import { SCENE_PRESETS, SCENE_PRESET_KEYS } from "./scene-presets.js";

// Keys that, when changed by the user, should flip scenePreset → "custom"
const SOUND_KEY_PREFIXES = ["synth.", "cassette.", "mix."];

function isSoundKey(k: string): boolean {
  return SOUND_KEY_PREFIXES.some((p) => k.startsWith(p)) && k !== "synth.scenePreset";
}

export class PresetController {
  private _applying = false;

  constructor() {
    // Listen for scene preset selection.
    // Origin is intentionally NOT filtered here — the preset selector lives in
    // the controller window, so changes arrive at the loop window as "broadcast".
    store.subscribeKey("synth.scenePreset", (v) => {
      if (this._applying) return;
      const key = v as string;
      if (key !== "custom" && SCENE_PRESETS[key]) {
        this._applyPreset(key);
      }
    });

    // Divergence detection: any sound key change → custom
    store.subscribe((patch) => {
      if (this._applying) return;
      if (patch.origin === "broadcast" || patch.origin === "ws") return;
      if (!isSoundKey(patch.key)) return;
      const current = store.get("synth.scenePreset");
      if (current !== "custom") {
        this._applying = true;
        store.set("synth.scenePreset", "custom");
        this._applying = false;
      }
    });
  }

  private _applyPreset(key: string): void {
    const preset = SCENE_PRESETS[key];
    if (!preset) return;
    this._applying = true;
    try {
      for (const [k, v] of Object.entries(preset.params)) {
        try {
          store.set(k as any, v as any);
        } catch {
          // Schema key may not exist yet — skip gracefully
        }
      }
    } finally {
      this._applying = false;
    }
  }

  /** Programmatically apply a preset by key (bypasses origin filtering). */
  applyPreset(key: string): void {
    if (key === "custom") return;
    this._applying = true;
    store.set("synth.scenePreset", key as any);
    this._applyPreset(key);
    this._applying = false;
  }

  /** List all available preset keys in display order. */
  static presetKeys(): string[] {
    return [...SCENE_PRESET_KEYS, "custom"];
  }
}
