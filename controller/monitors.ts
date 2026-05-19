/**
 * controller/monitors.ts
 *
 * Live telemetry monitors for the controller window.
 * mountVideoMonitor: meters, sparklines, hue panel, meta
 * mountAudioMonitor: chroma bars
 */

import { store } from "../src/store/store.js";
import { legacyConfig as CONFIG } from "../src/store/legacy-config.js";
import { Palette } from "../src/harmony/palette.js";
import { hueName } from "../src/analysis/color.js";
import type { AnalysisOut } from "../src/analysis/analyzer.js";
import type { TelemetryMsg } from "../src/store/telemetry.js";

// ── Helpers (lifted from renderer.ts, adapted for per-element accent) ──────────

function _setMonitorAccent(host: HTMLElement, out: AnalysisOut): void {
  host.style.setProperty("--accent-l", (0.55 + out.bri * 0.2).toFixed(3));
  host.style.setProperty("--accent-c", (0.04 + out.sat * 0.18).toFixed(3));
  host.style.setProperty("--accent-h", out.hue.toFixed(1));
}

function _accentColor(host: HTMLElement): string {
  const l = host.style.getPropertyValue("--accent-l") || "0.65";
  const c = host.style.getPropertyValue("--accent-c") || "0.15";
  const h = host.style.getPropertyValue("--accent-h") || "0";
  return `oklch(${l} ${c} ${h})`;
}

function _drawSpark(
  canvas: HTMLCanvasElement,
  data: number[],
  host: HTMLElement,
): void {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  if (canvas.width !== Math.round(r.width)) {
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
  }
  const ctx = canvas.getContext("2d")!;
  const w = r.width;
  const h = r.height;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  const sparkLen = CONFIG.sparkLen;
  const accent = _accentColor(host);

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (sparkLen - 1)) * w;
    const y = h - Math.max(0, Math.min(1, data[i])) * (h - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  ctx.stroke();

  const lx = ((data.length - 1) / (sparkLen - 1)) * w;
  const ly = h - data[data.length - 1] * (h - 2) - 1;
  ctx.shadowBlur = 0;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function _updateHistogram(huehist: HTMLElement, bins: Float32Array): void {
  let mx = 0.0001;
  for (const v of bins) if (v > mx) mx = v;
  const bars = huehist.children;
  for (let i = 0; i < bars.length; i++) {
    (bars[i] as HTMLElement).style.height =
      `${2 + ((bins[i] ?? 0) / mx) * 32}px`;
  }
}

// ── Video Monitor ─────────────────────────────────────────────────────────────

interface VideoMonitorRefs {
  sigDot: HTMLElement;
  sigKeyLbl: HTMLElement;
  sigNumeral: HTMLElement;
  sigNotename: HTMLElement;
  sigQuality: HTMLElement;
  sbAct: HTMLElement;
  sbBri: HTMLElement;
  sbActbg: HTMLElement;
  sbContrast: HTMLElement;
  sbSpread: HTMLElement;
  sbSat: HTMLElement;
  sbHi: HTMLElement;
  sbLo: HTMLElement;
  sbMass: HTMLElement;
  sbVmag: HTMLElement;
  sbMx: HTMLElement;
  sbVy: HTMLElement;
  svAct: HTMLElement;
  svBri: HTMLElement;
  svActbg: HTMLElement;
  svContrast: HTMLElement;
  svVy: HTMLElement;
  svMx: HTMLElement;
  sparkAct: HTMLCanvasElement;
  sparkActBg: HTMLCanvasElement;
  sparkBri: HTMLCanvasElement;
  sparkContrast: HTMLCanvasElement;
  sparkVy: HTMLCanvasElement;
  huemark: HTMLElement;
  huehist: HTMLElement;
  hueV: HTMLElement;
  hueN: HTMLElement;
}

function _buildVideoDOM(host: HTMLElement): VideoMonitorRefs {
  const mk = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  const row = (lbl: string, fillId: string, valId?: string, pos = false) => {
    const div = mk("div", pos ? "sig__row sig__row--pos" : "sig__row");
    div.appendChild(mk("span", "sig__lbl", lbl));
    if (pos) {
      const track = mk("div", "pos-track");
      const marker = mk("div", "pos-track__marker");
      marker.id = fillId;
      track.appendChild(marker);
      div.appendChild(track);
    } else {
      const meter = mk("div", "meter");
      const fill = mk("div", "meter__fill");
      fill.id = fillId;
      meter.appendChild(fill);
      div.appendChild(meter);
    }
    const val = mk("span", "sig__val");
    if (valId) val.id = valId;
    div.appendChild(val);
    return div;
  };

  // Synth section
  const synthHdr = mk("div", "sig__hdr", "SYNTH");
  const keyRow = mk("div", "sig__key-row");
  const sigDot = mk("span", "sig__dot");
  const sigKeyLbl = mk("span", undefined, "—");
  keyRow.append(sigDot, sigKeyLbl);

  const noteRow = mk("div", "sig__note-row");
  const sigNumeral = mk("span", "sig__numeral", "—");
  const sigNotename = mk("span", "sig__notename", "—");
  noteRow.append(sigNumeral, mk("span", "sig__sep", "·"), sigNotename);

  const sigQuality = mk("div", "sig__quality");

  // Sparklines
  const sparksDiv = mk("div", "sig__sparks");
  const sparkAct = mk("canvas", "spark");
  const sparkActBg = mk("canvas", "spark");
  const sparkBri = mk("canvas", "spark");
  const sparkContrast = mk("canvas", "spark");
  const sparkVy = mk("canvas", "spark");
  sparksDiv.append(sparkAct, sparkActBg, sparkBri, sparkContrast, sparkVy);

  // Scene meters
  const sceneHdr = mk("div", "sig__hdr", "SCENE");

  const sbBri = mk("div", "meter__fill");
  const svBri = mk("span", "sig__val");
  const sbAct = mk("div", "meter__fill");
  const svAct = mk("span", "sig__val");
  const sbActbg = mk("div", "meter__fill");
  const svActbg = mk("span", "sig__val");
  const sbContrast = mk("div", "meter__fill");
  const svContrast = mk("span", "sig__val");
  const sbSpread = mk("div", "meter__fill");
  const sbSat = mk("div", "meter__fill");
  const sbHi = mk("div", "meter__fill");
  const sbLo = mk("div", "meter__fill");
  const sbMass = mk("div", "meter__fill");
  const sbVmag = mk("div", "meter__fill");

  const meterRow = (lbl: string, fill: HTMLElement, val?: HTMLElement) => {
    const d = mk("div", "sig__row");
    d.appendChild(mk("span", "sig__lbl", lbl));
    const m = mk("div", "meter");
    m.appendChild(fill);
    d.appendChild(m);
    d.appendChild(val ?? mk("span", "sig__val"));
    return d;
  };

  // Position track rows
  const sbMx = mk("div", "pos-track__marker");
  const svMx = mk("span", "sig__val");
  const mxRow = mk("div", "sig__row sig__row--pos");
  mxRow.appendChild(mk("span", "sig__lbl", "MX"));
  const mxTrack = mk("div", "pos-track");
  mxTrack.appendChild(sbMx);
  mxRow.appendChild(mxTrack);
  mxRow.appendChild(svMx);

  const sbVy = mk("div", "pos-track__marker");
  const svVy = mk("span", "sig__val");
  const vyRow = mk("div", "sig__row sig__row--pos");
  vyRow.appendChild(mk("span", "sig__lbl", "VY"));
  const vyTrack = mk("div", "pos-track");
  vyTrack.appendChild(sbVy);
  vyRow.appendChild(vyTrack);
  vyRow.appendChild(svVy);

  // Hue section
  const hueLabel = mk("div", "panel__label", "SEEN CHROMA");
  const hueVal = mk("div", "panel__value");
  const hueV = mk("span", undefined, "—");
  const hueN = mk("span", "panel__unit");
  hueVal.append(hueV, mk("span", "panel__unit", "°"), hueN);

  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  const huehist = mk("div", "huehist");
  const hueBins = CONFIG.hueBins;
  for (let i = 0; i < hueBins; i++) {
    const bar = mk("span", "huehist__bar");
    bar.style.background = `hsl(${(i / hueBins) * 360}, 90%, 55%)`;
    huehist.appendChild(bar);
  }

  // Assemble into host
  const div = mk("div", "sig__divider");
  const div2 = mk("div", "sig__divider");
  const div3 = mk("div", "sig__divider");

  host.append(
    synthHdr,
    keyRow,
    noteRow,
    sigQuality,
    div,
    sparksDiv,
    div2,
    sceneHdr,
    meterRow("BRI", sbBri, svBri),
    meterRow("ACT", sbAct, svAct),
    meterRow("BG", sbActbg, svActbg),
    meterRow("CTR", sbContrast, svContrast),
    meterRow("SPR", sbSpread),
    meterRow("SAT", sbSat),
    meterRow("HI", sbHi),
    meterRow("LO", sbLo),
    meterRow("MSS", sbMass),
    meterRow("VMG", sbVmag),
    mxRow,
    vyRow,
    div3,
    hueLabel,
    hueVal,
    huebar,
    huehist,
  );

  return {
    sigDot,
    sigKeyLbl,
    sigNumeral,
    sigNotename,
    sigQuality,
    sbAct,
    sbBri,
    sbActbg,
    sbContrast,
    sbSpread,
    sbSat,
    sbHi,
    sbLo,
    sbMass,
    sbVmag,
    sbMx,
    sbVy,
    svAct,
    svBri,
    svActbg,
    svContrast,
    svVy,
    svMx,
    sparkAct,
    sparkActBg,
    sparkBri,
    sparkContrast,
    sparkVy,
    huemark,
    huehist,
    hueV,
    hueN,
  };
}

function _paintVideoSignals(
  refs: VideoMonitorRefs,
  out: AnalysisOut,
  synth: TelemetryMsg["synth"] | null,
): void {
  const pct = (v: number, scale = 1) =>
    `${Math.min(100, v * scale * 100).toFixed(1)}%`;

  refs.sbBri.style.width = pct(out.bri);
  refs.sbAct.style.width = pct(out.act);
  refs.sbActbg.style.width = pct(out.actBg);
  refs.sbContrast.style.width = pct(out.contrast, 2);
  refs.sbSpread.style.width = pct(out.spread);
  refs.sbSat.style.width = pct(out.sat);
  refs.sbHi.style.width = pct(out.hi);
  refs.sbLo.style.width = pct(out.lo);
  refs.sbMass.style.width = pct(out.mass);
  const vMag = Math.min(
    1,
    Math.sqrt(out.vmx * out.vmx + out.vmy * out.vmy) * 20,
  );
  refs.sbVmag.style.width = pct(vMag);
  refs.sbMx.style.left = `${(out.mx * 100).toFixed(1)}%`;
  refs.sbVy.style.left = `${(out.vy * 100).toFixed(1)}%`;

  refs.svBri.textContent = (out.bri * 100).toFixed(0);
  refs.svAct.textContent = (out.act * 100).toFixed(0);
  refs.svActbg.textContent = (out.actBg * 100).toFixed(0);
  refs.svContrast.textContent = (out.contrast * 100).toFixed(0);
  refs.svVy.textContent = (out.vy * 100).toFixed(0);
  refs.svMx.textContent = ((out.mx * 2 - 1) * 100).toFixed(0);

  const running = synth?.running ?? false;
  refs.sigDot.classList.toggle("is-on", running);

  if (!synth?.note) {
    refs.sigKeyLbl.textContent = synth?.keyLabel ?? "—";
    refs.sigNumeral.textContent = "—";
    refs.sigNotename.textContent = "—";
    refs.sigQuality.textContent = "";
    return;
  }
  const { numeral, name, quality } = synth.note;
  refs.sigKeyLbl.textContent = synth.keyLabel ?? "";
  refs.sigNumeral.textContent = numeral;
  refs.sigNotename.textContent = name;
  refs.sigQuality.textContent = quality.toUpperCase();
}

export function mountVideoMonitor(host: HTMLElement): {
  onMsg(msg: TelemetryMsg): void;
} {
  const refs = _buildVideoDOM(host);

  const actHist: number[] = [];
  const briHist: number[] = [];
  const actBgHist: number[] = [];
  const contrastHist: number[] = [];
  const vyHist: number[] = [];

  let latest: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    if (!latest?.video) return;
    const {
      video: out,
      fps = 0,
      sourceLabel,
      resLabel,
      synth,
      histBins,
    } = latest;

    _setMonitorAccent(host, out);

    // Hue readout
    refs.hueV.textContent = out.hue.toFixed(0).padStart(3, "0");
    refs.hueN.textContent = hueName(out.hue);
    refs.huemark.style.setProperty(
      "--hue-marker-pos",
      `${(out.hue / 360) * 100}%`,
    );

    if (histBins) _updateHistogram(refs.huehist, histBins);

    _paintVideoSignals(refs, out, synth ?? null);

    _drawSpark(refs.sparkAct, actHist, host);
    _drawSpark(refs.sparkActBg, actBgHist, host);
    _drawSpark(refs.sparkBri, briHist, host);
    _drawSpark(refs.sparkContrast, contrastHist, host);
    _drawSpark(refs.sparkVy, vyHist, host);
  }
  requestAnimationFrame(paint);

  return {
    onMsg(msg) {
      latest = msg;
      if (msg.video) {
        const sparkLen = CONFIG.sparkLen;
        const push = (arr: number[], v: number) => {
          arr.push(v);
          if (arr.length > sparkLen) arr.shift();
        };
        push(actHist, msg.video.act);
        push(briHist, msg.video.bri);
        push(actBgHist, msg.video.actBg);
        push(contrastHist, Math.min(1, msg.video.contrast * 2));
        push(vyHist, 1 - msg.video.vy);
      }
    },
  };
}

// ── Audio Monitor ─────────────────────────────────────────────────────────────

// Helper: build multi-stop oklch gradient string for a hue arc [h0, h1]
function _arcGradient(h0: number, h1: number): string {
  const arc = h1 - h0;
  const stops = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `oklch(0.65 0.22 ${(h0 + arc * t).toFixed(1)})`)
    .join(", ");
  return `linear-gradient(to right in oklch, ${stops})`;
}

export function mountAudioMonitor(host: HTMLElement): {
  onMsg(msg: TelemetryMsg): void;
} {
  const mk = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // ── Header + chord value line ─────────────────────────────────
  const chromaHdr = mk("div", "panel__label", "HEARD CHROMA");
  const chordVal = mk("div", "panel__value");
  const chordNumeral = mk("span", undefined, "\u2014");
  const chordRoot = mk("span", "panel__unit", "\u2014");
  chordVal.append(chordNumeral, chordRoot);

  // ── Spectrum bar (mirrors SEEN CHROMA huebar) ─────────────────
  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  // ── Chord-region bars ─────────────────────────────────────────
  const chromaContainer = mk("div", "chroma chroma--flex");

  host.append(chromaHdr, chordVal, huebar, chromaContainer);

  // ── Chord bar DOM (rebuild on harmony changes) ────────────────
  let chromaBars: HTMLElement[] = [];
  let currentPalette = _buildPalette();

  function _buildPalette(): Palette | null {
    const paletteStr = store.get("harmony.palette");
    if (!paletteStr) return null;
    try {
      return Palette.fromURLParam(paletteStr as string, {
        rootHue: store.get("harmony.rootHue") ?? 0,
        crossZone: store.get("harmony.crossZone"),
      });
    } catch {
      return null;
    }
  }

  function rebuildChromaDOM(): void {
    chromaContainer.innerHTML = "";
    chromaBars = [];

    if (currentPalette) {
      const N = currentPalette.slots.length;
      chromaBars = new Array(N);

      const sorted = currentPalette.slots
        .map((slot, i) => {
          let h0 = currentPalette!.slotBoundaryHues[i];
          let h1 =
            currentPalette!.slotBoundaryHues[i + 1] ??
            currentPalette!.slotBoundaryHues[0];
          if (h1 <= h0) h1 += 360;
          const arc = h1 - h0;
          return { slotIdx: i, h0, h1, arc, label: slot.chord.label };
        })
        .sort((a, b) => a.h0 - b.h0);

      const totalArc = sorted.reduce((s, e) => s + e.arc, 0) || 360;

      for (const { slotIdx, h0, h1, arc, label } of sorted) {
        const cell = document.createElement("div");
        cell.className = "chroma__cell";
        cell.style.flex = String((arc / totalArc) * N);
        const bar = document.createElement("div");
        bar.className = "chroma__bar";
        bar.style.background = _arcGradient(h0, h1);
        cell.appendChild(bar);
        const lbl = document.createElement("div");
        lbl.className = "chroma__lbl";
        lbl.textContent = label;
        cell.appendChild(lbl);
        chromaContainer.appendChild(cell);
        chromaBars[slotIdx] = bar;
      }
    }
  }

  rebuildChromaDOM();

  for (const k of [
    "harmony.rootHue",
    "harmony.palette",
    "harmony.crossZone",
  ] as const) {
    store.subscribeKey(k, () => {
      currentPalette = _buildPalette();
      rebuildChromaDOM();
    });
  }

  // ── Paint loop ────────────────────────────────────────────────
  let latestMsg: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    if (!latestMsg?.audio) return;
    const audio = latestMsg.audio;

    // Heard hue indicator on spectrum bar
    huemark.style.setProperty(
      "--hue-marker-pos",
      `${((audio.hue ?? 0) / 360) * 100}%`,
    );

    // Chord label
    if (audio.chord.label) {
      chordNumeral.textContent = "—";
      chordRoot.textContent = audio.chord.label;
    } else {
      chordNumeral.textContent = "—";
      chordRoot.textContent = "—";
    }

    // Chord-region bar heights
    const weights = audio.slots as Float32Array;
    for (let i = 0; i < weights.length; i++) {
      const bar = chromaBars[i];
      if (bar) bar.style.height = `${((weights[i] ?? 0) * 100).toFixed(1)}%`;
    }
  }
  requestAnimationFrame(paint);

  return {
    onMsg(msg) {
      latestMsg = msg;
    },
  };
}
