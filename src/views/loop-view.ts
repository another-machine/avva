import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Calibration } from "../controls/calibration.js";
import { Key } from "../harmony/music.js";
import { Synth } from "../audio/synth.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { Palette } from "../harmony/palette.js";
import { TelemetrySender } from "../store/telemetry.js";

// ── HTML template ─────────────────────────────────────────────────────────────

const LOOP_HTML = /* html */ `
  <div id="stage">
    <div class="pane pane--vis"><canvas id="av-canvas"></canvas></div>
    <div class="pane pane--cam">
      <video id="vid" playsinline muted></video>
      <canvas id="heat" class="canvas-layer"></canvas>
    </div>
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
let heatCtx: CanvasRenderingContext2D | null = null;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette | null = null;
let telemetry: TelemetrySender | null = null;
let _sourceLabel = "—";
let _resLabel = "—";

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

  _sourceLabel = videoSource.label;
  _resLabel = `${CONFIG.sampleW}×${CONFIG.sampleH}`;

  const heat = document.getElementById("heat") as HTMLCanvasElement;
  heat.width = CONFIG.sampleW;
  heat.height = CONFIG.sampleH;
  heatCtx = heat.getContext("2d")!;
  heatCtx.imageSmoothingEnabled = false;

  telemetry = new TelemetrySender();

  audioRenderer = new AudioRendererGL(audioCanvas, key.degreeHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.noiseScale,
  });
  if (palette) audioRenderer.setN(palette.slots.length);

  if (palette) {
    palette.onChange(() => {
      if (audioRenderer) audioRenderer.setN(palette!.slots.length);
    });
  }

  document.getElementById("gate")?.classList.add("hide");

  window.addEventListener("resize", () => { audioRenderer?.resize(); });

  // ── Controller subscriptions ────────────────────────────────────────────────

  store.subscribeKey("synth.enabled", (v) => {
    if (v && !synth.running) synth.start();
    else if (!v && synth.running) synth.stop();
  });

  store.subscribeKey("synth.masterGain", (v) => {
    if (synth._master) synth._master.gain.value = v;
  });

  store.subscribeKey("view.heatOn", (v) => {
    vidAnalyzer.heatOn = v;
    heat.style.setProperty("--heat-opacity", v ? "0.55" : "0");
  });

  store.subscribeKey("view.mirror", (v) => {
    videoEl.classList.toggle("mirror", v);
    heat.classList.toggle("mirror", v);
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

  // Apply initial state from store
  videoEl.classList.toggle("mirror", store.get("view.mirror"));
  heat.classList.toggle("mirror", store.get("view.mirror"));
  vidAnalyzer.heatOn = store.get("view.heatOn");
  heat.style.setProperty("--heat-opacity", store.get("view.heatOn") ? "0.55" : "0");

  (window as any)._avva = { synth, vidAnalyzer, audioAnalyzer, audioRenderer, videoSource, store };

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

    // Update accent CSS vars — audio visualizer shader reads these from :root
    const root = document.documentElement;
    root.style.setProperty("--accent-l", (0.55 + frame.out.bri * 0.2).toFixed(3));
    root.style.setProperty("--accent-c", (0.04 + frame.out.sat * 0.18).toFixed(3));
    root.style.setProperty("--accent-h", frame.out.hue.toFixed(1));

    if (frame.heatImageData && heatCtx) {
      heatCtx.putImageData(frame.heatImageData, 0, 0);
    }

    const synthSnap = {
      running: synth.running,
      keyLabel: synth.key ? synth.key.label.toUpperCase() : "—",
      note: synth.key ? synth.key.hueToNote(frame.out.hue) : null,
    };

    maybeTapSynth();
    let audioFrame: ReturnType<AudioAnalyzer["tick"]> | undefined;
    if (audioAnalyzer && audioRenderer) {
      audioFrame = audioAnalyzer.tick();
      audioRenderer.render(audioFrame);
    }

    telemetry?.send({
      t,
      fps: state.fps,
      sourceLabel: _sourceLabel,
      resLabel: _resLabel,
      video: frame.out,
      histBins: frame.histBins,
      synth: synthSnap,
      audio: audioFrame,
    });
  }

  requestAnimationFrame(tick);
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
