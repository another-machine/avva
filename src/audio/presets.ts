/**
 * src/audio/presets.ts
 *
 * Named aesthetic bundles for the synth + cassette engine.
 * Each preset is a partial Settings object that gets applied via store.set().
 * 'custom' is not in this table — it means "user has diverged from a preset".
 */

import type { Settings } from "../store/schema.js";

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
