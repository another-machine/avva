/**
 * src/views/loop-view.ts
 *
 * Closed-loop dev harness — both pipelines in one page sharing one AudioContext.
 *
 *   Program 1 (left): VideoSource → Analyzer → Synth
 *   Program 2 (right): synth._master → AudioAnalyzer → AudioRendererGL
 *
 * Mounted by main.ts when ?view=loop is in the URL. Injects its own HTML
 * template into document.body so it owns the full DOM without ID conflicts
 * with the analysis view.
 *
 * Keys: [S] synth on/off · [C] cycle video source · [V] calibration · [H] root-hue picker
 */

import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Calibration, CalibrationPanel } from "../controls/calibration.js";
import { Key } from "../harmony/music.js";
import { Synth } from "../audio/synth.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { fromPerceptual, toPerceptual } from "../harmony/hue-perception.js";
import { Palette } from "../harmony/palette.js";

// ── HTML template ─────────────────────────────────────────────────────────────

const LOOP_HTML = /* html */ `
  <header class="loop__header">
    <div class="loop__title">AVVA · LOOP HARNESS</div>
    <div class="loop__meta">
      <span>KEY <b id="m-key">—</b></span>
      <span>SRC <b id="m-src">—</b></span>
      <span><b id="m-fps">—</b> FPS</span>
      <span class="loop__hint">[S] synth · [C] cycle source</span>
    </div>
  </header>

  <main class="loop__stage">
    <!-- Program 1: video + readout -->
    <section class="loop__pane" aria-label="Program 1 — CAM→AUDIO">
      <div class="loop__pane-label">CAM → AUDIO</div>
      <video id="vid" class="loop__video" playsinline muted></video>
      <div class="loop__readout">
        <div class="rd__row"><span>HUE</span><b id="v-hue">—</b><span>°</span></div>
        <div class="rd__row"><span>BRI</span><b id="v-bri">—</b></div>
        <div class="rd__row"><span>ACT</span><b id="v-act">—</b></div>
        <div class="rd__row"><span>HI</span><b id="v-hi">—</b></div>
        <div class="rd__row"><span>LO</span><b id="v-lo">—</b></div>
        <div class="rd__row"><span>SPRD</span><b id="v-sprd">—</b></div>
        <div class="rd__sep"></div>
        <div class="rd__chord-hdr"><b id="v-numeral">—</b></div>
        <div class="rd__chord">
          <span class="rd__note" id="v-note-0">—</span>
          <span class="rd__note" id="v-note-1">—</span>
          <span class="rd__note" id="v-note-2">—</span>
        </div>
      </div>

      <div id="calibrate" class="panel" aria-label="Video calibration" aria-live="polite">
        <div class="cal__header">Video Calibration</div>
        <div class="cal__row" id="cal-row-brightness">
          <span class="cal__name">Brightness</span>
          <span class="cal__value" id="cal-val-brightness">1.00</span>
        </div>
        <div class="cal__row" id="cal-row-contrast">
          <span class="cal__name">Contrast</span>
          <span class="cal__value" id="cal-val-contrast">1.00</span>
        </div>
        <div class="cal__row" id="cal-row-saturation">
          <span class="cal__name">Saturation</span>
          <span class="cal__value" id="cal-val-saturation">1.00</span>
        </div>
        <div class="cal__row" id="cal-row-hueRotate">
          <span class="cal__name">Hue Rotate</span>
          <span class="cal__value" id="cal-val-hueRotate">0°</span>
        </div>
        <div class="cal__hint">↑↓ adjust · TAB next · 0 reset · V close</div>
        <div class="cal__url" id="cal-url"></div>
      </div>

      <div id="root-hue-picker" class="panel hide" aria-label="Root hue" aria-live="polite">
        <div class="cal__header">Root Hue</div>
        <div class="rhp__strip" id="rhp-strip">
          <div class="rhp__marker" id="rhp-marker"></div>
        </div>
        <div class="cal__row">
          <span class="cal__name">Display</span>
          <span class="cal__value" id="rhp-display">0°</span>
        </div>
        <div class="cal__row">
          <span class="cal__name">Perceptual</span>
          <span class="cal__value" id="rhp-perceptual">0°</span>
        </div>
        <div class="cal__hint">Click/drag strip to set · H close</div>
      </div>
    </section>

    <!-- Program 2: audio canvas + chroma readout -->
    <section class="loop__pane" aria-label="Program 2 — AUDIO→VIS">
      <div class="loop__pane-label">AUDIO → VIS</div>
      <canvas id="av-canvas" class="loop__canvas"></canvas>
      <div class="loop__readout">
        <div class="rd__row"><span>HUE</span><b id="a-hue">—</b><span>°</span></div>
        <div class="rd__row"><span>BRI</span><b id="a-bri">—</b></div>
        <div class="rd__row"><span>ACT</span><b id="a-act">—</b></div>
        <div class="rd__row"><span>HI</span><b id="a-hi">—</b></div>
        <div class="rd__row"><span>LO</span><b id="a-lo">—</b></div>
        <div class="rd__row rd__row--wide"><span>CHORD</span><b id="a-chord">—</b></div>
      </div>
      <div class="chroma" id="chroma-bars" aria-label="Chromatic prevalence"></div>
    </section>
  </main>

  <div id="gate">
    <h1 class="gate__title">AVVA · LOOP</h1>
    <p class="gate__sub">
      Closed-loop dev harness. Press <b>S</b> to start the synth — Program 2
      will read the audio bus directly. No mic, no speakers required for
      analysis (audio still plays to your speakers).
    </p>
    <button class="gate__btn" id="go">Begin</button>
    <div class="gate__err" id="err" role="alert"></div>
  </div>
`;

// ── RootHuePicker ─────────────────────────────────────────────────────────────

class RootHuePicker {
  private readonly _key: Key;
  private readonly _onRebuild: () => void;
  private _visible = false;
  private readonly _panel: HTMLElement | null;
  private readonly _strip: HTMLElement | null;
  private readonly _marker: HTMLElement | null;

  constructor({ key, onRebuild }: { key: Key; onRebuild: () => void }) {
    this._key = key;
    this._onRebuild = onRebuild;
    this._panel = document.getElementById("root-hue-picker");
    this._strip = document.getElementById("rhp-strip");
    this._marker = document.getElementById("rhp-marker");

    if (!this._strip) return;

    let dragging = false;
    this._strip.addEventListener("pointerdown", (e) => {
      dragging = true;
      this._strip!.setPointerCapture((e as PointerEvent).pointerId);
      this._pick(e as PointerEvent);
    });
    this._strip.addEventListener("pointermove", (e) => {
      if (dragging) this._pick(e as PointerEvent);
    });
    this._strip.addEventListener("pointerup", () => {
      dragging = false;
    });
    this._strip.addEventListener("pointercancel", () => {
      dragging = false;
    });

    this._update();
  }

  private _pick(e: PointerEvent): void {
    const rect = this._strip!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const displayHue = x * 360;
    this._key.setRootHueFromDisplay(displayHue);
    this._onRebuild();
    this._update();
  }

  _update(): void {
    const d = fromPerceptual(this._key.rootHue);
    this._strip?.style.setProperty(
      "--rhp-pos",
      ((d / 360) * 100).toFixed(2) + "%",
    );
    const elD = document.getElementById("rhp-display");
    const elP = document.getElementById("rhp-perceptual");
    if (elD) elD.textContent = d.toFixed(0) + "°";
    if (elP) elP.textContent = this._key.rootHue.toFixed(0) + "°";
  }

  toggle(): void {
    this._visible = !this._visible;
    this._panel?.classList.toggle("hide", !this._visible);
  }
}

// ── Module state ──────────────────────────────────────────────────────────────

const state = { fps: 0, frames: 0, fpsT: 0, lastT: 0, tapped: false };

let videoEl: HTMLVideoElement;
let audioCanvas: HTMLCanvasElement;
let videoSource: any, vidAnalyzer: any, calibration: any, calPanel: any;
let synth: any, key: Key;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette | null = null;
let chromaBars: HTMLElement[] = [];
let rhpPicker: RootHuePicker | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

async function begin(): Promise<void> {
  videoEl = document.getElementById("vid") as HTMLVideoElement;
  audioCanvas = document.getElementById("av-canvas") as HTMLCanvasElement;

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;

  calPanel = new CalibrationPanel(calibration, {
    onChange: (cal: any) => {
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
    const errEl = document.getElementById("err");
    if (errEl) errEl.textContent = "Video error: " + (e.message || e.name);
    return;
  }

  audioRenderer = new AudioRendererGL(audioCanvas, key.degreeHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.noiseScale,
  });
  if (palette) audioRenderer.setN(palette.slots.length);
  window.addEventListener("resize", () => audioRenderer?.resize());

  buildChromaReadout();
  rhpPicker = new RootHuePicker({ key, onRebuild: buildChromaReadout });

  if (palette) {
    palette.onChange(() => {
      buildChromaReadout();
      if (audioRenderer) audioRenderer.setN(palette!.slots.length);
      rhpPicker?._update();
    });
  }

  (window as any)._avva = {
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

  document.getElementById("m-key")!.textContent = key.label.toUpperCase();
  document.getElementById("m-src")!.textContent = videoSource.label;
  document.getElementById("gate")!.classList.add("hide");

  // ── Live store subscriptions (from controller) ───────────────────────────
  store.subscribeKey("synth.enabled", (v) => {
    if (v && !synth.running) synth.start();
    else if (!v && synth.running) synth.stop();
  });

  store.subscribeKey("synth.masterGain", (v) => {
    if (synth._master) synth._master.gain.value = v;
  });

  store.subscribeKey("audio.feedback", (v) => {
    audioRenderer?.setFeedback(v);
  });

  store.subscribeKey("audio.noiseScale", (v) => {
    audioRenderer?.setNoiseScale(v);
  });

  store.subscribeKey("source.playbackRate", (v) => {
    videoEl.playbackRate = v;
  });

  state.lastT = performance.now();
  requestAnimationFrame(tick);
}

function maybeTapSynth(): void {
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
    const v = vidAnalyzer.analyze(videoEl);
    synth.update({ ...v.out, histBins: v.histBins });
    paintVideoReadout(v);

    maybeTapSynth();
    if (audioAnalyzer && audioRenderer) {
      const a = audioAnalyzer.tick();
      audioRenderer.render(a);
      paintAudioReadout(a);
    }
  }

  document.getElementById("m-fps")!.textContent = state.fps.toFixed(0);
  requestAnimationFrame(tick);
}

// ── Readout painters ──────────────────────────────────────────────────────────

function paintVideoReadout(frame: any): void {
  const o = frame.out;
  document.getElementById("v-hue")!.textContent = o.hue.toFixed(0);
  document.getElementById("v-bri")!.textContent = o.bri.toFixed(2);
  document.getElementById("v-act")!.textContent = o.act.toFixed(2);
  document.getElementById("v-hi")!.textContent = o.hi.toFixed(2);
  document.getElementById("v-lo")!.textContent = o.lo.toFixed(2);
  document.getElementById("v-sprd")!.textContent = o.spread.toFixed(2);

  const note = key.hueToNote(o.hue);
  const thirdW = Math.max(0, Math.min(1, (o.spread - 0.15) / 0.25));
  const fifthW = Math.max(0, Math.min(1, (o.spread - 0.4) / 0.25));
  const weights = [1.0, thirdW, fifthW];

  document.getElementById("v-numeral")!.textContent = note.numeral;
  [0, 1, 2].forEach((vi) => {
    const el = document.getElementById(`v-note-${vi}`);
    if (!el) return;
    el.textContent = note.triad[vi].name;
    el.style.opacity = (0.15 + weights[vi] * 0.85).toFixed(2);
  });

  document.documentElement.style.setProperty("--accent-h", o.hue.toFixed(1));
}

function paintAudioReadout(frame: any): void {
  document.getElementById("a-hue")!.textContent = frame.hue.toFixed(0);
  document.getElementById("a-bri")!.textContent = frame.bri.toFixed(2);
  document.getElementById("a-act")!.textContent = frame.act.toFixed(2);
  document.getElementById("a-hi")!.textContent = frame.bands.hi.toFixed(2);
  document.getElementById("a-lo")!.textContent = frame.bands.lo.toFixed(2);
  document.getElementById("a-chord")!.textContent = frame.chord.label;

  const weights = frame.slots ?? frame.degrees;
  if (weights) {
    for (let i = 0; i < weights.length; i++) {
      const bar = chromaBars[i];
      if (bar) bar.style.height = `${((weights[i] ?? 0) * 100).toFixed(1)}%`;
    }
  }
}

// ── Chroma bars ───────────────────────────────────────────────────────────────

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
        let h1 =
          palette!.slotBoundaryHues[i + 1] ?? palette!.slotBoundaryHues[0];
        if (h1 <= h0) h1 += 360;
        return {
          slotIdx: i,
          centerHue: palette!.slotHues[i],
          h0,
          h1,
          label: slot.chord.label,
        };
      })
      .sort((a, b) => a.centerHue - b.centerHue);

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

// ── Keyboard ──────────────────────────────────────────────────────────────────

function bindKeys(): void {
  window.addEventListener("keydown", async (e) => {
    if ((calPanel as any)?.handleKey(e)) return;

    if (e.key === "v" || e.key === "V") {
      (calPanel as any)?.toggle();
    } else if (e.key === "h" || e.key === "H") {
      rhpPicker?.toggle();
    } else if (e.key === "s" || e.key === "S") {
      synth.toggle();
      store.set("synth.enabled", synth.running);
    } else if (e.key === "c" || e.key === "C") {
      try {
        await videoSource.cycleSource();
        const srcEl = document.getElementById("m-src");
        if (srcEl) srcEl.textContent = videoSource.label;
      } catch {
        /* swallow */
      }
    }
  });
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mountLoopView(): void {
  // Inject loop CSS
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/loop.css";
  document.head.appendChild(link);

  // Replace body content with loop template and activate the body.loop class
  document.body.className = "loop";
  document.body.innerHTML = LOOP_HTML;

  bindKeys();

  if (CONFIG.source !== "camera") {
    void begin();
  } else {
    document
      .getElementById("go")
      ?.addEventListener("click", () => void begin());
  }
}
