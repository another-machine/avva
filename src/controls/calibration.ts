/**
 * src/controls/calibration.ts
 *
 * Video calibration backed by the observable store.
 * Reads `calibration.*` slices live; writes back via store.set so the
 * controller window stays in sync.
 */

import { store } from "../store/store.js";
import type { SchemaKey } from "../store/schema.js";

type CalKey = "brightness" | "contrast" | "saturation" | "hueRotate";

const KEYS: CalKey[] = ["brightness", "contrast", "saturation", "hueRotate"];

const STORE_KEY: Record<CalKey, SchemaKey> = {
  brightness: "calibration.brightness",
  contrast: "calibration.contrast",
  saturation: "calibration.saturation",
  hueRotate: "calibration.hueRotate",
};

const DEFAULTS: Record<CalKey, number> = {
  brightness: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  hueRotate: 0,
};

const STEPS: Record<CalKey, number> = {
  brightness: 0.05,
  contrast: 0.05,
  saturation: 0.05,
  hueRotate: 5,
};

const RANGES: Record<CalKey, [number, number]> = {
  brightness: [0.1, 3.0],
  contrast: [0.1, 3.0],
  saturation: [0.0, 4.0],
  hueRotate: [-180, 180],
};

export class Calibration {
  // These are implemented via Object.defineProperty in the constructor;
  // the ! tells TypeScript they will definitely be defined before use.
  brightness!: number;
  contrast!: number;
  saturation!: number;
  hueRotate!: number;

  constructor() {
    for (const k of KEYS) {
      Object.defineProperty(this, k, {
        enumerable: true,
        get: () => store.get(STORE_KEY[k]) as number,
        set: (v: number) => {
          store.set(STORE_KEY[k], v as never);
        },
      });
    }
  }

  get filterString(): string {
    return [
      `brightness(${this.brightness.toFixed(2)})`,
      `contrast(${this.contrast.toFixed(2)})`,
      `saturate(${this.saturation.toFixed(2)})`,
      `hue-rotate(${this.hueRotate.toFixed(0)}deg)`,
    ].join(" ");
  }

  get urlDiff(): string {
    const p = new URLSearchParams(location.search);
    for (const key of KEYS) {
      const v = (this as Record<CalKey, number>)[key];
      const def = DEFAULTS[key];
      if (Math.abs(v - def) > 0.001) {
        p.set(key, key === "hueRotate" ? v.toFixed(0) : v.toFixed(2));
      } else {
        p.delete(key);
      }
    }
    const str = p.toString();
    return str ? `?${str}` : "(all defaults)";
  }

  nudge(key: CalKey, dir: 1 | -1): void {
    const self = this as Record<CalKey, number>;
    const [min, max] = RANGES[key];
    let v = self[key] + dir * STEPS[key];
    if (key === "hueRotate") {
      v = Math.round(v / 5) * 5;
      if (v > 180) v -= 360;
      else if (v < -180) v += 360;
      self[key] = v;
    } else {
      v = Math.round(v * 100) / 100;
      self[key] = Math.max(min, Math.min(max, v));
    }
  }

  reset(key: CalKey): void {
    (this as Record<CalKey, number>)[key] = DEFAULTS[key];
  }

  get isDefault(): boolean {
    const self = this as Record<CalKey, number>;
    return KEYS.every((k) => Math.abs(self[k] - DEFAULTS[k]) < 0.001);
  }

  onChange(cb: (cal: Calibration) => void): () => void {
    const unsubs = KEYS.map((k) =>
      store.subscribeKey(STORE_KEY[k], () => cb(this)),
    );
    return () => unsubs.forEach((u) => u());
  }
}

// ── Panel ──────────────────────────────────────────────────────

const PARAMS: CalKey[] = ["brightness", "contrast", "saturation", "hueRotate"];
const UNITS: Record<CalKey, string> = {
  brightness: "",
  contrast: "",
  saturation: "",
  hueRotate: "°",
};

export interface CalibrationPanelOptions {
  onChange?: (cal: Calibration) => void;
}

export class CalibrationPanel {
  private _cal: Calibration;
  private _onChange: (cal: Calibration) => void;
  private _visible: boolean;
  private _sel: number;
  private _unsub: () => void;

  private _el: HTMLElement | null;
  private _urlEl: HTMLElement | null;
  private _rows: (HTMLElement | null)[];
  private _valEls: (HTMLElement | null)[];

  constructor(calibration: Calibration, opts: CalibrationPanelOptions = {}) {
    this._cal = calibration;
    this._onChange = opts.onChange ?? (() => {});
    this._visible = false;
    this._sel = 0;

    this._el = document.getElementById("calibrate");
    this._urlEl = document.getElementById("cal-url");
    this._rows = PARAMS.map((k) => document.getElementById(`cal-row-${k}`));
    this._valEls = PARAMS.map((k) => document.getElementById(`cal-val-${k}`));

    this._unsub = calibration.onChange(() => {
      if (this._visible) this._render();
    });
  }

  get visible(): boolean {
    return this._visible;
  }

  toggle(): void {
    this._visible = !this._visible;
    this._el?.classList.toggle("visible", this._visible);
    if (this._visible) this._render();
  }

  show(): void {
    if (!this._visible) this.toggle();
  }
  hide(): void {
    if (this._visible) this.toggle();
  }

  handleKey(e: KeyboardEvent): boolean {
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

  private _emit(): void {
    this._onChange(this._cal);
    this._render();
  }

  private _render(): void {
    if (!this._el) return;
    const self = this._cal as Record<CalKey, number>;
    for (let i = 0; i < PARAMS.length; i++) {
      const key = PARAMS[i];
      const v = self[key];
      const valEl = this._valEls[i];
      if (valEl) {
        valEl.textContent =
          key === "hueRotate"
            ? `${v.toFixed(0)}${UNITS[key]}`
            : `${v.toFixed(2)}`;
      }
      const row = this._rows[i];
      if (row) row.classList.toggle("is-active", i === this._sel);
    }
    if (this._urlEl) this._urlEl.textContent = this._cal.urlDiff;
  }
}
