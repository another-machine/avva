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

  smoothing: number;
  hueSmoothing: number;
  satFloor: number;
  valFloor: number;
  activityGain: number;
  activityNoise: number;
  sparkLen: number;

  mirror: boolean;

  root: string;
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

  carrierTypeBass: string;
  carrierTypeMid: string;
  carrierTypeTreble: string;
  carrierTypePluck: string;
  glideSpread: number;
  octaveOffsetBass: number;
  octaveOffsetMid: number;
  octaveOffsetTreble: number;
  octaveOffsetPluck: number;

  articulationBass: number;
  articulationMid: number;
  articulationTreble: number;
  pulseRateBass: number;
  pulseRateMid: number;
  pulseRateTreble: number;
  glideScaleBass: number;
  glideScaleMid: number;
  glideScaleTreble: number;
  pluckFluxSensitivity: number;
  engine?: string;

  feedback: number;
  blobWarp: number;

  palette: string | null;
  crossZone: number;

  viewboxOn: boolean;
  maskOn: boolean;
  viewboxX: number;
  viewboxY: number;
  viewboxW: number;
  viewboxH: number;
}

export const legacyConfig: LegacyConfig = {
  get source() {
    const kind = store.get("source.kind");
    if (kind === "camera") return "camera";
    if (kind === "screen") return "screen";
    if (kind === "url") return store.get("source.url");
    return store.get("source.file") || "camera";
  },
  get preferCamera() {
    return store.get("source.preferCamera");
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
  get sparkLen() {
    return store.get("global.sparkLen");
  },

  get mirror() {
    return store.get("view.mirror");
  },

  get root() {
    return store.get("harmony.root");
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
    return store.get("synth.carrierTypeBass") as string;
  },
  get carrierTypeMid() {
    return store.get("synth.carrierTypeMid") as string;
  },
  get carrierTypeTreble() {
    return store.get("synth.carrierTypeTreble") as string;
  },
  get carrierTypePluck() {
    return store.get("synth.carrierTypePluck") as string;
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
  get octaveOffsetPluck() {
    return store.get("synth.octaveOffsetPluck");
  },

  get articulationBass() {
    return store.get("synth.articulationBass");
  },
  get articulationMid() {
    return store.get("synth.articulationMid");
  },
  get articulationTreble() {
    return store.get("synth.articulationTreble");
  },
  get pulseRateBass() {
    return store.get("synth.pulseRateBass");
  },
  get pulseRateMid() {
    return store.get("synth.pulseRateMid");
  },
  get pulseRateTreble() {
    return store.get("synth.pulseRateTreble");
  },
  get glideScaleBass() {
    return store.get("synth.glideScaleBass");
  },
  get glideScaleMid() {
    return store.get("synth.glideScaleMid");
  },
  get glideScaleTreble() {
    return store.get("synth.glideScaleTreble");
  },
  get pluckFluxSensitivity() {
    return store.get("synth.pluckFluxSensitivity");
  },
  get engine() {
    return store.get("synth.engine") as string;
  },

  get feedback() {
    return store.get("audio.feedback");
  },
  get blobWarp() {
    return store.get("audio.blobWarp");
  },

  get palette() {
    return store.get("harmony.palette") || null;
  },
  get crossZone() {
    return store.get("harmony.crossZone");
  },

  get viewboxOn() { return store.get("view.viewboxOn"); },
  get maskOn()    { return store.get("view.maskOn"); },
  get viewboxX()  { return store.get("view.viewboxX"); },
  get viewboxY()  { return store.get("view.viewboxY"); },
  get viewboxW()  { return store.get("view.viewboxW"); },
  get viewboxH()  { return store.get("view.viewboxH"); },
};
