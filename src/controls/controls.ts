/**
 * src/controls/controls.ts
 *
 * Keyboard bindings for the analysis view. Calibration is handled
 * entirely through the controller window.
 */

export interface ControlCallbacks {
  onHudToggle?: () => void;
  onHeatToggle?: () => void;
  onMirrorToggle?: () => void;
  onCycleSource?: () => void | Promise<void>;
  onSynthToggle?: () => void;
}

export class Controls {
  private _cb: ControlCallbacks;
  private _bound: (e: KeyboardEvent) => void;

  constructor(callbacks: ControlCallbacks) {
    this._cb = callbacks;
    this._bound = this._onKey.bind(this);
  }

  bind(): void {
    window.addEventListener("keydown", this._bound);
  }

  unbind(): void {
    window.removeEventListener("keydown", this._bound);
  }

  private _onKey(e: KeyboardEvent): void {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;

    switch (e.key.toLowerCase()) {
      case "h": this._cb.onHudToggle?.(); break;
      case "m": this._cb.onHeatToggle?.(); break;
      case "r": this._cb.onMirrorToggle?.(); break;
      case "f": this._toggleFullscreen(); break;
      case "c": this._cb.onCycleSource?.(); break;
      case "s": this._cb.onSynthToggle?.(); break;
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
