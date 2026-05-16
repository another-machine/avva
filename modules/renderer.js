/**
 * modules/renderer.js
 *
 * Renderer owns all DOM mutations: CSS custom property updates,
 * canvas drawing, histogram bars, and sparklines.
 *
 * Accent color uses oklch for perceptually uniform lightness.
 * JS sets --accent-l (number 0–1), --accent-c (number 0–0.4),
 * --accent-h (number 0–360) on :root; CSS derives --color-accent.
 *
 * CSS @property contract (all on :root unless noted):
 *   --accent-l  <number>     oklch lightness 0–1
 *   --accent-c  <number>     oklch chroma 0–0.4
 *   --accent-h  <number>     oklch/approx hue 0–360
 *   --hue-marker-pos <percentage>  (on .huebar__marker)
 *   --heat-opacity   <number>      (on #heat)
 */

import { hueName } from "./color.js";

export class Renderer {
  /**
   * @param {import('./config.js').CONFIG} config
   */
  constructor(config) {
    this._cfg  = config;
    this._root = document.documentElement;

    // Text readouts
    this._hueV    = document.getElementById("hue-v");
    this._hueN    = document.getElementById("hue-n");
    this._briV    = document.getElementById("bri-v");
    this._actV    = document.getElementById("act-v");
    this._mFps    = document.getElementById("m-fps");
    this._mSrc    = document.getElementById("m-src");
    this._mRes    = document.getElementById("m-res");

    // Hue display
    this._huemark = document.querySelector(".huebar__marker");
    this._huehist = document.getElementById("huehist");

    // Canvases
    this._heat    = document.getElementById("heat");
    this._ectx    = this._heat.getContext("2d");
    this._ectx.imageSmoothingEnabled = false;

    this._hud     = document.getElementById("hud");

    this._sparkBri = document.getElementById("bri-spark");
    this._sparkAct = document.getElementById("act-spark");

    // Heat canvas fixed at sample resolution; CSS scales it up (pixelated)
    this._heat.width  = config.sampleW;
    this._heat.height = config.sampleH;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Paint one frame.
   * @param {import('./analyzer.js').AnalysisFrame} frame
   * @param {number} fps
   */
  paint(frame, fps) {
    const { out, histBins, briHist, actHist, heatImageData } = frame;

    this._updateAccent(out);
    this._updateReadouts(out, fps);
    this._updateHistogram(histBins);
    this._drawSpark(this._sparkBri, briHist);
    this._drawSpark(this._sparkAct, actHist);

    if (heatImageData) {
      this._ectx.putImageData(heatImageData, 0, 0);
    }
  }

  setSourceLabel(label) {
    this._mSrc.textContent = label;
  }

  setResLabel(w, h) {
    this._mRes.textContent = `${w}×${h}`;
  }

  /** Toggle motion heat-map via typed @property on #heat. */
  setHeatVisible(on) {
    this._heat.style.setProperty("--heat-opacity", on ? "0.55" : "0");
  }

  /**
   * Build histogram bar elements.
   * Bars use oklch for perceptually uniform lightness across hues.
   * Call once after DOM is ready.
   */
  buildHistBars() {
    this._huehist.innerHTML = "";
    for (let i = 0; i < this._cfg.hueBins; i++) {
      const bar = document.createElement("span");
      bar.className = "huehist__bar";
      // oklch: constant lightness (0.65) and chroma (0.2) across all hues
      bar.style.background = `oklch(0.65 0.2 ${(i / this._cfg.hueBins) * 360})`;
      this._huehist.appendChild(bar);
    }
  }

  /** Resize HUD and sparkline canvases. Call on init and window resize. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._hud.width  = innerWidth * dpr;
    this._hud.height = innerHeight * dpr;
    this._hud.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const c of [this._sparkBri, this._sparkAct]) {
      const r = c.getBoundingClientRect();
      c.width  = r.width  * dpr;
      c.height = r.height * dpr;
      c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Map smoothed HSV analysis values to oklch display components.
   *
   * HSV hue ≈ oklch hue (both 0°=red, 120°=green, 240°=blue),
   * close enough for accent tinting. The key win is that
   * --accent-l and --accent-c are typed @property <number>s,
   * so CSS can interpolate them between frames.
   */
  _updateAccent(out) {
    const l = (0.55 + out.bri * 0.20).toFixed(3); // 0.55 – 0.75
    const c = (0.04 + out.sat * 0.18).toFixed(3); // 0.04 – 0.22
    const h = out.hue.toFixed(1);                  // 0 – 360

    this._root.style.setProperty("--accent-l", l);
    this._root.style.setProperty("--accent-c", c);
    this._root.style.setProperty("--accent-h", h);
  }

  _updateReadouts(out, fps) {
    this._hueV.textContent = out.hue.toFixed(0).padStart(3, "0");
    this._hueN.textContent = hueName(out.hue);
    this._briV.textContent = (out.bri * 100).toFixed(0);
    this._actV.textContent = (out.act * 100).toFixed(0);
    this._mFps.textContent = fps.toFixed(0);

    // --hue-marker-pos is a typed @property on the element;
    // CSS transitions it automatically
    this._huemark.style.setProperty(
      "--hue-marker-pos",
      `${(out.hue / 360) * 100}%`
    );
  }

  _updateHistogram(bins) {
    let mx = 0.0001;
    for (const v of bins) if (v > mx) mx = v;

    const bars = this._huehist.children;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.height = `${2 + (bins[i] / mx) * 32}px`;
    }
  }

  /**
   * Draw a sparkline. Accent color is assembled from the CSS component
   * properties we set each frame (avoids unresolved var() strings).
   */
  _drawSpark(canvas, data) {
    const ctx = canvas.getContext("2d");
    const w   = canvas.getBoundingClientRect().width;
    const h   = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;

    const accent = this._accentColor();

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (this._cfg.sparkLen - 1)) * w;
      const y = h - Math.max(0, Math.min(1, data[i])) * (h - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = accent;
    ctx.shadowBlur  = 6;
    ctx.stroke();

    // Live dot at head of line
    const lx = ((data.length - 1) / (this._cfg.sparkLen - 1)) * w;
    const ly = h - data[data.length - 1] * (h - 2) - 1;
    ctx.shadowBlur = 0;
    ctx.fillStyle  = accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Build an oklch color string from the typed CSS component vars we set
   * each frame. This avoids `getComputedStyle` returning an unresolved
   * `var()` string, which canvas doesn't understand.
   */
  _accentColor() {
    const s = this._root.style;
    const l = s.getPropertyValue("--accent-l") || "0.65";
    const c = s.getPropertyValue("--accent-c") || "0.15";
    const h = s.getPropertyValue("--accent-h") || "0";
    return `oklch(${l} ${c} ${h})`;
  }
}
