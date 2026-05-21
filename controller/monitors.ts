/**
 * controller/monitors.ts
 *
 * Per-stage telemetry monitors for the 4-column controller.
 * Each mount* function populates a host element and returns { onMsg }.
 */

import { store } from "../src/store/store.js";
import { legacyConfig as CONFIG } from "../src/store/legacy-config.js";
import { Palette } from "../src/harmony/palette.js";
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

function _deltaFill(audioVal: number, videoVal: number | undefined): string {
  if (videoVal === undefined) return "";
  const delta = Math.abs(audioVal - videoVal);
  // ≤0.05 → green (145), ≥0.3 → red (0), linearly interpolated
  const t = Math.min(1, Math.max(0, (delta - 0.05) / 0.25));
  return `oklch(0.72 0.18 ${(145 * (1 - t)).toFixed(1)})`;
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
      rootHue: store.get("harmony.rootHue") as number ?? 0,
      crossZone: store.get("harmony.crossZone"),
    });
  } catch { return null; }
}

/**
 * Returns visual-position → slot-index for histogram bars.
 * Slots are sorted by perceptual hue so they line up with the underlying
 * spectrum gradient regardless of rootHue rotation.
 */
function _slotVisualOrder(palette: Palette | null): number[] {
  if (!palette) return [];
  const n = palette.slots.length;
  const perceptual = new Float32Array(n);
  for (let i = 0; i < n; i++) perceptual[i] = toPerceptual(palette.slotHues[i]);
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => perceptual[a] - perceptual[b]);
  return order;
}

// ── Stage 1 — Video Analysis ──────────────────────────────────────────────────

export function mountVideoAnalysisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // Sparklines (labelled) — canonical axes: BRI / FLUX / SPR / CTR / TILT
  const sparksHdr = mk("div", "sig__hdr", "SIGNAL HISTORY");
  const sparksDiv = mk("div", "sig__sparks sig__sparks--labelled");
  const sparkRows = [
    { label: "BRI",  canvas: mk("canvas", "spark") },
    { label: "FLUX", canvas: mk("canvas", "spark") },
    { label: "SPR",  canvas: mk("canvas", "spark") },
    { label: "CTR",  canvas: mk("canvas", "spark") },
    { label: "TILT", canvas: mk("canvas", "spark") },
    { label: "SAT",  canvas: mk("canvas", "spark") },
  ];
  for (const { label, canvas } of sparkRows) {
    const row = mk("div", "spark-row");
    row.append(mk("span", "spark-row__lbl", label), canvas);
    sparksDiv.appendChild(row);
  }
  const [sparkBri, sparkFlux, sparkSpr, sparkCtr, sparkTilt, sparkSat] = sparkRows.map((r) => r.canvas);

  // Scene meters — canonical: BRI / FLUX / SPR / CTR / TILT / SAT
  const sceneHdr = mk("div", "sig__hdr", "SCENE");
  const mBri  = _meterRow("BRI");
  const mFlux = _meterRow("FLUX");
  const mSpr  = _meterRow("SPR");
  const mCtr  = _meterRow("CTR");
  const mTilt = _meterRow("TILT");
  const mSat  = _meterRow("SAT");

  // Position track — POS (horizontal centroid)
  const posTrack = mk("div", "pos-track");
  const posMarker = mk("div", "pos-track__marker");
  const posVal = mk("span", "sig__val");
  posTrack.appendChild(posMarker);
  const posRow = mk("div", "sig__row sig__row--pos");
  posRow.append(mk("span", "sig__lbl", "POS"), posTrack, posVal);

  // Hue section — shows chord label from palette, not raw hue degrees
  const hueLabel = mk("div", "panel__label", "SEEN CHROMA");
  const hueValDiv = mk("div", "panel__value");
  const hueV = mk("span", undefined, "—");
  hueValDiv.append(hueV);

  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  const huehist = mk("div", "huehist");
  const huehistLabels = mk("div", "huehist-labels");
  let histPalette = _buildPalette();
  let histOrder: number[] = _slotVisualOrder(histPalette);

  function _rebuildHistBars(): void {
    huehist.innerHTML = "";
    huehistLabels.innerHTML = "";
    histOrder = _slotVisualOrder(histPalette);
    const n = histPalette?.slots.length ?? 30;
    for (let i = 0; i < n; i++) {
      huehist.appendChild(mk("span", "huehist__bar"));
      const slotIdx = histOrder[i] ?? i;
      const lbl = histPalette ? (histPalette.slots[slotIdx]?.chord.label ?? "") : String(i);
      huehistLabels.appendChild(mk("span", "huehist-labels__lbl", lbl));
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
    hueLabel, hueValDiv, huebar, huehist, huehistLabels,
    mk("div", "sig__divider"),
    sparksHdr, sparksDiv,
    mk("div", "sig__divider"),
    sceneHdr,
    mBri.row, mFlux.row, mSpr.row, mCtr.row, mTilt.row, mSat.row,
    posRow,
  );

  const briHist: number[] = [], fluxHist: number[] = [],
        sprHist: number[] = [], ctrHist: number[] = [], tiltHist: number[] = [],
        satHist: number[] = [];
  let latest: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    if (!latest?.video) return;
    const { video: out, histBins } = latest;
    const pct = (v: number, scale = 1) => `${Math.min(100, v * scale * 100).toFixed(1)}%`;

    _setAccent(host, out);

    // Show chord label for current hue position in palette
    hueV.textContent = histPalette ? histPalette.hueToSlot(out.hue).slot.chord.label : "—";
    // Place marker in perceptual hue space so it lands on the matching gradient color.
    const _percPos = toPerceptual(out.hue);
    huemark.style.setProperty("--hue-marker-pos", `${(_percPos / 360) * 100}%`);
    if (histBins && histPalette) {
      const bars = huehist.children;
      const n = bars.length;
      if (n > 0) {
        // Accumulate energy into palette slot indices (not raw hue buckets).
        // Each histBin midpoint is mapped through hueToSlot so bar[i] always
        // corresponds to the same slot as the label[i] beneath it.
        const buckets = new Float32Array(n);
        const hb = histBins.length;
        for (let j = 0; j < hb; j++) {
          if (histBins[j] <= 0) continue;
          const midHue = ((j + 0.5) / hb) * 360;
          const slotIdx = histPalette.hueToSlot(midHue).slot.index;
          if (slotIdx < n) buckets[slotIdx] += histBins[j];
        }
        let mx = 0.0001;
        for (let i = 0; i < n; i++) if (buckets[i] > mx) mx = buckets[i];
        for (let i = 0; i < n; i++) {
          const slotIdx = histOrder[i] ?? i;
          const emptyH = 32 * (1 - buckets[slotIdx] / mx);
          (bars[i] as HTMLElement).style.height = `${emptyH.toFixed(1)}px`;
        }
      }
    }

    mBri.fill.style.width  = pct(out.bri);          mBri.val.textContent  = (out.bri * 100).toFixed(0);
    mFlux.fill.style.width = pct(out.flux);          mFlux.val.textContent = (out.flux * 100).toFixed(0);
    mSpr.fill.style.width  = pct(out.spread);        mSpr.val.textContent  = (out.spread * 100).toFixed(0);
    mCtr.fill.style.width  = pct(out.contrast, 2);   mCtr.val.textContent  = (out.contrast * 100).toFixed(0);
    mTilt.fill.style.width = pct(out.tilt);          mTilt.val.textContent = (out.tilt * 100).toFixed(0);
    mSat.fill.style.width  = pct(out.sat);           mSat.val.textContent  = (out.sat * 100).toFixed(0);
    posMarker.style.left = `${(out.pos * 100).toFixed(1)}%`;
    posVal.textContent = ((out.pos * 2 - 1) * 100).toFixed(0);

    _drawSpark(sparkBri,  briHist,  host);
    _drawSpark(sparkFlux, fluxHist, host);
    _drawSpark(sparkSpr,  sprHist,  host);
    _drawSpark(sparkCtr,  ctrHist,  host);
    _drawSpark(sparkTilt, tiltHist, host);
    _drawSpark(sparkSat,  satHist,  host);
  }
  requestAnimationFrame(paint);

  return {
    onMsg(msg) {
      latest = msg;
      if (msg.video) {
        const L = CONFIG.sparkLen;
        const push = (a: number[], v: number) => { a.push(v); if (a.length > L) a.shift(); };
        push(briHist,  msg.video.bri);
        push(fluxHist, msg.video.flux);
        push(sprHist,  msg.video.spread);
        push(ctrHist,  Math.min(1, msg.video.contrast * 2));
        push(tiltHist, msg.video.tilt);
        push(satHist,  msg.video.sat);
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

  // Tier amplitude meters
  const tierHdr = mk("div", "sig__hdr", "TIER AMPLITUDE");
  const tierSub = mk("div", "sig__sub", "bass ← lo  ·  mid / tre ← bri + tilt");
  const mBass = _meterRow("BASS");
  const mMid  = _meterRow("MID");
  const mTre  = _meterRow("TRE");

  host.append(
    statusRow,
    mk("div", "sig__divider"),
    tierHdr, tierSub, mBass.row, mMid.row, mTre.row,
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

    mBass.fill.style.width = pct(sc.bassW);   mBass.val.textContent = (sc.bassW * 100).toFixed(0);
    mMid.fill.style.width  = pct(sc.midW);    mMid.val.textContent  = (sc.midW * 100).toFixed(0);
    mTre.fill.style.width  = pct(sc.trebleW); mTre.val.textContent  = (sc.trebleW * 100).toFixed(0);

  }
  requestAnimationFrame(paint);

  return { onMsg(msg) { latest = msg; } };
}

// ── Stage 3 — Audio Analysis ──────────────────────────────────────────────────

export function mountAudioAnalysisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  const NOTE_NAMES_12 = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  // HEARD CHROMA header + chord value
  const chromaHdr = mk("div", "panel__label", "HEARD CHROMA");
  const chordVal = mk("div", "panel__value");
  const chordNumeral = mk("span", undefined, "—");
  chordVal.append(chordNumeral);

  // Huebar + marker
  const huebar = mk("div", "huebar");
  const huemark = mk("div", "huebar__marker");
  huebar.appendChild(huemark);

  // Slot score histogram (huehist-style bars, mirrors Stage 1 histogram)
  const slotHist = mk("div", "huehist");
  const slotHistLabels = mk("div", "huehist-labels");
  let slotHistBars: HTMLElement[] = [];
  let currentPalette = _buildPalette();
  let slotHistOrder: number[] = _slotVisualOrder(currentPalette);

  function rebuildSlotHist(): void {
    slotHist.innerHTML = "";
    slotHistLabels.innerHTML = "";
    slotHistBars = [];
    slotHistOrder = _slotVisualOrder(currentPalette);
    const n = currentPalette?.slots.length ?? 0;
    for (let i = 0; i < n; i++) {
      const bar = mk("span", "huehist__bar");
      slotHist.appendChild(bar);
      slotHistBars.push(bar);
      const slotIdx = slotHistOrder[i] ?? i;
      const lbl = currentPalette?.slots[slotIdx]?.chord.label ?? "";
      slotHistLabels.appendChild(mk("span", "huehist-labels__lbl", lbl));
    }
  }
  rebuildSlotHist();

  for (const k of ["harmony.rootHue", "harmony.palette", "harmony.crossZone"] as const) {
    store.subscribeKey(k, () => { currentPalette = _buildPalette(); rebuildSlotHist(); });
  }

  // Signal history — canonical axes mirroring video: BRI / FLUX / SPR / CTR / TILT
  const sparksHdr3 = mk("div", "sig__hdr", "SIGNAL HISTORY");
  const sparksDiv3 = mk("div", "sig__sparks sig__sparks--labelled");
  const sparkRows3 = [
    { label: "BRI",  canvas: mk("canvas", "spark") },
    { label: "FLUX", canvas: mk("canvas", "spark") },
    { label: "SPR",  canvas: mk("canvas", "spark") },
    { label: "CTR",  canvas: mk("canvas", "spark") },
    { label: "TILT", canvas: mk("canvas", "spark") },
    { label: "SAT",  canvas: mk("canvas", "spark") },
  ];
  const sparkRowEls3: HTMLElement[] = [];
  for (const { label, canvas } of sparkRows3) {
    const row = mk("div", "spark-row");
    row.append(mk("span", "spark-row__lbl", label), canvas);
    sparksDiv3.appendChild(row);
    sparkRowEls3.push(row);
  }
  const [s3Bri, s3Flux, s3Spr, s3Ctr, s3Tilt, s3Sat] = sparkRows3.map((r) => r.canvas);

  // Scene meters — canonical: BRI / FLUX / SPR / CTR / TILT + POS position track
  const sceneHdr = mk("div", "sig__hdr", "SCENE");
  const mBri  = _meterRow("BRI");
  const mFlux = _meterRow("FLUX");
  const mSpr  = _meterRow("SPR");
  const mCtr  = _meterRow("CTR");
  const mTilt = _meterRow("TILT");
  const mSat3 = _meterRow("SAT");

  const posTrack3 = mk("div", "pos-track");
  const posMarker3 = mk("div", "pos-track__marker");
  const posVal3 = mk("span", "sig__val");
  posTrack3.appendChild(posMarker3);
  const posRow3 = mk("div", "sig__row sig__row--pos");
  posRow3.append(mk("span", "sig__lbl", "POS"), posTrack3, posVal3);

  // 60-note grid
  const gridLabel = mk("div", "sig__hdr", "NOTES");
  const noteGrid = mk("div", "note-grid");
  let noteGridBuilt = false;
  let noteCells: HTMLElement[] = [];
  let noteLookup: Int16Array | null = null;

  host.append(
    chromaHdr, chordVal, huebar, slotHist, slotHistLabels,
    mk("div", "sig__divider"),
    sparksHdr3, sparksDiv3,
    mk("div", "sig__divider"),
    sceneHdr,
    mBri.row, mFlux.row, mSpr.row, mCtr.row, mTilt.row, mSat3.row,
    posRow3,
    mk("div", "sig__divider"),
    gridLabel, noteGrid,
  );

  const briHist3: number[] = [], fluxHist3: number[] = [],
        sprHist3: number[] = [], ctrHist3: number[] = [], tiltHist3: number[] = [],
        satHist3: number[] = [];
  let latestMsg: TelemetryMsg | null = null;

  function _buildNoteGrid(noteInfo: { chromatic: number; octave: number; name: string }[]): void {
    if (noteGridBuilt) return;
    noteGridBuilt = true;
    noteGrid.innerHTML = "";
    noteCells = [];
    const octaves = [...new Set(noteInfo.map((n) => n.octave))].sort((a, b) => b - a);

    // Header row: empty label cell + 12 note names
    const hdrRow = mk("div", "note-grid__hdr");
    hdrRow.appendChild(mk("span", "note-grid__hdr-lbl", ""));
    for (const name of NOTE_NAMES_12) {
      hdrRow.appendChild(mk("span", "note-grid__hdr-lbl", name));
    }
    noteGrid.appendChild(hdrRow);

    noteLookup = new Int16Array(octaves.length * 12).fill(-1);
    for (let oi = 0; oi < octaves.length; oi++) {
      const oct = octaves[oi];
      const rowEl = mk("div", "note-grid__row");
      rowEl.appendChild(mk("span", "note-grid__oct", String(oct)));
      for (let pc = 0; pc < 12; pc++) {
        const idx = noteInfo.findIndex((n) => n.octave === oct && n.chromatic === pc);
        noteLookup[oi * 12 + pc] = idx;
        const cell = mk("div", "note-grid__cell");
        if (idx >= 0) cell.title = `${noteInfo[idx].name}${oct}`;
        rowEl.appendChild(cell);
        noteCells.push(cell);
      }
      noteGrid.appendChild(rowEl);
    }
  }

  function paint() {
    requestAnimationFrame(paint);
    if (!latestMsg?.audio) return;
    const audio = latestMsg.audio;
    const vu = latestMsg.visualUniforms;
    const pct = (v: number) => `${Math.min(100, v * 100).toFixed(1)}%`;

    if (!noteGridBuilt && audio.noteInfo?.length) _buildNoteGrid(audio.noteInfo);

    // Marker position: weighted circular mean of palette slot centers in
    // PERCEPTUAL hue space, using the chord-template slot weights. We can't
    // use audio.hue directly because it's a circular mean over chroma-class
    // angles (C=0°, F=150°, …) which is unrelated to the palette's
    // display-hue arrangement (e.g. FAC may be positioned at red). The slot
    // weights, by contrast, already live in slot space and slide continuously
    // between neighbors as the chord transitions.
    let winnerIdx3 = 0;
    let _percPos3 = 0;
    if (audio.slots && currentPalette && audio.slots.length === currentPalette.slots.length) {
      let maxScore = -1;
      let cx = 0;
      let cy = 0;
      let totalW = 0;
      for (let i = 0; i < audio.slots.length; i++) {
        const w = audio.slots[i];
        if (w > maxScore) { maxScore = w; winnerIdx3 = i; }
        if (w <= 0) continue;
        const p = (toPerceptual(currentPalette.slotHues[i] ?? 0) * Math.PI) / 180;
        cx += Math.cos(p) * w;
        cy += Math.sin(p) * w;
        totalW += w;
      }
      if (totalW > 0 && (cx !== 0 || cy !== 0)) {
        const meanRad = Math.atan2(cy, cx);
        _percPos3 = (((meanRad * 180) / Math.PI) + 360) % 360;
      } else {
        _percPos3 = toPerceptual(currentPalette.slotHues[winnerIdx3] ?? 0);
      }
    } else {
      _percPos3 = toPerceptual(audio.hue ?? 0);
    }
    huemark.style.setProperty("--hue-marker-pos", `${(_percPos3 / 360) * 100}%`);

    chordNumeral.textContent = audio.chord.label || "—";

    // Signal quality
    mSat3.fill.style.width = pct(audio.sat ?? 0); mSat3.val.textContent = ((audio.sat ?? 0) * 100).toFixed(0);

    // Note grid
    if (noteGridBuilt && noteLookup && audio.notes) {
      for (let i = 0; i < noteCells.length; i++) {
        const noteIdx = noteLookup[i];
        const v = noteIdx >= 0 ? (audio.notes[noteIdx] ?? 0) : 0;
        noteCells[i].style.opacity = String(0.06 + v * 0.94);
      }
    }

    // Slot score histogram (same inverted-mask technique as Stage 1 huehist)
    if (audio.slots && slotHistBars.length === audio.slots.length) {
      const slots = audio.slots;
      let mx = 0.0001;
      for (let i = 0; i < slots.length; i++) if (slots[i] > mx) mx = slots[i];
      for (let i = 0; i < slotHistBars.length; i++) {
        const slotIdx = slotHistOrder[i] ?? i;
        const emptyH = 32 * (1 - (slots[slotIdx] ?? 0) / mx);
        slotHistBars[i].style.height = `${emptyH.toFixed(1)}px`;
      }
    }

    // Signal history sparklines — color tracks winner slot hue
    const winnerPercHue3 = toPerceptual(currentPalette?.slotHues[winnerIdx3] ?? 0).toFixed(1);
    for (const rowEl of sparkRowEls3) {
      rowEl.style.setProperty("--accent-l", "0.65");
      rowEl.style.setProperty("--accent-c", "0.22");
      rowEl.style.setProperty("--accent-h", winnerPercHue3);
    }
    _drawSpark(s3Bri,  briHist3,  sparkRowEls3[0]);
    _drawSpark(s3Flux, fluxHist3, sparkRowEls3[1]);
    _drawSpark(s3Spr,  sprHist3,  sparkRowEls3[2]);
    _drawSpark(s3Ctr,  ctrHist3,  sparkRowEls3[3]);
    _drawSpark(s3Tilt, tiltHist3, sparkRowEls3[4]);
    _drawSpark(s3Sat,  satHist3,  sparkRowEls3[5]);

    // Scene — canonical audio signals, fills colored green/red vs. video delta
    const pct2 = (v: number) => `${Math.min(100, v * 100).toFixed(1)}%`;
    const vid = latestMsg?.video;
    mBri.fill.style.width  = pct2(audio.bri);          mBri.val.textContent  = (audio.bri * 100).toFixed(0);
    mFlux.fill.style.width = pct2(audio.act);          mFlux.val.textContent = (audio.act * 100).toFixed(0);
    mSpr.fill.style.width  = pct2(audio.spread ?? 0);  mSpr.val.textContent  = ((audio.spread ?? 0) * 100).toFixed(0);
    mCtr.fill.style.width  = pct2(audio.ctr ?? 0);     mCtr.val.textContent  = ((audio.ctr ?? 0) * 100).toFixed(0);
    mTilt.fill.style.width = pct2(audio.tilt ?? 0.5);  mTilt.val.textContent = ((audio.tilt ?? 0.5) * 100).toFixed(0);
    mSat3.fill.style.width = pct2(audio.sat ?? 0);     mSat3.val.textContent = ((audio.sat ?? 0) * 100).toFixed(0);
    mBri.fill.style.background  = _deltaFill(audio.bri,         vid?.bri);
    mFlux.fill.style.background = _deltaFill(audio.act,         vid?.flux);
    mSpr.fill.style.background  = _deltaFill(audio.spread ?? 0, vid?.spread);
    mCtr.fill.style.background  = _deltaFill(audio.ctr ?? 0,    vid ? vid.contrast * 2 : undefined);
    mTilt.fill.style.background = _deltaFill(audio.tilt ?? 0.5, vid?.tilt);
    mSat3.fill.style.background = _deltaFill(audio.sat ?? 0,    vid?.sat);
    posMarker3.style.left = `${((audio.pos ?? 0.5) * 100).toFixed(1)}%`;
    posVal3.textContent = (((audio.pos ?? 0.5) * 2 - 1) * 100).toFixed(0);
  }
  requestAnimationFrame(paint);

  return {
    onMsg(msg) {
      latestMsg = msg;
      if (msg.audio) {
        const L = CONFIG.sparkLen;
        const p3 = (a: number[], v: number) => { a.push(v); if (a.length > L) a.shift(); };
        p3(briHist3,  msg.audio.bri);
        p3(fluxHist3, msg.audio.act);
        p3(sprHist3,  msg.audio.spread ?? 0);
        p3(ctrHist3,  msg.audio.ctr ?? 0);
        p3(tiltHist3, msg.audio.tilt ?? 0.5);
        p3(satHist3,  msg.audio.sat ?? 0);
      }
    },
  };
}

// ── Stage 4 — Visual Synthesis ────────────────────────────────────────────────

export function mountVisualSynthesisMonitor(host: HTMLElement): { onMsg(msg: TelemetryMsg): void } {
  host.className = "monitor";

  // Winner status row
  const statusRow = mk("div", "sig__key-row");
  const sigDot = mk("span", "sig__dot");
  const sigLabel = mk("span", "sig__status-lbl", "—");
  statusRow.append(sigDot, sigLabel);

  const currentPalette = _buildPalette();

  // Pulse sparkline
  const pulseHdr = mk("div", "sig__hdr", "PULSE");
  const pulseCanvas = mk("canvas", "spark");
  const pulseWrap = mk("div", "chord-spark-wrap");
  pulseWrap.appendChild(pulseCanvas);

  host.append(
    statusRow,
    mk("div", "sig__divider"),
    pulseHdr, pulseWrap,
  );

  const pulseHist: number[] = [];
  let latestMsg: TelemetryMsg | null = null;

  function paint() {
    requestAnimationFrame(paint);
    const vu = latestMsg?.visualUniforms;
    if (!vu) return;

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

    // Pulse sparkline
    const L = CONFIG.sparkLen;
    pulseHist.push(vu.pulse);
    if (pulseHist.length > L) pulseHist.shift();
    pulseWrap.style.setProperty("--accent-l", "0.65");
    pulseWrap.style.setProperty("--accent-c", "0.2");
    pulseWrap.style.setProperty("--accent-h", "200");
    _drawSpark(pulseCanvas, pulseHist.map((v) => Math.min(1, v)), pulseWrap);
  }
  requestAnimationFrame(paint);

  return { onMsg(msg) { latestMsg = msg; } };
}
