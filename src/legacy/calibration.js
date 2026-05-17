/**
 * src/legacy/calibration.js
 *
 * Video calibration backed by the observable store.
 * Reads `calibration.*` slices live; writes back via `store.set` so the
 * controller window (and future panels) stay in sync.
 */

import { store } from "../store/store";

const KEYS = ["brightness", "contrast", "saturation", "hueRotate"];
const STORE_KEY = {
  brightness: "calibration.brightness",
  contrast:   "calibration.contrast",
  saturation: "calibration.saturation",
  hueRotate:  "calibration.hueRotate",
};
const DEFAULTS = { brightness: 1.0, contrast: 1.0, saturation: 1.0, hueRotate: 0 };
const STEPS    = { brightness: 0.05, contrast: 0.05, saturation: 0.05, hueRotate: 5 };
const RANGES   = {
  brightness: [0.1, 3.0],
  contrast:   [0.1, 3.0],
  saturation: [0.0, 4.0],
  hueRotate:  [-180, 180],
};

export class Calibration {
  constructor() {
    // Live getters mirror store slices; assignments forward to store.
    for (const k of KEYS) {
      Object.defineProperty(this, k, {
        enumerable: true,
        get() { return store.get(STORE_KEY[k]); },
        set(v) { store.set(STORE_KEY[k], v); },
      });
    }
  }

  get filterString() {
    return [
      `brightness(${this.brightness.toFixed(2)})`,
      `contrast(${this.contrast.toFixed(2)})`,
      `saturate(${this.saturation.toFixed(2)})`,
      `hue-rotate(${this.hueRotate.toFixed(0)}deg)`,
    ].join(" ");
  }

  get urlDiff() {
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

  nudge(key, dir) {
    const [min, max] = RANGES[key];
    let v = this[key] + dir * STEPS[key];
    if (key === "hueRotate") {
      v = Math.round(v / 5) * 5;
      if (v > 180) v -= 360;
      else if (v < -180) v += 360;
      this[key] = v;
    } else {
      v = Math.round(v * 100) / 100;
      this[key] = Math.max(min, Math.min(max, v));
    }
  }

  reset(key) { this[key] = DEFAULTS[key]; }

  get isDefault() {
    return KEYS.every((k) => Math.abs(this[k] - DEFAULTS[k]) < 0.001);
  }

  /** Subscribe to any calibration change (for external syncs). */
  onChange(cb) {
    const unsubs = KEYS.map((k) =>
      store.subscribeKey(STORE_KEY[k], () => cb(this))
    );
    return () => unsubs.forEach((u) => u());
  }
}

// ── Panel ──────────────────────────────────────────────────────

const PARAMS = ["brightness", "contrast", "saturation", "hueRotate"];
const UNITS = { brightness: "", contrast: "", saturation: "", hueRotate: "°" };

export class CalibrationPanel {
  constructor(calibration, opts = {}) {
    this._cal = calibration;
    this._onChange = opts.onChange ?? (() => {});
    this._visible = false;
    this._sel = 0;

    this._el = document.getElementById("calibrate");
    this._urlEl = document.getElementById("cal-url");
    this._rows = PARAMS.map((k) => document.getElementById(`cal-row-${k}`));
    this._valEls = PARAMS.map((k) => document.getElementById(`cal-val-${k}`));

    // Re-render when external changes (controller window, etc.) come in.
    this._unsub = calibration.onChange(() => {
      if (this._visible) this._render();
    });
  }

  get visible() { return this._visible; }

  toggle() {
    this._visible = !this._visible;
    this._el?.classList.toggle("visible", this._visible);
    if (this._visible) this._render();
  }

  show() { if (!this._visible) this.toggle(); }
  hide() { if (this._visible) this.toggle(); }

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
        this._sel =
          (this._sel + (e.shiftKey ? -1 : 1) + PARAMS.length) % PARAMS.length;
        this._render();
        return true;
      case "0":
        this._cal.reset(PARAMS[this._sel]);
        this._emit();
        return true;
    }
    return false;
  }

  _emit() { this._onChange(this._cal); this._render(); }

  _render() {
    if (!this._el) return;
    for (let i = 0; i < PARAMS.length; i++) {
      const key = PARAMS[i];
      const v = this._cal[key];
      if (this._valEls[i]) {
        this._valEls[i].textContent =
          key === "hueRotate" ? `${v.toFixed(0)}${UNITS[key]}` : `${v.toFixed(2)}`;
      }
      if (this._rows[i]) this._rows[i].classList.toggle("is-active", i === this._sel);
    }
    if (this._urlEl) this._urlEl.textContent = this._cal.urlDiff;
  }
}
