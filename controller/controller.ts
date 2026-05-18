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
import { mountVideoMonitor, mountAudioMonitor } from "./monitors.js";

// ── Asset file list (populated from Vite glob at build time) ──────────────────

const ASSET_FILES = Object.keys(
  import.meta.glob("/assets/*", { eager: false }),
).map((p) => p.replace(/^\/assets\//, ""));

// ── Section layout ────────────────────────────────────────────────────────────
// source is built as a custom section; the rest auto-generate from schema groups.

const SECTIONS: Array<{ label: string | null; groups: string[] }> = [
  { label: null, groups: ["view"] },
  { label: "GLOBAL — HARMONY", groups: ["harmony"] },
  {
    label: "VISUAL → AUDIO",
    groups: ["calibration", "analysis", "synth", "cassette"],
  },
  { label: "AUDIO → VISUAL", groups: ["audio"] },
];

// ── Boot BroadcastChannel sync ────────────────────────────────────────────────

startBroadcastSync();

// ── Telemetry monitors ────────────────────────────────────────────────────────

const videoMonitor = mountVideoMonitor(
  document.getElementById("video-monitor")!,
);
const audioMonitor = mountAudioMonitor(
  document.getElementById("audio-monitor")!,
);

new TelemetryReceiver((msg) => {
  if (msg.video) videoMonitor.onMsg(msg);
  if (msg.audio || msg.synth) audioMonitor.onMsg(msg);
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

const controlsEl = document.getElementById("controls")!;

// Source section (custom — conditional rows + asset dropdown)
buildSourceGroup(controlsEl);

// Auto-generated sections from schema
for (const { label, groups } of SECTIONS) {
  if (label) {
    const hdr = document.createElement("div");
    hdr.className = "section-hdr";
    hdr.textContent = label;
    controlsEl.appendChild(hdr);
  }
  for (const group of groups) {
    const keys = (Object.keys(SCHEMA) as SchemaKey[]).filter(
      (k) => SCHEMA[k].group === group,
    );
    if (!keys.length) continue;

    const section = document.createElement("section");
    section.className = "group";
    section.dataset.group = group;

    const header = document.createElement("div");
    header.className = "group__header";
    const h2 = document.createElement("h2");
    h2.textContent = group.toUpperCase();
    const resetBtn = document.createElement("button");
    resetBtn.className = "btn-reset";
    resetBtn.textContent = "reset";
    resetBtn.addEventListener("click", () => store.resetGroup(group));
    header.append(h2, resetBtn);
    section.appendChild(header);

    for (const key of keys) {
      const field = SCHEMA[key];
      if ((field.kind as string) === "json") continue;
      section.appendChild(buildRow(key));
    }

    controlsEl.appendChild(section);
  }
}

// ── Custom source group ───────────────────────────────────────────────────────

function buildSourceGroup(container: HTMLElement): void {
  const section = document.createElement("section");
  section.className = "group";
  section.dataset.group = "source";

  const header = document.createElement("div");
  header.className = "group__header";
  const h2 = document.createElement("h2");
  h2.textContent = "SOURCE";
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-reset";
  resetBtn.textContent = "reset";
  resetBtn.addEventListener("click", () => store.resetGroup("source"));
  header.append(h2, resetBtn);
  section.appendChild(header);

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
  section.appendChild(kindRow);

  // ─ URL input (shown only for url) ────────────────────────────────────────
  const urlRow = buildRow("source.url");
  section.appendChild(urlRow);

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
  section.appendChild(fileRow);

  // ─ Camera facing (shown only for camera) ─────────────────────────────────
  const cameraRow = buildRow("source.preferCamera");
  section.appendChild(cameraRow);

  // ─ Playback rate (shown for file/url) ────────────────────────────────────
  const rateRow = buildRow("source.playbackRate");
  section.appendChild(rateRow);

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
  store.subscribeKey(key, (value) => syncControl(ctrl, key, value));

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
