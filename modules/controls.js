/**
 * modules/controls.js
 *
 * Keyboard bindings. Routes events to CalibrationPanel first when
 * it's visible (so arrow keys tune calibration, not the app).
 * Fires callbacks for all other actions; owns no application state.
 *
 * Bound keys:
 *   V — toggle video calibration panel
 *   H — toggle HUD visibility
 *   M — toggle motion heat-map
 *   R — toggle mirror
 *   F — toggle fullscreen
 *   C — cycle source (cameras if camera mode; files if source is an array)
 *   S — toggle synth audio on/off
 *
 * While calibration panel is visible:
 *   ↑ / ↓   — adjust selected parameter
 *   Tab     — next parameter (Shift+Tab previous)
 *   0       — reset selected parameter to default
 *   (V or Esc close the panel)
 */
export class Controls {
  /**
   * @param {Object} callbacks
   * @param {() => void}           callbacks.onHudToggle
   * @param {() => void}           callbacks.onHeatToggle
   * @param {() => void}           callbacks.onMirrorToggle
   * @param {() => Promise<void>}  callbacks.onCycleSource
   * @param {() => void}           [callbacks.onSynthToggle]
   * @param {import('./calibration.js').CalibrationPanel} [callbacks.calibrationPanel]
   */
  constructor(callbacks) {
    this._cb = callbacks;
    this._cal = callbacks.calibrationPanel ?? null;
    this._bound = this._onKey.bind(this);
  }

  bind() {
    window.addEventListener("keydown", this._bound);
  }

  unbind() {
    window.removeEventListener("keydown", this._bound);
  }

  // ── Private ──────────────────────────────────────────────────

  _onKey(e) {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;

    // Calibration panel gets first crack at key events when visible.
    // Arrow keys and Tab are consumed there; V/Esc fall through.
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

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }
}
