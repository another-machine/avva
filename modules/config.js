/**
 * modules/config.js
 *
 * Single source of truth for all tunable parameters.
 * Defaults are overridden by matching URL search params.
 *
 * URL param examples:
 *   ?source=./clip.mp4          use a looping video file instead of camera
 *   ?root=D&scale=phrygian      (reserved for future audio params)
 *   ?smoothing=0.25             override any numeric default
 *   ?mirror=false               override any boolean default
 */

const DEFAULTS = {
  // --- video source ---
  // "camera" → getUserMedia; any other string → treated as a video file path
  source: "camera",
  // source: ["assets/lavalamp.mp4", "assets/mario.mp4", "assets/tmnt.mp4"],

  // --- analysis resolution ---
  // Low values = faster, more stable; high values = more spatial detail
  sampleW: 96,
  sampleH: 72,

  // --- smoothing (exponential moving average) ---
  // 0 = frozen, 1 = raw (no smoothing). Hue uses shortest-arc interpolation.
  smoothing: 0.18,
  hueSmoothing: 0.2,

  // --- pixel filtering ---
  satFloor: 0.1, // ignore near-gray pixels below this saturation (0–1)
  valFloor: 0.06, // ignore near-black pixels below this value (0–1)

  // --- activity detection ---
  activityGain: 7.0, // scales raw frame-difference into 0–1 range
  activityNoise: 0.012, // per-pixel diff below this treated as sensor noise

  // --- display ---
  hueBins: 30, // histogram bucket count
  sparkLen: 160, // samples retained for sparkline history

  // --- camera ---
  mirror: false,
  preferCamera: "environment", // "environment" | "user"

  // --- synth ---
  root: "A",
  mode: "locrian",
  octave: 4,
  glideMin: 0.01, // seconds at act=1 (staccato)
  glideMax: 2.0, // seconds at act=0 (legato)
  masterGain: 0.35,

  // --- FM synthesis ---
  // sat → pad modulation index (timbre brightness)
  fmIndexBase: 0.15, // index when sat=0 (near-pure sine)
  fmIndexScale: 2.4, // index swing range driven by sat
  // spread → modulator ratio drift (chorusy detune at rainbow frames)
  fmRatioDrift: 0.04, // max ±drift off integer ratio at spread=1
  // spread → stereo width
  fmStereoWidth: 0.75, // max width multiplier at spread=1 (0.25 minimum)
  // pluck FM ratio (DX-style metallic ping at 7; clarinet-ish at 3; mallet/pluck at 2)
  fmPluckRatio: 2,
};

/** Parse URL search params and return overrides matching known keys. */
function parseUrlParams() {
  const p = new URLSearchParams(location.search);
  const out = {};

  // String params
  for (const k of ["source", "preferCamera", "root", "mode"]) {
    if (p.has(k)) out[k] = p.get(k);
  }

  // Numeric params
  for (const k of [
    "sampleW",
    "sampleH",
    "smoothing",
    "hueSmoothing",
    "satFloor",
    "valFloor",
    "activityGain",
    "activityNoise",
    "hueBins",
    "sparkLen",
    "octave",
    "glideMin",
    "glideMax",
    "masterGain",
    "fmIndexBase",
    "fmIndexScale",
    "fmRatioDrift",
    "fmStereoWidth",
    "fmPluckRatio",
  ]) {
    if (p.has(k)) {
      const v = Number(p.get(k));
      if (!isNaN(v)) out[k] = v;
    }
  }

  // Boolean params
  if (p.has("mirror")) out.mirror = p.get("mirror") !== "false";

  return out;
}

export const CONFIG = Object.freeze({ ...DEFAULTS, ...parseUrlParams() });
