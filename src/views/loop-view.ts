import { store } from "../store/store.js";
import { AUDIO_EQ_KEYS } from "../store/schema.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { VideoSource } from "../input/video-source.js";
import { Analyzer } from "../analysis/analyzer.js";
import { Calibration } from "../controls/calibration.js";
import {
  Synth,
  SYNTH_NOTE_GRID_OCT_L,
  SYNTH_NOTE_GRID_OCT_H,
} from "../audio/synth.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { Palette } from "../harmony/palette.js";
import { TelemetrySender } from "../store/telemetry.js";
import { PRESETS, CASSETTE_PRESETS, FM_PRESETS, GLIDE_PRESETS } from "../audio/presets.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { startBroadcaster, type BroadcasterBridge } from "../input/webrtc-bridge.js";

// ── HTML template ─────────────────────────────────────────────────────────────

const LOOP_HTML = /* html */ `
  <div id="stage">
    <div class="pane pane--vis"><canvas id="av-canvas"></canvas></div>
    <div class="pane pane--cam">
      <video id="vid" playsinline muted></video>
      <canvas id="heat" class="canvas-layer"></canvas>
      <canvas id="tilt" class="canvas-layer"></canvas>
      <canvas id="mask" class="canvas-layer"></canvas>
    </div>
  </div>
  <div id="gate" class="hide">
    <h1 class="gate__title">AVVA</h1>
    <div class="gate__err" id="err" role="alert"></div>
    <button class="gate__btn" id="go">Retry</button>
  </div>
`;

// va view (video → audio only). Same camera pane + analysis overlays as the
// loop, but no visualizer pane — the blob renderer lives in the listener window.
const SOURCE_HTML = /* html */ `
  <div id="stage">
    <div class="pane pane--cam">
      <video id="vid" playsinline muted></video>
      <canvas id="heat" class="canvas-layer"></canvas>
      <canvas id="tilt" class="canvas-layer"></canvas>
      <canvas id="mask" class="canvas-layer"></canvas>
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

// When false (?view=va) this window runs the video→audio half of the loop
// only: camera + analysis + synth + WebRTC broadcast, with no local audio
// analyzer or blob renderer. The listener window (?view=av) draws those.
let _renderVisuals = true;

let videoEl: HTMLVideoElement;
let audioCanvas: HTMLCanvasElement;
let videoSource: any, vidAnalyzer: any, calibration: any;
let synth: any;
let heatCtx: CanvasRenderingContext2D | null = null;
let tiltCanvas: HTMLCanvasElement | null = null;
let maskCanvas: HTMLCanvasElement | null = null;
let tiltOn = false;
let maskOn = false;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette | null = null;
let telemetry: TelemetrySender | null = null;
let pipeline: Pipeline | null = null;
let _sourceLabel = "—";
let _resLabel = "—";
let broadcaster: BroadcasterBridge | null = null;
let broadcastStreamNode: MediaStreamAudioDestinationNode | null = null;

// ── Tilt overlay ──────────────────────────────────────────────────────────────

// Tilt is computed by the analyzer over the active sample area, which is the
// viewbox crop when masking is on. We need to map it back into viewbox-relative
// canvas coordinates so the line lands where the analyzer is actually looking.
function _drawTiltOverlay(canvas: HTMLCanvasElement, tilt: number): void {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  if (canvas.width !== Math.round(r.width) || canvas.height !== Math.round(r.height)) {
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
  }
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Map tilt (0-1 within the analyzed region) into pane pixel space. The
  // analyzer crops to the viewbox whenever the mask (or viewboxOn) is on, so the
  // overlay must match — tilt is relative to the masked crop, not the frame.
  const cropped = !!store.get("view.maskOn") || !!store.get("view.viewboxOn");
  const vy = cropped ? (store.get("view.viewboxY") as number ?? 0) : 0;
  const vbh = cropped ? (store.get("view.viewboxH") as number ?? 1) : 1;
  const vx = cropped ? (store.get("view.viewboxX") as number ?? 0) : 0;
  const vbw = cropped ? (store.get("view.viewboxW") as number ?? 1) : 1;
  const clampedVh = Math.max(0, Math.min(vbh, 1 - vy));
  const clampedVw = Math.max(0, Math.min(vbw, 1 - vx));

  const y = (vy + tilt * clampedVh) * h;
  const xL = vx * w;
  const xR = (vx + clampedVw) * w;
  const bandH = Math.round(clampedVh * h * 0.18); // 18% of *cropped* height

  const grad = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
  grad.addColorStop(0,   "rgba(100, 220, 190, 0)");
  grad.addColorStop(0.5, "rgba(100, 220, 190, 0.15)");
  grad.addColorStop(1,   "rgba(100, 220, 190, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(xL, Math.max(0, y - bandH), xR - xL, bandH * 2);

  ctx.strokeStyle = "rgba(130, 240, 210, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xL, y);
  ctx.lineTo(xR, y);
  ctx.stroke();
}

// ── Mask overlay ──────────────────────────────────────────────────────────────

function _drawMaskOverlay(canvas: HTMLCanvasElement): void {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  if (canvas.width !== Math.round(r.width) || canvas.height !== Math.round(r.height)) {
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
  }
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  const vx  = store.get("view.viewboxX") as number ?? 0;
  const vy  = store.get("view.viewboxY") as number ?? 0;
  const vbw = store.get("view.viewboxW") as number ?? 1;
  const vbh = store.get("view.viewboxH") as number ?? 1;
  const cx = Math.round(vx * w);
  const cy = Math.round(vy * h);
  const cw = Math.max(1, Math.round(Math.min(vbw, 1 - vx) * w));
  const ch = Math.max(1, Math.round(Math.min(vbh, 1 - vy) * h));

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
  ctx.fillRect(0, 0, w, h);
  ctx.clearRect(cx, cy, cw, ch);
}

function _clearMask(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
}

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
    rootHue: store.get("harmony.rootHue") as number ?? 0,
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
    const goBtn = document.getElementById("go");
    const isScreen = store.get("source.kind") === "screen";
    if (errEl) errEl.textContent = isScreen ? "" : "Video error: " + (e.message || e.name);
    if (goBtn) goBtn.textContent = isScreen ? "Start Screen Share" : "Retry";
    gate?.addEventListener(
      "click",
      (ev) => {
        if ((ev.target as HTMLElement).id !== "go") return;
        gate.classList.add("hide");
        void begin();
      },
      { once: true },
    );
    return;
  }

  _sourceLabel = videoSource.label;

  videoSource.onStreamEnded = () => {
    const gate = document.getElementById("gate");
    const errEl = document.getElementById("err");
    const goBtn = document.getElementById("go");
    gate?.classList.remove("hide");
    if (errEl) errEl.textContent = "Screen share ended.";
    if (goBtn) goBtn.textContent = "Restart Screen Share";
    gate?.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).id !== "go") return;
      gate.classList.add("hide");
      void begin();
    }, { once: true });
  };
  _resLabel = `96×72`;

  const heat = document.getElementById("heat") as HTMLCanvasElement;
  heat.width = 96;
  heat.height = 72;
  heatCtx = heat.getContext("2d")!;
  heatCtx.imageSmoothingEnabled = false;

  tiltCanvas = document.getElementById("tilt") as HTMLCanvasElement;
  maskCanvas = document.getElementById("mask") as HTMLCanvasElement;
  tiltOn = !!store.get("view.tiltOn");
  maskOn = !!store.get("view.maskOn");
  videoEl.playbackRate = store.get("source.playbackRate") as number;

  telemetry = new TelemetrySender();

  // Start the WebRTC broadcaster bridge. It's idle (no peer connections)
  // until a listener tab pings; the synth tap (in maybeTapSynth) wires its
  // master output into a MediaStreamDestination once the synth is running.
  if (!broadcaster) broadcaster = startBroadcaster();

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
      if (tiltOn && tiltCanvas) _drawTiltOverlay(tiltCanvas, f.out.tilt);
      if (maskOn && maskCanvas) _drawMaskOverlay(maskCanvas);
      synth.update(f.out);
      if (synth._actx) {
        synth.setBriDim(f.out.bri, synth._actx.currentTime);
      }
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

  // Source mode skips the local blob renderer (stage 4) entirely — the
  // listener window owns the audio→visual side. All audio.* subscriptions
  // below are null-safe (audioRenderer?.…), so they no-op here harmlessly.
  if (_renderVisuals) {
    audioRenderer = new AudioRendererGL(audioCanvas, palette.slotHues, {
      feedback: CONFIG.feedback,
      noiseScale: CONFIG.blobWarp,
    });
    audioRenderer.setN(palette.slots.length);
    // Sync all visual synthesis store values — subscribeKey doesn't fire on init
    audioRenderer.setStyle(store.get("audio.visualStyle") as string);
    audioRenderer.setBlobSpeed(store.get("audio.blobSpeed") as number);
    audioRenderer.setBlobDrive(store.get("audio.blobDrive") as number);
    audioRenderer.setShiftSpeed(store.get("audio.shiftSpeed") as number);
    audioRenderer.setBlobSize(store.get("audio.blobSize") as number);
    audioRenderer.setBlobSharp(store.get("audio.blobSharp") as number);
    audioRenderer.setPulseReactivity(store.get("audio.pulseReactivity") as number);
    audioRenderer.setBriScale(store.get("audio.briScale") as number);
  }

  document.getElementById("gate")?.classList.add("hide");

  window.addEventListener("resize", () => {
    audioRenderer?.resize();
  });

  // ── Controller subscriptions ────────────────────────────────────────────────

  store.subscribeKey("synth.enabled", (v) => {
    if (v && !synth.running) {
      synth.start();
      // Wire the broadcast tap (and local analyzer) right here, off the enable
      // event, instead of waiting for the rAF pipeline tick. rAF is paused while
      // this tab is backgrounded — which it usually is when the synth gets
      // enabled from the controller/LISTEN tab — so the tick-driven tap would
      // never run and the broadcaster would sit there publishing nothing.
      maybeTapSynth();
    } else if (!v && synth.running) synth.stop();
  });

  store.subscribeKey("synth.masterGain", (v) => {
    synth.setMasterGain(v as number);
  });

  // Mix bus levels
  const _dBToLinear = (db: number) => Math.pow(10, db / 20);
  const _busLevels: [string, (g: number) => void][] = [
    ["mix.subLevel",    (g) => { if (synth.graph) synth.graph.subBus.gain.value = g; }],
    ["mix.bassLevel",   (g) => { if (synth.graph) synth.graph.bassBus.gain.value = g; }],
    ["mix.midLevel",    (g) => { if (synth.graph) synth.graph.midBus.gain.value = g; }],
    ["mix.trebleLevel", (g) => { if (synth.graph) synth.graph.trebleBus.gain.value = g; }],
    ["mix.pluckLevel",  (g) => { if (synth.graph) synth.graph.pluckBus.gain.value = g; }],
  ];
  for (const [key, apply] of _busLevels) {
    store.subscribeKey(key as any, (v) => apply(_dBToLinear(v as number)));
  }

  store.subscribeKey("view.heatOn", (v) => {
    vidAnalyzer.heatOn = v;
    heat.style.setProperty("--heat-opacity", v ? "0.55" : "0");
  });

  store.subscribeKey("view.tiltOn", (v) => {
    tiltOn = !!v;
    tiltCanvas!.style.setProperty("--tilt-opacity", v ? "1" : "0");
    if (!v && tiltCanvas) {
      const ctx = tiltCanvas.getContext("2d");
      ctx?.clearRect(0, 0, tiltCanvas.width, tiltCanvas.height);
    }
  });

  store.subscribeKey("view.mirror", (v) => {
    videoEl.classList.toggle("mirror", v);
    heat.classList.toggle("mirror", v);
    tiltCanvas?.classList.toggle("mirror", v);
  });

  store.subscribeKey("view.maskOn", (v) => {
    maskOn = !!v;
    if (!v && maskCanvas) _clearMask(maskCanvas);
  });
  store.subscribeKey("view.viewboxOn", () => {
    // viewboxOn is read live in analyze(); no extra action needed here
  });

  store.subscribeKey("harmony.palette", () => {
    const paletteStr = store.get("harmony.palette") || "CEG, FAC, GBD";
    try {
      palette = Palette.fromURLParam(paletteStr as string, {
        rootHue: store.get("harmony.rootHue") as number ?? 0,
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

  store.subscribeKey("harmony.rootHue", (v) => {
    palette?.setRootHue(v as number);
  });

  store.subscribeKey("harmony.crossZone", (v) => {
    palette?.setCrossZone(v);
  });

  store.subscribeKey("audio.visualStyle", (v) => {
    audioRenderer?.setStyle(v as string);
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
  store.subscribeKey("audio.briScale", (v) => {
    audioRenderer?.setBriScale(v);
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
    const preset = CASSETTE_PRESETS[name as string];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      store.set(k as any, v as any);
    }
  });
  store.subscribeKey("synth.fmPreset", (name) => {
    const preset = FM_PRESETS[name as string];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      store.set(k as any, v as any);
    }
  });
  store.subscribeKey("synth.glidePreset", (name) => {
    const preset = GLIDE_PRESETS[name as string];
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
      videoSource.onStreamEnded = () => {
        const gate = document.getElementById("gate");
        const errEl = document.getElementById("err");
        const goBtn = document.getElementById("go");
        gate?.classList.remove("hide");
        if (errEl) errEl.textContent = "Screen share ended.";
        if (goBtn) goBtn.textContent = "Restart Screen Share";
        gate?.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).id !== "go") return;
          gate.classList.add("hide");
          void begin();
        }, { once: true });
      };
    } catch (e: any) {
      if (store.get("source.kind") === "screen") {
        const gate = document.getElementById("gate");
        const errEl = document.getElementById("err");
        const goBtn = document.getElementById("go");
        gate?.classList.remove("hide");
        if (errEl) errEl.textContent = "";
        if (goBtn) goBtn.textContent = "Start Screen Share";
        gate?.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).id !== "go") return;
          gate.classList.add("hide");
          void begin();
        }, { once: true });
      } else {
        console.error("Source restart failed:", e.message);
      }
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
  tiltCanvas.classList.toggle("mirror", store.get("view.mirror"));
  vidAnalyzer.heatOn = store.get("view.heatOn");
  heat.style.setProperty("--heat-opacity", store.get("view.heatOn") ? "0.55" : "0");
  tiltCanvas.style.setProperty("--tilt-opacity", store.get("view.tiltOn") ? "1" : "0");
  maskOn = !!store.get("view.maskOn");
  _applyCassette();
  for (const [k, v] of Object.entries(FM_PRESETS[store.get("synth.fmPreset") as string] ?? {})) store.set(k as any, v as any);
  for (const [k, v] of Object.entries(GLIDE_PRESETS[store.get("synth.glidePreset") as string] ?? {})) store.set(k as any, v as any);

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
  // Fully wired already? (full loop = analyzer + broadcast; source = broadcast only)
  if (broadcastStreamNode && (audioAnalyzer || !_renderVisuals)) return;
  if (!synth.running || !synth._actx || !synth.analysisTap) return;
  if (!palette) return;

  // Local audio analysis (stages 3+4) runs only in full-loop mode. In source
  // mode the listener window analyzes the broadcast stream instead.
  if (_renderVisuals && !audioAnalyzer) {
    audioAnalyzer = new AudioAnalyzer({
      audioContext: synth._actx,
      palette,
    });
    // Tap pre-cassette for chroma analysis (same signal position as before)
    synth.analysisTap.connect(audioAnalyzer.input);
    // Stereo tap post-cassette for L/R balance detection
    const stereoNode = synth.outputNode;
    if (stereoNode) audioAnalyzer.connectStereo(stereoNode);

    // 8-band pre-analysis EQ (device-local calibration). Created once with the
    // analyzer; gains track the audioEq.* store keys live.
    AUDIO_EQ_KEYS.forEach((k, i) => {
      audioAnalyzer!.setEqGain(i, store.get(k) as number);
      store.subscribeKey(k, (v) => audioAnalyzer?.setEqGain(i, v as number));
    });
  }

  // Expose the synth's master output as a MediaStream for any listener tabs
  // that have started a WebRTC bridge (visualize-view). Tap from output so
  // the broadcast carries the same final-stage signal that hits the speakers.
  // Both modes broadcast — this is the only audio path out of a source window.
  if (broadcaster && !broadcastStreamNode) {
    const tapSource: AudioNode = synth.outputNode ?? synth.analysisTap!;
    const dest = synth._actx.createMediaStreamDestination();
    tapSource.connect(dest);
    broadcastStreamNode = dest;
    broadcaster.setStream(dest.stream);
  }
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
      synth: {
        running: synth.running,
        note: synth.lastNote ?? null,
        noteGrid: synth.lastNoteGrid ?? undefined,
        noteGridOctL: SYNTH_NOTE_GRID_OCT_L,
        noteGridOctH: SYNTH_NOTE_GRID_OCT_H,
      },
      synthControls: synth.lastControls ?? undefined,
      audio: audioFrame ?? undefined,
      visualUniforms: vis ?? undefined,
    });
  }

  requestAnimationFrame(tick);
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mountLoopView(opts: { renderVisuals?: boolean } = {}): void {
  _renderVisuals = opts.renderVisuals !== false;
  document.body.className = _renderVisuals ? "loop" : "loop va";
  document.body.innerHTML = _renderVisuals ? LOOP_HTML : SOURCE_HTML;

  store.set("synth.enabled", false);
  void begin();
}
