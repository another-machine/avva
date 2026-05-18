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
  unit?: string;
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
export const SOURCE_KINDS = [
  "camera",
  "file",
  "files",
  "screen",
  "url",
] as const;

export type HarmonyMode = "scale" | "palette";
export type FacingMode = "environment" | "user";

// ── Schema ──────────────────────────────────────────────────────

export const SCHEMA = {
  // ── view / app ─────────────────────────────────────────────
  "view.mirror": {
    kind: "boolean",
    default: false,
    label: "Mirror video",
    group: "view",
  },
  "view.heatOn": {
    kind: "boolean",
    default: false,
    label: "Motion heatmap",
    group: "view",
  },

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
  "source.file": {
    kind: "string",
    default: "",
    label: "File path",
    group: "source",
  },
  "source.url": {
    kind: "string",
    default: "",
    label: "Stream URL",
    group: "source",
  },
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
    unit: "×",
    group: "source",
  },

  // ── analysis ───────────────────────────────────────────────
  "analysis.sampleW": {
    kind: "number",
    default: 96,
    min: 16,
    max: 320,
    step: 8,
    label: "Sample width",
    group: "analysis",
  },
  "analysis.sampleH": {
    kind: "number",
    default: 72,
    min: 16,
    max: 240,
    step: 8,
    label: "Sample height",
    group: "analysis",
  },
  "analysis.smoothing": {
    kind: "number",
    default: 0.18,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Smoothing",
    group: "analysis",
    hint: "EMA weight on all signals — higher = slower response, more stable",
  },
  "analysis.hueSmoothing": {
    kind: "number",
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Hue smoothing",
    group: "analysis",
    hint: "Separate EMA for hue — decouples colour tracking from motion noise",
  },
  "analysis.satFloor": {
    kind: "number",
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Sat floor",
    group: "analysis",
    hint: "Min saturation for a pixel to count as vivid. Raises it to filter grey/neutral pixels",
  },
  "analysis.valFloor": {
    kind: "number",
    default: 0.06,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Value floor",
    group: "analysis",
    hint: "Min brightness for a pixel to be included in hue/sat analysis",
  },
  "analysis.activityGain": {
    kind: "number",
    default: 7.0,
    min: 0,
    max: 30,
    step: 0.1,
    label: "Activity gain",
    unit: "×",
    group: "analysis",
    hint: "Multiplier on raw frame-diff signal before clamping to 0–1",
  },
  "analysis.activityNoise": {
    kind: "number",
    default: 0.012,
    min: 0,
    max: 0.2,
    step: 0.001,
    label: "Activity noise floor",
    group: "analysis",
    hint: "Frame-diff below this is clamped to zero — suppresses camera sensor noise",
  },
  "analysis.hueBins": {
    kind: "number",
    default: 30,
    min: 6,
    max: 120,
    step: 1,
    label: "Hue bins",
    group: "analysis",
    hint: "Histogram buckets around the hue wheel — more = finer resolution",
  },
  "analysis.sparkLen": {
    kind: "number",
    default: 160,
    min: 30,
    max: 600,
    step: 10,
    label: "Sparkline length",
    group: "analysis",
    hint: "Frames of history shown in sparklines",
  },

  // ── calibration ────────────────────────────────────────────
  "calibration.brightness": {
    kind: "number",
    default: 1.0,
    min: 0.1,
    max: 3.0,
    step: 0.05,
    label: "Brightness",
    group: "calibration",
  },
  "calibration.contrast": {
    kind: "number",
    default: 1.0,
    min: 0.1,
    max: 3.0,
    step: 0.05,
    label: "Contrast",
    group: "calibration",
  },
  "calibration.saturation": {
    kind: "number",
    default: 1.0,
    min: 0.0,
    max: 4.0,
    step: 0.05,
    label: "Saturation",
    group: "calibration",
  },
  "calibration.hueRotate": {
    kind: "number",
    default: 0,
    min: -180,
    max: 180,
    step: 5,
    label: "Hue rotate",
    unit: "°",
    group: "calibration",
    hint: "CSS hue-rotate applied to video before analysis — shifts all colours around the wheel",
  },

  // ── harmony ────────────────────────────────────────────────
  "harmony.mode": {
    kind: "enum",
    default: "scale" as HarmonyMode,
    options: ["scale", "palette"] as const,
    label: "Harmony mode",
    group: "harmony",
    hint: "Scale: maps hue angles to diatonic degrees. Palette: custom chord list — each chord owns a hue range",
  },
  "harmony.root": {
    kind: "string",
    default: "A",
    label: "Root",
    group: "harmony",
  },
  "harmony.scale": {
    kind: "string",
    default: "locrian",
    label: "Scale",
    group: "harmony",
  },
  "harmony.octave": {
    kind: "number",
    default: 4,
    min: 1,
    max: 7,
    step: 1,
    label: "Octave",
    group: "harmony",
  },
  "harmony.rootHue": {
    kind: "number",
    default: 0,
    min: 0,
    max: 360,
    step: 1,
    label: "Root hue",
    unit: "°",
    group: "harmony",
  },
  "harmony.palette": {
    kind: "string",
    default: "",
    label: "Palette",
    group: "harmony",
    hint: "Comma-separated chord names e.g. Am,C,G,Em — each chord is assigned a hue arc",
  },
  "harmony.crossZone": {
    kind: "number",
    default: 0.15,
    min: 0,
    max: 0.5,
    step: 0.01,
    label: "Cross-fade zone",
    group: "harmony",
    hint: "Hue overlap fraction between adjacent palette chords — widens the blend region",
  },

  // ── synth ──────────────────────────────────────────────────
  "synth.enabled": {
    kind: "boolean",
    default: false,
    label: "Synth on",
    group: "synth",
  },
  "synth.masterGain": {
    kind: "number",
    default: 0.28,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Master gain",
    group: "synth",
  },
  "synth.glideMin": {
    kind: "number",
    default: 0.01,
    min: 0,
    max: 1,
    step: 0.005,
    label: "Glide min",
    unit: "s",
    group: "synth",
    hint: "Shortest portamento time — reached at low activity",
  },
  "synth.glideMax": {
    kind: "number",
    default: 2.0,
    min: 0,
    max: 5,
    step: 0.05,
    label: "Glide max",
    unit: "s",
    group: "synth",
    hint: "Longest portamento time — reached at high activity",
  },
  "synth.fmIndexBase": {
    kind: "number",
    default: 0.15,
    min: 0,
    max: 5,
    step: 0.05,
    label: "FM index base",
    group: "synth",
    hint: "Starting FM modulation index at zero saturation/brightness — sets the base timbre",
  },
  "synth.fmIndexScale": {
    kind: "number",
    default: 2.4,
    min: 0,
    max: 10,
    step: 0.1,
    label: "FM index scale",
    group: "synth",
    hint: "How much FM index grows as saturation increases — more = brighter/harsher with vivid colours",
  },
  "synth.fmRatioDrift": {
    kind: "number",
    default: 0.04,
    min: 0,
    max: 0.5,
    step: 0.005,
    label: "FM ratio drift",
    group: "synth",
    hint: "Random walk on carrier:modulator ratio — adds beating and metallic texture",
  },
  "synth.fmStereoWidth": {
    kind: "number",
    default: 0.75,
    min: 0,
    max: 1,
    step: 0.05,
    label: "FM stereo width",
    group: "synth",
    hint: "Spread between L/R FM voices — 0 = mono, 1 = maximum stereo width",
  },
  "synth.fmPluckRatio": {
    kind: "number",
    default: 2,
    min: 1,
    max: 12,
    step: 1,
    label: "FM pluck ratio",
    group: "synth",
    hint: "Carrier:modulator integer ratio for pluck voices — higher = brighter attack tone",
  },

  // ── cassette effects ───────────────────────────────────────
  "cassette.midBoostDb": {
    kind: "number",
    default: 3,
    min: 0,
    max: 12,
    step: 0.5,
    label: "Mid boost",
    unit: "dB",
    group: "cassette",
  },
  "cassette.masterLPHz": {
    kind: "number",
    default: 12000,
    min: 3000,
    max: 20000,
    step: 100,
    label: "Master LP cutoff",
    unit: "Hz",
    group: "cassette",
    hint: "Low-pass filter on the final mix — reduces harshness and adds warmth",
  },
  "cassette.satAmount": {
    kind: "number",
    default: 8,
    min: 0,
    max: 20,
    step: 0.5,
    label: "Saturation",
    group: "cassette",
  },
  "cassette.satWet": {
    kind: "number",
    default: 0.4,
    min: 0,
    max: 1,
    step: 0.02,
    label: "Sat wet",
    group: "cassette",
  },
  "cassette.tapeDelayMs": {
    kind: "number",
    default: 120,
    min: 20,
    max: 400,
    step: 5,
    label: "Tape delay",
    unit: "ms",
    group: "cassette",
  },
  "cassette.tapeDelayFb": {
    kind: "number",
    default: 0.22,
    min: 0,
    max: 0.9,
    step: 0.01,
    label: "Delay feedback",
    group: "cassette",
  },
  "cassette.tapeDelayWet": {
    kind: "number",
    default: 0.18,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Delay wet",
    group: "cassette",
  },
  "cassette.reverbWet": {
    kind: "number",
    default: 0.1,
    min: 0,
    max: 0.5,
    step: 0.01,
    label: "Reverb wet",
    group: "cassette",
    hint: "Convolution reverb mix — adds ambience and tail",
  },
  "cassette.noiseGain": {
    kind: "number",
    default: 0.015,
    min: 0,
    max: 0.1,
    step: 0.001,
    label: "Hiss level",
    group: "cassette",
    hint: "Amplitude of the tape-hiss noise mixed into the signal",
  },
  "cassette.wowDepthCents": {
    kind: "number",
    default: 6,
    min: 0,
    max: 20,
    step: 0.5,
    label: "Wow depth",
    unit: "¢",
    group: "cassette",
    hint: "Slow LFO pitch wobble depth — 100¢ = 1 semitone",
  },
  "cassette.flutterDepthCents": {
    kind: "number",
    default: 1.5,
    min: 0,
    max: 8,
    step: 0.1,
    label: "Flutter depth",
    unit: "¢",
    group: "cassette",
    hint: "Fast motor-flutter pitch depth — higher = more degraded/worn feel",
  },

  // ── audio renderer (loop view) ─────────────────────────────
  "audio.feedback": {
    kind: "number",
    default: 0.92,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Feedback decay",
    group: "audio",
    hint: "WebGL frame-feedback strength — how much of the last visual frame persists (loop view)",
  },
  "audio.noiseScale": {
    kind: "number",
    default: 2.5,
    min: 0.1,
    max: 10,
    step: 0.1,
    label: "Noise scale",
    group: "audio",
    hint: "Scale of the noise texture in the WebGL visualizer (loop view)",
  },
} as const satisfies Record<string, Field>;

export type SchemaKey = keyof typeof SCHEMA;

// Widen literal defaults to their semantic type so the store accepts any
// in-range value, not just the literal default.
type Widen<T> = T extends number
  ? number
  : T extends boolean
    ? boolean
    : T extends string
      ? T extends SourceKind | HarmonyMode | FacingMode
        ? T
        : string
      : T;

export type Settings = {
  [K in SchemaKey]: (typeof SCHEMA)[K] extends { options: readonly (infer O)[] }
    ? O
    : Widen<(typeof SCHEMA)[K]["default"]>;
};

export const SCHEMA_VERSION = 1;
