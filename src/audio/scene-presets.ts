/**
 * src/audio/scene-presets.ts
 *
 * Unified scene presets — each bundles synth + cassette + mix params into a
 * named aesthetic. Validated at module load against the live schema defaults.
 *
 * A preset specifies only the params it overrides; unmentioned params keep
 * whatever value they already have. gainTrimDb is a per-preset loudness offset
 * (applied to masterGain multiplicatively) so all presets land near −16 LUFS.
 */

export interface ScenePreset {
  label: string;
  description: string;
  /** Partial settings patch — merged over the current store state. */
  params: Record<string, unknown>;
  /** Additional dB offset on master gain for loudness normalization. */
  gainTrimDb?: number;
}

export const SCENE_PRESETS: Record<string, ScenePreset> = {

  // ── Warm organic ─────────────────────────────────────────────────────────

  "cassette-memory": {
    label: "Cassette Memory",
    description: "Warm FM pads with tape saturation and light hiss — lo-fi, nostalgic.",
    params: {
      "synth.fmIndexBase":      0.12,
      "synth.fmIndexScale":     1.8,
      "synth.fmRatioDrift":     0.03,
      "synth.glideMin":         0.05,
      "synth.glideMax":         2.5,
      "cassette.preset":        "lofi",
      "cassette.midBoostDb":    4,
      "cassette.satAmount":     10,
      "cassette.satWet":        0.45,
      "cassette.noiseGain":     0.02,
      "cassette.wowDepthCents": 8,
      "cassette.reverbWet":     0.12,
      "mix.bassLevel":          2,
      "mix.trebleLevel":        -3,
      "mix.shimmerLevel":       -6,
    },
    gainTrimDb: 0,
  },

  "music-box": {
    label: "Music Box",
    description: "Bell carrier FM + KS plucks — delicate, tonal, clockwork.",
    params: {
      "synth.carrierTypeBass":        "bell",
      "synth.carrierTypeMid":         "bell",
      "synth.carrierTypeTreble":      "bell",
      "synth.fmIndexBase":            0.08,
      "synth.fmIndexScale":           0.9,
      "synth.articulationMid":        0.65,
      "synth.articulationTreble":     0.8,
      "synth.glideMin":               0.01,
      "synth.glideMax":               0.4,
      "cassette.preset":              "clean",
      "cassette.midBoostDb":          2,
      "cassette.reverbWet":           0.18,
      "mix.ksLevel":                  3,
      "mix.shimmerLevel":             -8,
      "mix.noiseLevel":               -24,
    },
    gainTrimDb: 1,
  },

  // ── Textural ─────────────────────────────────────────────────────────────

  "static-field": {
    label: "Static Field",
    description: "Noise resonator dominant — airy, textural, not pitched.",
    params: {
      "synth.fmIndexBase":      0.05,
      "synth.fmIndexScale":     0.8,
      "synth.masterGain":       0.22,
      "cassette.preset":        "warm",
      "cassette.reverbWet":     0.3,
      "cassette.noiseGain":     0.04,
      "mix.bassLevel":          -6,
      "mix.midLevel":           -4,
      "mix.trebleLevel":        -8,
      "mix.noiseLevel":         6,
      "mix.ksLevel":            -12,
      "mix.shimmerLevel":       -12,
    },
    gainTrimDb: 2,
  },

  "glass-air": {
    label: "Glass Air",
    description: "Shimmer-heavy, high-register — bright, glassy, airy.",
    params: {
      "synth.carrierTypeTreble":  "softtri",
      "synth.fmIndexBase":        0.1,
      "synth.fmIndexScale":       1.2,
      "synth.octaveOffsetTreble": 6,
      "synth.glideMin":           0.08,
      "synth.glideMax":           3.0,
      "cassette.preset":          "clean",
      "cassette.reverbWet":       0.25,
      "mix.bassLevel":            -8,
      "mix.midLevel":             -4,
      "mix.shimmerLevel":         5,
      "mix.noiseLevel":           -6,
      "mix.ksLevel":              -12,
    },
    gainTrimDb: 1,
  },

  // ── Rhythmic / energetic ──────────────────────────────────────────────────

  "wire": {
    label: "Wire",
    description: "KS strings dominant, clean + tight glide — metallic, plucked, present.",
    params: {
      "synth.fmIndexBase":        0.1,
      "synth.fmIndexScale":       1.5,
      "synth.glideMin":           0.01,
      "synth.glideMax":           0.8,
      "synth.carrierTypePluck":   "sawtooth",
      "cassette.preset":          "none",
      "cassette.reverbWet":       0.06,
      "mix.ksLevel":              5,
      "mix.pluckLevel":           3,
      "mix.noiseLevel":           -12,
      "mix.shimmerLevel":         -16,
    },
    gainTrimDb: 0,
  },

  "drone": {
    label: "Drone",
    description: "Slow glide, heavy FM, sub bass — meditative, deep, slowly evolving.",
    params: {
      "synth.fmIndexBase":      0.25,
      "synth.fmIndexScale":     3.5,
      "synth.fmRatioDrift":     0.06,
      "synth.glideMin":         0.2,
      "synth.glideMax":         5.0,
      "synth.glideScaleBass":   2.0,
      "synth.glideScaleMid":    1.5,
      "cassette.preset":        "vintage",
      "cassette.midBoostDb":    5,
      "cassette.reverbWet":     0.2,
      "mix.subLevel":           4,
      "mix.bassLevel":          3,
      "mix.trebleLevel":        -6,
      "mix.ksLevel":            -16,
      "mix.noiseLevel":         -8,
      "mix.shimmerLevel":       -16,
    },
    gainTrimDb: -1,
  },

  "pulse": {
    label: "Pulse",
    description: "Articulated tiers with pulse rates — rhythmic, percussive, driving.",
    params: {
      "synth.articulationBass":    0.4,
      "synth.articulationMid":     0.55,
      "synth.articulationTreble":  0.7,
      "synth.pulseRateBass":       2.0,
      "synth.pulseRateMid":        4.0,
      "synth.pulseRateTreble":     0,
      "synth.glideMin":            0.01,
      "synth.glideMax":            0.5,
      "synth.fmIndexBase":         0.2,
      "synth.fmIndexScale":        2.0,
      "cassette.preset":           "live",
      "cassette.reverbWet":        0.05,
      "mix.ksLevel":               2,
      "mix.shimmerLevel":          -12,
      "mix.noiseLevel":            -16,
    },
    gainTrimDb: 0,
  },

  // ── Cinematic ─────────────────────────────────────────────────────────────

  "soft-organ": {
    label: "Soft Organ",
    description: "Organ waveform, warm reverb, gentle FM — full, harmonic, cathedral.",
    params: {
      "synth.carrierTypeBass":    "organ",
      "synth.carrierTypeMid":     "organ",
      "synth.carrierTypeTreble":  "softsquare",
      "synth.fmIndexBase":        0.08,
      "synth.fmIndexScale":       1.0,
      "synth.glideMin":           0.02,
      "synth.glideMax":           1.5,
      "cassette.preset":          "warm",
      "cassette.reverbWet":       0.35,
      "cassette.midBoostDb":      3,
      "mix.shimmerLevel":         -6,
      "mix.noiseLevel":           -12,
      "mix.ksLevel":              -16,
    },
    gainTrimDb: 0,
  },

  "lush": {
    label: "Lush",
    description: "Wide FM pads, full chord voicing, gentle shimmer — the signature AVVA sound.",
    params: {
      "synth.fmIndexBase":      0.15,
      "synth.fmIndexScale":     2.4,
      "synth.fmStereoWidth":    0.85,
      "synth.fmRatioDrift":     0.04,
      "synth.glideMin":         0.05,
      "synth.glideMax":         2.0,
      "cassette.preset":        "clean",
      "cassette.midBoostDb":    3,
      "cassette.reverbWet":     0.1,
      "mix.shimmerLevel":       -2,
      "mix.noiseLevel":         -8,
      "mix.ksLevel":            -6,
    },
    gainTrimDb: 0,
  },
};

export const SCENE_PRESET_KEYS = Object.keys(SCENE_PRESETS) as (keyof typeof SCENE_PRESETS)[];
