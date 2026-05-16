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
    this._cfg = config;
    this._root = document.documentElement;

    // Text readouts
    this._hueV = document.getElementById("hue-v");
    this._hueN = document.getElementById("hue-n");
    this._mFps = document.getElementById("m-fps");
    this._mSrc = document.getElementById("m-src");
    this._mRes = document.getElementById("m-res");

    // Hue display
    this._huemark = document.querySelector(".huebar__marker");
    this._huehist = document.getElementById("huehist");

    // Canvases
    this._heat = document.getElementById("heat");
    this._ectx = this._heat.getContext("2d");
    this._ectx.imageSmoothingEnabled = false;

    this._hud = document.getElementById("hud");

    // Sparklines — all live inside #p-signals
    this._sparkAct = document.getElementById("ss-act");
    this._sparkActBg = document.getElementById("ss-actbg");
    this._sparkBri = document.getElementById("ss-bri");
    this._sparkContrast = document.getElementById("ss-contrast");
    this._sparkVy = document.getElementById("ss-vy");

    // Per-frame histories for signals not tracked by the analyzer
    this._actBgHist = [];
    this._contrastHist = [];
    this._vyHist = [];

    // Heat canvas fixed at sample resolution; CSS scales it up (pixelated)
    this._heat.width = config.sampleW;
    this._heat.height = config.sampleH;

    // Signal monitor panel
    this._sigDot = document.getElementById("sig-dot");
    this._sigKeyLbl = document.getElementById("sig-key-lbl");
    this._sigNumeral = document.getElementById("sig-numeral");
    this._sigNotename = document.getElementById("sig-notename");
    this._sigQuality = document.getElementById("sig-quality");
    this._sbAct = document.getElementById("sb-act");
    this._sbBri = document.getElementById("sb-bri");
    this._sbActbg = document.getElementById("sb-actbg");
    this._sbActedge = document.getElementById("sb-actedge");
    // Value labels
    this._svAct = document.getElementById("sv-act");
    this._svActbg = document.getElementById("sv-actbg");
    this._svBri = document.getElementById("sv-bri");
    this._svContrast = document.getElementById("sv-contrast");
    this._svVy = document.getElementById("sv-vy");
    this._sbVy = document.getElementById("sb-vy");
    this._sbContrast = document.getElementById("sb-contrast");
    this._sbSpread = document.getElementById("sb-spread");
    this._sbSat = document.getElementById("sb-sat");
    this._sbHi = document.getElementById("sb-hi");
    this._sbLo = document.getElementById("sb-lo");
    // Moment / object-tracking signals
    this._sbMx = document.getElementById("sb-mx");
    this._svMx = document.getElementById("sv-mx");
    this._sbMass = document.getElementById("sb-mass");
    this._sbVmag = document.getElementById("sb-vmag");
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Paint one frame.
   * @param {import('./analyzer.js').AnalysisFrame} frame
   * @param {number} fps
   * @param {{ running: boolean, keyLabel: string, note: object|null }|null} [synthSnap]
   */
  paint(frame, fps, synthSnap = null) {
    const { out, histBins, briHist, actHist, heatImageData } = frame;

    this._updateAccent(out);
    this._updateReadouts(out, fps);
    this._updateHistogram(histBins);
    this._updateSignalPanel(out, synthSnap);
    // Update renderer-owned histories (analyzer only tracks bri + act)
    const push = (arr, val) => {
      arr.push(val);
      if (arr.length > this._cfg.sparkLen) arr.shift();
    };
    push(this._actBgHist, out.actBg);
    push(this._contrastHist, Math.min(1, out.contrast * 2));
    push(this._vyHist, 1 - out.vy); // invert: top-heavy → high on chart

    this._drawSpark(this._sparkAct, actHist);
    this._drawSpark(this._sparkActBg, this._actBgHist);
    this._drawSpark(this._sparkBri, briHist);
    this._drawSpark(this._sparkContrast, this._contrastHist);
    this._drawSpark(this._sparkVy, this._vyHist);

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

    this._hud.width = innerWidth * dpr;
    this._hud.height = innerHeight * dpr;
    this._hud.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const c of [
      this._sparkAct,
      this._sparkActBg,
      this._sparkBri,
      this._sparkContrast,
      this._sparkVy,
    ]) {
      const r = c.getBoundingClientRect();
      c.width = r.width * dpr;
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
    const l = (0.55 + out.bri * 0.2).toFixed(3); // 0.55 – 0.75
    const c = (0.04 + out.sat * 0.18).toFixed(3); // 0.04 – 0.22
    const h = out.hue.toFixed(1); // 0 – 360

    this._root.style.setProperty("--accent-l", l);
    this._root.style.setProperty("--accent-c", c);
    this._root.style.setProperty("--accent-h", h);
  }

  _updateReadouts(out, fps) {
    this._hueV.textContent = out.hue.toFixed(0).padStart(3, "0");
    this._hueN.textContent = hueName(out.hue);
    this._mFps.textContent = fps.toFixed(0);

    // --hue-marker-pos is a typed @property on the element;
    // CSS transitions it automatically
    this._huemark.style.setProperty(
      "--hue-marker-pos",
      `${(out.hue / 360) * 100}%`,
    );
  }

  _updateSignalPanel(out, snap) {
    // ── bars (0–1 signals → 0–100% fill width) ────────────────
    const pct = (v, scale = 1) =>
      `${Math.min(100, v * scale * 100).toFixed(1)}%`;

    this._sbAct.style.width = pct(out.act);
    this._sbBri.style.width = pct(out.bri);
    this._sbActbg.style.width = pct(out.actBg);
    this._sbActedge.style.width = pct(out.actEdge);
    // Numeric value labels
    this._svAct.textContent = (out.act * 100).toFixed(0);
    this._svActbg.textContent = (out.actBg * 100).toFixed(0);
    this._svBri.textContent = (out.bri * 100).toFixed(0);
    this._svContrast.textContent = (out.contrast * 100).toFixed(0);
    this._svVy.textContent = (out.vy * 100).toFixed(0);
    // contrast max ~0.5 (std-dev), ×2 maps to full bar
    this._sbContrast.style.width = pct(out.contrast, 2);
    this._sbSpread.style.width = pct(out.spread);
    this._sbSat.style.width = pct(out.sat);
    this._sbHi.style.width = pct(out.hi);
    this._sbLo.style.width = pct(out.lo);

    // Moment signals
    if (this._sbMx) {
      this._sbMx.style.left = `${(out.mx * 100).toFixed(1)}%`;
      this._svMx.textContent = ((out.mx * 2 - 1) * 100).toFixed(0); // −100…+100
      this._sbMass.style.width = pct(out.mass);
      const vMag = Math.min(
        1,
        Math.sqrt(out.vmx * out.vmx + out.vmy * out.vmy) * 20,
      );
      this._sbVmag.style.width = pct(vMag);
    }

    // vy pip: left% = 0 (top of frame) → 100% (bottom of frame)
    this._sbVy.style.left = `${(out.vy * 100).toFixed(1)}%`;

    // ── synth state ───────────────────────────────────────────
    const running = snap?.running ?? false;
    this._sigDot.classList.toggle("is-on", running);

    if (!snap?.note) {
      this._sigKeyLbl.textContent = snap?.keyLabel ?? "—";
      this._sigNumeral.textContent = "—";
      this._sigNotename.textContent = "—";
      this._sigQuality.textContent = "";
      return;
    }

    const { numeral, name, quality } = snap.note;
    this._sigKeyLbl.textContent = snap.keyLabel;
    this._sigNumeral.textContent = numeral;
    this._sigNotename.textContent = name;
    this._sigQuality.textContent = quality.toUpperCase();
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
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

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
    ctx.lineWidth = 1.5;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 6;
    ctx.stroke();

    // Live dot at head of line
    const lx = ((data.length - 1) / (this._cfg.sparkLen - 1)) * w;
    const ly = h - data[data.length - 1] * (h - 2) - 1;
    ctx.shadowBlur = 0;
    ctx.fillStyle = accent;
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
