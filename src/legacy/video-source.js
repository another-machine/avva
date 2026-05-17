/**
 * modules/video-source.js
 *
 * VideoSource abstracts the video input — camera, single file, or an
 * array of files. All modes drive the same <video> element so downstream
 * processing (Analyzer) stays source-agnostic.
 *
 * source = "camera"              → getUserMedia, device cycling with C key
 * source = "assets/clip.mp4"    → single looping file, no cycling
 * source = ["a.mp4", "b.mp4"]   → file array, C key cycles through them
 */
export class VideoSource {
  /**
   * @param {HTMLVideoElement} el
   * @param {import('./config.js').CONFIG} config
   */
  constructor(el, config) {
    this._el      = el;
    this._config  = config;
    this._label   = "";

    // Camera state
    this._stream  = null;
    this._devices = [];
    this._devIdx  = 0;

    // File array state — normalise source into an array regardless of type
    this._sources  = Array.isArray(config.source) ? config.source : [config.source];
    this._fileIdx  = 0;
  }

  // ── Public API ──────────────────────────────────────────────

  get element()     { return this._el; }
  get label()       { return this._label; }
  get isCamera()    { return this._config.source === "camera"; }
  get isFileArray() { return Array.isArray(this._config.source); }
  /** True if there is more than one source to cycle through. */
  get canCycle()    { return this.isCamera ? this._devices.length > 1 : this._sources.length > 1; }

  /**
   * Start the video source.
   * Camera: requests getUserMedia, enumerates devices.
   * File / file array: starts first (or only) file, loops silently.
   */
  async start() {
    if (this.isCamera) {
      await this._startCamera(null);
      await this._enumerateDevices();
    } else {
      this._fileIdx = 0;
      await this._startFile(this._sources[this._fileIdx]);
    }
  }

  /**
   * Cycle to the next source.
   * Camera mode: advance through detected camera devices.
   * File array:  advance through the source array, wrapping around.
   * Single file: no-op.
   */
  async cycleSource() {
    if (this.isCamera) {
      if (this._devices.length < 2) return;
      this._devIdx = (this._devIdx + 1) % this._devices.length;
      await this._startCamera(this._devices[this._devIdx].deviceId);
    } else {
      if (this._sources.length < 2) return;
      this._fileIdx = (this._fileIdx + 1) % this._sources.length;
      await this._startFile(this._sources[this._fileIdx]);
    }
  }

  /** Stop all tracks and clear the video element. */
  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    this._el.srcObject = null;
    this._el.src = "";
  }

  // ── Private — camera ────────────────────────────────────────

  async _startCamera(deviceId) {
    if (this._stream) this._stream.getTracks().forEach((t) => t.stop());

    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : {
          video: {
            facingMode: this._config.preferCamera,
            width:  { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        };

    this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._el.srcObject = this._stream;
    await this._el.play();

    const track = this._stream.getVideoTracks()[0];
    this._label = (track?.label || "camera").slice(0, 28).toUpperCase();
  }

  async _enumerateDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this._devices = all.filter((d) => d.kind === "videoinput");
    } catch {
      this._devices = [];
    }
  }

  // ── Private — file ───────────────────────────────────────────

  async _startFile(src) {
    this._el.srcObject = null;
    this._el.src       = src;
    this._el.loop      = true;
    this._el.muted     = true;
    this._el.playsInline = true;

    try {
      await this._el.play();
    } catch (e) {
      throw new Error(
        `Could not play "${src}": ${e.message}. ` +
        `Serve over http:// and check the path.`
      );
    }

    this._label = src.split("/").pop().split("?")[0].toUpperCase();
  }
}
