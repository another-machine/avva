/**
 * loop.js — closed-loop dev harness for AVVA Program 1 + Program 2.
 *
 * Both pipelines run in one page sharing a single AudioContext.
 *
 *   Program 1 (left half):
 *     VideoSource → Analyzer → Synth
 *
 *   Program 2 (right half):
 *     synth._master  →  AudioAnalyzer  →  AudioRenderer
 *
 * No mic, no speakers, no OS routing for the loop test. Audio still
 * plays out the speakers (synth → destination is unchanged); Program 2
 * reads the same signal via an in-context AudioNode tap, so the loop
 * is closed entirely inside the browser tab.
 *
 * Press S to start/stop the synth (also enables the AudioAnalyzer tap).
 * Press C to cycle video sources.
 */

import { CONFIG } from "./modules/config.js";
import { VideoSource } from "./modules/video-source.js";
import { Analyzer } from "./modules/analyzer.js";
import { Calibration } from "./modules/calibration.js";
import { Key } from "./modules/music.js";
import { Synth } from "./modules/synth.js";
import { AudioAnalyzer } from "./modules/audio-analyzer.js";
import { AudioRenderer } from "./modules/audio-renderer.js";

const state = {
  fps: 0,
  frames: 0,
  fpsT: 0,
  lastT: 0,
  tapped: false,
};

let videoEl, videoSource, vidAnalyzer, calibration, synth, key;
let audioAnalyzer, audioRenderer, audioCanvas;
let chromaBars = []; // 12 DOM elements for chromatic prevalence readout

async function begin() {
  videoEl = document.getElementById("vid");
  audioCanvas = document.getElementById("av-canvas");

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;

  key = new Key({
    root: CONFIG.root,
    mode: CONFIG.mode,
    octave: CONFIG.octave,
  });

  videoSource = new VideoSource(videoEl, CONFIG);
  vidAnalyzer = new Analyzer(CONFIG, calibration);
  synth = new Synth(CONFIG);
  synth.key = key;

  try {
    await videoSource.start();
  } catch (e) {
    document.getElementById("err").textContent =
      "Video error: " + (e.message || e.name);
    return;
  }

  audioRenderer = new AudioRenderer(audioCanvas, key.chromaticHues);
  window.addEventListener("resize", () => audioRenderer.resize());

  buildChromaReadout();
  document.getElementById("m-key").textContent = key.label.toUpperCase();
  document.getElementById("m-src").textContent = videoSource.label;

  document.getElementById("gate").classList.add("hide");

  state.lastT = performance.now();
  requestAnimationFrame(loop);
}

/** Wire synth's master gain into the AudioAnalyzer once synth is running. */
function maybeTapSynth() {
  if (state.tapped) return;
  if (!synth.running || !synth._actx || !synth._master) return;

  audioAnalyzer = new AudioAnalyzer({
    audioContext: synth._actx,
    key,
  });
  synth._master.connect(audioAnalyzer.analyser);
  state.tapped = true;
}

function loop(t) {
  const dt = t - state.lastT;
  state.lastT = t;
  state.frames++;
  state.fpsT += dt;
  if (state.fpsT >= 500) {
    state.fps = state.frames / (state.fpsT / 1000);
    state.frames = 0;
    state.fpsT = 0;
  }

  if (videoEl.readyState >= 2) {
    const v = vidAnalyzer.analyze(videoEl);
    synth.update(v.out);
    paintVideoReadout(v);

    maybeTapSynth();
    if (audioAnalyzer) {
      const a = audioAnalyzer.tick();
      audioRenderer.render(a);
      paintAudioReadout(a);
    }
  }

  document.getElementById("m-fps").textContent = state.fps.toFixed(0);

  requestAnimationFrame(loop);
}

function paintVideoReadout(frame) {
  const o = frame.out;
  document.getElementById("v-hue").textContent = o.hue.toFixed(0);
  document.getElementById("v-bri").textContent = o.bri.toFixed(2);
  document.getElementById("v-act").textContent = o.act.toFixed(2);
  document.getElementById("v-hi").textContent = o.hi.toFixed(2);
  document.getElementById("v-lo").textContent = o.lo.toFixed(2);
  // Mirror dominant hue on root so panel accents track Program 1's view
  document.documentElement.style.setProperty(
    "--accent-h",
    o.hue.toFixed(1),
  );
}

function paintAudioReadout(frame) {
  document.getElementById("a-hue").textContent = frame.hue.toFixed(0);
  document.getElementById("a-bri").textContent = frame.bri.toFixed(2);
  document.getElementById("a-act").textContent = frame.act.toFixed(2);
  document.getElementById("a-hi").textContent = frame.bands.hi.toFixed(2);
  document.getElementById("a-lo").textContent = frame.bands.lo.toFixed(2);
  document.getElementById("a-chord").textContent = frame.chord.label;

  // Update 12 chroma bars
  for (let i = 0; i < 12; i++) {
    const bar = chromaBars[i];
    if (!bar) continue;
    const p = frame.chroma[i] || 0;
    bar.style.height = `${(p * 100).toFixed(1)}%`;
  }
}

function buildChromaReadout() {
  const container = document.getElementById("chroma-bars");
  if (!container) return;
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const hues = key.chromaticHues;
  chromaBars = [];
  for (let i = 0; i < 12; i++) {
    const cell = document.createElement("div");
    cell.className = "chroma__cell";
    const bar = document.createElement("div");
    bar.className = "chroma__bar";
    bar.style.background = `oklch(0.65 0.22 ${hues[i]})`;
    cell.appendChild(bar);
    const lbl = document.createElement("div");
    lbl.className = "chroma__lbl";
    lbl.textContent = names[i];
    cell.appendChild(lbl);
    container.appendChild(cell);
    chromaBars.push(bar);
  }
}

// ── Keyboard ──────────────────────────────────────────────────
window.addEventListener("keydown", async (e) => {
  if (e.key === "s" || e.key === "S") {
    synth.toggle();
  } else if (e.key === "c" || e.key === "C") {
    try {
      await videoSource.cycleSource();
      document.getElementById("m-src").textContent = videoSource.label;
    } catch (_) {}
  }
});

// ── Gate ──────────────────────────────────────────────────────
if (CONFIG.source !== "camera") {
  begin();
} else {
  document.getElementById("go").addEventListener("click", begin);
}
