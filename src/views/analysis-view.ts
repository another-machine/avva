/**
 * src/views/analysis-view.ts
 *
 * CAM→AUDIO analysis view. Mounts onto the DOM that index.html provides
 * (the default body content). Equivalent to Phase 1's main.ts minus the
 * store-bootstrap calls (those live in main.ts).
 */

import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";

import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Renderer } from "../render/renderer.js";
import { Controls } from "../controls/controls.js";
import { Calibration } from "../controls/calibration.js";
import { Key } from "../harmony/music.js";
import { Synth } from "../audio/synth.js";

interface RuntimeState {
  heatOn: boolean;
  hudOn: boolean;
  mirror: boolean;
  fps: number;
  frames: number;
  fpsT: number;
  lastT: number;
}

const state: RuntimeState = {
  heatOn: store.get("view.heatOn"),
  hudOn: store.get("view.hud"),
  mirror: store.get("view.mirror"),
  fps: 0,
  frames: 0,
  fpsT: 0,
  lastT: 0,
};

let videoSource: any, analyzer: any, renderer: any, controls: any;
let calibration: any, synth: any;

async function begin(): Promise<void> {
  const videoEl = document.getElementById("vid") as HTMLVideoElement;
  const errEl = document.getElementById("err");

  videoEl.classList.toggle("mirror", state.mirror);
  document.getElementById("heat")?.classList.toggle("mirror", state.mirror);

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;
  calibration.onChange((cal: any) => { videoEl.style.filter = cal.filterString; });

  videoSource = new VideoSource(videoEl, CONFIG);
  analyzer = new Analyzer(CONFIG, calibration);
  renderer = new Renderer(CONFIG);

  synth = new Synth(CONFIG);
  synth.key = new Key({
    root: CONFIG.root,
    mode: CONFIG.mode,
    octave: CONFIG.octave,
    rootHue: CONFIG.rootHue,
  });

  for (const k of [
    "harmony.root",
    "harmony.scale",
    "harmony.octave",
    "harmony.rootHue",
  ] as const) {
    store.subscribeKey(k, () => {
      synth.key = new Key({
        root: CONFIG.root,
        mode: CONFIG.mode,
        octave: CONFIG.octave,
        rootHue: CONFIG.rootHue,
      });
    });
  }

  try {
    await videoSource.start();
  } catch (e: any) {
    const gate = document.getElementById("gate");
    gate?.classList.remove("hide");
    if (errEl) {
      const isCam = CONFIG.source === "camera";
      errEl.textContent =
        (isCam ? "Camera unavailable: " : "Video error: ") +
        (e.message || e.name);
    }
    document.getElementById("go")?.addEventListener("click", () => {
      gate?.classList.add("hide");
      void begin();
    }, { once: true });
    return;
  }

  renderer.setSourceLabel(videoSource.label);
  renderer.setResLabel(CONFIG.sampleW, CONFIG.sampleH);
  renderer.buildHistBars();
  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  controls = new Controls({
    onHudToggle() {
      state.hudOn = !state.hudOn;
      store.set("view.hud", state.hudOn);
      document.body.style.setProperty("--hud-opacity", state.hudOn ? "1" : "0");
    },
    onHeatToggle() {
      state.heatOn = !state.heatOn;
      store.set("view.heatOn", state.heatOn);
      analyzer.heatOn = state.heatOn;
      renderer.setHeatVisible(state.heatOn);
    },
    onMirrorToggle() {
      state.mirror = !state.mirror;
      store.set("view.mirror", state.mirror);
      videoEl.classList.toggle("mirror", state.mirror);
      document.getElementById("heat")?.classList.toggle("mirror", state.mirror);
    },
    async onCycleSource() {
      try {
        await videoSource.cycleSource();
        renderer.setSourceLabel(videoSource.label);
      } catch {
        /* swallow */
      }
    },
    onSynthToggle() {
      synth.toggle();
      store.set("synth.enabled", !!synth.running);
    },
  });
  controls.bind();

  store.subscribeKey("view.mirror", (v) => {
    state.mirror = v;
    videoEl.classList.toggle("mirror", v);
    document.getElementById("heat")?.classList.toggle("mirror", v);
  });

  store.subscribeKey("view.hud", (v) => {
    state.hudOn = v;
    document.body.style.setProperty("--hud-opacity", v ? "1" : "0");
  });

  store.subscribeKey("view.heatOn", (v) => {
    state.heatOn = v;
    analyzer.heatOn = v;
    renderer.setHeatVisible?.(v);
  });

  store.subscribeKey("synth.enabled", (v) => {
    if (v && !synth.running) synth.start();
    else if (!v && synth.running) synth.stop();
  });

  store.subscribeKey("synth.masterGain", (v) => {
    if (synth._master) synth._master.gain.value = v;
  });

  const _applyCassette = () =>
    synth.setCassetteParams({
      midBoostDb: store.get("cassette.midBoostDb"),
      masterLPHz: store.get("cassette.masterLPHz"),
      satAmount: store.get("cassette.satAmount"),
      satWet: store.get("cassette.satWet"),
      tapeDelayMs: store.get("cassette.tapeDelayMs"),
      tapeDelayFb: store.get("cassette.tapeDelayFb"),
      tapeDelayWet: store.get("cassette.tapeDelayWet"),
      reverbWet: store.get("cassette.reverbWet"),
      noiseGain: store.get("cassette.noiseGain"),
      wowDepthCents: store.get("cassette.wowDepthCents"),
      flutterDepthCents: store.get("cassette.flutterDepthCents"),
    });

  for (const k of [
    "cassette.midBoostDb",
    "cassette.masterLPHz",
    "cassette.satAmount",
    "cassette.satWet",
    "cassette.tapeDelayMs",
    "cassette.tapeDelayFb",
    "cassette.tapeDelayWet",
    "cassette.reverbWet",
    "cassette.noiseGain",
    "cassette.wowDepthCents",
    "cassette.flutterDepthCents",
  ] as const) {
    store.subscribeKey(k, _applyCassette);
  }

  store.subscribeKey("source.playbackRate", (v) => {
    videoEl.playbackRate = v;
  });

  document.getElementById("gate")?.classList.add("hide");

  document.getElementById("gate")?.classList.add("hide");

  (window as any)._avva = { synth, analyzer, renderer, videoSource, store };

  state.lastT = performance.now();
  requestAnimationFrame(tick);
}

function tick(t: number): void {
  const dt = t - state.lastT;
  state.lastT = t;

  state.frames++;
  state.fpsT += dt;
  if (state.fpsT >= 500) {
    state.fps = state.frames / (state.fpsT / 1000);
    state.frames = 0;
    state.fpsT = 0;
  }

  const videoEl = document.getElementById("vid") as HTMLVideoElement | null;
  if (videoEl && videoEl.readyState >= 2) {
    const frame = analyzer.analyze(videoEl);
    const synthSnap = {
      running: synth.running,
      keyLabel: synth.key ? synth.key.label.toUpperCase() : "—",
      note: synth.key ? synth.key.hueToNote(frame.out.hue) : null,
    };
    renderer.paint(frame, state.fps, synthSnap);
    synth.update({ ...frame.out, histBins: frame.histBins });
  }

  requestAnimationFrame(tick);
}

export function mountAnalysisView(): void {
  void begin();
}
