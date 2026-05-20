import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Calibration } from "../controls/calibration.js";
import { Synth } from "../audio/synth.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { Palette } from "../harmony/palette.js";
import { TelemetrySender } from "../store/telemetry.js";
import { PRESETS, CASSETTE_PRESETS } from "../audio/presets.js";
import { Pipeline } from "../pipeline/pipeline.js";

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
let synth: any;
let heatCtx: CanvasRenderingContext2D | null = null;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette | null = null;
let telemetry: TelemetrySender | null = null;
let pipeline: Pipeline | null = null;
let _sourceLabel = "—";
let _resLabel = "—";

// ── Init ──────────────────────────────────────────────────────────────────────

async function begin(): Promise<void> {
  videoEl = document.getElementById("vid") as HTMLVideoElement;
  audioCanvas = document.getElementById("av-canvas") as HTMLCanvasElement;

  calibration = new Calibration();
  videoEl.style.filter = calibration.filterString;
  calibration.onChange((cal: any) => {
    videoEl.style.filter = cal.filterString;
  });

  const defaultPaletteStr = store.get("harmony.palette") || "CEG, FAC, GBD";
  palette = Palette.fromURLParam(defaultPaletteStr, {
    rootHue: 0,
    crossZone: CONFIG.crossZone,
  });

  videoSource = new VideoSource(videoEl, CONFIG);
  vidAnalyzer = new Analyzer(CONFIG, calibration);
  synth = new Synth(CONFIG);
  synth.palette = palette;

  try {
    await videoSource.start();
  } catch (e: any) {
    const gate = document.getElementById("gate");
    gate?.classList.remove("hide");
    const errEl = document.getElementById("err");
    if (errEl) errEl.textContent = "Video error: " + (e.message || e.name);
    document.getElementById("go")?.addEventListener(
      "click",
      () => {
        gate?.classList.add("hide");
        void begin();
      },
      { once: true },
    );
    return;
  }

  _sourceLabel = videoSource.label;
  _resLabel = `96×72`;

  const heat = document.getElementById("heat") as HTMLCanvasElement;
  heat.width = 96;
  heat.height = 72;
  heatCtx = heat.getContext("2d")!;
  heatCtx.imageSmoothingEnabled = false;

  telemetry = new TelemetrySender();

  pipeline = new Pipeline({
    runVideo: () => {
      if (videoEl.readyState < 2) return null;
      return vidAnalyzer.analyze(videoEl);
    },
    runSynth: (videoOut) => {
      if (!videoOut) return null;
      const f = videoOut as ReturnType<typeof vidAnalyzer.analyze>;
      const root = document.documentElement;
      root.style.setProperty("--accent-l", (0.55 + f.out.bri * 0.2).toFixed(3));
      root.style.setProperty("--accent-c", (0.04 + f.out.sat * 0.18).toFixed(3));
      root.style.setProperty("--accent-h", f.out.hue.toFixed(1));
      if (f.heatImageData && heatCtx) heatCtx.putImageData(f.heatImageData, 0, 0);
      synth.update(f.out);
      return synth.lastControls;
    },
    runAudio: () => {
      maybeTapSynth();
      if (!audioAnalyzer) return null;
      return audioAnalyzer.tick();
    },
    runVisual: (audioOut) => {
      if (!audioOut || !audioRenderer) return null;
      return audioRenderer.render(audioOut as ReturnType<AudioAnalyzer["tick"]>);
    },
  });

  audioRenderer = new AudioRendererGL(audioCanvas, palette.slotHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.blobWarp,
  });
  audioRenderer.setN(palette.slots.length);

  document.getElementById("gate")?.classList.add("hide");

  window.addEventListener("resize", () => {
    audioRenderer?.resize();
  });

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

  store.subscribeKey("harmony.palette", () => {
    const paletteStr = store.get("harmony.palette") || "CEG, FAC, GBD";
    try {
      palette = Palette.fromURLParam(paletteStr as string, {
        rootHue: 0,
        crossZone: CONFIG.crossZone,
      });
    } catch {
      palette = null;
    }
    synth.setPalette(palette);
    if (palette) {
      audioAnalyzer?.setPalette(palette);
      if (audioRenderer) audioRenderer.setN(palette.slots.length);
    }
  });

  store.subscribeKey("harmony.crossZone", (v) => {
    palette?.setCrossZone(v);
  });

  store.subscribeKey("audio.feedback", (v) => {
    audioRenderer?.setFeedback(v);
  });
  store.subscribeKey("audio.blobWarp", (v) => {
    audioRenderer?.setBlobWarp(v);
  });
  store.subscribeKey("audio.blobSpeed", (v) => {
    audioRenderer?.setBlobSpeed(v);
  });
  store.subscribeKey("audio.blobDrive", (v) => {
    audioRenderer?.setBlobDrive(v);
  });
  store.subscribeKey("audio.shiftSpeed", (v) => {
    audioRenderer?.setShiftSpeed(v);
  });
  store.subscribeKey("audio.blobSize", (v) => {
    audioRenderer?.setBlobSize(v);
  });
  store.subscribeKey("audio.blobSharp", (v) => {
    audioRenderer?.setBlobSharp(v);
  });
  store.subscribeKey("audio.pulseReactivity", (v) => {
    audioRenderer?.setPulseReactivity(v);
  });

  store.subscribeKey("synth.preset", (name) => {
    if (name === "custom") return;
    const preset = PRESETS[name as string];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      store.set(k as any, v as any);
    }
  });
  store.subscribeKey("cassette.preset", (name) => {
    if (name === "custom") return;
    const preset = CASSETTE_PRESETS[name as string];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      store.set(k as any, v as any);
    }
  });
  store.subscribeKey("source.playbackRate", (v) => {
    videoEl.playbackRate = v;
  });

  const _restartSource = async () => {
    if (!videoSource) return;
    videoSource.stop();
    try {
      await videoSource.start();
      _sourceLabel = videoSource.label;
    } catch (e: any) {
      console.error("Source restart failed:", e.message);
    }
  };
  for (const k of ["source.kind", "source.file", "source.url"] as const) {
    store.subscribeKey(k, _restartSource);
  }

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

  // Apply initial state from store
  videoEl.classList.toggle("mirror", store.get("view.mirror"));
  heat.classList.toggle("mirror", store.get("view.mirror"));
  vidAnalyzer.heatOn = store.get("view.heatOn");
  heat.style.setProperty(
    "--heat-opacity",
    store.get("view.heatOn") ? "0.55" : "0",
  );

  (window as any)._avva = {
    synth,
    vidAnalyzer,
    audioAnalyzer,
    audioRenderer,
    videoSource,
    store,
  };

  state.lastT = performance.now();
  requestAnimationFrame(tick);
}

function maybeTapSynth(): void {
  if (audioAnalyzer || !synth.running || !synth._actx || !synth._master) return;
  if (!palette) return;
  audioAnalyzer = new AudioAnalyzer({
    audioContext: synth._actx,
    palette,
  });
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

  if (pipeline) {
    const { videoOut, audioOut, visualOut } = pipeline.tick();
    const frame = videoOut as ReturnType<typeof vidAnalyzer.analyze> | null;
    const audioFrame = audioOut as ReturnType<AudioAnalyzer["tick"]> | null | undefined;
    const vis = visualOut as import("../render/audio-renderer-gl.js").VisualUniforms | null | undefined;

    telemetry?.send({
      t,
      fps: state.fps,
      sourceLabel: _sourceLabel,
      resLabel: _resLabel,
      video: frame?.out,
      histBins: frame?.histBins,
      synth: { running: synth.running, note: synth.lastNote ?? null },
      synthControls: synth.lastControls ?? undefined,
      audio: audioFrame ?? undefined,
      visualUniforms: vis ?? undefined,
    });
  }

  requestAnimationFrame(tick);
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mountLoopView(): void {
  document.body.className = "loop";
  document.body.innerHTML = LOOP_HTML;

  store.set("synth.enabled", false);
  void begin();
}
