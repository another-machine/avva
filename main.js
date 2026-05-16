/**
 * main.js — AVVA · Analysis Layer
 *
 * Entry point. Wires all modules together and runs the RAF loop.
 *
 * URL params (see modules/config.js and modules/calibration.js):
 *   ?source=camera              live camera (default)
 *   ?source=./assets/clip.mp4  looping video file — auto-starts, no permission
 *   ?brightness=1.2             video calibration params
 *   ?contrast=1.1&saturation=0.9&hueRotate=15
 *   ?mirror=false               disable mirror
 *   ?smoothing=0.25             analysis tuning overrides
 */

import { CONFIG } from "./modules/config.js";
import { VideoSource } from "./modules/video-source.js";
import { Analyzer } from "./modules/analyzer.js";
import { Renderer } from "./modules/renderer.js";
import { Controls } from "./modules/controls.js";
import { Calibration, CalibrationPanel } from "./modules/calibration.js";
import { Key } from "./modules/music.js";
import { Synth } from "./modules/synth.js";

// ── Application state ─────────────────────────────────────────

const state = {
  heatOn: false,
  hudOn: true,
  mirror: CONFIG.mirror,
  fps: 0,
  frames: 0,
  fpsT: 0,
  lastT: 0,
};

let videoSource, analyzer, renderer, controls, calibration, calPanel, synth;

// ── Entry ─────────────────────────────────────────────────────

async function begin() {
  const videoEl = document.getElementById("vid");
  const errEl = document.getElementById("err");

  // Apply initial mirror state to both video and heat canvas
  videoEl.classList.toggle("mirror", state.mirror);
  document.getElementById("heat").classList.toggle("mirror", state.mirror);

  // Calibration is independent of config — reads its own URL params
  calibration = new Calibration();

  // Apply initial calibration filter to video display
  videoEl.style.filter = calibration.filterString;

  // Instantiate core modules
  videoSource = new VideoSource(videoEl, CONFIG);
  analyzer = new Analyzer(CONFIG, calibration);
  renderer = new Renderer(CONFIG);

  // Synth — started on S key (requires user gesture for AudioContext)
  synth = new Synth(CONFIG);
  synth.key = new Key({
    root: CONFIG.root,
    mode: CONFIG.mode,
    octave: CONFIG.octave,
  });

  // Calibration panel — onChange keeps video display in sync with analysis
  calPanel = new CalibrationPanel(calibration, {
    onChange(cal) {
      videoEl.style.filter = cal.filterString;
    },
  });

  // Start video source
  try {
    await videoSource.start();
  } catch (e) {
    errEl.textContent =
      (CONFIG.source === "camera"
        ? "Camera unavailable: "
        : "Video file error: ") +
      (e.message || e.name) +
      (CONFIG.source === "camera"
        ? " — check browser permissions, or serve over https/localhost."
        : "");
    return;
  }

  // Populate meta bar
  renderer.setSourceLabel(videoSource.label);
  renderer.setResLabel(CONFIG.sampleW, CONFIG.sampleH);

  // Build display elements
  renderer.buildHistBars();
  renderer.resize();
  window.addEventListener("resize", () => renderer.resize());

  // Keyboard controls
  controls = new Controls({
    calibrationPanel: calPanel,

    onHudToggle() {
      state.hudOn = !state.hudOn;
      // JS only sets the value — CSS owns all timing via
      // transition: --hud-opacity on body (see va.css / --dur-hud-hide)
      document.body.style.setProperty("--hud-opacity", state.hudOn ? "1" : "0");
      if (!state.hudOn) calPanel.hide();
    },

    onHeatToggle() {
      state.heatOn = !state.heatOn;
      analyzer.heatOn = state.heatOn;
      renderer.setHeatVisible(state.heatOn);
    },

    onMirrorToggle() {
      state.mirror = !state.mirror;
      videoEl.classList.toggle("mirror", state.mirror);
      // Heat canvas must mirror too — it overlays the video in screen space
      document.getElementById("heat").classList.toggle("mirror", state.mirror);
    },

    async onCycleSource() {
      try {
        await videoSource.cycleSource();
        renderer.setSourceLabel(videoSource.label);
      } catch (_) {
        // Silently ignore source switch failures
      }
    },

    onSynthToggle() {
      synth.toggle();
    },
  });
  controls.bind();

  // Dismiss gate
  document.getElementById("gate").classList.add("hide");

  // Start loop
  state.lastT = performance.now();
  requestAnimationFrame(loop);
}

// ── RAF loop ──────────────────────────────────────────────────

function loop(t) {
  const dt = t - state.lastT;
  state.lastT = t;

  // Rolling FPS counter (500ms window)
  state.frames++;
  state.fpsT += dt;
  if (state.fpsT >= 500) {
    state.fps = state.frames / (state.fpsT / 1000);
    state.frames = 0;
    state.fpsT = 0;
  }

  const videoEl = document.getElementById("vid");
  if (videoEl.readyState >= 2) {
    const frame = analyzer.analyze(videoEl);
    const synthSnap = {
      running: synth.running,
      keyLabel: synth.key ? synth.key.label.toUpperCase() : "—",
      note: synth.key ? synth.key.hueToNote(frame.out.hue) : null,
    };
    renderer.paint(frame, state.fps, synthSnap);
    synth.update(frame.out);
  }

  requestAnimationFrame(loop);
}

// ── Gate setup ────────────────────────────────────────────────

function initGate() {
  if (CONFIG.source !== "camera") {
    // File / file-array mode — no camera permission needed, auto-start
    const sources = Array.isArray(CONFIG.source)
      ? CONFIG.source
      : [CONFIG.source];
    const subLabel =
      sources.length > 1
        ? `${sources.length} sources · C to cycle`
        : sources[0].split("/").pop();

    document.querySelector(".gate__title").textContent = "VA · FILE MODE";
    document.querySelector(".gate__sub").textContent = subLabel;
    document.querySelector(".gate__btn").textContent = "Begin";
    begin();
  } else {
    document.getElementById("go").addEventListener("click", begin);
  }
}

initGate();
