/**
 * src/main.ts — avva v2 entry point.
 *
 * Phase 1: same behavior as the legacy `main.js`, but driven by the new
 * observable store. Legacy modules read from the store via the
 * `legacy-config` adapter; calibration writes through the store so the
 * controller window (phase 3) will Just Work.
 */

import { seedFromQuery } from "./store/url-seed.js";
import { store } from "./store/store.js";
import { startBroadcastSync } from "./store/sync.js";
import { legacyConfig as CONFIG } from "./store/legacy-config.js";

import { VideoSource } from "./input/video-source.js";
import { Analyzer } from "./analysis/analyzer.js";
import { Renderer } from "./render/renderer.js";
import { Controls } from "./controls/controls.js";
import { Calibration, CalibrationPanel } from "./controls/calibration.js";
import { Key } from "./harmony/music.js";
import { Synth } from "./audio/synth.js";

// Seed legacy ?query=params into the store, then start cross-window sync.
seedFromQuery();
startBroadcastSync();

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
let calibration: any, calPanel: any, synth: any;

async function begin(): Promise<void> {
  const videoEl = document.getElementById("vid") as HTMLVideoElement;
  const errEl = document.getElementById("err");

  videoEl.classList.toggle("mirror", state.mirror);
  document.getElementById("heat")?.classList.toggle("mirror", state.mirror);

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;

  // Keep video filter in sync with store-driven calibration changes
  // (from keyboard panel, controller window, or hash-loaded URL).
  calibration.onChange((cal: any) => {
    videoEl.style.filter = cal.filterString;
  });

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

  // Re-key the synth when harmony settings change from any source.
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

  calPanel = new CalibrationPanel(calibration, {
    onChange(cal: any) {
      videoEl.style.filter = cal.filterString;
    },
  });

  try {
    await videoSource.start();
  } catch (e: any) {
    if (errEl) {
      const isCam = CONFIG.source === "camera";
      errEl.textContent =
        (isCam ? "Camera unavailable: " : "Video file error: ") +
        (e.message || e.name) +
        (isCam
          ? " — check browser permissions, or serve over https/localhost."
          : "");
    }
    return;
  }

  renderer.setSourceLabel(videoSource.label);
  renderer.setResLabel(CONFIG.sampleW, CONFIG.sampleH);
  renderer.buildHistBars();
  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  controls = new Controls({
    calibrationPanel: calPanel,
    onHudToggle() {
      state.hudOn = !state.hudOn;
      store.set("view.hud", state.hudOn);
      document.body.style.setProperty("--hud-opacity", state.hudOn ? "1" : "0");
      if (!state.hudOn) calPanel.hide();
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

  // React to external mirror toggles (controller window).
  store.subscribeKey("view.mirror", (v) => {
    state.mirror = v;
    videoEl.classList.toggle("mirror", v);
    document.getElementById("heat")?.classList.toggle("mirror", v);
  });

  document.getElementById("gate")?.classList.add("hide");

  // Debug handle (replaces window._avva)
  (window as any)._avva = { synth, analyzer, renderer, videoSource, store };

  state.lastT = performance.now();
  requestAnimationFrame(loop);
}

function loop(t: number): void {
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

  requestAnimationFrame(loop);
}

function initGate(): void {
  if (CONFIG.source !== "camera") {
    const sources = Array.isArray(CONFIG.source)
      ? CONFIG.source
      : [CONFIG.source];
    const subLabel =
      sources.length > 1
        ? `${sources.length} sources · C to cycle`
        : ((sources[0] as string).split("/").pop() ?? "");

    const titleEl = document.querySelector(".gate__title");
    const subEl = document.querySelector(".gate__sub");
    const btnEl = document.querySelector(".gate__btn");
    if (titleEl) titleEl.textContent = "AVVA · FILE MODE";
    if (subEl) subEl.textContent = subLabel;
    if (btnEl) btnEl.textContent = "Begin";
    void begin();
  } else {
    document
      .getElementById("go")
      ?.addEventListener("click", () => void begin());
  }
}

initGate();
