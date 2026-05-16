/**
 * modules/analyzer.js
 *
 * Analyzer processes video frames and returns structured analysis data.
 * It owns its own off-screen sample canvas and all smoothing state.
 * No DOM access beyond its internal canvas — source-agnostic.
 *
 * If a Calibration is provided, the same filter string applied to the
 * video display element is also applied to the sample canvas before
 * drawImage — so analysis always reflects exactly what you see.
 *
 * Three analysis passes per frame:
 *   1. Hue        — saturation-weighted circular mean of vivid pixels
 *   2. Brightness — mean HSV value across all pixels
 *   3. Activity   — mean absolute luma delta vs previous frame
 *
 * @typedef {Object} AnalysisFrame
 * @property {{ hue: number, sat: number, bri: number, act: number }} out
 * @property {Float32Array}   histBins      — raw hue histogram weights
 * @property {number[]}       briHist       — recent brightness history (0–1)
 * @property {number[]}       actHist       — recent activity history (0–1)
 * @property {ImageData|null} heatImageData — motion map, or null if heatOn=false
 */

import { rgbToHsv } from "./color.js";

export class Analyzer {
  /**
   * @param {import('./config.js').CONFIG} config
   * @param {import('./calibration.js').Calibration|null} calibration
   */
  constructor(config, calibration = null) {
    this._cfg         = config;
    this._calibration = calibration;

    // Off-screen sample canvas — never displayed
    this._canvas = document.createElement("canvas");
    this._canvas.width  = config.sampleW;
    this._canvas.height = config.sampleH;
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });

    // State
    this._prev     = null;
    this._out      = { hue: 0, sat: 0, bri: 0, act: 0 };
    this._histBins = new Float32Array(config.hueBins);
    this._briHist  = [];
    this._actHist  = [];

    this.heatOn = false;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Process one frame from a video element.
   * @param {HTMLVideoElement} videoEl
   * @returns {AnalysisFrame}
   */
  analyze(videoEl) {
    const { sampleW: W, sampleH: H } = this._cfg;

    // Apply calibration filter (if any) to the sample draw.
    // This keeps analysis and display in perfect sync.
    this._ctx.filter = this._calibration?.filterString ?? "none";
    this._ctx.drawImage(videoEl, 0, 0, W, H);
    this._ctx.filter = "none"; // always reset

    let frame;
    try {
      frame = this._ctx.getImageData(0, 0, W, H);
    } catch {
      return this._currentFrame(null); // tainted canvas (CORS)
    }

    const px  = frame.data;
    const nPx = px.length / 4;

    // ── Pass 1: hue + brightness + histogram ──────────────────
    let sumX = 0, sumY = 0, sumW = 0;
    let briSum = 0, satSum = 0, satN = 0;

    this._histBins.fill(0);

    for (let i = 0; i < px.length; i += 4) {
      const [h, s, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
      briSum += v;

      if (s > this._cfg.satFloor && v > this._cfg.valFloor) {
        const w   = s * v; // vivid, lit pixels vote loudest
        const rad = (h * Math.PI) / 180;
        sumX += Math.cos(rad) * w;
        sumY += Math.sin(rad) * w;
        sumW += w;
        satSum += s;
        satN++;

        const bin = Math.min(
          this._cfg.hueBins - 1,
          ((h / 360) * this._cfg.hueBins) | 0
        );
        this._histBins[bin] += w;
      }
    }

    // Circular mean — handles 0°/360° wrap correctly
    let hue = this._out.hue;
    if (sumW > 0.0001) {
      let a = (Math.atan2(sumY, sumX) * 180) / Math.PI;
      if (a < 0) a += 360;
      hue = a;
    }

    const bri = briSum / nPx;
    const sat = satN > 0 ? satSum / satN : 0;

    // ── Pass 2: activity (perceptual color delta vs previous frame) ──
    //
    // Uses weighted RGB Euclidean distance rather than luma-only delta.
    // This makes activity sensitive to chromatic motion (e.g. similarly-bright
    // blobs of different hue moving through a uniform-hue scene like a lava lamp)
    // which luma-only diffing would miss entirely.
    //
    // d = sqrt(0.299·ΔR² + 0.587·ΔG² + 0.114·ΔB²) / 255
    // Range 0–1; max = 1.0 (white↔black). Same scale as old luma approach.
    let act = 0;
    let heatImageData = null;

    if (this._prev) {
      let acc = 0;
      let heatData;

      if (this.heatOn) {
        heatImageData = this._ctx.createImageData(W, H);
        heatData = heatImageData.data;
      }

      for (let i = 0; i < px.length; i += 4) {
        const dr = (px[i]   - this._prev[i])   / 255;
        const dg = (px[i+1] - this._prev[i+1]) / 255;
        const db = (px[i+2] - this._prev[i+2]) / 255;
        let d = Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
        if (d < this._cfg.activityNoise) d = 0;
        acc += d;

        if (heatData) {
          const t = Math.min(1, d * this._cfg.activityGain);
          heatData[i]     = 255 * t;
          heatData[i + 1] = 200 * t * (0.4 + 0.6 * (1 - hue / 360));
          heatData[i + 2] = 255 * t * (hue / 360);
          heatData[i + 3] = t * 255 > 14 ? 255 : 0;
        }
      }

      act = Math.min(1, (acc / nPx) * this._cfg.activityGain);
    } else {
      this._prev = new Uint8ClampedArray(px.length);
    }

    this._prev.set(px);

    // ── EMA smoothing (shortest-arc for hue) ─────────────────
    const k  = this._cfg.smoothing;
    const kh = this._cfg.hueSmoothing;
    const dh = ((hue - this._out.hue + 540) % 360) - 180;
    this._out.hue = (this._out.hue + dh * kh + 360) % 360;
    this._out.bri += (bri - this._out.bri) * k;
    this._out.sat += (sat - this._out.sat) * k;
    this._out.act += (act - this._out.act) * k;

    // ── History ───────────────────────────────────────────────
    this._briHist.push(this._out.bri);
    this._actHist.push(this._out.act);
    if (this._briHist.length > this._cfg.sparkLen) this._briHist.shift();
    if (this._actHist.length > this._cfg.sparkLen) this._actHist.shift();

    return this._currentFrame(heatImageData);
  }

  // ── Private ──────────────────────────────────────────────────

  _currentFrame(heatImageData) {
    return {
      out:          { ...this._out },
      histBins:     this._histBins,
      briHist:      this._briHist,
      actHist:      this._actHist,
      heatImageData,
    };
  }
}
