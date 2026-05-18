/**
 * src/render/renderer.ts
 *
 * Renderer owns all DOM mutations: CSS custom property updates,
 * canvas drawing, histogram bars, and sparklines.
 *
 * CSS @property contract (all on :root unless noted):
 *   --accent-l  <number>     oklch lightness 0–1
 *   --accent-c  <number>     oklch chroma 0–0.4
 *   --accent-h  <number>     oklch/approx hue 0–360
 *   --hue-marker-pos <percentage>  (on .huebar__marker)
 *   --heat-opacity   <number>      (on #heat)
 */

import { hueName } from "../analysis/color.js";
import type { LegacyConfig } from "../store/legacy-config.js";
import type { AnalysisFrame, AnalysisOut } from "../analysis/analyzer.js";

export interface SynthSnap {
  running: boolean;
  keyLabel?: string;
  note?: {
    numeral: string;
    name: string;
    quality: string;
  } | null;
}

export class Renderer {
  private _cfg: LegacyConfig;
  private _root: HTMLElement;

  // Text readouts
  private _hueV: HTMLElement | null;
  private _hueN: HTMLElement | null;
  private _mFps: HTMLElement | null;
  private _mSrc: HTMLElement | null;
  private _mRes: HTMLElement | null;

  // Hue display
  private _huemark: HTMLElement | null;
  private _huehist: HTMLElement | null;

  // Canvases
  private _heat: HTMLCanvasElement;
  private _ectx: CanvasRenderingContext2D;
  private _hud: HTMLCanvasElement;

  // Sparklines
  private _sparkAct: HTMLCanvasElement | null;
  private _sparkActBg: HTMLCanvasElement | null;
  private _sparkBri: HTMLCanvasElement | null;
  private _sparkContrast: HTMLCanvasElement | null;
  private _sparkVy: HTMLCanvasElement | null;

  // Per-frame histories
  private _actBgHist: number[];
  private _contrastHist: number[];
  private _vyHist: number[];

  // Signal monitor panel
  private _sigDot: HTMLElement | null;
  private _sigKeyLbl: HTMLElement | null;
  private _sigNumeral: HTMLElement | null;
  private _sigNotename: HTMLElement | null;
  private _sigQuality: HTMLElement | null;
  private _sbAct: HTMLElement | null;
  private _sbBri: HTMLElement | null;
  private _sbActbg: HTMLElement | null;
  private _sbActedge: HTMLElement | null;
  private _svAct: HTMLElement | null;
  private _svActbg: HTMLElement | null;
  private _svBri: HTMLElement | null;
  private _svContrast: HTMLElement | null;
  private _svVy: HTMLElement | null;
  private _sbVy: HTMLElement | null;
  private _sbContrast: HTMLElement | null;
  private _sbSpread: HTMLElement | null;
  private _sbSat: HTMLElement | null;
  private _sbHi: HTMLElement | null;
  private _sbLo: HTMLElement | null;
  private _sbMx: HTMLElement | null;
  private _svMx: HTMLElement | null;
  private _sbMass: HTMLElement | null;
  private _sbVmag: HTMLElement | null;

  constructor(config: LegacyConfig) {
    this._cfg = config;
    this._root = document.documentElement;

    this._hueV = document.getElementById("hue-v");
    this._hueN = document.getElementById("hue-n");
    this._mFps = document.getElementById("m-fps");
    this._mSrc = document.getElementById("m-src");
    this._mRes = document.getElementById("m-res");

    this._huemark = document.querySelector<HTMLElement>(".huebar__marker");
    this._huehist = document.getElementById("huehist");

    this._heat = document.getElementById("heat") as HTMLCanvasElement;
    this._ectx = this._heat.getContext("2d")!;
    this._ectx.imageSmoothingEnabled = false;

    this._hud = document.getElementById("hud") as HTMLCanvasElement;

    this._sparkAct = document.getElementById(
      "ss-act",
    ) as HTMLCanvasElement | null;
    this._sparkActBg = document.getElementById(
      "ss-actbg",
    ) as HTMLCanvasElement | null;
    this._sparkBri = document.getElementById(
      "ss-bri",
    ) as HTMLCanvasElement | null;
    this._sparkContrast = document.getElementById(
      "ss-contrast",
    ) as HTMLCanvasElement | null;
    this._sparkVy = document.getElementById(
      "ss-vy",
    ) as HTMLCanvasElement | null;

    this._actBgHist = [];
    this._contrastHist = [];
    this._vyHist = [];

    this._heat.width = config.sampleW;
    this._heat.height = config.sampleH;

    this._sigDot = document.getElementById("sig-dot");
    this._sigKeyLbl = document.getElementById("sig-key-lbl");
    this._sigNumeral = document.getElementById("sig-numeral");
    this._sigNotename = document.getElementById("sig-notename");
    this._sigQuality = document.getElementById("sig-quality");
    this._sbAct = document.getElementById("sb-act");
    this._sbBri = document.getElementById("sb-bri");
    this._sbActbg = document.getElementById("sb-actbg");
    this._sbActedge = document.getElementById("sb-actedge");
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
    this._sbMx = document.getElementById("sb-mx");
    this._svMx = document.getElementById("sv-mx");
    this._sbMass = document.getElementById("sb-mass");
    this._sbVmag = document.getElementById("sb-vmag");
  }

  // ── Public API ──────────────────────────────────────────────

  paint(
    frame: AnalysisFrame,
    fps: number,
    synthSnap: SynthSnap | null = null,
  ): void {
    const { out, histBins, briHist, actHist, heatImageData } = frame;

    this._updateAccent(out);
    this._updateReadouts(out, fps);
    this._updateHistogram(histBins);
    this._updateSignalPanel(out, synthSnap);

    const push = (arr: number[], val: number) => {
      arr.push(val);
      if (arr.length > this._cfg.sparkLen) arr.shift();
    };
    push(this._actBgHist, out.actBg);
    push(this._contrastHist, Math.min(1, out.contrast * 2));
    push(this._vyHist, 1 - out.vy);

    this._drawSpark(this._sparkAct, actHist);
    this._drawSpark(this._sparkActBg, this._actBgHist);
    this._drawSpark(this._sparkBri, briHist);
    this._drawSpark(this._sparkContrast, this._contrastHist);
    this._drawSpark(this._sparkVy, this._vyHist);

    if (heatImageData) {
      this._ectx.putImageData(heatImageData, 0, 0);
    }
  }

  setSourceLabel(label: string): void {
    if (this._mSrc) this._mSrc.textContent = label;
  }

  setResLabel(w: number, h: number): void {
    if (this._mRes) this._mRes.textContent = `${w}×${h}`;
  }

  setHeatVisible(on: boolean): void {
    this._heat.style.setProperty("--heat-opacity", on ? "0.55" : "0");
  }

  buildHistBars(): void {
    if (!this._huehist) return;
    this._huehist.innerHTML = "";
    for (let i = 0; i < this._cfg.hueBins; i++) {
      const bar = document.createElement("span");
      bar.className = "huehist__bar";
      bar.style.background = `hsl(${(i / this._cfg.hueBins) * 360}, 90%, 55%)`;
      this._huehist.appendChild(bar);
    }
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._hud.width = innerWidth * dpr;
    this._hud.height = innerHeight * dpr;
    this._hud.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const c of [
      this._sparkAct,
      this._sparkActBg,
      this._sparkBri,
      this._sparkContrast,
      this._sparkVy,
    ].filter((c): c is HTMLCanvasElement => c !== null)) {
      const r = c.getBoundingClientRect();
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      c.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private _updateAccent(out: AnalysisOut): void {
    const l = (0.55 + out.bri * 0.2).toFixed(3);
    const c = (0.04 + out.sat * 0.18).toFixed(3);
    const h = out.hue.toFixed(1);
    this._root.style.setProperty("--accent-l", l);
    this._root.style.setProperty("--accent-c", c);
    this._root.style.setProperty("--accent-h", h);
  }

  private _updateReadouts(out: AnalysisOut, fps: number): void {
    if (this._hueV)
      this._hueV.textContent = out.hue.toFixed(0).padStart(3, "0");
    if (this._hueN) this._hueN.textContent = hueName(out.hue);
    if (this._mFps) this._mFps.textContent = fps.toFixed(0);
    this._huemark?.style.setProperty(
      "--hue-marker-pos",
      `${(out.hue / 360) * 100}%`,
    );
  }

  private _updateSignalPanel(out: AnalysisOut, snap: SynthSnap | null): void {
    const pct = (v: number, scale = 1) =>
      `${Math.min(100, v * scale * 100).toFixed(1)}%`;

    if (this._sbAct) this._sbAct.style.width = pct(out.act);
    if (this._sbBri) this._sbBri.style.width = pct(out.bri);
    if (this._sbActbg) this._sbActbg.style.width = pct(out.actBg);
    if (this._svAct) this._svAct.textContent = (out.act * 100).toFixed(0);
    if (this._svActbg) this._svActbg.textContent = (out.actBg * 100).toFixed(0);
    if (this._svBri) this._svBri.textContent = (out.bri * 100).toFixed(0);
    if (this._svContrast)
      this._svContrast.textContent = (out.contrast * 100).toFixed(0);
    if (this._svVy) this._svVy.textContent = (out.vy * 100).toFixed(0);
    if (this._sbContrast) this._sbContrast.style.width = pct(out.contrast, 2);
    if (this._sbSpread) this._sbSpread.style.width = pct(out.spread);
    if (this._sbSat) this._sbSat.style.width = pct(out.sat);
    if (this._sbHi) this._sbHi.style.width = pct(out.hi);
    if (this._sbLo) this._sbLo.style.width = pct(out.lo);

    if (this._sbMx) {
      this._sbMx.style.left = `${(out.mx * 100).toFixed(1)}%`;
      if (this._svMx)
        this._svMx.textContent = ((out.mx * 2 - 1) * 100).toFixed(0);
      if (this._sbMass) this._sbMass.style.width = pct(out.mass);
      const vMag = Math.min(
        1,
        Math.sqrt(out.vmx * out.vmx + out.vmy * out.vmy) * 20,
      );
      if (this._sbVmag) this._sbVmag.style.width = pct(vMag);
    }

    if (this._sbVy) this._sbVy.style.left = `${(out.vy * 100).toFixed(1)}%`;

    const running = snap?.running ?? false;
    this._sigDot?.classList.toggle("is-on", running);

    if (!snap?.note) {
      if (this._sigKeyLbl) this._sigKeyLbl.textContent = snap?.keyLabel ?? "—";
      if (this._sigNumeral) this._sigNumeral.textContent = "—";
      if (this._sigNotename) this._sigNotename.textContent = "—";
      if (this._sigQuality) this._sigQuality.textContent = "";
      return;
    }

    const { numeral, name, quality } = snap.note;
    if (this._sigKeyLbl) this._sigKeyLbl.textContent = snap.keyLabel ?? "";
    if (this._sigNumeral) this._sigNumeral.textContent = numeral;
    if (this._sigNotename) this._sigNotename.textContent = name;
    if (this._sigQuality) this._sigQuality.textContent = quality.toUpperCase();
  }

  private _updateHistogram(bins: Float32Array): void {
    if (!this._huehist) return;
    let mx = 0.0001;
    for (const v of bins) if (v > mx) mx = v;

    const bars = this._huehist.children;
    for (let i = 0; i < bars.length; i++) {
      (bars[i] as HTMLElement).style.height = `${2 + (bins[i] / mx) * 32}px`;
    }
  }

  private _drawSpark(canvas: HTMLCanvasElement | null, data: number[]): void {
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
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

    const lx = ((data.length - 1) / (this._cfg.sparkLen - 1)) * w;
    const ly = h - data[data.length - 1] * (h - 2) - 1;
    ctx.shadowBlur = 0;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  private _accentColor(): string {
    const s = this._root.style;
    const l = s.getPropertyValue("--accent-l") || "0.65";
    const c = s.getPropertyValue("--accent-c") || "0.15";
    const h = s.getPropertyValue("--accent-h") || "0";
    return `oklch(${l} ${c} ${h})`;
  }
}
