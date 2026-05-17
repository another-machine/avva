/**
 * src/input/video-source.ts
 *
 * VideoSource abstracts the video input — camera, single file, or an
 * array of files. All modes drive the same <video> element so downstream
 * processing (Analyzer) stays source-agnostic.
 */

import type { LegacyConfig } from "../store/legacy-config.js";

export class VideoSource {
  private _el: HTMLVideoElement;
  private _config: LegacyConfig;
  private _label: string;

  // Camera state
  private _stream: MediaStream | null;
  private _devices: MediaDeviceInfo[];
  private _devIdx: number;

  // File array state
  private _sources: string[];
  private _fileIdx: number;

  constructor(el: HTMLVideoElement, config: LegacyConfig) {
    this._el = el;
    this._config = config;
    this._label = "";

    this._stream = null;
    this._devices = [];
    this._devIdx = 0;

    const src = config.source;
    this._sources = Array.isArray(src) ? (src as string[]) : [src as string];
    this._fileIdx = 0;
  }

  // ── Public API ──────────────────────────────────────────────

  get element(): HTMLVideoElement {
    return this._el;
  }
  get label(): string {
    return this._label;
  }
  get isCamera(): boolean {
    return this._config.source === "camera";
  }
  get isFileArray(): boolean {
    return Array.isArray(this._config.source);
  }
  get canCycle(): boolean {
    return this.isCamera ? this._devices.length > 1 : this._sources.length > 1;
  }

  async start(): Promise<void> {
    if (this.isCamera) {
      await this._startCamera(null);
      await this._enumerateDevices();
    } else {
      this._fileIdx = 0;
      await this._startFile(this._sources[this._fileIdx]);
    }
  }

  async cycleSource(): Promise<void> {
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

  stop(): void {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    this._el.srcObject = null;
    this._el.src = "";
  }

  // ── Private — camera ────────────────────────────────────────

  private async _startCamera(deviceId: string | null): Promise<void> {
    if (this._stream) this._stream.getTracks().forEach((t) => t.stop());

    const constraints: MediaStreamConstraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : {
          video: {
            facingMode: this._config.preferCamera,
            width: { ideal: 1280 },
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

  private async _enumerateDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this._devices = all.filter((d) => d.kind === "videoinput");
    } catch {
      this._devices = [];
    }
  }

  // ── Private — file ───────────────────────────────────────────

  private async _startFile(src: string): Promise<void> {
    this._el.srcObject = null;
    this._el.src = src;
    this._el.loop = true;
    this._el.muted = true;
    this._el.playsInline = true;

    try {
      await this._el.play();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Could not play "${src}": ${msg}. ` +
          `Serve over http:// and check the path.`,
      );
    }

    this._label = src.split("/").pop()!.split("?")[0].toUpperCase();
  }
}
