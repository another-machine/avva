/**
 * controller/monitors.ts
 *
 * Per-stage telemetry monitors for the 4-column controller.
 * Each mount* function populates a host element and returns { onMsg }.
 */

import { store } from "../src/store/store.js";
import { legacyConfig as CONFIG } from "../src/store/legacy-config.js";
import { Palette } from "../src/harmony/palette.js";
import { hueName } from "../src/analysis/color.js";
import { toPerceptual } from "../src/harmony/hue-perception.js";
import type { AnalysisOut } from "../src/analysis/analyzer.js";
import type { TelemetryMsg } from "../src/store/telemetry.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function _setAccent(host: HTMLElement, out: AnalysisOut): void {
  const l = (0.55 + out.bri * 0.2).toFixed(3);
  const c = (0.04 + out.sat * 0.18).toFixed(3);
  const h = out.hue.toFixed(1);
  host.style.setProperty("--accent-l", l);
  host.style.setProperty("--accent-c", c);
  host.style.setProperty("--accent-h", h);
  host.style.setProperty("--color-accent", `oklch(${l} ${c} ${h})`);
}

function _accentColor(host: HTMLElement): string {
  const l = host.style.getPropertyValue("--accent-l") || "0.65";
  const c = host.style.getPropertyValue("--accent-c") || "0.15";
  const h = host.style.getPropertyValue("--accent-h") || "0";
  return `oklch(${l} ${c} ${h})`;
}

function _drawSpark(canvas: HTMLCanvasElement, data: number[], host: HTMLElement): void {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  if (canvas.width !== Math.round(r.width)) {
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
  }
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
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
  ctx.shadowBlur = 0;
  ctx.fillStyle = accent;
  ctx.beginPath();
  const lx = ((data.length - 1) / (sparkLen - 1)) * w;
  const ly = h - data[data.length - 1] * (h - 2) - 1;
  ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function _arcGradient(h0: number, h1: number): string {
  const arc = h1 - h0;
  const stops = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `oklch(0.65 0.22 ${(h0 + arc * t).toFixed(1)})`)
    .join(", ");
  return `linear-gradient(to right in oklch, ${stops})`;
}

function _meterRow(lbl: string, wideVal = false): { row: HTMLElement; fill: HTMLElement; val: HTMLElement } {
  const row = mk("div", "sig__row");
  row.appendChild(mk("span", "sig__lbl", lbl));
  const meter = mk("div", "meter");
  const fill = mk("div", "meter__fill");
  meter.appendChild(fill);
  row.appendChild(meter);
  const val = mk("span", wideVal ? "sig__val sig__val--wide" : "sig__val");
  row.appendChild(val);
  return { row, fill, val };
}

function _buildPalette(): Palette | null {
  const s = store.get("harmony.palette");
  if (!s) return null;
  try {
    return Palette.fromURLParam(s as string, {
      rootHue: toPerceptual(store.get("harmony.rootHue") ?? 0),
      crossZone: store.get("harmony.crossZone"),
    });
  } catch { return null; }
}

// ── Stage 1 — Video Analysis ──────────────────────────────────────────────────

export function mountVideoAnalysisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // Compact status row: running dot + chord label (no large display)
  const statusRow = mk("div", "sig__key-row");
  const sigDot = mk("span", "sig__dot");
  const sigChordLbl = mk("span", "sig__status-lbl", "—");
  statusRow.append(sigDot, sigChordLbl);

  // Sparklines (labelled)
  const sparksHdr = mk("div", "sig__hdr", "SIGNAL HISTORY");
  const sparksDiv = mk("div", "sig__sparks sig__sparks--labelled");
  const sparkRows = [
    { label: "ACT", canvas: mk("canvas", "spark") },
    { label: "BG",  canvas: mk("canvas", "spark") },
    { label: "BRI", canvas: mk("canvas", "spark") },
    { label: "CTR", canvas: mk("canvas", "spark") },
    { label: "VY",  canvas: mk("canvas", "spark") },
  ];
  for (const { label, canvas } of sparkRows) {
    const row = mk("div", "spark-row");
    row.append(mk("span", "spark-row__lbl", label), canvas);
    sparksDiv.appendChild(row);
  }
  const [sparkAct, sparkActBg, sparkBri, sparkContrast, sparkVy] = sparkRows.map((r) => r.canvas);

  // Scene meters
  const sceneHdr = mk("div", "sig__hdr", "SCENE");
  const mBri = _meterRow("BRI");
  const mAct = _meterRow("ACT");
  const mBg  = _meterRow("BG");
  const mCtr = _meterRow("CTR");
  const mSpr = _meterRow("SPR");

  // Position tracks
  const mxTrack = mk("div", "pos-track");
  const mxMarker = mk("div", "pos-track__marker");
  const mxVal = mk("span", "sig__val");
  mxTrack.appendChild(mxMarker);
  const mxRow = mk("div", "sig__row sig__row--pos");
  mxRow.append(mk("span", "sig__lbl", "MX"), mxTrack, mxVal);

  const vyTrack = mk("div", "pos-track");
  const vyMarker = mk("div", "pos-track__marker");
  const vyVal = mk("span", "sig__val");
  vyTrack.appendChild(vyMarker);
  const vyRow = mk("div", "sig__row sig__row--pos");
  vyRow.append(mk("span", "sig__lbl", "VY"), vyTrack, vyVal);

  // Hue section
  const hueLabel = mk("div", "panel__label", "SEEN CHROMA");
  const hueValDiv = mk("div", "panel__value");
  const hueV = mk("span", undefined, "—");
  const hueN = mk("span", "panel__unit");
  hueValDiv.append(hueV, mk("span", "panel__unit", "°"), hueN);

  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  const huehist = mk("div", "huehist");
  let histPalette = _buildPalette();

  function _rebuildHistBars(): void {
    huehist.innerHTML = "";
    const n = histPalette?.slots.length ?? CONFIG.hueBins;
    const boundaryHues = histPalette?.slotBoundaryHues;
    for (let i = 0; i < n; i++) {
      const bar = mk("span", "huehist__bar");
      const hDeg = boundaryHues
        ? boundaryHues[i].toFixed(0)
        : ((i / n) * 360).toFixed(0);
      bar.style.background = `oklch(0.65 0.22 ${hDeg})`;
      huehist.appendChild(bar);
    }
  }
  _rebuildHistBars();

  for (const k of ["harmony.rootHue", "harmony.palette", "harmony.crossZone"] as const) {
    store.subscribeKey(k, () => {
      histPalette = _buildPalette();
      _rebuildHistBars();
    });
  }

  host.append(
    hueLabel, hueValDiv, huebar, huehist,
    mk("div", "sig__divider"),
    statusRow,
    mk("div", "sig__divider"),
    sceneHdr,
    mBri.row, mAct.row, mBg.row, mCtr.row, mSpr.row,
    mxRow, vyRow,
    mk("div", "sig__divider"),
    sparksHdr, sparksDiv,
  );

  const actHist: number[] = [], briHist: number[] = [],
        actBgHist: number[] = [], contrastHist: number[] = [], vyHist: number[] = [];
  let latest: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    if (!latest?.video) return;
    const { video: out, synth, histBins } = latest;
    const pct = (v: number, scale = 1) => `${Math.min(100, v * scale * 100).toFixed(1)}%`;

    _setAccent(host, out);

    hueV.textContent = out.hue.toFixed(0).padStart(3, "0");
    hueN.textContent = hueName(out.hue);
    huemark.style.setProperty("--hue-marker-pos", `${(out.hue / 360) * 100}%`);
    if (histBins) {
      const bars = huehist.children;
      const n = bars.length;
      if (n > 0) {
        // Aggregate fine histBins into n slot buckets
        const buckets = new Float32Array(n);
        const hb = histBins.length;
        for (let j = 0; j < hb; j++) {
          buckets[Math.floor((j / hb) * n)] += histBins[j];
        }
        let mx = 0.0001;
        for (let i = 0; i < n; i++) if (buckets[i] > mx) mx = buckets[i];
        for (let i = 0; i < n; i++)
          (bars[i] as HTMLElement).style.height = `${2 + (buckets[i] / mx) * 32}px`;
      }
    }

    mBri.fill.style.width = pct(out.bri);    mBri.val.textContent = (out.bri * 100).toFixed(0);
    mAct.fill.style.width = pct(out.act);    mAct.val.textContent = (out.act * 100).toFixed(0);
    mBg.fill.style.width  = pct(out.actBg);  mBg.val.textContent  = (out.actBg * 100).toFixed(0);
    mCtr.fill.style.width = pct(out.contrast, 2); mCtr.val.textContent = (out.contrast * 100).toFixed(0);
    mSpr.fill.style.width = pct(out.spread); mSpr.val.textContent = (out.spread * 100).toFixed(0);
    mxMarker.style.left = `${(out.mx * 100).toFixed(1)}%`;
    mxVal.textContent = ((out.mx * 2 - 1) * 100).toFixed(0);
    vyMarker.style.left = `${(out.vy * 100).toFixed(1)}%`;
    vyVal.textContent = (out.vy * 100).toFixed(0);

    const running = synth?.running ?? false;
    sigDot.classList.toggle("is-on", running);
    sigChordLbl.textContent = synth?.note?.label ?? synth?.keyLabel ?? "—";

    _drawSpark(sparkAct, actHist, host);
    _drawSpark(sparkActBg, actBgHist, host);
    _drawSpark(sparkBri, briHist, host);
    _drawSpark(sparkContrast, contrastHist, host);
    _drawSpark(sparkVy, vyHist, host);
  }
  requestAnimationFrame(paint);

  return {
    onMsg(msg) {
      latest = msg;
      if (msg.video) {
        const L = CONFIG.sparkLen;
        const push = (a: number[], v: number) => { a.push(v); if (a.length > L) a.shift(); };
        push(actHist, msg.video.act);
        push(briHist, msg.video.bri);
        push(actBgHist, msg.video.actBg);
        push(contrastHist, Math.min(1, msg.video.contrast * 2));
        push(vyHist, 1 - msg.video.vy);
      }
    },
  };
}

// ── Stage 2 — Sound Synthesis ─────────────────────────────────────────────────

export function mountSoundSynthesisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // Running status
  const statusRow = mk("div", "sig__key-row");
  const sigDot = mk("span", "sig__dot");
  const sigLabel = mk("span", undefined, "—");
  statusRow.append(sigDot, sigLabel);

  // Chord / voice gates
  const synthHdr = mk("div", "sig__hdr", "VOICE GATES");
  const pillsRow = mk("div", "synth-pills");
  const pillLabels = ["R", "3", "5", "7", "9"];
  const pills = pillLabels.map((lbl) => {
    const pill = mk("div", "synth-pill");
    pill.textContent = lbl;
    pillsRow.appendChild(pill);
    return pill;
  });

  // Tier amplitude meters
  const tierHdr = mk("div", "sig__hdr", "TIER AMPLITUDE");
  const mBass = _meterRow("BASS");
  const mMid  = _meterRow("MID");
  const mTre  = _meterRow("TRE");

  // FM index bars
  const fmHdr = mk("div", "sig__hdr", "FM INDEX");
  const fmBass = _meterRow("FM-B", true);
  const fmMid  = _meterRow("FM-M", true);
  const fmTre  = _meterRow("FM-T", true);

  // Glide tau
  const glideHdr = mk("div", "sig__hdr", "GLIDE");
  const glideRow = mk("div", "sig__row");
  glideRow.appendChild(mk("span", "sig__lbl", "TAU"));
  const glideMeter = mk("div", "meter");
  const glideFill = mk("div", "meter__fill");
  glideMeter.appendChild(glideFill);
  const glideVal = mk("span", "sig__val sig__val--wide");
  glideRow.appendChild(glideMeter);
  glideRow.appendChild(glideVal);

  // Pluck LED
  const pluckRow = mk("div", "sig__key-row");
  const pluckLed = mk("span", "sig__dot");
  pluckRow.append(pluckLed, mk("span", undefined, "PLUCK"));

  host.append(
    statusRow,
    mk("div", "sig__divider"),
    synthHdr, pillsRow,
    mk("div", "sig__divider"),
    tierHdr, mBass.row, mMid.row, mTre.row,
    mk("div", "sig__divider"),
    fmHdr, fmBass.row, fmMid.row, fmTre.row,
    mk("div", "sig__divider"),
    glideHdr, glideRow,
    mk("div", "sig__divider"),
    pluckRow,
  );

  let latest: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    const sc = latest?.synthControls;
    const running = latest?.synth?.running ?? false;

    sigDot.classList.toggle("is-on", running);
    sigLabel.textContent = sc?.slotLabel ?? (running ? "…" : "—");

    if (!sc) return;
    const pct = (v: number) => `${Math.min(100, v * 100).toFixed(1)}%`;

    // Pill opacity: root always full, others by weight
    const gates = [1, sc.thirdW, sc.fifthW, sc.seventhW, sc.ninthW];
    for (let i = 0; i < pills.length; i++) {
      pills[i].style.opacity = String(0.15 + gates[i] * 0.85);
      pills[i].style.borderColor = `oklch(0.65 0.22 ${(i * 72).toFixed(0)})`;
    }

    mBass.fill.style.width = pct(sc.bassW);   mBass.val.textContent = (sc.bassW * 100).toFixed(0);
    mMid.fill.style.width  = pct(sc.midW);    mMid.val.textContent  = (sc.midW * 100).toFixed(0);
    mTre.fill.style.width  = pct(sc.trebleW); mTre.val.textContent  = (sc.trebleW * 100).toFixed(0);

    // FM index: scale 0..10 → 0..100%
    fmBass.fill.style.width = `${Math.min(100, sc.fmIndexBass * 10).toFixed(1)}%`;
    fmBass.val.textContent = sc.fmIndexBass.toFixed(1);
    fmMid.fill.style.width  = `${Math.min(100, sc.fmIndexMid * 10).toFixed(1)}%`;
    fmMid.val.textContent = sc.fmIndexMid.toFixed(1);
    fmTre.fill.style.width  = `${Math.min(100, sc.fmIndexTreble * 10).toFixed(1)}%`;
    fmTre.val.textContent = sc.fmIndexTreble.toFixed(1);

    // Glide tau: 0..500ms → 0..100%
    glideFill.style.width = `${Math.min(100, (sc.glideTau / 0.5) * 100).toFixed(1)}%`;
    glideVal.textContent = (sc.glideTau * 1000).toFixed(0) + "ms";

    pluckLed.classList.toggle("is-on", sc.pluckFired);
  }
  requestAnimationFrame(paint);

  return { onMsg(msg) { latest = msg; } };
}

// ── Stage 3 — Audio Analysis ──────────────────────────────────────────────────

export function mountAudioAnalysisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // HEARD CHROMA header + chord value
  const chromaHdr = mk("div", "panel__label", "HEARD CHROMA");
  const chordVal = mk("div", "panel__value");
  const chordNumeral = mk("span", undefined, "—");
  const chordRoot = mk("span", "panel__unit", "—");
  const stickyDot = mk("span", "sticky-dot");
  chordVal.append(chordNumeral, chordRoot, stickyDot);

  // Huebar + marker
  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  // Chroma-12 ring (canvas)
  const ringLabel = mk("div", "sig__hdr", "CHROMA RING");
  const ringCanvas = mk("canvas", "chroma-ring");
  ringCanvas.width = 140;
  ringCanvas.height = 140;

  // 60-note grid
  const gridLabel = mk("div", "sig__hdr", "NOTES");
  const noteGrid = mk("div", "note-grid");
  let noteGridBuilt = false;
  let noteCells: HTMLElement[] = [];
  // noteInfoIdx[octaveRank][pc] → index into audio.notes[] (built once)
  let noteLookup: Int16Array | null = null;

  // Chord score breakdown
  const scoresLabel = mk("div", "sig__hdr", "SLOT SCORES");
  const scoresContainer = mk("div", "score-bars");
  let scoreBars: { fill: HTMLElement; row: HTMLElement }[] = [];
  let currentPalette = _buildPalette();

  function rebuildScoresDOM(): void {
    scoresContainer.innerHTML = "";
    scoreBars = [];
    if (!currentPalette) return;
    for (let i = 0; i < currentPalette.slots.length; i++) {
      const slot = currentPalette.slots[i];
      const row = mk("div", "score-bar");
      const lbl = mk("span", "score-bar__lbl", slot.chord.label);
      const track = mk("div", "score-bar__track");
      const fill = mk("div", "score-bar__fill");
      const h0 = currentPalette.slotBoundaryHues[i];
      fill.style.background = `oklch(0.65 0.22 ${h0.toFixed(0)})`;
      track.appendChild(fill);
      row.append(lbl, track);
      scoresContainer.appendChild(row);
      scoreBars.push({ fill, row });
    }
  }
  rebuildScoresDOM();

  for (const k of ["harmony.rootHue", "harmony.palette", "harmony.crossZone"] as const) {
    store.subscribeKey(k, () => {
      currentPalette = _buildPalette();
      rebuildScoresDOM();
    });
  }

  // Chord-change sparkline
  const sparkLabel = mk("div", "sig__hdr", "CHORD CHANGES");
  const chordSparkCanvas = mk("canvas", "spark");
  const chordChangeSpark = mk("div", "chord-spark-wrap");
  chordChangeSpark.appendChild(chordSparkCanvas);

  host.append(
    chromaHdr, chordVal, huebar,
    mk("div", "sig__divider"),
    ringLabel, ringCanvas,
    mk("div", "sig__divider"),
    gridLabel, noteGrid,
    mk("div", "sig__divider"),
    scoresLabel, scoresContainer,
    mk("div", "sig__divider"),
    sparkLabel, chordChangeSpark,
  );

  const chordIdxHist: number[] = [];
  let latestMsg: TelemetryMsg | null = null;

  function _buildNoteGrid(noteInfo: { chromatic: number; octave: number; name: string }[]): void {
    if (noteGridBuilt) return;
    noteGridBuilt = true;
    noteGrid.innerHTML = "";
    noteCells = [];
    const octaves = [...new Set(noteInfo.map((n) => n.octave))].sort((a, b) => b - a);
    // lookup[octRank * 12 + pc] = index into notes[]
    noteLookup = new Int16Array(octaves.length * 12).fill(-1);
    for (let oi = 0; oi < octaves.length; oi++) {
      const oct = octaves[oi];
      const rowEl = mk("div", "note-grid__row");
      rowEl.setAttribute("data-oct", String(oct));
      for (let pc = 0; pc < 12; pc++) {
        const idx = noteInfo.findIndex((n) => n.octave === oct && n.chromatic === pc);
        noteLookup[oi * 12 + pc] = idx;
        const cell = mk("div", "note-grid__cell");
        cell.style.background = `oklch(0.65 0.22 ${(pc * 30).toFixed(0)})`;
        if (idx >= 0) cell.title = `${noteInfo[idx].name}${oct}`;
        rowEl.appendChild(cell);
        noteCells.push(cell);
      }
      noteGrid.appendChild(rowEl);
    }
  }

  function _drawRing(frame: NonNullable<TelemetryMsg["audio"]>): void {
    const ctx = ringCanvas.getContext("2d");
    if (!ctx) return;
    const W = ringCanvas.width, H = ringCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const rOuter = cx - 4, rInner = rOuter * 0.45;
    const chroma = frame.chroma;

    for (let pc = 0; pc < 12; pc++) {
      const v = chroma[pc] ?? 0;
      const startAngle = (pc / 12) * Math.PI * 2 - Math.PI / 2;
      const endAngle = ((pc + 1) / 12) * Math.PI * 2 - Math.PI / 2;
      const r = rInner + (rOuter - rInner) * (0.3 + v * 0.7);
      const hDeg = pc * 30;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(startAngle) * rInner, cy + Math.sin(startAngle) * rInner);
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.arc(cx, cy, rInner, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = `oklch(0.65 0.22 ${hDeg})`;
      ctx.globalAlpha = 0.25 + v * 0.75;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Center label: top-1 pitch class
    let maxPc = 0, maxV = -1;
    for (let i = 0; i < 12; i++) if ((chroma[i] ?? 0) > maxV) { maxV = chroma[i]; maxPc = i; }
    const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    ctx.fillStyle = "#e8e6e0";
    ctx.globalAlpha = maxV > 0.05 ? 1 : 0.3;
    ctx.font = "bold 14px 'Space Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(NOTE_NAMES[maxPc], cx, cy);
    ctx.globalAlpha = 1;
  }

  function paint() {
    requestAnimationFrame(paint);
    if (!latestMsg?.audio) return;
    const audio = latestMsg.audio;

    // Build note grid on first frame
    if (!noteGridBuilt && audio.noteInfo?.length) _buildNoteGrid(audio.noteInfo);

    // Huebar marker
    huemark.style.setProperty("--hue-marker-pos", `${((audio.hue ?? 0) / 360) * 100}%`);

    // Chord label + sticky dot
    chordNumeral.textContent = audio.chord.label ? audio.chord.label : "—";
    chordRoot.textContent = "";
    stickyDot.classList.toggle("is-on", audio.stickyApplied ?? false);

    // Chroma-12 ring
    _drawRing(audio);

    // 60-note grid
    if (noteGridBuilt && noteLookup && audio.notes) {
      for (let i = 0; i < noteCells.length; i++) {
        const noteIdx = noteLookup[i];
        const v = noteIdx >= 0 ? (audio.notes[noteIdx] ?? 0) : 0;
        noteCells[i].style.opacity = String(0.06 + v * 0.94);
      }
    }

    // Chord score breakdown
    if (audio.slots && scoreBars.length === audio.slots.length) {
      const slots = audio.slots;
      let best = 0;
      for (let i = 0; i < slots.length; i++) if (slots[i] > best) best = slots[i];
      const threshold = best * 0.9;
      for (let i = 0; i < scoreBars.length; i++) {
        const v = slots[i] ?? 0;
        const { fill, row } = scoreBars[i];
        fill.style.width = `${(v * 100).toFixed(1)}%`;
        row.classList.toggle("score-bar--winner", v === best && best > 0.01);
        row.classList.toggle("score-bar--sticky-zone", audio.stickyApplied && v >= threshold && v !== best);
      }
    }

    // Chord-change sparkline
    const L = CONFIG.sparkLen;
    if (audio.chord?.change) {
      chordIdxHist.push(1);
    } else {
      chordIdxHist.push(0);
    }
    if (chordIdxHist.length > L) chordIdxHist.shift();
    _drawChordSpark(chordSparkCanvas, chordIdxHist, audio.chord.change ?? false);
  }
  requestAnimationFrame(paint);

  function _drawChordSpark(canvas: HTMLCanvasElement, data: number[], flash: boolean): void {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return;
    if (canvas.width !== Math.round(r.width)) { canvas.width = Math.round(r.width); canvas.height = Math.round(r.height); }
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const L = CONFIG.sparkLen;
    // Draw vertical tick marks for chord changes
    ctx.strokeStyle = flash ? "#fff" : "rgba(232,230,224,0.4)";
    ctx.lineWidth = flash ? 2 : 1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0.5) {
        const x = (i / (L - 1)) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
    // Baseline
    ctx.strokeStyle = "rgba(232,230,224,0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
  }

  return { onMsg(msg) { latestMsg = msg; } };
}

// ── Stage 4 — Visual Synthesis ────────────────────────────────────────────────

export function mountVisualSynthesisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // Winner status row (mirrors Stage 2 compact header)
  const statusRow = mk("div", "sig__key-row");
  const sigDot = mk("span", "sig__dot");
  const sigLabel = mk("span", "sig__status-lbl", "—");
  statusRow.append(sigDot, sigLabel);

  // Slot weights (visual renderer EMA) vs audio slots (raw)
  const weightsHdr = mk("div", "sig__hdr", "SLOT WEIGHTS");
  const weightsContainer = mk("div", "score-bars");
  let weightBars: { fill: HTMLElement; rawFill: HTMLElement; row: HTMLElement }[] = [];
  let currentPalette = _buildPalette();

  function rebuildWeightsDOM(): void {
    weightsContainer.innerHTML = "";
    weightBars = [];
    if (!currentPalette) return;
    for (let i = 0; i < currentPalette.slots.length; i++) {
      const slot = currentPalette.slots[i];
      const h0 = currentPalette.slotBoundaryHues[i];
      const row = mk("div", "score-bar");
      const lbl = mk("span", "score-bar__lbl", slot.chord.label);
      const track = mk("div", "score-bar__track score-bar__track--dual");
      const fill = mk("div", "score-bar__fill");
      fill.style.background = `oklch(0.65 0.22 ${h0.toFixed(0)})`;
      const rawFill = mk("div", "score-bar__fill score-bar__fill--raw");
      rawFill.style.background = `oklch(0.45 0.12 ${h0.toFixed(0)})`;
      track.append(rawFill, fill);
      row.append(lbl, track);
      weightsContainer.appendChild(row);
      weightBars.push({ fill, rawFill, row });
    }
  }
  rebuildWeightsDOM();

  for (const k of ["harmony.rootHue", "harmony.palette", "harmony.crossZone"] as const) {
    store.subscribeKey(k, () => {
      currentPalette = _buildPalette();
      rebuildWeightsDOM();
    });
  }

  // Pulse sparkline
  const pulseHdr = mk("div", "sig__hdr", "PULSE");
  const pulseCanvas = mk("canvas", "spark");
  const pulseWrap = mk("div", "chord-spark-wrap");
  pulseWrap.appendChild(pulseCanvas);

  // GL param readouts
  const paramsHdr = mk("div", "sig__hdr", "RENDER PARAMS");
  const mFeedback  = _meterRow("FEED");
  const mBlobWarp  = _meterRow("WARP");
  const mBlobSpeed = _meterRow("SPD");
  const mBri       = _meterRow("BRI");
  const mSpread    = _meterRow("SPR");
  const mAct       = _meterRow("ACT");
  const mBandLo    = _meterRow("LO");
  const mBandHi    = _meterRow("HI");

  host.append(
    statusRow,
    mk("div", "sig__divider"),
    weightsHdr, weightsContainer,
    mk("div", "sig__divider"),
    pulseHdr, pulseWrap,
    mk("div", "sig__divider"),
    paramsHdr,
    mFeedback.row, mBlobWarp.row, mBlobSpeed.row,
    mBri.row, mSpread.row, mAct.row, mBandLo.row, mBandHi.row,
  );

  const pulseHist: number[] = [];
  let latestMsg: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    const vu = latestMsg?.visualUniforms;
    const audio = latestMsg?.audio;
    const pct = (v: number) => `${Math.min(100, v * 100).toFixed(1)}%`;

    if (vu) {
      // Winner: slot with highest EMA weight
      let winnerIdx = -1, winnerW = 0;
      for (let i = 0; i < vu.slotWeights.length; i++) {
        if (vu.slotWeights[i] > winnerW) { winnerW = vu.slotWeights[i]; winnerIdx = i; }
      }
      const active = winnerW > 0.01;
      sigDot.classList.toggle("is-on", active);
      sigLabel.textContent = (active && currentPalette && winnerIdx >= 0)
        ? currentPalette.slots[winnerIdx]?.chord.label ?? "—"
        : "—";

      // Slot weight bars: fill = EMA-smoothed, rawFill = raw audio slots
      if (weightBars.length === vu.slotWeights.length) {
        for (let i = 0; i < weightBars.length; i++) {
          const { fill, rawFill, row } = weightBars[i];
          fill.style.width = pct(vu.slotWeights[i] ?? 0);
          if (audio?.slots) rawFill.style.width = pct(audio.slots[i] ?? 0);
          row.classList.toggle("score-bar--winner", i === winnerIdx && active);
        }
      }

      // Pulse sparkline
      const L = CONFIG.sparkLen;
      pulseHist.push(vu.pulse);
      if (pulseHist.length > L) pulseHist.shift();

      // Fake a host accent from vu.bri for spark colour
      const fakeHost = pulseWrap as HTMLElement;
      fakeHost.style.setProperty("--accent-l", "0.65");
      fakeHost.style.setProperty("--accent-c", "0.2");
      fakeHost.style.setProperty("--accent-h", "200");
      _drawSpark(pulseCanvas, pulseHist.map((v) => Math.min(1, v)), fakeHost);

      mBri.fill.style.width    = pct(vu.bri);    mBri.val.textContent    = vu.bri.toFixed(2);
      mSpread.fill.style.width = pct(vu.spread);  mSpread.val.textContent = vu.spread.toFixed(2);
      mAct.fill.style.width    = pct(vu.act);     mAct.val.textContent    = vu.act.toFixed(2);
      mBandLo.fill.style.width = pct(vu.bandLo);  mBandLo.val.textContent = vu.bandLo.toFixed(2);
      mBandHi.fill.style.width = pct(vu.bandHi);  mBandHi.val.textContent = vu.bandHi.toFixed(2);
    }

    // Store-driven render params (no telemetry needed)
    const feedback  = store.get("audio.feedback")  as number ?? 0;
    const blobWarp  = store.get("audio.blobWarp")   as number ?? 0;
    const blobSpeed = store.get("audio.blobSpeed")  as number ?? 0;
    mFeedback.fill.style.width  = pct(feedback);   mFeedback.val.textContent  = feedback.toFixed(2);
    mBlobWarp.fill.style.width  = pct(blobWarp);   mBlobWarp.val.textContent  = blobWarp.toFixed(2);
    mBlobSpeed.fill.style.width = pct(blobSpeed);  mBlobSpeed.val.textContent = blobSpeed.toFixed(2);
  }
  requestAnimationFrame(paint);

  return { onMsg(msg) { latestMsg = msg; } };
}
