/**
 * src/views/loop-view.ts
 *
 * The single performance view.
 *   - Fullscreen AUDIO→VIS canvas as background
 *   - Camera video as a small PiP inset
 *   - Analysis HUD (meters, sparklines, synth info) as overlay, toggled via view.hud
 *   - Chroma bars show what the synth is "hearing" chromatically
 */

import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Calibration } from "../controls/calibration.js";
import { Key } from "../harmony/music.js";
import { Synth } from "../audio/synth.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { Renderer } from "../render/renderer.js";
import { Palette } from "../harmony/palette.js";

// ── HTML template ─────────────────────────────────────────────────────────────

const LOOP_HTML = /* html */ `
  <div id="stage">
    <canvas id="av-canvas"></canvas>
    <video id="vid" playsinline muted></video>
    <canvas id="heat" class="canvas-layer"></canvas>
    <canvas id="hud" class="canvas-layer"></canvas>

    <div id="p-id" class="panel" aria-label="Program identity">
      <div class="p-id__name">AVVA</div>
      <div class="p-id__desc">CAM → AUDIO → VIS</div>
    </div>

    <div id="p-signals" class="panel" aria-label="Analysis signals">
      <div class="sig__hdr">SYNTH</div>
      <div class="sig__key-row">
        <span class="sig__dot" id="sig-dot"></span>
        <span id="sig-key-lbl">—</span>
      </div>
      <div class="sig__note-row">
        <span class="sig__numeral" id="sig-numeral">—</span>
        <span class="sig__sep">·</span>
        <span class="sig__notename" id="sig-notename">—</span>
      </div>
      <div class="sig__quality" id="sig-quality"></div>

      <div class="sig__divider"></div>

      <div class="sig__sparks">
        <canvas class="spark" id="ss-act"></canvas>
        <canvas class="spark" id="ss-actbg"></canvas>
        <canvas class="spark" id="ss-bri"></canvas>
        <canvas class="spark" id="ss-contrast"></canvas>
        <canvas class="spark" id="ss-vy"></canvas>
      </div>

      <div class="sig__divider"></div>

      <div class="sig__hdr">SCENE</div>

      <div class="sig__row">
        <span class="sig__lbl">BRI</span>
        <div class="meter"><div class="meter__fill" id="sb-bri"></div></div>
        <span class="sig__val" id="sv-bri">—</span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">ACT</span>
        <div class="meter"><div class="meter__fill" id="sb-act"></div></div>
        <span class="sig__val" id="sv-act">—</span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">BG</span>
        <div class="meter"><div class="meter__fill" id="sb-actbg"></div></div>
        <span class="sig__val" id="sv-actbg">—</span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">CTR</span>
        <div class="meter"><div class="meter__fill" id="sb-contrast"></div></div>
        <span class="sig__val" id="sv-contrast">—</span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">SPR</span>
        <div class="meter"><div class="meter__fill" id="sb-spread"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">SAT</span>
        <div class="meter"><div class="meter__fill" id="sb-sat"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">HI</span>
        <div class="meter"><div class="meter__fill" id="sb-hi"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">LO</span>
        <div class="meter"><div class="meter__fill" id="sb-lo"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">MSS</span>
        <div class="meter"><div class="meter__fill" id="sb-mass"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row">
        <span class="sig__lbl">VMG</span>
        <div class="meter"><div class="meter__fill" id="sb-vmag"></div></div>
        <span class="sig__val"></span>
      </div>
      <div class="sig__row sig__row--pos">
        <span class="sig__lbl">MX</span>
        <div class="pos-track"><div class="pos-track__marker" id="sb-mx"></div></div>
        <span class="sig__val" id="sv-mx">—</span>
      </div>
      <div class="sig__row sig__row--pos">
        <span class="sig__lbl">VY</span>
        <div class="pos-track"><div class="pos-track__marker" id="sb-vy"></div></div>
        <span class="sig__val" id="sv-vy">—</span>
      </div>
    </div>

    <div id="p-hue" class="panel" aria-label="Hue readout">
      <div class="panel__label">Hue</div>
      <div class="panel__value">
        <span id="hue-v">—</span><span class="panel__unit">°</span>
        <span id="hue-n" class="panel__unit"></span>
      </div>
      <div class="huebar">
        <div class="huebar__marker" id="huemark" aria-hidden="true"></div>
      </div>
      <div class="huehist" id="huehist" aria-hidden="true"></div>
    </div>

    <div id="p-meta" class="panel" aria-label="Signal metadata">
      <b id="m-src">—</b> · <b id="m-res">—</b> · <b id="m-fps">—</b> fps
    </div>

    <div class="chroma" id="chroma-bars" aria-label="Chromatic prevalence"></div>
  </div>

  <div id="gate" class="hide">
    <h1 class="gate__title">AVVA</h1>
    <div class="gate__err" id="err" role="alert"></div>
    <button class="gate__btn" id="go">Retry</button>
  </div>
`;

// ── Module state ──────────────────────────────────────────────────────────────

const state = { fps: 0, frames: 0, fpsT: 0, lastT: 0 };

let videoEl: HTMLVideoElement;
let audioCanvas: HTMLCanvasElement;
let videoSource: any, vidAnalyzer: any, calibration: any;
let synth: any, key: Key;
let renderer: Renderer | null = null;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette | null = null;
let chromaBars: HTMLElement[] = [];

// ── Init ──────────────────────────────────────────────────────────────────────

async function begin(): Promise<void> {
  videoEl = document.getElementById("vid") as HTMLVideoElement;
  audioCanvas = document.getElementById("av-canvas") as HTMLCanvasElement;

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;
  calibration.onChange((cal: any) => { videoEl.style.filter = cal.filterString; });

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
    } catch (e: any) {
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
  } catch (e: any) {
    const gate = document.getElementById("gate");
    gate?.classList.remove("hide");
    const errEl = document.getElementById("err");
    if (errEl) errEl.textContent = "Video error: " + (e.message || e.name);
    document.getElementById("go")?.addEventListener("click", () => {
      gate?.classList.add("hide");
      void begin();
    }, { once: true });
    return;
  }

  renderer = new Renderer(CONFIG);
  renderer.setSourceLabel(videoSource.label);
  renderer.setResLabel(CONFIG.sampleW, CONFIG.sampleH);
  renderer.buildHistBars();
  renderer.resize();
  window.addEventListener("resize", () => {
    renderer?.resize();
    audioRenderer?.resize();
  });

  audioRenderer = new AudioRendererGL(audioCanvas, key.degreeHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.noiseScale,
  });
  if (palette) audioRenderer.setN(palette.slots.length);

  buildChromaReadout();

  if (palette) {
    palette.onChange(() => {
      buildChromaReadout();
      if (audioRenderer) audioRenderer.setN(palette!.slots.length);
    });
  }

  document.getElementById("gate")?.classList.add("hide");

  // ── Controller subscriptions ────────────────────────────────────────────────

  store.subscribeKey("synth.enabled", (v) => {
    if (v && !synth.running) synth.start();
    else if (!v && synth.running) synth.stop();
  });

  store.subscribeKey("synth.masterGain", (v) => {
    if (synth._master) synth._master.gain.value = v;
  });

  store.subscribeKey("view.hud", (v) => {
    document.body.style.setProperty("--hud-opacity", v ? "1" : "0");
  });

  store.subscribeKey("view.heatOn", (v) => {
    vidAnalyzer.heatOn = v;
    renderer?.setHeatVisible(v);
  });

  store.subscribeKey("view.mirror", (v) => {
    videoEl.classList.toggle("mirror", v);
    document.getElementById("heat")?.classList.toggle("mirror", v);
  });

  for (const k of [
    "harmony.root", "harmony.scale", "harmony.octave", "harmony.rootHue",
  ] as const) {
    store.subscribeKey(k, () => {
      key = new Key({
        root: CONFIG.root, mode: CONFIG.mode,
        octave: CONFIG.octave, rootHue: CONFIG.rootHue,
      });
      synth.key = key;
      buildChromaReadout();
    });
  }

  store.subscribeKey("audio.feedback", (v) => { audioRenderer?.setFeedback(v); });
  store.subscribeKey("audio.noiseScale", (v) => { audioRenderer?.setNoiseScale(v); });
  store.subscribeKey("source.playbackRate", (v) => { videoEl.playbackRate = v; });

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
    "cassette.midBoostDb", "cassette.masterLPHz", "cassette.satAmount",
    "cassette.satWet", "cassette.tapeDelayMs", "cassette.tapeDelayFb",
    "cassette.tapeDelayWet", "cassette.reverbWet", "cassette.noiseGain",
    "cassette.wowDepthCents", "cassette.flutterDepthCents",
  ] as const) {
    store.subscribeKey(k, _applyCassette);
  }

  // Apply initial hud/mirror/heat state from store
  document.body.style.setProperty(
    "--hud-opacity", store.get("view.hud") ? "1" : "0",
  );
  videoEl.classList.toggle("mirror", store.get("view.mirror"));
  document.getElementById("heat")?.classList.toggle("mirror", store.get("view.mirror"));
  vidAnalyzer.heatOn = store.get("view.heatOn");
  renderer.setHeatVisible(store.get("view.heatOn"));

  (window as any)._avva = { synth, vidAnalyzer, renderer, audioAnalyzer, audioRenderer, videoSource, store };

  state.lastT = performance.now();
  requestAnimationFrame(tick);
}

function maybeTapSynth(): void {
  if (audioAnalyzer || !synth.running || !synth._actx || !synth._master) return;
  audioAnalyzer = new AudioAnalyzer({ audioContext: synth._actx, key, palette });
  synth._master.connect(audioAnalyzer.analyser);
}

// ── Tick ──────────────────────────────────────────────────────────────────────

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

  if (videoEl.readyState >= 2) {
    const frame = vidAnalyzer.analyze(videoEl);
    synth.update({ ...frame.out, histBins: frame.histBins });

    if (renderer) {
      const synthSnap = {
        running: synth.running,
        keyLabel: synth.key ? synth.key.label.toUpperCase() : "—",
        note: synth.key ? synth.key.hueToNote(frame.out.hue) : null,
      };
      renderer.paint(frame, state.fps, synthSnap);
    }

    maybeTapSynth();
    if (audioAnalyzer && audioRenderer) {
      const a = audioAnalyzer.tick();
      audioRenderer.render(a);
      paintChroma(a);
    }
  }

  requestAnimationFrame(tick);
}

// ── Chroma readout ────────────────────────────────────────────────────────────

function paintChroma(frame: any): void {
  const weights = frame.slots ?? frame.degrees;
  if (!weights) return;
  for (let i = 0; i < weights.length; i++) {
    const bar = chromaBars[i];
    if (bar) bar.style.height = `${((weights[i] ?? 0) * 100).toFixed(1)}%`;
  }
}

function buildChromaReadout(): void {
  const container = document.getElementById("chroma-bars");
  if (!container) return;
  container.innerHTML = "";

  if (palette) {
    const N = palette.slots.length;
    container.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
    chromaBars = new Array(N);

    const sorted = palette.slots
      .map((slot, i) => {
        let h0 = palette!.slotBoundaryHues[i];
        let h1 = palette!.slotBoundaryHues[i + 1] ?? palette!.slotBoundaryHues[0];
        if (h1 <= h0) h1 += 360;
        return { slotIdx: i, h0, h1, label: slot.chord.label };
      })
      .sort((a, b) => a.h0 - b.h0);

    for (const { slotIdx, h0, h1, label } of sorted) {
      const cell = document.createElement("div");
      cell.className = "chroma__cell";
      const bar = document.createElement("div");
      bar.className = "chroma__bar";
      bar.style.background = `linear-gradient(to right, oklch(0.65 0.22 ${h0.toFixed(1)}), oklch(0.65 0.22 ${h1.toFixed(1)}))`;
      cell.appendChild(bar);
      const lbl = document.createElement("div");
      lbl.className = "chroma__lbl";
      lbl.textContent = label;
      cell.appendChild(lbl);
      container.appendChild(cell);
      chromaBars[slotIdx] = bar;
    }
  } else {
    container.style.gridTemplateColumns = "repeat(7, 1fr)";
    const sorted = Array.from({ length: 7 }, (_, i) => ({
      degree: i,
      h0: key.degreeToHue(i, 0),
      h1: key.degreeToHue(i, 1),
      numeral: key.degrees[i].numeral,
    })).sort((a, b) => a.h0 - b.h0);

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

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mountLoopView(): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/loop.css";
  document.head.appendChild(link);

  document.body.className = "loop";
  document.body.innerHTML = LOOP_HTML;

  void begin();
}
