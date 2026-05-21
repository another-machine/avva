/**
 * src/views/visualize-view.ts
 *
 * Audio-only visualizer: receives a MediaStream (from a same-origin broadcaster
 * tab via WebRTC by default, or any other MediaStream source in the future
 * — mic, getDisplayMedia tab capture, phone-as-mic, etc.) and runs only the
 * audio analyzer + GL renderer.
 *
 * The store is already kept in sync across same-origin tabs by
 * `startBroadcastSync()` in main.ts, so palette / blob params / etc. update
 * automatically when changed from the broadcaster tab.
 */

import { store } from "../store/store.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { Palette } from "../harmony/palette.js";
import { TelemetrySender } from "../store/telemetry.js";
import { startListener, type ListenerBridge } from "../input/webrtc-bridge.js";

const VIS_HTML = /* html */ `
  <div id="stage">
    <div class="pane pane--vis pane--solo"><canvas id="av-canvas"></canvas></div>
  </div>
  <div id="gate">
    <h1 class="gate__title">AVVA · LISTEN</h1>
    <div class="gate__err" id="err" role="alert">Waiting for a broadcaster tab…</div>
    <button class="gate__btn" id="go">Click to listen</button>
  </div>
`;

let audioCanvas: HTMLCanvasElement;
let actx: AudioContext | null = null;
let audioAnalyzer: AudioAnalyzer | null = null;
let audioRenderer: AudioRendererGL | null = null;
let palette: Palette;
let telemetry: TelemetrySender | null = null;
let listener: ListenerBridge | null = null;
let _running = false;

function _buildPalette(): Palette {
  const paletteStr = (store.get("harmony.palette") as string) || "CEG, FAC, GBD";
  const rootHue = (store.get("harmony.rootHue") as number) ?? 0;
  try {
    return Palette.fromURLParam(paletteStr, {
      rootHue,
      crossZone: CONFIG.crossZone,
    });
  } catch {
    return Palette.fromURLParam("CEG, FAC, GBD", { rootHue, crossZone: CONFIG.crossZone });
  }
}

function _wireStream(stream: MediaStream): void {
  if (!actx || !audioAnalyzer) return;
  const src = actx.createMediaStreamSource(stream);
  src.connect(audioAnalyzer.analyser);
  // Stereo source for pos (L/R balance) analysis. The analyzer's
  // connectStereo creates its own splitter, so this is independent of the
  // mono path above.
  audioAnalyzer.connectStereo(src);
}

function _applyRendererStoreValues(r: AudioRendererGL): void {
  r.setBlobSpeed(store.get("audio.blobSpeed") as number);
  r.setBlobDrive(store.get("audio.blobDrive") as number);
  r.setShiftSpeed(store.get("audio.shiftSpeed") as number);
  r.setBlobSize(store.get("audio.blobSize") as number);
  r.setBlobSharp(store.get("audio.blobSharp") as number);
  r.setPulseReactivity(store.get("audio.pulseReactivity") as number);
  r.setBriScale(store.get("audio.briScale") as number);
  r.setFeedback(store.get("audio.feedback") as number);
  r.setBlobWarp(store.get("audio.blobWarp") as number);
}

async function _begin(): Promise<void> {
  if (_running) return;
  _running = true;

  palette = _buildPalette();

  actx = new AudioContext();
  // AudioContexts start "suspended" until a user gesture; the click on
  // the gate button qualifies, so resume immediately.
  await actx.resume();

  audioAnalyzer = new AudioAnalyzer({
    audioContext: actx,
    palette,
  });

  audioRenderer = new AudioRendererGL(audioCanvas, palette.slotHues, {
    feedback: CONFIG.feedback,
    noiseScale: CONFIG.blobWarp,
  });
  audioRenderer.setN(palette.slots.length);
  _applyRendererStoreValues(audioRenderer);

  telemetry = new TelemetrySender();

  window.addEventListener("resize", () => audioRenderer?.resize());

  // ── Store subscriptions (palette + renderer params) ──────────────────────
  store.subscribeKey("harmony.palette", () => {
    palette = _buildPalette();
    audioAnalyzer?.setPalette(palette);
    audioRenderer?.setN(palette.slots.length);
  });
  store.subscribeKey("harmony.rootHue", (v) => palette.setRootHue(v as number));
  store.subscribeKey("harmony.crossZone", (v) => palette.setCrossZone(v as number));
  store.subscribeKey("audio.feedback", (v) => audioRenderer?.setFeedback(v as number));
  store.subscribeKey("audio.blobWarp", (v) => audioRenderer?.setBlobWarp(v as number));
  store.subscribeKey("audio.blobSpeed", (v) => audioRenderer?.setBlobSpeed(v as number));
  store.subscribeKey("audio.blobDrive", (v) => audioRenderer?.setBlobDrive(v as number));
  store.subscribeKey("audio.shiftSpeed", (v) => audioRenderer?.setShiftSpeed(v as number));
  store.subscribeKey("audio.blobSize", (v) => audioRenderer?.setBlobSize(v as number));
  store.subscribeKey("audio.blobSharp", (v) => audioRenderer?.setBlobSharp(v as number));
  store.subscribeKey("audio.pulseReactivity", (v) => audioRenderer?.setPulseReactivity(v as number));
  store.subscribeKey("audio.briScale", (v) => audioRenderer?.setBriScale(v as number));

  // ── Start WebRTC listener ────────────────────────────────────────────────
  const errEl = document.getElementById("err");
  listener = startListener({
    onStream: (stream) => {
      _wireStream(stream);
      document.getElementById("gate")?.classList.add("hide");
    },
    onState: (s) => {
      if (!errEl) return;
      if (s === "searching") errEl.textContent = "Waiting for a broadcaster tab…";
      else if (s === "connecting") errEl.textContent = "Connecting…";
      else if (s === "connected") errEl.textContent = "";
      else if (s === "failed") errEl.textContent = "Connection failed. Refresh both tabs.";
    },
  });

  (window as any)._avva = { audioAnalyzer, audioRenderer, palette, store, listener };

  requestAnimationFrame(tick);
}

function tick(t: number): void {
  if (audioAnalyzer && audioRenderer) {
    const audioFrame = audioAnalyzer.tick();
    const vis = audioRenderer.render(audioFrame);
    telemetry?.send({
      t,
      fps: 60, // approximate; we're not measuring in this view
      sourceLabel: listener?.connected ? "webrtc" : "—",
      resLabel: "—",
      audio: audioFrame,
      visualUniforms: vis,
    });
  }
  requestAnimationFrame(tick);
}

export function mountVisualizeView(): void {
  document.body.className = "loop visualize";
  document.body.innerHTML = VIS_HTML;
  audioCanvas = document.getElementById("av-canvas") as HTMLCanvasElement;

  const goBtn = document.getElementById("go") as HTMLButtonElement | null;
  goBtn?.addEventListener("click", () => void _begin());
}
