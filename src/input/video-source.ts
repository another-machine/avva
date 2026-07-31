/**
 * src/input/video-source.ts
 *
 * VideoSource abstracts the video input — camera, screen, single file, or an
 * array of files. All modes drive the same <video> element so downstream
 * processing (Analyzer) stays source-agnostic.
 *
 * Camera and screen capture are @amplib/devices now. What stays here is what
 * is actually AVVA's: files resolved through the chosen media folder, the
 * store-backed config that decides which mode is active, and driving one
 * shared <video> element so the analyzer never learns where frames came from.
 */

import { CameraStream, ScreenStream } from "@amplib/devices";
import type { LegacyConfig } from "../store/legacy-config.js";
import {
  hasFolder,
  isFolderRelative,
  restoreFolder,
  urlForFile,
} from "./media-folder.js";

export class VideoSource {
  private _el: HTMLVideoElement;
  private _config: LegacyConfig;
  private _label: string;

  private _camera: CameraStream;
  private _screen: ScreenStream;

  // File array state
  private _sources: string[];
  private _fileIdx: number;

  private _onStreamEnded: (() => void) | null = null;

  constructor(el: HTMLVideoElement, config: LegacyConfig) {
    this._el = el;
    this._config = config;
    this._label = "";

    this._camera = new CameraStream({ facingMode: config.preferCamera });
    this._screen = new ScreenStream({ displaySurface: "browser" });
    this._screen.onEnded = () => this._onStreamEnded?.();

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
  get isScreen(): boolean {
    return this._config.source === "screen";
  }
  get isFileArray(): boolean {
    return Array.isArray(this._config.source);
  }
  get canCycle(): boolean {
    return this.isCamera ? this._camera.canCycle : this._sources.length > 1;
  }

  set onStreamEnded(cb: (() => void) | null) {
    this._onStreamEnded = cb;
  }

  async start(): Promise<void> {
    if (this.isCamera) {
      // CameraStream enumerates as part of start — device labels are empty
      // until permission is granted, so there is nothing useful to ask for
      // beforehand.
      await this._attach(await this._camera.start(), this._camera.label);
    } else if (this.isScreen) {
      await this._attach(await this._screen.start(), this._screen.label, true);
    } else {
      this._fileIdx = 0;
      await this._startFile(this._sources[this._fileIdx]);
    }
  }

  async cycleSource(): Promise<void> {
    if (this.isCamera) {
      if (!this._camera.canCycle) return;
      await this._attach(await this._camera.cycle(), this._camera.label);
    } else {
      if (this._sources.length < 2) return;
      this._fileIdx = (this._fileIdx + 1) % this._sources.length;
      await this._startFile(this._sources[this._fileIdx]);
    }
  }

  stop(): void {
    this._camera.stop();
    this._screen.stop();
    this._el.srcObject = null;
    this._el.src = "";
  }

  // ── Private — attaching a device stream ─────────────────────

  /**
   * Point the shared <video> element at a stream from @amplib/devices.
   *
   * The element is the reason this wrapper still exists: the analyzer reads
   * frames from one <video> regardless of whether they came from a camera, a
   * capture, or a file, and only this class knows which.
   */
  private async _attach(
    stream: MediaStream | null,
    label: string,
    muted = false,
  ): Promise<void> {
    if (!stream) return;
    this._el.srcObject = stream;
    this._el.src = "";
    if (muted) this._el.muted = true;
    await this._el.play();
    this._label = label.toUpperCase();
  }

  // ── Private — file ───────────────────────────────────────────

  private async _startFile(src: string): Promise<void> {
    // A bare filename is looked up in the folder the user chose; anything with
    // a slash or a scheme is a real path and is served as-is, so preset links
    // written before the folder picker still work.
    let url = src;
    if (isFolderRelative(src)) {
      if (!hasFolder()) {
        const restored = await restoreFolder();
        if (!restored) {
          throw new Error(
            `No media folder selected. Choose one in the controller, ` +
              `then "${src}" will resolve.`,
          );
        }
      }
      url = await urlForFile(src);
    }

    this._el.srcObject = null;
    this._el.src = url;
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
