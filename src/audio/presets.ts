/**
 * src/audio/presets.ts
 *
 * Named aesthetic bundles for the synth + cassette engine.
 * Each preset is a partial Settings object that gets applied via store.set().
 * 'custom' is not in this table — it means "user has diverged from a preset".
 */

import type { Settings } from "../store/schema.js";

export const CASSETTE_PRESETS: Record<string, Partial<Settings>> = {
  clean: {
    "cassette.midBoostDb": 0,
    "cassette.masterLPHz": 18000,
    "cassette.satAmount": 2,
    "cassette.satWet": 0.1,
    "cassette.tapeDelayMs": 60,
    "cassette.tapeDelayFb": 0.05,
    "cassette.tapeDelayWet": 0.0,
    "cassette.reverbWet": 0.0,
    "cassette.noiseGain": 0.002,
    "cassette.wowDepthCents": 0,
    "cassette.flutterDepthCents": 0,
  },
  warm: {
    "cassette.midBoostDb": 3,
    "cassette.masterLPHz": 11000,
    "cassette.satAmount": 7,
    "cassette.satWet": 0.35,
    "cassette.tapeDelayMs": 130,
    "cassette.tapeDelayFb": 0.2,
    "cassette.tapeDelayWet": 0.12,
    "cassette.reverbWet": 0.08,
    "cassette.noiseGain": 0.01,
    "cassette.wowDepthCents": 5,
    "cassette.flutterDepthCents": 1.0,
  },
  lofi: {
    "cassette.midBoostDb": 4,
    "cassette.masterLPHz": 6000,
    "cassette.satAmount": 14,
    "cassette.satWet": 0.6,
    "cassette.tapeDelayMs": 80,
    "cassette.tapeDelayFb": 0.35,
    "cassette.tapeDelayWet": 0.22,
    "cassette.reverbWet": 0.06,
    "cassette.noiseGain": 0.055,
    "cassette.wowDepthCents": 12,
    "cassette.flutterDepthCents": 4.0,
  },
  vintage: {
    "cassette.midBoostDb": 6,
    "cassette.masterLPHz": 8000,
    "cassette.satAmount": 12,
    "cassette.satWet": 0.55,
    "cassette.tapeDelayMs": 180,
    "cassette.tapeDelayFb": 0.28,
    "cassette.tapeDelayWet": 0.25,
    "cassette.reverbWet": 0.22,
    "cassette.noiseGain": 0.03,
    "cassette.wowDepthCents": 14,
    "cassette.flutterDepthCents": 2.5,
  },
  live: {
    "cassette.midBoostDb": 5,
    "cassette.masterLPHz": 15000,
    "cassette.satAmount": 5,
    "cassette.satWet": 0.25,
    "cassette.tapeDelayMs": 60,
    "cassette.tapeDelayFb": 0.1,
    "cassette.tapeDelayWet": 0.0,
    "cassette.reverbWet": 0.0,
    "cassette.noiseGain": 0.005,
    "cassette.wowDepthCents": 2,
    "cassette.flutterDepthCents": 0.5,
  },
};

export const PRESETS: Record<string, Partial<Settings>> = {
  lush: {
    "synth.articulation": 0.0,
    "synth.pulseRate": 0,
    "synth.fmIndexBase": 0.15,
    "synth.fmIndexScale": 2.4,
    "synth.glideMax": 2.0,
    "cassette.reverbWet": 0.18,
    "cassette.tapeDelayWet": 0.18,
    "cassette.satAmount": 8,
  },
  drone: {
    "synth.articulation": 0.0,
    "synth.pulseRate": 0,
    "synth.fmIndexBase": 0.05,
    "synth.fmIndexScale": 1.2,
    "synth.glideMax": 3.5,
    "cassette.reverbWet": 0.3,
    "cassette.tapeDelayWet": 0.22,
    "cassette.satAmount": 5,
  },
  staccato: {
    "synth.articulation": 0.65,
    "synth.pulseRate": 2,
    "synth.fmIndexScale": 1.8,
    "synth.glideMax": 0.5,
    "cassette.reverbWet": 0.04,
    "cassette.tapeDelayWet": 0.05,
    "cassette.satAmount": 10,
  },
  percussive: {
    "synth.articulation": 0.95,
    "synth.pulseRate": 4,
    "synth.fmPluckRatio": 3,
    "synth.glideMax": 0.2,
    "cassette.reverbWet": 0.02,
    "cassette.tapeDelayWet": 0.03,
    "cassette.satAmount": 12,
  },
  bell: {
    "synth.articulation": 0.85,
    "synth.pulseRate": 0,
    "synth.fmPluckRatio": 7,
    "synth.carrierTypePluck": "sine",
    "synth.glideMax": 0.3,
    "cassette.reverbWet": 0.25,
    "cassette.tapeDelayWet": 0.1,
    "cassette.satAmount": 6,
  },
};
