/**
 * src/controls/controls.ts
 *
 * Keyboard bindings. Routes events to CalibrationPanel first when
 * it's visible, fires callbacks for all other actions; owns no state.
 */

import type { CalibrationPanel } from "./calibration.js";

export interface ControlCallbacks {
  onHudToggle?: () => void;
  onHeatToggle?: () => void;
  onMirrorToggle?: () => void;
  onCycleSource?: () => void | Promise<void>;
  onSynthToggle?: () => void;
  calibrationPanel?: CalibrationPanel | null;
}

export class Controls {
  private _cb: ControlCallbacks;
  private _cal: CalibrationPanel | null;
  private _bound: (e: KeyboardEvent) => void;

  constructor(callbacks: ControlCallbacks) {
    this._cb = callbacks;
    this._cal = callbacks.calibrationPanel ?? null;
    this._bound = this._onKey.bind(this);
  }

  bind(): void {
    window.addEventListener("keydown", this._bound);
  }

  unbind(): void {
    window.removeEventListener("keydown", this._bound);
  }

  // ── Private ──────────────────────────────────────────────────

  private _onKey(e: KeyboardEvent): void {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;

    if (this._cal?.handleKey(e)) return;

    switch (e.key.toLowerCase()) {
      case "v":
        this._cal?.toggle();
        break;
      case "escape":
        this._cal?.hide();
        break;
      case "h":
        this._cb.onHudToggle?.();
        break;
      case "m":
        this._cb.onHeatToggle?.();
        break;
      case "r":
        this._cb.onMirrorToggle?.();
        break;
      case "f":
        this._toggleFullscreen();
        break;
      case "c":
        this._cb.onCycleSource?.();
        break;
      case "s":
        this._cb.onSynthToggle?.();
        break;
    }
  }

  private _toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }
}
