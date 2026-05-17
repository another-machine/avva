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
import { Calibration, CalibrationPanel } from "./modules/calibration.js";
import { Key } from "./modules/music.js";
import { Synth } from "./modules/synth.js";
import { AudioAnalyzer } from "./modules/audio-analyzer.js";
import { AudioRendererGL } from "./modules/audio-renderer-gl.js";
import { fromPerceptual, toPerceptual } from "./modules/hue-perception.js";
import { Palette } from "./modules/palette.js";

const state = {
  fps: 0,
  frames: 0,
  fpsT: 0,
  lastT: 0,
  tapped: false,
};

let videoEl, videoSource, vidAnalyzer, calibration, calPanel, synth, key;
let audioAnalyzer, audioRenderer, audioCanvas;
let palette = null; // Palette instance when ?palette= is set
let chromaBars = []; // DOM elements for the chord-strip readout
let rhpPicker; // RootHuePicker instance (created in begin())

async function begin() {
  videoEl = document.getElementById("vid");
  audioCanvas = document.getElementById("av-canvas");

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;

  calPanel = new CalibrationPanel(calibration, {
    onChange: (cal) => {
      videoEl.style.filter = cal.filterString;
    },
  });

  key = new Key({
    root: CONFIG.root,
    mode: CONFIG.mode,
    octave: CONFIG.octave,
    rootHue: CONFIG.rootHue,
  });

  if (CONFIG.palette) {
    try {
      palette = Palette.fromURLParam(CONFIG.palette, {
        rootHue: CONFIG.rootHue ?? 0,
        crossZone: CONFIG.crossZone,
      });
    } catch (e) {
      console.error("Palette parse error:", e.message);
    }
  }

  videoSource = new VideoSource(videoEl, CONFIG);
  vidAnalyzer = new Analyzer(CONFIG, calibration);
  synth = new Synth(CONFIG);
  synth.key = key;
  synth.palette = palette;

  try {
    await videoSource.start();
  } catch (e) {
    document.getElementById("err").textContent =
      "Video error: " + (e.message || e.name);
    return;
  }

  audioRenderer = new AudioRendererGL(audioCanvas, key.degreeHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.noiseScale,
  });
  if (palette) audioRenderer.setN(palette.slots.length);
  window.addEventListener("resize", () => audioRenderer.resize());

  buildChromaReadout();
  rhpPicker = new RootHuePicker({ key, onRebuild: buildChromaReadout });

  // Subscribe to palette changes so the chord strip and renderer stay in sync.
  if (palette) {
    palette.onChange(() => {
      buildChromaReadout();
      if (audioRenderer) audioRenderer.setN(palette.slots.length);
      rhpPicker?._update();
    });
  }

  window._avva = {
    get key() {
      return key;
    },
    get audioAnalyzer() {
      return audioAnalyzer;
    },
    get audioRenderer() {
      return audioRenderer;
    },
    get palette() {
      return palette;
    },
  };
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
    palette,
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
    synth.update({ ...v.out, histBins: v.histBins });
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
  document.getElementById("v-sprd").textContent = o.spread.toFixed(2);

  // Chord strip — mirrors the exact gate thresholds used in synth.update()
  const note = key.hueToNote(o.hue);
  const thirdW = Math.max(0, Math.min(1, (o.spread - 0.15) / 0.25));
  const fifthW = Math.max(0, Math.min(1, (o.spread - 0.4) / 0.25));
  const weights = [1.0, thirdW, fifthW];

  document.getElementById("v-numeral").textContent = note.numeral;
  [0, 1, 2].forEach((vi) => {
    const el = document.getElementById(`v-note-${vi}`);
    if (!el) return;
    el.textContent = note.triad[vi].name;
    el.style.opacity = (0.15 + weights[vi] * 0.85).toFixed(2);
  });

  // Mirror dominant hue on root so panel accents track Program 1's view
  document.documentElement.style.setProperty("--accent-h", o.hue.toFixed(1));
}

function paintAudioReadout(frame) {
  document.getElementById("a-hue").textContent = frame.hue.toFixed(0);
  document.getElementById("a-bri").textContent = frame.bri.toFixed(2);
  document.getElementById("a-act").textContent = frame.act.toFixed(2);
  document.getElementById("a-hi").textContent = frame.bands.hi.toFixed(2);
  document.getElementById("a-lo").textContent = frame.bands.lo.toFixed(2);
  document.getElementById("a-chord").textContent = frame.chord.label;

  // Update bars — slots (palette) or degrees (key)
  const weights = frame.slots ?? frame.degrees;
  const N = weights ? weights.length : 0;
  for (let i = 0; i < N; i++) {
    const bar = chromaBars[i];
    if (!bar) continue;
    bar.style.height = `${((weights[i] ?? 0) * 100).toFixed(1)}%`;
  }
}

function buildChromaReadout() {
  const container = document.getElementById("chroma-bars");
  if (!container) return;
  container.innerHTML = ""; // clear before rebuilding

  if (palette) {
    // Palette mode: N slots in sector order
    const N = palette.slots.length;
    container.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
    chromaBars = new Array(N);
    for (let i = 0; i < N; i++) {
      const h0 = palette.slotBoundaryHues[i];
      const h1 = palette.slotBoundaryHues[i + 1] ?? palette.slotBoundaryHues[0];
      const cell = document.createElement("div");
      cell.className = "chroma__cell";
      const bar = document.createElement("div");
      bar.className = "chroma__bar";
      bar.style.background = `linear-gradient(to right, oklch(0.65 0.22 ${h0.toFixed(1)}), oklch(0.65 0.22 ${h1.toFixed(1)}))`;
      cell.appendChild(bar);
      const lbl = document.createElement("div");
      lbl.className = "chroma__lbl";
      lbl.textContent = palette.slots[i].chord.label;
      cell.appendChild(lbl);
      container.appendChild(cell);
      chromaBars[i] = bar; // indexed by slot
    }
  } else {
    // Key mode: 7 degree bars sorted by hue left→right
    container.style.gridTemplateColumns = "repeat(7, 1fr)";
    const sorted = Array.from({ length: 7 }, (_, i) => ({
      degree: i,
      hue: key.degreeToHue(i, 0.5),
      h0: key.degreeToHue(i, 0),
      h1: key.degreeToHue(i, 1),
      numeral: key.degrees[i].numeral,
    })).sort((a, b) => a.hue - b.hue);

    chromaBars = new Array(7);
    for (const { degree, h0, h1, numeral } of sorted) {
      const cell = document.createElement("div");
      cell.className = "chroma__cell";
      const bar = document.createElement("div");
      bar.className = "chroma__bar";
      bar.style.background = `linear-gradient(to right, oklch(0.65 0.22 ${h0.toFixed(1)}), oklch(0.65 0.22 ${h1.toFixed(1)}))`;
      cell.appendChild(bar);
      const lbl = document.createElement("div");
      lbl.className = "chroma__lbl";
      lbl.textContent = numeral;
      cell.appendChild(lbl);
      container.appendChild(cell);
      chromaBars[degree] = bar;
    }
  }
}

class RootHuePicker {
  constructor({ key: keyInstance, onRebuild }) {
    this._key = keyInstance;
    this._onRebuild = onRebuild;
    this._visible = false;

    this._panel = document.getElementById("root-hue-picker");
    this._strip = document.getElementById("rhp-strip");
    this._marker = document.getElementById("rhp-marker");

    if (!this._strip) return;

    let dragging = false;
    this._strip.addEventListener("pointerdown", (e) => {
      dragging = true;
      this._strip.setPointerCapture(e.pointerId);
      this._pick(e);
    });
    this._strip.addEventListener("pointermove", (e) => {
      if (dragging) this._pick(e);
    });
    this._strip.addEventListener("pointerup", () => {
      dragging = false;
    });
    this._strip.addEventListener("pointercancel", () => {
      dragging = false;
    });

    this._update();
  }

  _pick(e) {
    const rect = this._strip.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const displayHue = x * 360;
    // Phase 6: drive palette or key
    if (palette) palette.setRootHue(toPerceptual(displayHue));
    else this._key.setRootHueFromDisplay(displayHue);
    if (audioAnalyzer) audioAnalyzer.rebuildKeyTables();
    if (audioRenderer && palette) audioRenderer.setN(palette.slots.length);
    if (audioRenderer && !palette)
      audioRenderer._staticDegreeHues = this._key.degreeHues;
    this._onRebuild();
    this._update();
  }

  _update() {
    // Track either palette.rootHue or key.rootHue for the strip marker.
    const p = palette ? palette.rootHue : this._key.rootHue;
    const d = fromPerceptual(p);
    this._strip?.style.setProperty(
      "--rhp-pos",
      ((d / 360) * 100).toFixed(2) + "%",
    );
    const elD = document.getElementById("rhp-display");
    const elP = document.getElementById("rhp-perceptual");
    if (elD) elD.textContent = d.toFixed(0) + "°";
    if (elP) elP.textContent = p.toFixed(0) + "°";
  }

  toggle() {
    this._visible = !this._visible;
    this._panel?.classList.toggle("hide", !this._visible);
  }
}

// ── Keyboard ──────────────────────────────────────────────────
window.addEventListener("keydown", async (e) => {
  // Let the calibration panel consume arrow/tab/0 keys when visible
  if (calPanel?.handleKey(e)) return;

  if (e.key === "v" || e.key === "V") {
    calPanel?.toggle();
  } else if (e.key === "h" || e.key === "H") {
    rhpPicker?.toggle();
  } else if (e.key === "s" || e.key === "S") {
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
