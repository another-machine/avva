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
import { SCHEMA, type SchemaKey } from "../src/store/schema.js";
import { startBroadcastSync, startWebSocketSync } from "../src/store/sync.js";
import { TelemetryReceiver } from "../src/store/telemetry.js";
import { mountVideoMonitor, mountAudioMonitor } from "./monitors.js";

// ── Group order ───────────────────────────────────────────────────────────────

const GROUP_ORDER = [
  "view",
  "source",
  "calibration",
  "harmony",
  "synth",
  "cassette",
  "audio",
  "analysis",
] as const;

// ── Boot BroadcastChannel sync ────────────────────────────────────────────────

startBroadcastSync();

// ── Telemetry monitors ────────────────────────────────────────────────────────

const videoMonitor = mountVideoMonitor(document.getElementById("video-monitor")!);
const audioMonitor = mountAudioMonitor(document.getElementById("audio-monitor")!);

new TelemetryReceiver((msg) => {
  if (msg.video) videoMonitor.onMsg(msg);
  if (msg.audio || msg.synth) audioMonitor.onMsg(msg);
});

// Repurpose view.hud toggle: show/hide monitor sections in controller
const applyHudVisibility = (v: boolean) => {
  document.getElementById("video-monitor")?.classList.toggle("is-hidden", !v);
  document.getElementById("audio-monitor")?.classList.toggle("is-hidden", !v);
};
store.subscribeKey("view.hud", applyHudVisibility);
applyHudVisibility(store.get("view.hud"));

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

for (const group of GROUP_ORDER) {
  const keys = (Object.keys(SCHEMA) as SchemaKey[]).filter(
    (k) => SCHEMA[k].group === group,
  );
  if (!keys.length) continue;

  const section = document.createElement("section");
  section.className = "group";
  section.dataset.group = group;

  // Group header
  const header = document.createElement("div");
  header.className = "group__header";

  const h2 = document.createElement("h2");
  h2.textContent = group.toUpperCase();

  const resetBtn = document.createElement("button");
  resetBtn.className = "btn-reset";
  resetBtn.textContent = "reset";
  resetBtn.addEventListener("click", () => store.resetGroup(group));

  header.appendChild(h2);
  header.appendChild(resetBtn);
  section.appendChild(header);

  // Rows
  for (const key of keys) {
    const field = SCHEMA[key];
    if (field.kind === "json") continue; // not useful in runtime controller

    const row = buildRow(key);
    section.appendChild(row);
  }

  controlsEl.appendChild(section);
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
  const field = SCHEMA[key];
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
    out.textContent = fmtNum(value as number, field.step);

    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = fmtNum(v, field.step);
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
  const field = SCHEMA[key];

  if (field.kind === "number") {
    const input = ctrl.querySelector<HTMLInputElement>("input");
    const out = ctrl.querySelector<HTMLOutputElement>("output");
    if (input) input.value = String(value);
    if (out) out.textContent = fmtNum(value as number, field.step);
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
