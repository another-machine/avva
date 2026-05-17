/**
 * Settings schema. Single source of truth for every tunable parameter.
 *
 * Each field carries metadata (default, range, step, label, group) so the
 * controller window can render UI automatically. Add a field here and it
 * shows up in the controller without touching the controller code.
 *
 * Schema is flat (dot.path keys) so transports/persistence/diffing stay
 * trivial. Group is a UI-only hint.
 */

export type FieldKind = "number" | "boolean" | "string" | "enum" | "json";

interface FieldBase<T> {
  default: T;
  label: string;
  group: string;
  hint?: string;
}

interface NumberField extends FieldBase<number> {
  kind: "number";
  min: number;
  max: number;
  step: number;
}

interface BooleanField extends FieldBase<boolean> {
  kind: "boolean";
}

interface StringField extends FieldBase<string> {
  kind: "string";
}

interface EnumField<T extends string> extends FieldBase<T> {
  kind: "enum";
  options: readonly T[];
}

interface JsonField<T> extends FieldBase<T> {
  kind: "json";
}

export type Field =
  | NumberField
  | BooleanField
  | StringField
  | EnumField<string>
  | JsonField<unknown>;

// ── Source types ────────────────────────────────────────────────

export type SourceKind = "camera" | "file" | "files" | "screen" | "url";
export const SOURCE_KINDS = ["camera", "file", "files", "screen", "url"] as const;

export type HarmonyMode = "scale" | "palette";
export type ViewMode = "analysis" | "loop";
export type FacingMode = "environment" | "user";

// ── Schema ──────────────────────────────────────────────────────

export const SCHEMA = {
  // ── view / app ─────────────────────────────────────────────
  "view.mode": {
    kind: "enum",
    default: "analysis" as ViewMode,
    options: ["analysis", "loop"] as const,
    label: "View",
    group: "view",
  },
  "view.hud": { kind: "boolean", default: true, label: "HUD visible", group: "view" },
  "view.mirror": { kind: "boolean", default: false, label: "Mirror video", group: "view" },
  "view.heatOn": { kind: "boolean", default: false, label: "Motion heatmap", group: "view" },

  // ── input source ───────────────────────────────────────────
  "source.kind": {
    kind: "enum",
    default: "camera" as SourceKind,
    options: SOURCE_KINDS,
    label: "Source",
    group: "source",
  },
  "source.files": {
    kind: "json",
    default: [] as string[],
    label: "File list (files mode)",
    group: "source",
  },
  "source.file": { kind: "string", default: "", label: "File path", group: "source" },
  "source.url": { kind: "string", default: "", label: "Stream URL", group: "source" },
  "source.preferCamera": {
    kind: "enum",
    default: "environment" as FacingMode,
    options: ["environment", "user"] as const,
    label: "Camera facing",
    group: "source",
  },
  "source.playbackRate": {
    kind: "number",
    default: 1.0,
    min: 0.1,
    max: 4.0,
    step: 0.05,
    label: "Playback rate",
    group: "source",
  },

  // ── analysis ───────────────────────────────────────────────
  "analysis.sampleW": { kind: "number", default: 96, min: 16, max: 320, step: 8, label: "Sample width", group: "analysis" },
  "analysis.sampleH": { kind: "number", default: 72, min: 16, max: 240, step: 8, label: "Sample height", group: "analysis" },
  "analysis.smoothing": { kind: "number", default: 0.18, min: 0, max: 1, step: 0.01, label: "Smoothing", group: "analysis" },
  "analysis.hueSmoothing": { kind: "number", default: 0.2, min: 0, max: 1, step: 0.01, label: "Hue smoothing", group: "analysis" },
  "analysis.satFloor": { kind: "number", default: 0.1, min: 0, max: 1, step: 0.01, label: "Sat floor", group: "analysis" },
  "analysis.valFloor": { kind: "number", default: 0.06, min: 0, max: 1, step: 0.01, label: "Value floor", group: "analysis" },
  "analysis.activityGain": { kind: "number", default: 7.0, min: 0, max: 30, step: 0.1, label: "Activity gain", group: "analysis" },
  "analysis.activityNoise": { kind: "number", default: 0.012, min: 0, max: 0.2, step: 0.001, label: "Activity noise floor", group: "analysis" },
  "analysis.hueBins": { kind: "number", default: 30, min: 6, max: 120, step: 1, label: "Hue bins", group: "analysis" },
  "analysis.sparkLen": { kind: "number", default: 160, min: 30, max: 600, step: 10, label: "Sparkline length", group: "analysis" },

  // ── calibration ────────────────────────────────────────────
  "calibration.brightness": { kind: "number", default: 1.0, min: 0.1, max: 3.0, step: 0.05, label: "Brightness", group: "calibration" },
  "calibration.contrast": { kind: "number", default: 1.0, min: 0.1, max: 3.0, step: 0.05, label: "Contrast", group: "calibration" },
  "calibration.saturation": { kind: "number", default: 1.0, min: 0.0, max: 4.0, step: 0.05, label: "Saturation", group: "calibration" },
  "calibration.hueRotate": { kind: "number", default: 0, min: -180, max: 180, step: 5, label: "Hue rotate", group: "calibration" },

  // ── harmony ────────────────────────────────────────────────
  "harmony.mode": {
    kind: "enum",
    default: "scale" as HarmonyMode,
    options: ["scale", "palette"] as const,
    label: "Harmony mode",
    group: "harmony",
  },
  "harmony.root": { kind: "string", default: "A", label: "Root", group: "harmony" },
  "harmony.scale": { kind: "string", default: "locrian", label: "Scale", group: "harmony" },
  "harmony.octave": { kind: "number", default: 4, min: 1, max: 7, step: 1, label: "Octave", group: "harmony" },
  "harmony.rootHue": { kind: "number", default: 0, min: 0, max: 360, step: 1, label: "Root hue °", group: "harmony" },
  "harmony.palette": { kind: "string", default: "", label: "Palette (chord list)", group: "harmony" },
  "harmony.crossZone": { kind: "number", default: 0.15, min: 0, max: 0.5, step: 0.01, label: "Cross-fade zone", group: "harmony" },

  // ── synth ──────────────────────────────────────────────────
  "synth.enabled": { kind: "boolean", default: false, label: "Synth on", group: "synth" },
  "synth.masterGain": { kind: "number", default: 0.28, min: 0, max: 1, step: 0.01, label: "Master gain", group: "synth" },
  "synth.glideMin": { kind: "number", default: 0.01, min: 0, max: 1, step: 0.005, label: "Glide min (s)", group: "synth" },
  "synth.glideMax": { kind: "number", default: 2.0, min: 0, max: 5, step: 0.05, label: "Glide max (s)", group: "synth" },
  "synth.fmIndexBase": { kind: "number", default: 0.15, min: 0, max: 5, step: 0.05, label: "FM index base", group: "synth" },
  "synth.fmIndexScale": { kind: "number", default: 2.4, min: 0, max: 10, step: 0.1, label: "FM index scale", group: "synth" },
  "synth.fmRatioDrift": { kind: "number", default: 0.04, min: 0, max: 0.5, step: 0.005, label: "FM ratio drift", group: "synth" },
  "synth.fmStereoWidth": { kind: "number", default: 0.75, min: 0, max: 1, step: 0.05, label: "FM stereo width", group: "synth" },
  "synth.fmPluckRatio": { kind: "number", default: 2, min: 1, max: 12, step: 1, label: "FM pluck ratio", group: "synth" },

  // ── audio renderer (loop view) ─────────────────────────────
  "audio.feedback": { kind: "number", default: 0.92, min: 0, max: 1, step: 0.01, label: "Feedback decay", group: "audio" },
  "audio.noiseScale": { kind: "number", default: 2.5, min: 0.1, max: 10, step: 0.1, label: "Noise scale", group: "audio" },
} as const satisfies Record<string, Field>;

export type SchemaKey = keyof typeof SCHEMA;

// Widen literal defaults to their semantic type so the store accepts any
// in-range value, not just the literal default.
type Widen<T> = T extends number
  ? number
  : T extends boolean
    ? boolean
    : T extends string
      ? T extends ViewMode | SourceKind | HarmonyMode | FacingMode
        ? T
        : string
      : T;

export type Settings = {
  [K in SchemaKey]: (typeof SCHEMA)[K] extends { options: readonly (infer O)[] }
    ? O
    : Widen<(typeof SCHEMA)[K]["default"]>;
};

export const SCHEMA_VERSION = 1;
