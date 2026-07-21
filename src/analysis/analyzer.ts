/**
 * src/analysis/analyzer.ts
 *
 * Analyzer processes video frames and returns structured analysis data.
 * It owns its own off-screen sample canvas and all smoothing state.
 */

import { rgbToHsv } from "./color.js";
import { AutoRange } from "./auto-range.js";
import type { LegacyConfig } from "../store/legacy-config.js";
import type { Calibration } from "../controls/calibration.js";

const SAMPLE_W = 96;
const SAMPLE_H = 72;
const HUE_BINS = 30;

// ── Types ─────────────────────────────────────────────────────

export interface AnalysisOut {
  hue: number;
  sat: number;
  bri: number;
  lo: number;
  contrast: number;
  spread: number;
  // canonical aligned axes (video side ↔ audio side)
  flux: number;   // consolidated activity: max(act,actBg) + 0.4*actEdge
  tilt: number;   // vertical brightness centroid → spectral centroid target
  pos: number;    // horizontal motion centroid → stereo position target
  /** Un-normalized brightness — auto-range never touches this. The extremes
   *  system keys off it so "total dark" keeps its absolute meaning. */
  briRaw: number;
}

export interface AnalysisFrame {
  out: AnalysisOut;
  histBins: Float32Array;
  heatImageData: ImageData | null;
}

// ── Analyzer ─────────────────────────────────────────────────

export class Analyzer {
  private _cfg: LegacyConfig;
  private _calibration: Calibration | null;

  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  private _prev: Uint8ClampedArray | null;
  private _bg: Float32Array | null;
  private _out: AnalysisOut;
  private _histBins: Float32Array;
  private _actSmooth = 0;
  private _actBgSmooth = 0;
  private _mxSmooth = 0.5;
  private _vySmooth = 0.5;
  private readonly _autoRange = new AutoRange();

  heatOn: boolean;

  constructor(config: LegacyConfig, calibration: Calibration | null = null) {
    this._cfg = config;
    this._calibration = calibration;

    this._canvas = document.createElement("canvas");
    this._canvas.width = SAMPLE_W;
    this._canvas.height = SAMPLE_H;
    this._ctx = this._canvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    this._prev = null;
    this._bg = null;
    this._out = {
      hue: 0,
      sat: 0,
      bri: 0,
      lo: 0,
      contrast: 0,
      spread: 0,
      flux: 0,
      tilt: 0.5,
      pos: 0.5,
      briRaw: 0,
    };
    this._histBins = new Float32Array(HUE_BINS);
    this.heatOn = false;
  }

  // ── Public API ──────────────────────────────────────────────

  analyze(videoEl: HTMLVideoElement): AnalysisFrame {
    const W = SAMPLE_W, H = SAMPLE_H;

    this._ctx.filter = this._calibration?.filterString ?? "none";
    // The mask is the region of interest: when it's on (or the explicit
    // viewboxOn flag), restrict analysis to the viewbox so every axis — tilt,
    // pos, brightness — is measured over the masked crop, not the whole frame.
    if (this._cfg.viewboxOn || this._cfg.maskOn) {
      const vw = videoEl.videoWidth  || videoEl.clientWidth  || W;
      const vh = videoEl.videoHeight || videoEl.clientHeight || H;
      const vx  = this._cfg.viewboxX ?? 0;
      const vy  = this._cfg.viewboxY ?? 0;
      const vbw = this._cfg.viewboxW ?? 1;
      const vbh = this._cfg.viewboxH ?? 1;
      const sx = Math.round(vx * vw);
      const sy = Math.round(vy * vh);
      const sw = Math.max(1, Math.round(Math.min(vbw, 1 - vx) * vw));
      const sh = Math.max(1, Math.round(Math.min(vbh, 1 - vy) * vh));
      this._ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, W, H);
    } else {
      this._ctx.drawImage(videoEl, 0, 0, W, H);
    }
    this._ctx.filter = "none";

    let frame: ImageData;
    try {
      frame = this._ctx.getImageData(0, 0, W, H);
    } catch {
      return this._currentFrame(null);
    }

    const px = frame.data;
    const nPx = px.length / 4;

    if (!this._bg) this._bg = new Float32Array(px);

    // ── Pass 1: hue + brightness + histogram ──────────────────
    let sumX = 0,
      sumY = 0,
      sumW = 0;
    let briSum = 0,
      satSum = 0,
      satN = 0;
    let briSumSq = 0;
    let yWeightSum = 0;
    const rowStride = W * 4;

    const botThresh = W * 4 * Math.ceil((H * 2) / 3);
    const nBot = (H - Math.ceil((H * 2) / 3)) * W;
    let briBotSum = 0;

    this._histBins.fill(0);

    for (let i = 0; i < px.length; i += 4) {
      const [h, s, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
      briSum += v;
      briSumSq += v * v;
      yWeightSum += ((i / rowStride) | 0) * v;
      if (i >= botThresh) briBotSum += v;

      if (s > this._cfg.satFloor && v > this._cfg.valFloor) {
        // sqrt(s) reduces vivid-pixel dominance: muted (s=0.15) vs vivid (s=0.9)
        // goes from 6:1 bias down to ~2.4:1, so faded colors register properly.
        const w = Math.sqrt(s) * v;
        const rad = (h * Math.PI) / 180;
        sumX += Math.cos(rad) * w;
        sumY += Math.sin(rad) * w;
        sumW += w;
        satSum += s;
        satN++;

        const bin = Math.min(
          HUE_BINS - 1,
          ((h / 360) * HUE_BINS) | 0,
        );
        this._histBins[bin] += w;
      }
    }

    let hue = this._out.hue;
    if (sumW > 0.0001) {
      let a = (Math.atan2(sumY, sumX) * 180) / Math.PI;
      if (a < 0) a += 360;
      hue = a;
    }

    const spread =
      sumW > 0.0001 ? 1 - Math.sqrt(sumX * sumX + sumY * sumY) / sumW : 0;

    const bri = briSum / nPx;
    const sat = satN > 0 ? satSum / satN : 0;

    // ── Pass 2: activity ──────────────────────────────────────
    let act = 0;
    let actEdge = 0;
    let actBg = 0;
    let heatImageData: ImageData | null = null;
    let rawMx = 0.5;

    if (this._prev) {
      let acc = 0,
        accEdge = 0,
        accBg = 0;
      let mxAcc = 0,
        massAcc = 0;
      let heatData: Uint8ClampedArray | undefined;

      if (this.heatOn) {
        heatImageData = this._ctx.createImageData(W, H);
        heatData = heatImageData.data;
      }

      const bg = this._bg!;
      const prev = this._prev;

      for (let i = 0; i < px.length; i += 4) {
        const dr = (px[i] - prev[i]) / 255;
        const dg = (px[i + 1] - prev[i + 1]) / 255;
        const db = (px[i + 2] - prev[i + 2]) / 255;
        let d = Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
        if (d < this._cfg.activityNoise) d = 0;
        acc += d;

        if (d > 0) {
          const li = i >= 4 ? i - 4 : i;
          const luma =
            (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
          const lumaL =
            (px[li] * 0.299 + px[li + 1] * 0.587 + px[li + 2] * 0.114) / 255;
          accEdge += d * Math.abs(luma - lumaL);
        }

        const drBg = (px[i] - bg[i]) / 255;
        const dgBg = (px[i + 1] - bg[i + 1]) / 255;
        const dbBg = (px[i + 2] - bg[i + 2]) / 255;
        let dBg = Math.sqrt(
          0.299 * drBg * drBg + 0.587 * dgBg * dgBg + 0.114 * dbBg * dbBg,
        );
        if (dBg < this._cfg.activityNoise) dBg = 0;
        accBg += dBg;

        if (dBg > 0) {
          const pi = i >> 2;
          const xi = ((pi % W) + 0.5) / W;
          const [, s] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
          const wm = dBg * Math.max(s, 0.1);
          mxAcc += xi * wm;
          massAcc += wm;
        }

        if (heatData) {
          const gain = this._cfg.activityGain;
          const tFd = Math.min(1, d * gain);
          const tBg = Math.min(1, dBg * gain * 0.7);
          heatData[i] = Math.min(255, 255 * tFd + 80 * tBg) | 0;
          heatData[i + 1] =
            Math.min(
              255,
              200 * tFd * (0.4 + 0.6 * (1 - hue / 360)) + 40 * tBg,
            ) | 0;
          heatData[i + 2] =
            Math.min(255, 255 * tFd * (hue / 360) + 210 * tBg) | 0;
          heatData[i + 3] = Math.max(tFd, tBg * 0.7) * 255 > 14 ? 255 : 0;
        }
      }

      act = Math.min(1, (acc / nPx) * this._cfg.activityGain);
      actEdge = Math.min(1, (accEdge / nPx) * this._cfg.activityGain * 6);
      actBg = Math.min(1, (accBg / nPx) * this._cfg.activityGain);

      if (massAcc > 0.0001) {
        rawMx = mxAcc / massAcc;
      }
    } else {
      this._prev = new Uint8ClampedArray(px.length);
    }

    this._prev!.set(px);

    const bgK = 0.03;
    const bg = this._bg!;
    for (let i = 0; i < bg.length; i++) {
      bg[i] += (px[i] - bg[i]) * bgK;
    }

    // ── EMA smoothing ─────────────────────────────────────────
    const briBot = nBot > 0 ? briBotSum / nBot : 0;
    const rawVy = briSum > 0.0001 ? yWeightSum / (briSum * (H - 1)) : 0.5;

    const briMean = briSum / nPx;
    const contrast = Math.sqrt(Math.max(0, briSumSq / nPx - briMean * briMean));
    const k = this._cfg.smoothing;
    const kh = this._cfg.hueSmoothing;

    const dh = ((hue - this._out.hue + 540) % 360) - 180;
    this._out.hue = (this._out.hue + dh * kh + 360) % 360;
    this._out.bri += (bri - this._out.bri) * k;
    this._out.sat += (sat - this._out.sat) * k;
    this._out.lo += (briBot - this._out.lo) * k;
    this._out.contrast += (contrast - this._out.contrast) * k;
    this._out.spread += (spread - this._out.spread) * k;

    // Internal EMA for act/actBg (used only to derive flux)
    this._actSmooth += (act - this._actSmooth) * k;
    this._actBgSmooth += (actBg - this._actBgSmooth) * k;
    this._mxSmooth += (rawMx - this._mxSmooth) * k;
    this._vySmooth += (rawVy - this._vySmooth) * k;

    // Canonical axes
    const rawFlux = Math.min(1, Math.max(this._actSmooth, this._actBgSmooth) + 0.4 * actEdge);
    this._out.flux += (rawFlux - this._out.flux) * k;
    this._out.tilt = this._vySmooth;
    this._out.pos = this._mxSmooth;

    return this._currentFrame(heatImageData);
  }

  // ── Private ──────────────────────────────────────────────────

  private _currentFrame(heatImageData: ImageData | null): AnalysisFrame {
    // Auto-range projection: `_out` stays raw smoothing state; the emitted
    // frame gets the six canonical axes adaptively normalized ("forgiving
    // constraints") so downstream mappings see full-range swings even from a
    // dim or flat scene. Bounds track continuously (cheap) so the knob is
    // warm the moment it's raised. briRaw always carries the absolute value.
    const out = { ...this._out };
    out.briRaw = this._out.bri;
    const amt = Math.max(0, Math.min(1, this._cfg.autoRange ?? 0));
    const win = this._cfg.autoRangeWindow ?? 75;
    this._autoRange.tick(performance.now());
    out.bri = this._autoRange.apply("bri", this._out.bri, amt, win);
    out.flux = this._autoRange.apply("flux", this._out.flux, amt, win);
    out.spread = this._autoRange.apply("spread", this._out.spread, amt, win);
    out.tilt = this._autoRange.apply("tilt", this._out.tilt, amt, win);
    out.pos = this._autoRange.apply("pos", this._out.pos, amt, win);
    out.contrast = this._autoRange.apply("contrast", this._out.contrast, amt, win);
    out.lo = this._autoRange.apply("lo", this._out.lo, amt, win);
    return {
      out,
      histBins: this._histBins,
      heatImageData,
    };
  }
}
