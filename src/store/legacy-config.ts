/**
 * Adapter that exposes the new store as the old `CONFIG` shape.
 * Used so ported modules can keep `config.smoothing` access while we
 * gradually migrate them to store subscriptions.
 *
 * Each property is a live getter on the store — reads are always current.
 */

import { store } from "./store.js";

export interface LegacyConfig {
  // source (legacy: a string or array; new store splits into kind/file/files/url)
  source: string | string[];
  preferCamera: "environment" | "user";

  sampleW: number;
  sampleH: number;
  smoothing: number;
  hueSmoothing: number;
  satFloor: number;
  valFloor: number;
  activityGain: number;
  activityNoise: number;
  hueBins: number;
  sparkLen: number;

  mirror: boolean;

  root: string;
  mode: string;
  octave: number;
  rootHue: number;
  glideMin: number;
  glideMax: number;
  masterGain: number;

  fmIndexBase: number;
  fmIndexScale: number;
  fmRatioDrift: number;
  fmStereoWidth: number;
  fmPluckRatio: number;

  carrierTypeBass: OscillatorType;
  carrierTypeMid: OscillatorType;
  carrierTypeTreble: OscillatorType;
  carrierTypePluck: OscillatorType;
  glideSpread: number;
  octaveOffsetBass: number;
  octaveOffsetMid: number;
  octaveOffsetTreble: number;

  feedback: number;
  blobWarp: number;

  palette: string | null;
  crossZone: number;
}

export const legacyConfig: LegacyConfig = {
  get source() {
    const kind = store.get("source.kind");
    if (kind === "camera") return "camera";
    if (kind === "url") return store.get("source.url");
    return store.get("source.file") || "camera";
  },
  get preferCamera() {
    return store.get("source.preferCamera");
  },

  get sampleW() {
    return store.get("analysis.sampleW");
  },
  get sampleH() {
    return store.get("analysis.sampleH");
  },
  get smoothing() {
    return store.get("analysis.smoothing");
  },
  get hueSmoothing() {
    return store.get("analysis.hueSmoothing");
  },
  get satFloor() {
    return store.get("analysis.satFloor");
  },
  get valFloor() {
    return store.get("analysis.valFloor");
  },
  get activityGain() {
    return store.get("analysis.activityGain");
  },
  get activityNoise() {
    return store.get("analysis.activityNoise");
  },
  get hueBins() {
    return store.get("analysis.hueBins");
  },
  get sparkLen() {
    return store.get("analysis.sparkLen");
  },

  get mirror() {
    return store.get("view.mirror");
  },

  get root() {
    return store.get("harmony.root");
  },
  get mode() {
    return store.get("harmony.scale");
  },
  get octave() {
    return store.get("harmony.octave");
  },
  get rootHue() {
    return store.get("harmony.rootHue");
  },
  get glideMin() {
    return store.get("synth.glideMin");
  },
  get glideMax() {
    return store.get("synth.glideMax");
  },
  get masterGain() {
    return store.get("synth.masterGain");
  },

  get fmIndexBase() {
    return store.get("synth.fmIndexBase");
  },
  get fmIndexScale() {
    return store.get("synth.fmIndexScale");
  },
  get fmRatioDrift() {
    return store.get("synth.fmRatioDrift");
  },
  get fmStereoWidth() {
    return store.get("synth.fmStereoWidth");
  },
  get fmPluckRatio() {
    return store.get("synth.fmPluckRatio");
  },

  get carrierTypeBass() {
    return store.get("synth.carrierTypeBass") as OscillatorType;
  },
  get carrierTypeMid() {
    return store.get("synth.carrierTypeMid") as OscillatorType;
  },
  get carrierTypeTreble() {
    return store.get("synth.carrierTypeTreble") as OscillatorType;
  },
  get carrierTypePluck() {
    return store.get("synth.carrierTypePluck") as OscillatorType;
  },
  get glideSpread() {
    return store.get("synth.glideSpread");
  },
  get octaveOffsetBass() {
    return store.get("synth.octaveOffsetBass");
  },
  get octaveOffsetMid() {
    return store.get("synth.octaveOffsetMid");
  },
  get octaveOffsetTreble() {
    return store.get("synth.octaveOffsetTreble");
  },

  get feedback() {
    return store.get("audio.feedback");
  },
  get blobWarp() {
    return store.get("audio.blobWarp");
  },

  get palette() {
    const mode = store.get("harmony.mode");
    return mode === "palette" ? store.get("harmony.palette") : null;
  },
  get crossZone() {
    return store.get("harmony.crossZone");
  },
};
