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

export type FieldKind =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "select"
  | "json"
  | "action";

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

interface SelectField<T extends string> extends FieldBase<T> {
  kind: "select";
  options: readonly T[];
}

interface JsonField<T> extends FieldBase<T> {
  kind: "json";
}

export interface ActionField {
  kind: "action";
  default: null;
  label: string;
  group: string;
  hint?: string;
}

export type Field =
  | NumberField
  | BooleanField
  | StringField
  | EnumField<string>
  | SelectField<string>
  | JsonField<unknown>
  | ActionField;

// ── Source types ────────────────────────────────────────────────

export type SourceKind = "camera" | "file" | "screen" | "url";
export const SOURCE_KINDS = ["camera", "file", "screen", "url"] as const;

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
  "analysis.hueOffset": {
    kind: "number",
    default: 0,
    min: -180,
    max: 180,
    step: 5,
    label: "Hue offset",
    unit: "°",
    group: "analysis",
    hint: "Rotates the hue wheel before bucketing — e.g. +15 puts pure red at the centre of bucket 1 instead of its left edge",
  },
  "global.sparkLen": {
    kind: "number",
    default: 160,
    min: 30,
    max: 600,
    step: 10,
    label: "Sparkline length",
    group: "global",
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
  "harmony.root": {
    kind: "string",
    default: "A",
    label: "Root",
    group: "harmony",
  },
  "harmony.scale": {
    kind: "enum",
    default: "major",
    options: [
      "major",
      "minor",
      "dorian",
      "phrygian",
      "lydian",
      "mixolydian",
      "locrian",
    ] as const,
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
    group: "synth",
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
    default: "CEG, FAC, GBD",
    label: "Palette",
    group: "harmony",
    hint: "Comma-separated note letters e.g. CEG, FAC, GBD — each chord owns a hue arc. Use # and b for accidentals (e.g. ACEb).",
  },
  "harmony.fillTriads": {
    kind: "action",
    default: null,
    label: "Fill palette with triads",
    group: "harmony",
    hint: "Fills the palette with 7 diatonic triads from the current Root + Scale",
  } as ActionField,
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
    group: "global",
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
    min: 0.001,
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
    min: 0.05,
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
  "synth.carrierTypeBass": {
    kind: "select",
    default: "sine" as string,
    options: [
      "sine",
      "triangle",
      "square",
      "sawtooth",
      "pwm",
      "organ",
      "softsaw",
    ] as const,
    label: "Bass carrier wave",
    group: "synth",
    hint: "Waveform for bass-tier pad oscillators",
  },
  "synth.carrierTypeMid": {
    kind: "select",
    default: "sine" as string,
    options: [
      "sine",
      "triangle",
      "square",
      "sawtooth",
      "pwm",
      "organ",
      "softsaw",
    ] as const,
    label: "Mid carrier wave",
    group: "synth",
    hint: "Waveform for mid-tier pad oscillators",
  },
  "synth.carrierTypeTreble": {
    kind: "select",
    default: "sine" as string,
    options: [
      "sine",
      "triangle",
      "square",
      "sawtooth",
      "pwm",
      "organ",
      "softsaw",
    ] as const,
    label: "Treble carrier wave",
    group: "synth",
    hint: "Waveform for treble-tier pad oscillators",
  },
  "synth.carrierTypePluck": {
    kind: "select",
    default: "sine" as string,
    options: [
      "sine",
      "triangle",
      "square",
      "sawtooth",
      "pwm",
      "organ",
      "softsaw",
    ] as const,
    label: "Pluck carrier wave",
    group: "synth",
    hint: "Waveform for pluck voice oscillators",
  },
  "synth.glideSpread": {
    kind: "number",
    default: 1.0,
    min: 0,
    max: 3,
    step: 0.05,
    label: "Glide spread",
    group: "synth",
    hint: "How much chord voices diverge in portamento time — 0 = all voices glide together, higher = wider stagger",
  },
  "synth.octaveOffsetBass": {
    kind: "number",
    default: -1,
    min: -3,
    max: 3,
    step: 1,
    label: "Bass tier octave",
    group: "synth",
    hint: "Octave offset for the low-tier pad voices, relative to harmony.octave",
  },
  "synth.octaveOffsetMid": {
    kind: "number",
    default: 0,
    min: -3,
    max: 3,
    step: 1,
    label: "Mid tier octave",
    group: "synth",
    hint: "Octave offset for the mid-tier pad voices, relative to harmony.octave",
  },
  "synth.octaveOffsetTreble": {
    kind: "number",
    default: 1,
    min: -3,
    max: 3,
    step: 1,
    label: "Treble tier octave",
    group: "synth",
    hint: "Octave offset for the high-tier pad voices, relative to harmony.octave",
  },

  "synth.octaveOffsetPluck": {
    kind: "number",
    default: 1,
    min: -3,
    max: 3,
    step: 1,
    label: "Pluck octave",
    group: "synth",
    hint: "Octave offset for pluck voices, relative to harmony.octave",
  },

  "synth.articulation": {
    kind: "number",
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Articulation",
    group: "synth",
    hint: "0 = lush sustained pads, 1 = percussive plucks only. Mid values re-trigger pads as short envelopes synced to chord change.",
  },
  "synth.pulseRate": {
    kind: "number",
    default: 0,
    min: 0,
    max: 12,
    step: 0.1,
    label: "Pulse rate",
    unit: "Hz",
    group: "synth",
    hint: "When > 0, pads re-trigger on a steady tempo regardless of motion. 0 disables pulsing.",
  },
  "synth.preset": {
    kind: "select",
    default: "custom" as const,
    options: [
      "custom",
      "lush",
      "drone",
      "staccato",
      "percussive",
      "bell",
    ] as const,
    label: "Preset",
    group: "synth",
    hint: "Snaps a bundle of synth + cassette params to a named aesthetic. 'custom' is the live-edited state.",
  },

  // ── cassette effects ───────────────────────────────────────
  "cassette.preset": {
    kind: "select",
    default: "clean" as const,
    options: ["custom", "clean", "warm", "lofi", "vintage", "live"] as const,
    label: "Tape preset",
    group: "cassette",
    hint: "Snaps cassette effect params to a named tape-machine aesthetic.",
  },
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
    default: 0,
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

  // ── audio analyzer (stage 3) ───────────────────────────────
  "audioAnalysis.gateExp": {
    kind: "number",
    default: 50,
    min: 5,
    max: 200,
    step: 1,
    label: "Gate exponent",
    group: "audioAnalysis",
    hint: "Steepness of the prominence gate — higher = only near-peak bins register",
  },
  "audioAnalysis.attackTau": {
    kind: "number",
    default: 0.25,
    min: 0.01,
    max: 1,
    step: 0.01,
    label: "Attack",
    group: "audioAnalysis",
    hint: "Per-note EMA factor when note energy is rising (higher = snappier attack)",
  },
  "audioAnalysis.releaseTau": {
    kind: "number",
    default: 0.06,
    min: 0.01,
    max: 0.5,
    step: 0.005,
    label: "Release",
    group: "audioAnalysis",
    hint: "Per-note EMA factor when note energy is falling (lower = longer sustain)",
  },
  "audioAnalysis.octL": {
    kind: "number",
    default: 2,
    min: 1,
    max: 4,
    step: 1,
    label: "Octave low",
    group: "audioAnalysis",
    hint: "Lowest octave scanned for note detection (C2 = 65 Hz)",
  },
  "audioAnalysis.octH": {
    kind: "number",
    default: 6,
    min: 4,
    max: 8,
    step: 1,
    label: "Octave high",
    group: "audioAnalysis",
    hint: "Highest octave scanned for note detection (C6 = 1047 Hz)",
  },
  "audioAnalysis.stickyRatio": {
    kind: "number",
    default: 0.9,
    min: 0.5,
    max: 1.0,
    step: 0.01,
    label: "Sticky ratio",
    group: "audioAnalysis",
    hint: "Previous chord wins if it scores ≥ this fraction of the new best — prevents rapid flickering",
  },

  // ── visual synthesis (stage 4 — blob renderer) ─────────────
  "audio.feedback": {
    kind: "number",
    default: 0.92,
    min: 0,
    max: 1,
    step: 0.01,
    label: "Feedback decay",
    group: "visualSynthesis",
    hint: "How much of the previous frame persists — higher = longer glowing trails",
  },
  "audio.blobWarp": {
    kind: "number",
    default: 0.022,
    min: 0,
    max: 0.12,
    step: 0.002,
    label: "Edge warp",
    group: "visualSynthesis",
    hint: "Noise displacement on blob edges — higher = more organic, wobbly outlines",
  },
  "audio.blobSpeed": {
    kind: "number",
    default: 1.0,
    min: 0,
    max: 4,
    step: 0.05,
    label: "Blob speed",
    group: "visualSynthesis",
    hint: "Base drift speed of all blobs",
  },
  "audio.blobDrive": {
    kind: "number",
    default: 1.2,
    min: 0,
    max: 5,
    step: 0.1,
    label: "Activity drive",
    group: "visualSynthesis",
    hint: "How much video motion accelerates blob movement",
  },
  "audio.shiftSpeed": {
    kind: "number",
    default: 1.5,
    min: 0,
    max: 6,
    step: 0.1,
    label: "Shift burst",
    group: "visualSynthesis",
    hint: "Velocity burst added to blobs on each chord change — decays with the pulse",
  },
  "audio.blobSize": {
    kind: "number",
    default: 0.2,
    min: 0.05,
    max: 0.6,
    step: 0.01,
    label: "Blob size",
    group: "visualSynthesis",
    hint: "Base radius of each blob — larger = fewer, rounder shapes",
  },
  "audio.blobSharp": {
    kind: "number",
    default: 0.4,
    min: 0.05,
    max: 1.5,
    step: 0.05,
    label: "Merge softness",
    group: "visualSynthesis",
    hint: "Width of the blob isosurface — low = crisp hard edges, high = soft glowing merges",
  },
  "audio.pulseReactivity": {
    kind: "number",
    default: 1,
    min: 0,
    max: 4,
    step: 0.05,
    label: "Pulse reactivity",
    group: "visualSynthesis",
    hint: "How strongly band energy bursts the bright pulse blobs riding on top of each chord blob.",
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
      ? T extends SourceKind | FacingMode
        ? T
        : string
      : T;

export type Settings = {
  [K in SchemaKey]: (typeof SCHEMA)[K] extends { options: readonly (infer O)[] }
    ? O
    : Widen<(typeof SCHEMA)[K]["default"]>;
};

export const SCHEMA_VERSION = 1;
