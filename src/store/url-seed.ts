/**
 * Backwards-compat: translate legacy `?key=value` query params into store
 * writes at startup. Runs once before anything subscribes meaningfully.
 *
 * Hash-based shareable state (`#s=...`) is handled by the store itself.
 */

import { store } from "./store.js";
import type { SchemaKey } from "./schema.js";

// Legacy param name → schema key (where they differ)
const ALIAS: Record<string, SchemaKey> = {
  smoothing: "analysis.smoothing",
  hueSmoothing: "analysis.hueSmoothing",
  satFloor: "analysis.satFloor",
  valFloor: "analysis.valFloor",
  activityGain: "analysis.activityGain",
  activityNoise: "analysis.activityNoise",
  sparkLen: "global.sparkLen",
  mirror: "view.mirror",
  brightness: "calibration.brightness",
  contrast: "calibration.contrast",
  saturation: "calibration.saturation",
  hueRotate: "calibration.hueRotate",
  root: "harmony.root",
  octave: "harmony.octave",
  rootHue: "harmony.rootHue",
  crossZone: "harmony.crossZone",
  glideMin: "synth.glideMin",
  glideMax: "synth.glideMax",
  masterGain: "synth.masterGain",
  fmIndexBase: "synth.fmIndexBase",
  fmIndexScale: "synth.fmIndexScale",
  fmRatioDrift: "synth.fmRatioDrift",
  fmStereoWidth: "synth.fmStereoWidth",
  fmPluckRatio: "synth.fmPluckRatio",
  feedback: "audio.feedback",
  blobWarp: "audio.blobWarp",
  preferCamera: "source.preferCamera",
};

export function seedFromQuery(): void {
  const params = new URLSearchParams(location.search);
  if (params.size === 0) return;

  // ?source=... is special: a string means file mode, "camera" means camera.
  if (params.has("source")) {
    const raw = decodeURIComponent(params.get("source")!);
    if (raw === "camera") {
      store.set("source.kind", "camera", "url");
    } else {
      store.set("source.kind", "file", "url");
      store.set("source.file", raw, "url");
    }
  }

  if (params.has("palette")) {
    store.set(
      "harmony.palette",
      decodeURIComponent(params.get("palette")!),
      "url",
    );
  }

  for (const [raw, key] of Object.entries(ALIAS)) {
    if (!params.has(raw)) continue;
    const v = params.get(raw)!;
    if (v === "true" || v === "false") {
      store.set(key as never, (v === "true") as never, "url");
    } else {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        store.set(key as never, n as never, "url");
      } else {
        store.set(key as never, v as never, "url");
      }
    }
  }
}
