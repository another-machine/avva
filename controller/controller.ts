/**
 * controller/controller.ts
 *
 * Schema-driven settings controller. Generates a full control panel from
 * SCHEMA metadata — add a field to schema.ts and it appears here automatically.
 *
 * Sync: BroadcastChannel always (same-origin). WebSocket relay optional for
 * cross-device use: open  http://<host>:5173/controller/?relay=ws://<host>:3001
 * or paste a relay URL into the connect form and hit Connect.
 */

import { store } from "../src/store/store.js";
import {
  SCHEMA,
  type SchemaKey,
  type Field,
  type SourceKind,
} from "../src/store/schema.js";
import { startBroadcastSync, startWebSocketSync } from "../src/store/sync.js";
import { TelemetryReceiver } from "../src/store/telemetry.js";
import {
  mountVideoAnalysisMonitor,
  mountSoundSynthesisMonitor,
  mountAudioAnalysisMonitor,
  mountVisualSynthesisMonitor,
} from "./monitors.js";
import { buildTriadsForMode, type ScaleMode } from "../src/harmony/music.js";

// ── Asset file list (populated from Vite glob at build time) ──────────────────

const ASSET_FILES = Object.keys(
  import.meta.glob("/assets/*", { eager: false }),
).map((p) => p.replace(/^\/assets\//, ""));

// ── Stage → schema group mapping ─────────────────────────────────────────────

const STAGE_GROUPS: Record<string, string[]> = {
  videoAnalysis:   ["calibration", "analysis"],
  soundSynthesis:  ["synth", "cassette"],
  audioAnalysis:   ["audioAnalysis"],
  visualSynthesis: ["visualSynthesis"],
};

// ── Boot BroadcastChannel sync ────────────────────────────────────────────────

startBroadcastSync();

// ── Telemetry monitors ────────────────────────────────────────────────────────

const videoMon  = mountVideoAnalysisMonitor(document.getElementById("mon-video")!);
const synthMon  = mountSoundSynthesisMonitor(document.getElementById("mon-synth")!);
const audioMon  = mountAudioAnalysisMonitor(document.getElementById("mon-audio")!);
const visualMon = mountVisualSynthesisMonitor(document.getElementById("mon-visual")!);

new TelemetryReceiver((msg) => {
  videoMon.onMsg(msg);
  synthMon.onMsg(msg);
  audioMon.onMsg(msg);
  visualMon.onMsg(msg);
});

// ── Optional WS relay from URL param ─────────────────────────────────────────

const wsStatusEl = document.getElementById("ws-status") as HTMLElement;
const wsUrlInput = document.getElementById("ws-url") as HTMLInputElement;
const wsConnectBtn = document.getElementById("ws-connect") as HTMLButtonElement;

let stopWs: (() => void) | null = null;

function connectWs(url: string): void {
  stopWs?.();
  stopWs = null;

  if (!url.trim()) return;

  // Validate URL before connecting
  try {
    new URL(url);
  } catch {
    wsStatusEl.textContent = "invalid URL";
    wsStatusEl.className = "ctrl-header__status ws-error";
    return;
  }

  stopWs = startWebSocketSync(url);
  wsStatusEl.textContent = `WS: ${url}`;
  wsStatusEl.className = "ctrl-header__status ws-connected";
  wsConnectBtn.textContent = "Disconnect";
  wsConnectBtn.classList.add("active");
  wsUrlInput.value = url;

  // Persist so a page refresh reconnects automatically
  try {
    sessionStorage.setItem("avva.relay", url);
  } catch {
    /* ignore */
  }
}

function disconnectWs(): void {
  stopWs?.();
  stopWs = null;
  wsStatusEl.textContent = "BC";
  wsStatusEl.className = "ctrl-header__status";
  wsConnectBtn.textContent = "Connect";
  wsConnectBtn.classList.remove("active");
  try {
    sessionStorage.removeItem("avva.relay");
  } catch {
    /* ignore */
  }
}

// URL param or sessionStorage reconnect
const initialRelay =
  new URLSearchParams(location.search).get("relay") ??
  (() => {
    try {
      return sessionStorage.getItem("avva.relay");
    } catch {
      return null;
    }
  })();
if (initialRelay) {
  wsUrlInput.value = initialRelay;
  connectWs(initialRelay);
} else {
  wsStatusEl.textContent = "BC";
}

wsConnectBtn.addEventListener("click", () => {
  if (stopWs) {
    disconnectWs();
  } else {
    connectWs(wsUrlInput.value.trim());
  }
});

wsUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connectWs(wsUrlInput.value.trim());
});

// Copy-URL button
document.getElementById("copy-url-btn")?.addEventListener("click", () => {
  const url = stopWs
    ? `${location.origin}${location.pathname}?relay=${encodeURIComponent(wsUrlInput.value)}`
    : location.href;
  navigator.clipboard.writeText(url).catch(() => {
    /* ignore */
  });
});

// ── Build UI ──────────────────────────────────────────────────────────────────

buildSettingsPanel(document.getElementById("settings-body")!);

// Panel 0 collapse toggle
{
  const panel = document.getElementById("settings-panel")!;
  const btn   = document.getElementById("sp-toggle")!;
  const LS_KEY = "avva.ctrl.settings.open";
  const isOpen = () => !panel.classList.contains("collapsed");
  const setOpen = (open: boolean) => {
    panel.classList.toggle("collapsed", !open);
    btn.textContent = open ? "◀" : "▶";
    try { localStorage.setItem(LS_KEY, open ? "1" : "0"); } catch { /* */ }
  };
  btn.addEventListener("click", () => setOpen(!isOpen()));
  // Restore from localStorage (default: open)
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved === "0") setOpen(false);
  } catch { /* */ }
}

// ── Collapse animation helper ────────────────────────────────────────────────
// grid-template-rows animation is unreliable; measure actual px height instead.

function setBodyHeight(
  bodyEl: HTMLElement,
  collapse: boolean,
  animate: boolean,
): void {
  if (!animate) {
    // Set instantly — suppress transition so initial state doesn't animate in
    bodyEl.style.transition = "none";
    bodyEl.style.height = collapse ? "0px" : "";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bodyEl.style.transition = "";
      });
    });
    return;
  }
  if (collapse) {
    // Snapshot rendered height → reflow → animate to 0
    bodyEl.style.height = bodyEl.scrollHeight + "px";
    bodyEl.offsetHeight; // force reflow
    bodyEl.style.height = "0px";
  } else {
    // Animate from 0 → measured content height, then clear to allow reflow
    bodyEl.style.height = bodyEl.scrollHeight + "px";
    bodyEl.addEventListener(
      "transitionend",
      () => {
        bodyEl.style.height = "";
      },
      { once: true },
    );
  }
}

// ── Collapsible group helpers ─────────────────────────────────────────────────

const LS_GROUP_PREFIX = "avva.ctrl.group.";

function getGroupCollapsed(group: string): boolean {
  try {
    return localStorage.getItem(LS_GROUP_PREFIX + group) === "1";
  } catch {
    return false;
  }
}

function setGroupCollapsed(group: string, collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(LS_GROUP_PREFIX + group, "1");
    } else {
      localStorage.removeItem(LS_GROUP_PREFIX + group);
    }
  } catch {
    /* ignore */
  }
}

function makeGroupCard(
  group: string,
  onReset: () => void,
  buildBody: (bodyEl: HTMLElement) => void,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "group";
  section.dataset.group = group;

  const header = document.createElement("div");
  header.className = "group__header";
  const h2 = document.createElement("h2");
  h2.textContent = group.toUpperCase();
  const chevron = document.createElement("span");
  chevron.className = "group__chevron";
  chevron.setAttribute("aria-hidden", "true");
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-reset";
  resetBtn.textContent = "reset";
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onReset();
  });
  header.append(h2, chevron, resetBtn);
  section.appendChild(header);

  const body = document.createElement("div");
  body.className = "group__body";
  buildBody(body);
  section.appendChild(body);

  const startCollapsed = getGroupCollapsed(group);
  if (startCollapsed) section.classList.add("collapsed");
  setBodyHeight(body, startCollapsed, false);

  header.addEventListener("click", () => {
    const isNowCollapsed = section.classList.toggle("collapsed");
    setGroupCollapsed(group, isNowCollapsed);
    setBodyHeight(body, isNowCollapsed, true);
  });

  return section;
}


// Auto-generated groups — each stage column gets its schema groups
const CTL_IDS: Record<string, string> = {
  videoAnalysis: "ctl-video",
  soundSynthesis: "ctl-synth",
  audioAnalysis: "ctl-audio",
  visualSynthesis: "ctl-visual",
};

for (const [stageId, groups] of Object.entries(STAGE_GROUPS)) {
  const targetEl = document.getElementById(CTL_IDS[stageId]!);
  if (!targetEl) continue;

  for (const group of groups) {
    // source group is handled by buildSourceGroup — skip auto-generation
    if (group === "source") continue;

    const keys = (Object.keys(SCHEMA) as SchemaKey[]).filter(
      (k) => SCHEMA[k].group === group,
    );
    if (!keys.length) continue;

    const card = makeGroupCard(
      group,
      () => store.resetGroup(group),
      (body) => {
        for (const key of keys) {
          const field = SCHEMA[key];
          if ((field.kind as string) === "json") continue;
          body.appendChild(buildRow(key));
        }
      },
    );
    targetEl.appendChild(card);
  }
}

// ── Settings panel (panel 0) ─────────────────────────────────────────────────

function _spSection(label: string): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("div");
  section.className = "sp-section";
  const hdr = document.createElement("div");
  hdr.className = "sp-section__hdr";
  hdr.textContent = label;
  section.appendChild(hdr);
  const body = document.createElement("div");
  body.className = "sp-section__body";
  section.appendChild(body);
  return { section, body };
}

function _spRow(label: string, ctrl: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "sp-row";
  const lbl = document.createElement("span");
  lbl.className = "sp-row__lbl";
  lbl.textContent = label;
  row.append(lbl, ctrl);
  return row;
}

function buildSettingsPanel(container: HTMLElement): void {
  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;

  // ── SOURCE ────────────────────────────────────────────────────────────────
  const { section: srcSec, body: srcBody } = _spSection("SOURCE");
  const UI_KINDS = ["camera", "file", "screen", "url"] as const;
  const getUiKind = () => store.get("source.kind") as (typeof UI_KINDS)[number];

  const kindSel = document.createElement("select");
  kindSel.className = "sp-select";
  for (const kind of UI_KINDS) {
    const o = document.createElement("option");
    o.value = kind; o.textContent = kind;
    kindSel.appendChild(o);
  }
  kindSel.value = getUiKind();
  kindSel.addEventListener("change", () => store.set("source.kind", kindSel.value as SourceKind));
  store.subscribeKey("source.kind", (v) => { kindSel.value = String(v); });
  srcBody.appendChild(_spRow("Source", kindSel));

  const fileSelect = document.createElement("select");
  fileSelect.className = "sp-select";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = ""; emptyOpt.textContent = "— select file —";
  fileSelect.appendChild(emptyOpt);
  for (const f of ASSET_FILES) {
    const opt = document.createElement("option");
    opt.value = `/assets/${f}`; opt.textContent = f;
    fileSelect.appendChild(opt);
  }
  const curFile = store.get("source.file");
  if (curFile) fileSelect.value = String(curFile);
  fileSelect.addEventListener("change", () => {
    store.set("source.kind", "file" as SourceKind);
    store.set("source.file", fileSelect.value);
  });
  store.subscribeKey("source.file", (v) => { fileSelect.value = String(v); });
  const fileRow = _spRow("File", fileSelect);
  srcBody.appendChild(fileRow);

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.className = "sp-input";
  urlInput.placeholder = "https://…";
  urlInput.value = String(store.get("source.url") ?? "");
  urlInput.addEventListener("change", () => store.set("source.url", urlInput.value as never));
  store.subscribeKey("source.url", (v) => { if (document.activeElement !== urlInput) urlInput.value = String(v ?? ""); });
  const urlRow = _spRow("URL", urlInput);
  srcBody.appendChild(urlRow);

  const rateField = SCHEMA["source.playbackRate"];
  const rateWrap = document.createElement("div");
  rateWrap.className = "sp-range-wrap";
  const rateInput = document.createElement("input");
  rateInput.type = "range";
  rateInput.min = String(rateField.min); rateInput.max = String(rateField.max);
  rateInput.step = String(rateField.step);
  rateInput.value = String(store.get("source.playbackRate"));
  const rateOut = document.createElement("output");
  rateOut.textContent = fmtNum(store.get("source.playbackRate") as number, rateField.step) + "\u00d7";
  rateInput.addEventListener("input", () => {
    const v = Number(rateInput.value);
    rateOut.textContent = fmtNum(v, rateField.step) + "\u00d7";
    store.set("source.playbackRate", v);
  });
  store.subscribeKey("source.playbackRate", (v) => {
    rateInput.value = String(v);
    rateOut.textContent = fmtNum(v as number, rateField.step) + "\u00d7";
  });
  rateWrap.append(rateInput, rateOut);
  const rateRow = _spRow("Speed", rateWrap);
  srcBody.appendChild(rateRow);

  const updateSourceVis = () => {
    const kind = getUiKind();
    fileRow.style.display  = kind === "file"   ? "" : "none";
    urlRow.style.display   = kind === "url"    ? "" : "none";
    rateRow.style.display  = kind !== "camera" ? "" : "none";
  };
  updateSourceVis();
  store.subscribeKey("source.kind", updateSourceVis);
  container.appendChild(srcSec);

  // ── VIEW ──────────────────────────────────────────────────────────────────
  const { section: viewSec, body: viewBody } = _spSection("VIEW");
  const viewBtns = document.createElement("div");
  viewBtns.className = "ctrl ctrl--enum";
  for (const [key, label] of [["view.mirror", "mirror"], ["view.heatOn", "heat"]] as const) {
    const btn = document.createElement("button");
    btn.className = "seg-btn" + (store.get(key) ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => store.set(key, !store.get(key) as never));
    store.subscribeKey(key, (v) => btn.classList.toggle("active", !!v));
    viewBtns.appendChild(btn);
  }
  viewBody.appendChild(_spRow("Display", viewBtns));
  container.appendChild(viewSec);

  // ── SYNTH ─────────────────────────────────────────────────────────────────
  const { section: synthSec, body: synthBody } = _spSection("SYNTH");
  const synthBtn = document.createElement("button");
  const synthOn = store.get("synth.enabled") as boolean;
  synthBtn.className = "toggle" + (synthOn ? " on" : "");
  synthBtn.textContent = synthOn ? "ON" : "OFF";
  synthBtn.addEventListener("click", () => store.set("synth.enabled", !store.get("synth.enabled") as never));
  store.subscribeKey("synth.enabled", (v) => {
    synthBtn.classList.toggle("on", !!v);
    synthBtn.textContent = v ? "ON" : "OFF";
  });
  const synthWrap = document.createElement("div");
  synthWrap.className = "ctrl ctrl--bool";
  synthWrap.appendChild(synthBtn);
  synthBody.appendChild(_spRow("Enable", synthWrap));
  container.appendChild(synthSec);

  // ── HARMONY ───────────────────────────────────────────────────────────────
  const { section: harmSec, body: harmBody } = _spSection("HARMONY");

  const rootSelect = document.createElement("select");
  rootSelect.className = "sp-select";
  for (const n of NOTE_NAMES) {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = n;
    rootSelect.appendChild(opt);
  }
  const getActiveNote = () => Math.round(((store.get("harmony.rootHue") as number) ?? 0) / 30) % 12;
  rootSelect.value = NOTE_NAMES[getActiveNote()];
  rootSelect.addEventListener("change", () => {
    const i = NOTE_NAMES.indexOf(rootSelect.value as typeof NOTE_NAMES[number]);
    if (i >= 0) {
      store.set("harmony.rootHue", i * 30);
      store.set("harmony.root", rootSelect.value as never);
    }
  });
  store.subscribeKey("harmony.rootHue", (v) => {
    const i = Math.round(((v as number) ?? 0) / 30) % 12;
    rootSelect.value = NOTE_NAMES[i];
  });
  harmBody.appendChild(_spRow("Root", rootSelect));

  const scaleSelect = document.createElement("select");
  scaleSelect.className = "sp-select";
  for (const opt of (SCHEMA["harmony.scale"] as { options: readonly string[] }).options) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    scaleSelect.appendChild(o);
  }
  scaleSelect.value = String(store.get("harmony.scale") ?? "major");
  scaleSelect.addEventListener("change", () => store.set("harmony.scale", scaleSelect.value as never));
  store.subscribeKey("harmony.scale", (v) => { scaleSelect.value = String(v); });
  harmBody.appendChild(_spRow("Scale", scaleSelect));

  const fillBtns = document.createElement("div");
  fillBtns.className = "fill-btns";

  const seqBtn = document.createElement("button");
  seqBtn.className = "action-btn";
  seqBtn.textContent = "Sequence";
  seqBtn.title = "Fill palette I – VII in scale order";
  seqBtn.addEventListener("click", () => {
    const root = store.get("harmony.root") as string;
    const scale = store.get("harmony.scale") as ScaleMode;
    const triads = buildTriadsForMode(root, scale);
    store.set("harmony.palette", triads.join(", "));
  });

  const mixBtn = document.createElement("button");
  mixBtn.className = "action-btn";
  mixBtn.textContent = "Mixed";
  mixBtn.title = "Fill palette I III V IV VII II VI";
  mixBtn.addEventListener("click", () => {
    const root = store.get("harmony.root") as string;
    const scale = store.get("harmony.scale") as ScaleMode;
    const triads = buildTriadsForMode(root, scale);
    // I III V IV VII II VI — strong degrees first, I always first
    const order = [0, 2, 4, 3, 6, 1, 5];
    store.set("harmony.palette", order.map((i) => triads[i]).join(", "));
  });

  fillBtns.append(seqBtn, mixBtn);
  harmBody.appendChild(fillBtns);

  const paletteInput = document.createElement("input");
  paletteInput.type = "text";
  paletteInput.className = "sp-input";
  paletteInput.spellcheck = false;
  paletteInput.placeholder = "CG, FAC, GBD …";
  paletteInput.value = String(store.get("harmony.palette") ?? "");
  paletteInput.addEventListener("change", () => store.set("harmony.palette", paletteInput.value as never));
  store.subscribeKey("harmony.palette", (v) => {
    if (document.activeElement !== paletteInput) paletteInput.value = String(v ?? "");
  });
  harmBody.appendChild(_spRow("Slots", paletteInput));

  const czField = SCHEMA["harmony.crossZone"];
  const czWrap = document.createElement("div");
  czWrap.className = "sp-range-wrap";
  const czInput = document.createElement("input");
  czInput.type = "range";
  czInput.min = String(czField.min); czInput.max = String(czField.max);
  czInput.step = String(czField.step);
  czInput.value = String(store.get("harmony.crossZone"));
  const czOut = document.createElement("output");
  czOut.textContent = fmtNum(store.get("harmony.crossZone") as number, czField.step);
  czInput.addEventListener("input", () => {
    const v = Number(czInput.value);
    czOut.textContent = fmtNum(v, czField.step);
    store.set("harmony.crossZone", v);
  });
  store.subscribeKey("harmony.crossZone", (v) => {
    czInput.value = String(v);
    czOut.textContent = fmtNum(v as number, czField.step);
  });
  czWrap.append(czInput, czOut);
  harmBody.appendChild(_spRow("X-zone", czWrap));

  container.appendChild(harmSec);
}

// ── Custom source group (legacy — no longer used, kept for safety) ────────────

function buildSourceGroup(container: HTMLElement): void {
  let sectionBody!: HTMLElement;
  const section = makeGroupCard(
    "source",
    () => store.resetGroup("source"),
    (body) => {
      sectionBody = body;
    },
  );

  // ─ Kind selector ─────────────────────────────────────────────────────────
  const UI_KINDS = ["camera", "file", "screen", "url"] as const;
  const getUiKind = () => store.get("source.kind") as (typeof UI_KINDS)[number];

  const kindRow = document.createElement("div");
  kindRow.className = "row";
  const kindLabel = document.createElement("label");
  kindLabel.className = "row__label";
  kindLabel.textContent = "Source";
  const kindCtrl = document.createElement("div");
  kindCtrl.className = "ctrl ctrl--enum";
  for (const kind of UI_KINDS) {
    const btn = document.createElement("button");
    btn.className = "seg-btn" + (getUiKind() === kind ? " active" : "");
    btn.textContent = kind;
    btn.addEventListener("click", () =>
      store.set("source.kind", kind as SourceKind),
    );
    kindCtrl.appendChild(btn);
  }
  kindRow.append(kindLabel, kindCtrl);
  sectionBody.appendChild(kindRow);

  // ─ URL input (shown only for url) ────────────────────────────────────────
  const urlRow = buildRow("source.url");
  sectionBody.appendChild(urlRow);

  // ─ File dropdown (shown only for file) ───────────────────────────────────
  const fileRow = document.createElement("div");
  fileRow.className = "row";
  const fileLabel = document.createElement("label");
  fileLabel.className = "row__label";
  fileLabel.textContent = "Video file";
  const fileCtrl = document.createElement("div");
  fileCtrl.className = "ctrl ctrl--select";
  const fileSelect = document.createElement("select");
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "— select —";
  fileSelect.appendChild(emptyOpt);
  for (const f of ASSET_FILES) {
    const opt = document.createElement("option");
    opt.value = `/assets/${f}`;
    opt.textContent = f;
    fileSelect.appendChild(opt);
  }
  const curFile = store.get("source.file");
  if (curFile) fileSelect.value = String(curFile);
  fileSelect.addEventListener("change", () => {
    store.set("source.kind", "file" as SourceKind);
    store.set("source.file", fileSelect.value);
  });
  store.subscribeKey("source.file", (v) => {
    fileSelect.value = String(v);
  });
  fileCtrl.appendChild(fileSelect);
  fileRow.append(fileLabel, fileCtrl);
  sectionBody.appendChild(fileRow);

  // ─ Camera facing (shown only for camera) ─────────────────────────────────
  const cameraRow = buildRow("source.preferCamera");
  sectionBody.appendChild(cameraRow);

  // ─ Playback rate (shown for file/url) ────────────────────────────────────
  const rateRow = buildRow("source.playbackRate");
  sectionBody.appendChild(rateRow);

  // ─ Visibility logic ───────────────────────────────────────────────────────
  const updateVisibility = () => {
    const kind = getUiKind();
    for (const btn of kindCtrl.querySelectorAll<HTMLButtonElement>(
      ".seg-btn",
    )) {
      btn.classList.toggle("active", btn.textContent === kind);
    }
    urlRow.style.display = kind === "url" ? "" : "none";
    fileRow.style.display = kind === "file" ? "" : "none";
    cameraRow.style.display = kind === "camera" ? "" : "none";
    rateRow.style.display = kind !== "camera" ? "" : "none";
  };
  updateVisibility();
  store.subscribeKey("source.kind", updateVisibility);

  container.appendChild(section);
}

// ── Row / control builders ────────────────────────────────────────────────────

function buildRow(key: SchemaKey): HTMLElement {
  const field = SCHEMA[key];

  const row = document.createElement("div");
  row.className = "row";
  row.dataset.key = key;

  const label = document.createElement("label");
  label.className = "row__label";
  label.textContent = field.label;
  row.appendChild(label);

  const ctrl = buildControl(key);
  row.appendChild(ctrl);

  if (
    "hint" in field &&
    typeof (field as { hint?: string }).hint === "string"
  ) {
    const hint = document.createElement("div");
    hint.className = "row__hint";
    hint.textContent = (field as { hint: string }).hint;
    row.appendChild(hint);
  }

  // Reflect external changes (BroadcastChannel / WebSocket) back into the control
  if (field.kind !== "action") {
    store.subscribeKey(key, (value) => syncControl(ctrl, key, value));
  }

  return row;
}

function buildControl(key: SchemaKey): HTMLElement {
  const field = SCHEMA[key] as Field;
  const value = store.get(key);

  // ── number slider ──────────────────────────────────────────────────────────
  if (field.kind === "number") {
    const wrap = document.createElement("div");
    wrap.className = "ctrl ctrl--range";

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.value = String(value);

    const out = document.createElement("output");
    const unitStr = field.unit ? ` ${field.unit}` : "";
    out.textContent = fmtNum(value as number, field.step) + unitStr;

    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = fmtNum(v, field.step) + unitStr;
      store.set(key, v as never);
    });

    // Double-click resets to schema default
    input.addEventListener("dblclick", () => store.reset(key));

    wrap.appendChild(input);
    wrap.appendChild(out);
    return wrap;
  }

  // ── boolean toggle ─────────────────────────────────────────────────────────
  if (field.kind === "boolean") {
    const wrap = document.createElement("div");
    wrap.className = "ctrl ctrl--bool";

    const btn = document.createElement("button");
    btn.className = "toggle" + (value ? " on" : "");
    btn.textContent = value ? "ON" : "OFF";
    btn.addEventListener("click", () => {
      store.set(key, !store.get(key) as never);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  // ── enum segmented buttons ─────────────────────────────────────────────────
  if (field.kind === "enum") {
    const wrap = document.createElement("div");
    wrap.className = "ctrl ctrl--enum";

    for (const opt of field.options) {
      const btn = document.createElement("button");
      btn.className = "seg-btn" + (opt === value ? " active" : "");
      btn.textContent = opt;
      btn.dataset.val = opt;
      btn.addEventListener("click", () => store.set(key, opt as never));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  // ── select dropdown ────────────────────────────────────────────────────────
  if (field.kind === "select") {
    const wrap = document.createElement("div");
    wrap.className = "ctrl ctrl--select";

    const sel = document.createElement("select");
    for (const opt of field.options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => store.set(key, sel.value as never));
    wrap.appendChild(sel);
    return wrap;
  }
  // ── action button ─────────────────────────────────────────────────────────────
  if (field.kind === "action") {
    const wrap = document.createElement("div");
    wrap.className = "ctrl ctrl--action";
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.textContent = field.label;
    btn.dataset.actionKey = key;
    wrap.appendChild(btn);
    return wrap;
  }
  // ── string text input ──────────────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.className = "ctrl ctrl--text";
  const input = document.createElement("input");
  input.type = "text";
  input.value = String(value);
  input.addEventListener("change", () => store.set(key, input.value as never));
  wrap.appendChild(input);
  return wrap;
}

// ── Sync incoming store updates back to the DOM ───────────────────────────────

function syncControl(ctrl: HTMLElement, key: SchemaKey, value: unknown): void {
  const field = SCHEMA[key] as Field;

  if (field.kind === "number") {
    const input = ctrl.querySelector<HTMLInputElement>("input");
    const out = ctrl.querySelector<HTMLOutputElement>("output");
    const unitStr = field.unit ? ` ${field.unit}` : "";
    if (input) input.value = String(value);
    if (out) out.textContent = fmtNum(value as number, field.step) + unitStr;
    return;
  }

  if (field.kind === "boolean") {
    const btn = ctrl.querySelector<HTMLButtonElement>(".toggle");
    if (btn) {
      btn.classList.toggle("on", !!value);
      btn.textContent = value ? "ON" : "OFF";
    }
    return;
  }

  if (field.kind === "enum") {
    for (const btn of ctrl.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
      btn.classList.toggle("active", btn.dataset.val === String(value));
    }
    return;
  }

  if (field.kind === "select") {
    const sel = ctrl.querySelector<HTMLSelectElement>("select");
    if (sel) sel.value = String(value);
    return;
  }

  if (field.kind === "string") {
    const input = ctrl.querySelector<HTMLInputElement>("input");
    // Don't clobber while the user is typing
    if (input && document.activeElement !== input) input.value = String(value);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(v: number, step: number): string {
  const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  return v.toFixed(dp);
}

// ── Action handlers ───────────────────────────────────────────────────────────

const ACTION_HANDLERS: Partial<Record<SchemaKey, () => void>> = {
  "harmony.fillTriads": () => {
    const root = store.get("harmony.root") as string;
    const scale = store.get("harmony.scale") as ScaleMode;
    const triads = buildTriadsForMode(root, scale);
    store.set("harmony.palette", triads.join(", "));
  },
};

document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-action-key]",
  );
  if (!btn) return;
  const key = btn.dataset.actionKey as SchemaKey | undefined;
  if (key && ACTION_HANDLERS[key]) ACTION_HANDLERS[key]!();
});
