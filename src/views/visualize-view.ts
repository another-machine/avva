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
import { AUDIO_EQ_KEYS } from "../store/schema.js";
import { legacyConfig as CONFIG } from "../store/legacy-config.js";
import { AudioAnalyzer } from "../analysis/audio-analyzer.js";
import { AudioRendererGL } from "../render/audio-renderer-gl.js";
import { createChordPalette, type ChordPalette } from "../harmony/chord-palette.js";
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
let palette: ChordPalette;
let telemetry: TelemetrySender | null = null;
let listener: ListenerBridge | null = null;
let _srcNode: MediaStreamAudioSourceNode | null = null;
let _micStream: MediaStream | null = null;
let _streamSink: HTMLAudioElement | null = null;
let _running = false;

function _buildPalette(): ChordPalette {
  const paletteStr = (store.get("harmony.palette") as string) || "CEG, FAC, GBD";
  const rootHue = (store.get("harmony.rootHue") as number) ?? 0;
  try {
    return createChordPalette(paletteStr, {
      rootHue,
      crossZone: CONFIG.crossZone,
    });
  } catch {
    return createChordPalette("CEG, FAC, GBD", { rootHue, crossZone: CONFIG.crossZone });
  }
}

function _wireStream(stream: MediaStream): void {
  if (!actx || !audioAnalyzer) return;
  // Chrome quirk: a REMOTE WebRTC MediaStream delivers no samples into a Web
  // Audio graph (the analyser reads silence) unless the stream is also attached
  // to an HTMLMediaElement. A muted <audio> sink "pulls" the stream so the
  // analyser actually receives data. (Local mic streams don't need this, which
  // is why mic visualized but broadcast didn't.)
  const sink = new Audio();
  sink.srcObject = stream;
  sink.muted = true; // audio is already audible from the source tab; don't double it
  void sink.play().catch(() => {});
  _streamSink = sink;

  const src = actx.createMediaStreamSource(stream);
  src.connect(audioAnalyzer.input);
  // Stereo source for pos (L/R balance) analysis. The analyzer's
  // connectStereo creates its own splitter, so this is independent of the
  // mono path above.
  audioAnalyzer.connectStereo(src);
  _srcNode = src;
}

// Tear down whatever source is currently feeding the analyzer (WebRTC listener,
// mic, or both) so a new source can be wired cleanly. Disconnecting _srcNode
// drops it from both the analyser and the stereo splitter in one call.
function _teardownSource(): void {
  if (listener) {
    listener.close();
    listener = null;
  }
  if (_srcNode) {
    try { _srcNode.disconnect(); } catch { /* already gone */ }
    _srcNode = null;
  }
  if (_streamSink) {
    try { _streamSink.pause(); } catch { /* */ }
    _streamSink.srcObject = null;
    _streamSink = null;
  }
  if (_micStream) {
    for (const t of _micStream.getTracks()) t.stop();
    _micStream = null;
  }
}

// Acquire and wire the audio source selected by `listen.source` (broadcast | mic),
// tearing down any previous source first. Safe to call repeatedly (live switch).
async function _activateSource(): Promise<void> {
  if (!actx || !audioAnalyzer) return;
  _teardownSource();

  const gate = document.getElementById("gate");
  const err = document.getElementById("err");
  const kind = (store.get("listen.source") as string) || "broadcast";

  if (kind === "mic") {
    if (err) err.textContent = "Requesting microphone…";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Disable processing so the analyzer sees the raw signal.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      // A live switch could have changed the source again mid-await.
      if ((store.get("listen.source") as string) !== "mic") {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      _micStream = stream;
      _wireStream(stream);
      if (err) err.textContent = "";
      gate?.classList.add("hide");
    } catch (e) {
      const msg = e instanceof Error ? e.message || e.name : String(e);
      if (err) err.textContent = "Mic error: " + msg;
      gate?.classList.remove("hide");
    }
    return;
  }

  // broadcast: receive the synth master output over the WebRTC bridge.
  listener = startListener({
    onStream: (stream) => {
      _wireStream(stream);
      gate?.classList.add("hide");
    },
    onState: (s) => {
      if (!err) return;
      if (s === "searching") err.textContent = "Waiting for a broadcaster tab…";
      else if (s === "idle") err.textContent = "Broadcaster found — turn the synth ON in the source tab.";
      else if (s === "connecting") err.textContent = "Connecting…";
      else if (s === "connected") err.textContent = "";
      else if (s === "failed") err.textContent = "Connection failed. Refresh both tabs.";
    },
  });
}

function _applyRendererStoreValues(r: AudioRendererGL): void {
  r.setStyle(store.get("audio.visualStyle") as string);
  r.setBlobSpeed(store.get("audio.blobSpeed") as number);
  r.setBlobDrive(store.get("audio.blobDrive") as number);
  r.setShiftSpeed(store.get("audio.shiftSpeed") as number);
  r.setBlobSize(store.get("audio.blobSize") as number);
  r.setBlobSharp(store.get("audio.blobSharp") as number);
  r.setPulseReactivity(store.get("audio.pulseReactivity") as number);
  r.setBriScale(store.get("audio.briScale") as number);
  r.setFeedback(store.get("audio.feedback") as number);
  r.setBlobWarp(store.get("audio.blobWarp") as number);
  r.setExtremes(_extremesFromStore());
}

function _extremesFromStore() {
  return {
    enabled: store.get("extremes.enabled") as boolean,
    darkStart: store.get("extremes.darkStart") as number,
    whiteStart: store.get("extremes.whiteStart") as number,
    whiteWash: store.get("extremes.whiteWash") as number,
    speed: store.get("extremes.speed") as number,
  };
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
  store.subscribeKey("audio.visualStyle", (v) => audioRenderer?.setStyle(v as string));
  store.subscribeKey("audio.feedback", (v) => audioRenderer?.setFeedback(v as number));
  store.subscribeKey("audio.blobWarp", (v) => audioRenderer?.setBlobWarp(v as number));
  store.subscribeKey("audio.blobSpeed", (v) => audioRenderer?.setBlobSpeed(v as number));
  store.subscribeKey("audio.blobDrive", (v) => audioRenderer?.setBlobDrive(v as number));
  store.subscribeKey("audio.shiftSpeed", (v) => audioRenderer?.setShiftSpeed(v as number));
  store.subscribeKey("audio.blobSize", (v) => audioRenderer?.setBlobSize(v as number));
  store.subscribeKey("audio.blobSharp", (v) => audioRenderer?.setBlobSharp(v as number));
  store.subscribeKey("audio.pulseReactivity", (v) => audioRenderer?.setPulseReactivity(v as number));
  store.subscribeKey("audio.briScale", (v) => audioRenderer?.setBriScale(v as number));
  for (const k of ["extremes.enabled", "extremes.darkStart", "extremes.whiteStart", "extremes.whiteWash", "extremes.speed"] as const) {
    store.subscribeKey(k, () => audioRenderer?.setExtremes(_extremesFromStore()));
  }

  // ── 8-band pre-analysis EQ (device-local calibration) ────────────────────
  AUDIO_EQ_KEYS.forEach((k, i) => {
    audioAnalyzer!.setEqGain(i, store.get(k) as number);
    store.subscribeKey(k, (v) => audioAnalyzer?.setEqGain(i, v as number));
  });

  // Audio-side auto-range (forgiving constraints), tracking the store live.
  const _applyAudioAutoRange = () =>
    audioAnalyzer?.setAutoRange(
      store.get("audioAnalysis.autoRange") as number,
      store.get("analysis.autoRangeWindow") as number,
    );
  _applyAudioAutoRange();
  store.subscribeKey("audioAnalysis.autoRange", _applyAudioAutoRange);
  store.subscribeKey("analysis.autoRangeWindow", _applyAudioAutoRange);

  // ── Acquire the selected audio source (broadcast | mic) ──────────────────
  await _activateSource();
  // Live-switch when the controller (or another tab) changes listen.source.
  store.subscribeKey("listen.source", () => {
    void _activateSource();
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
      sourceLabel: _micStream ? "mic" : listener?.connected ? "webrtc" : "—",
      resLabel: "—",
      audio: audioFrame,
      visualUniforms: vis,
    });
  }
  requestAnimationFrame(tick);
}

function _syncGateLabel(): void {
  const btn = document.getElementById("go");
  if (!btn) return;
  btn.textContent =
    (store.get("listen.source") as string) === "mic"
      ? "Click to use mic"
      : "Click to listen";
}

export function mountVisualizeView(): void {
  document.body.className = "loop av";
  document.body.innerHTML = VIS_HTML;
  audioCanvas = document.getElementById("av-canvas") as HTMLCanvasElement;

  _syncGateLabel();
  store.subscribeKey("listen.source", _syncGateLabel);

  const goBtn = document.getElementById("go") as HTMLButtonElement | null;
  goBtn?.addEventListener("click", () => {
    // Before first start → boot everything. After that (e.g. retry after a mic
    // permission error) → just re-acquire the source under a fresh gesture.
    if (_running) void _activateSource();
    else void _begin();
  });
}
