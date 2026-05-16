/**
 * modules/calibration.js
 *
 * Video feed color/lighting calibration.
 *
 * Calibration holds four adjustable parameters and derives the
 * CSS/canvas filter string used by both the video display element
 * and the Analyzer's sample canvas — keeping what you see and
 * what gets analyzed perfectly in sync.
 *
 * CalibrationPanel manages the HUD overlay for runtime tuning.
 *
 * URL params (seeded on load, persisted via urlDiff):
 *   ?brightness=1.20&contrast=1.10&saturation=1.30&hueRotate=15
 */

// ── Data ─────────────────────────────────────────────────────

const DEFAULTS = {
  brightness:  1.0,  // overall exposure         0.1 – 3.0
  contrast:    1.0,  // contrast ratio            0.1 – 3.0
  saturation:  1.0,  // color intensity           0.0 – 4.0
  hueRotate:   0,    // color-cast correction °  -180 – 180
};

const STEPS = {
  brightness:  0.05,
  contrast:    0.05,
  saturation:  0.05,
  hueRotate:   5,
};

const RANGES = {
  brightness:  [0.1, 3.0],
  contrast:    [0.1, 3.0],
  saturation:  [0.0, 4.0],
  hueRotate:   [-180, 180],
};

export class Calibration {
  constructor() {
    const p = new URLSearchParams(location.search);

    this.brightness = p.has("brightness") ? Number(p.get("brightness")) : DEFAULTS.brightness;
    this.contrast   = p.has("contrast")   ? Number(p.get("contrast"))   : DEFAULTS.contrast;
    this.saturation = p.has("saturation") ? Number(p.get("saturation")) : DEFAULTS.saturation;
    this.hueRotate  = p.has("hueRotate")  ? Number(p.get("hueRotate"))  : DEFAULTS.hueRotate;
  }

  /**
   * CSS filter string for both `videoEl.style.filter` and
   * canvas 2d `ctx.filter`. The two always stay identical.
   */
  get filterString() {
    return [
      `brightness(${this.brightness.toFixed(2)})`,
      `contrast(${this.contrast.toFixed(2)})`,
      `saturate(${this.saturation.toFixed(2)})`,
      `hue-rotate(${this.hueRotate.toFixed(0)}deg)`,
    ].join(" ");
  }

  /**
   * URL search string showing only non-default values.
   * Copy-paste into the URL bar to save a calibration preset.
   */
  get urlDiff() {
    // Start from the current URL params so non-calibration params are preserved
    const p = new URLSearchParams(location.search);

    for (const [key, def] of Object.entries(DEFAULTS)) {
      const v = this[key];
      if (Math.abs(v - def) > 0.001) {
        p.set(key, key === "hueRotate" ? v.toFixed(0) : v.toFixed(2));
      } else {
        p.delete(key);
      }
    }

    const str = p.toString();
    return str ? `?${str}` : "(all defaults)";
  }

  /** Adjust a parameter by one step in direction (+1 up, -1 down). */
  nudge(key, dir) {
    const [min, max] = RANGES[key];
    let v = this[key] + dir * STEPS[key];
    v = key === "hueRotate"
      ? Math.round(v / 5) * 5          // snap to 5° increments
      : Math.round(v * 100) / 100;     // snap to 0.01
    this[key] = Math.max(min, Math.min(max, v));
  }

  /** Reset one parameter to its default value. */
  reset(key) {
    this[key] = DEFAULTS[key];
  }

  /** True if all values are at defaults. */
  get isDefault() {
    return Object.entries(DEFAULTS).every(([k, d]) => Math.abs(this[k] - d) < 0.001);
  }
}

// ── Panel ─────────────────────────────────────────────────────

const PARAMS = ["brightness", "contrast", "saturation", "hueRotate"];

const LABELS = {
  brightness: "BRIGHTNESS",
  contrast:   "CONTRAST",
  saturation: "SATURATION",
  hueRotate:  "HUE ROTATE",
};

const UNITS = {
  brightness: "",
  contrast:   "",
  saturation: "",
  hueRotate:  "°",
};

export class CalibrationPanel {
  /**
   * @param {Calibration} calibration
   * @param {{ onChange?: (cal: Calibration) => void }} opts
   */
  constructor(calibration, opts = {}) {
    this._cal      = calibration;
    this._onChange = opts.onChange ?? (() => {});
    this._visible  = false;
    this._sel      = 0;

    this._el     = document.getElementById("calibrate");
    this._urlEl  = document.getElementById("cal-url");
    this._rows   = PARAMS.map(k => document.getElementById(`cal-row-${k}`));
    this._valEls = PARAMS.map(k => document.getElementById(`cal-val-${k}`));
  }

  get visible() { return this._visible; }

  toggle() {
    this._visible = !this._visible;
    this._el.classList.toggle("visible", this._visible);
    if (this._visible) this._render();
  }

  show() { if (!this._visible) this.toggle(); }
  hide() { if (this._visible)  this.toggle(); }

  /**
   * Handle a keyboard event while panel is visible.
   * @returns {boolean} true if the event was consumed
   */
  handleKey(e) {
    if (!this._visible) return false;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        this._cal.nudge(PARAMS[this._sel], +1);
        this._emit();
        return true;

      case "ArrowDown":
        e.preventDefault();
        this._cal.nudge(PARAMS[this._sel], -1);
        this._emit();
        return true;

      case "Tab":
        e.preventDefault();
        this._sel = (this._sel + (e.shiftKey ? -1 : 1) + PARAMS.length) % PARAMS.length;
        this._render();
        return true;

      case "0":
        this._cal.reset(PARAMS[this._sel]);
        this._emit();
        return true;
    }

    return false;
  }

  // ── Private ────────────────────────────────────────────────

  _emit() {
    this._onChange(this._cal);
    this._render();
  }

  _render() {
    for (let i = 0; i < PARAMS.length; i++) {
      const key = PARAMS[i];
      const v   = this._cal[key];
      this._valEls[i].textContent =
        key === "hueRotate" ? `${v.toFixed(0)}${UNITS[key]}` : `${v.toFixed(2)}`;
      this._rows[i].classList.toggle("is-active", i === this._sel);
    }
    this._urlEl.textContent = this._cal.urlDiff;
  }
}
