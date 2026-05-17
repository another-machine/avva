/**
 * src/analysis/analyzer.ts
 *
 * Analyzer processes video frames and returns structured analysis data.
 * It owns its own off-screen sample canvas and all smoothing state.
 */

import { rgbToHsv } from "./color.js";
import type { LegacyConfig } from "../store/legacy-config.js";
import type { Calibration } from "../controls/calibration.js";

// ── Types ─────────────────────────────────────────────────────

export interface AnalysisOut {
  hue: number;
  sat: number;
  bri: number;
  act: number;
  hi: number;
  lo: number;
  vy: number;
  contrast: number;
  actEdge: number;
  spread: number;
  dContrast: number;
  actBg: number;
  mx: number;
  my: number;
  sx: number;
  sy: number;
  vmx: number;
  vmy: number;
  mass: number;
}

export interface AnalysisFrame {
  out: AnalysisOut;
  histBins: Float32Array;
  briHist: number[];
  actHist: number[];
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
  private _prevContrast: number;
  private _histBins: Float32Array;
  private _briHist: number[];
  private _actHist: number[];

  heatOn: boolean;

  constructor(config: LegacyConfig, calibration: Calibration | null = null) {
    this._cfg = config;
    this._calibration = calibration;

    this._canvas = document.createElement("canvas");
    this._canvas.width = config.sampleW;
    this._canvas.height = config.sampleH;
    this._ctx = this._canvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    this._prev = null;
    this._bg = null;
    this._out = {
      hue: 0,
      sat: 0,
      bri: 0,
      act: 0,
      hi: 0,
      lo: 0,
      vy: 0.5,
      contrast: 0,
      actEdge: 0,
      spread: 0,
      dContrast: 0,
      actBg: 0,
      mx: 0.5,
      my: 0.5,
      sx: 0.5,
      sy: 0.5,
      vmx: 0,
      vmy: 0,
      mass: 0,
    };
    this._prevContrast = 0;
    this._histBins = new Float32Array(config.hueBins);
    this._briHist = [];
    this._actHist = [];
    this.heatOn = false;
  }

  // ── Public API ──────────────────────────────────────────────

  analyze(videoEl: HTMLVideoElement): AnalysisFrame {
    const { sampleW: W, sampleH: H } = this._cfg;

    this._ctx.filter = this._calibration?.filterString ?? "none";
    this._ctx.drawImage(videoEl, 0, 0, W, H);
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

    const topThresh = W * 4 * Math.floor(H / 3);
    const botThresh = W * 4 * Math.ceil((H * 2) / 3);
    const nTop = Math.floor(H / 3) * W;
    const nBot = (H - Math.ceil((H * 2) / 3)) * W;
    let briTopSum = 0,
      briBotSum = 0;

    this._histBins.fill(0);

    for (let i = 0; i < px.length; i += 4) {
      const [h, s, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
      briSum += v;
      briSumSq += v * v;
      yWeightSum += ((i / rowStride) | 0) * v;
      if (i < topThresh) briTopSum += v;
      else if (i >= botThresh) briBotSum += v;

      if (s > this._cfg.satFloor && v > this._cfg.valFloor) {
        const w = s * v;
        const rad = (h * Math.PI) / 180;
        sumX += Math.cos(rad) * w;
        sumY += Math.sin(rad) * w;
        sumW += w;
        satSum += s;
        satN++;

        const bin = Math.min(
          this._cfg.hueBins - 1,
          ((h / 360) * this._cfg.hueBins) | 0,
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
    let rawMx = 0.5,
      rawMy = 0.5,
      rawSx = 0.5,
      rawSy = 0.5,
      rawMass = 0;

    if (this._prev) {
      let acc = 0,
        accEdge = 0,
        accBg = 0;
      let mxAcc = 0,
        myAcc = 0,
        mx2Acc = 0,
        my2Acc = 0,
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
          const yi = (((pi / W) | 0) + 0.5) / H;
          const [, s] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
          const wm = dBg * Math.max(s, 0.1);
          mxAcc += xi * wm;
          myAcc += yi * wm;
          mx2Acc += xi * xi * wm;
          my2Acc += yi * yi * wm;
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
        rawMy = myAcc / massAcc;
        rawSx = Math.sqrt(Math.max(0, mx2Acc / massAcc - rawMx * rawMx));
        rawSy = Math.sqrt(Math.max(0, my2Acc / massAcc - rawMy * rawMy));
      }
      rawMass = Math.min(1, massAcc * this._cfg.activityGain);
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
    const briTop = nTop > 0 ? briTopSum / nTop : 0;
    const briBot = nBot > 0 ? briBotSum / nBot : 0;
    const vy = briSum > 0.0001 ? yWeightSum / (briSum * (H - 1)) : 0.5;

    const briMean = briSum / nPx;
    const contrast = Math.sqrt(Math.max(0, briSumSq / nPx - briMean * briMean));
    const k = this._cfg.smoothing;
    const kh = this._cfg.hueSmoothing;

    const dh = ((hue - this._out.hue + 540) % 360) - 180;
    this._out.hue = (this._out.hue + dh * kh + 360) % 360;
    this._out.bri += (bri - this._out.bri) * k;
    this._out.sat += (sat - this._out.sat) * k;
    this._out.act += (act - this._out.act) * k;
    this._out.hi += (briTop - this._out.hi) * k;
    this._out.lo += (briBot - this._out.lo) * k;
    this._out.vy += (vy - this._out.vy) * k;
    this._out.contrast += (contrast - this._out.contrast) * k;
    this._out.actEdge += (actEdge - this._out.actEdge) * k;
    this._out.spread += (spread - this._out.spread) * k;
    this._out.actBg += (actBg - this._out.actBg) * k;

    const prevMx = this._out.mx;
    const prevMy = this._out.my;
    this._out.mx += (rawMx - this._out.mx) * k;
    this._out.my += (rawMy - this._out.my) * k;
    this._out.sx += (rawSx - this._out.sx) * k;
    this._out.sy += (rawSy - this._out.sy) * k;
    this._out.mass += (rawMass - this._out.mass) * k;
    const dMx = this._out.mx - prevMx;
    const dMy = this._out.my - prevMy;
    this._out.vmx += (dMx - this._out.vmx) * k;
    this._out.vmy += (dMy - this._out.vmy) * k;

    this._out.dContrast = this._out.contrast - this._prevContrast;
    this._prevContrast = this._out.contrast;

    // ── History ───────────────────────────────────────────────
    this._briHist.push(this._out.bri);
    this._actHist.push(this._out.act);
    if (this._briHist.length > this._cfg.sparkLen) this._briHist.shift();
    if (this._actHist.length > this._cfg.sparkLen) this._actHist.shift();

    return this._currentFrame(heatImageData);
  }

  // ── Private ──────────────────────────────────────────────────

  private _currentFrame(heatImageData: ImageData | null): AnalysisFrame {
    return {
      out: { ...this._out },
      histBins: this._histBins,
      briHist: this._briHist,
      actHist: this._actHist,
      heatImageData,
    };
  }
}
