/**
 * controller/controller.ts
 *
 * Schema-driven configuration UI. One page, three query-param views:
 *   ?view=analysis  →  VIDEO | AUDIO   (analysis panels, side by side)
 *   ?view=synth     →  SOUND | VISUAL  (synthesis panels)
 *   ?view=global    →  SOURCES + HARMONY | SETTINGS JSON (copy / push)
 * Default view is "analysis".
 *
 * NOTE: this ?view= namespace is the *controller page's* and is unrelated to the
 * instrument app's ?view=loop|va|av (src/main.ts) — separate docs.
 *
 * Add a field to schema.ts and it appears in the relevant panel automatically.
 * Sync: BroadcastChannel always (same-origin); WebSocket relay optional via the
 * Global view's relay form or ?relay=ws://<host>:3001.
 */

import { store } from "../src/store/store.js";
import {
  SCHEMA,
  type SchemaKey,
  type Field,
  type SourceKind,
} from "../src/store/schema.js";
import { startBroadcastSync, startWebSocketSync } from "../src/store/sync.js";
import { TelemetryReceiver, type TelemetryMsg } from "../src/store/telemetry.js";
import {
  mountVideoAnalysisMonitor,
  mountAudioAnalysisMonitorCore,
  mountSoundSynthesisMonitor,
  mountVisualSynthesisMonitor,
  mountDetectedNotesMonitor,
  mountSynthNotesMonitor,
} from "./monitors.js";
import { buildTriadsForMode, type ScaleMode } from "../src/harmony/music.js";
import {
  adoptFileList,
  folderName,
  listVideos,
  pickFolder,
  restoreFolder,
  supportsDirectoryPicker,
} from "../src/input/media-folder.js";

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;

// Keys rendered by hand in a section builder — skipped by the auto-gen cards so
// they don't appear twice.
const HANDLED_KEYS = new Set<SchemaKey>(["listen.source"]);

// Nicer card titles than group.toUpperCase() for a couple of groups.
const GROUP_TITLES: Partial<Record<string, string>> = {
  audioEq: "EQ",
  audioAnalysis: "ANALYSIS",
};

// ── Tiny DOM helper ───────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

startBroadcastSync();

// ── WebSocket relay (cross-device sync) ──────────────────────────────────────
// Module-scoped so it auto-connects on EVERY view — the nav tabs are full-page
// links, so the connection must be re-established on each load. The Global view's
// RELAY form binds to this same connection and mirrors its state.
const relay = (() => {
  let stop: (() => void) | null = null;
  let url = "";
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  return {
    get connected() { return stop !== null; },
    get url() { return url; },
    connect(next: string) {
      stop?.();
      stop = null;
      const u = next.trim();
      if (!u) { notify(); return; }
      try { new URL(u); } catch { return; }
      stop = startWebSocketSync(u);
      url = u;
      try { sessionStorage.setItem("avva.relay", u); } catch { /* ignore */ }
      notify();
    },
    disconnect() {
      stop?.();
      stop = null;
      try { sessionStorage.removeItem("avva.relay"); } catch { /* ignore */ }
      notify();
    },
    onChange(fn: () => void) { listeners.add(fn); },
  };
})();

// Auto-connect from ?relay= or the saved URL — independent of the active view.
{
  const initial =
    new URLSearchParams(location.search).get("relay") ??
    (() => { try { return sessionStorage.getItem("avva.relay"); } catch { return null; } })();
  if (initial) relay.connect(initial);
}

type View = "analysis" | "synth" | "global";
const VALID_VIEWS: View[] = ["analysis", "synth", "global"];
const _viewParam = new URLSearchParams(location.search).get("view") ?? "";
const VIEW: View = (VALID_VIEWS as string[]).includes(_viewParam)
  ? (_viewParam as View)
  : "analysis";

// Monitors for the active view register here; the telemetry receiver fans each
// frame out to all of them. Views that aren't active are never built.
const activeMonitors: { onMsg(msg: TelemetryMsg): void }[] = [];

// ── Collapse animation helper ────────────────────────────────────────────────
// grid-template-rows animation is unreliable; measure actual px height instead.

function setBodyHeight(
  bodyEl: HTMLElement,
  collapse: boolean,
  animate: boolean,
): void {
  if (!animate) {
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
    bodyEl.style.height = bodyEl.scrollHeight + "px";
    bodyEl.offsetHeight; // force reflow
    bodyEl.style.height = "0px";
  } else {
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
  title: string = group.toUpperCase(),
): HTMLElement {
  const section = document.createElement("section");
  section.className = "group";
  section.dataset.group = group;

  const header = document.createElement("div");
  header.className = "group__header";
  const h2 = document.createElement("h2");
  h2.textContent = title;
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

/** Append one collapsible card per schema group into `target`. */
function appendGroupCards(target: HTMLElement, groups: string[]): void {
  for (const group of groups) {
    const keys = (Object.keys(SCHEMA) as SchemaKey[]).filter(
      (k) =>
        SCHEMA[k].group === group &&
        (SCHEMA[k].kind as string) !== "json" &&
        !HANDLED_KEYS.has(k),
    );
    if (!keys.length) continue;
    const card = makeGroupCard(
      group,
      () => store.resetGroup(group),
      (body) => {
        for (const key of keys) body.appendChild(buildRow(key));
      },
      GROUP_TITLES[group] ?? group.toUpperCase(),
    );
    target.appendChild(card);
  }
}

// ── Settings-panel section helpers (relocated from the old sidebar) ───────────

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

// ── VIDEO source / view / synth-toggle sections ───────────────────────────────

function buildSourceSection(): HTMLElement {
  const { section: srcSec, body: srcBody } = _spSection("VIDEO");
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

  // ── Media folder ───────────────────────────────────────────
  // Files come from a folder the user picks, not from the repo. Options are
  // bare filenames so a preset URL resolves on any machine whose folder holds
  // a file by that name.
  const fileSelect = document.createElement("select");
  fileSelect.className = "sp-select";

  const folderBtn = document.createElement("button");
  folderBtn.type = "button";
  folderBtn.className = "sp-btn";

  // Fallback for browsers without showDirectoryPicker. Kept out of the layout
  // entirely when the picker exists.
  const folderInput = document.createElement("input");
  folderInput.type = "file";
  folderInput.hidden = true;
  folderInput.setAttribute("webkitdirectory", "");
  folderInput.setAttribute("directory", "");
  folderInput.accept = "video/*";

  async function refreshFiles(): Promise<void> {
    fileSelect.textContent = "";
    const names = await listVideos();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = names.length ? "— select file —" : "— no folder —";
    fileSelect.appendChild(empty);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      fileSelect.appendChild(opt);
    }
    const current = String(store.get("source.file") ?? "");
    if (current) fileSelect.value = current;
    const label = folderName();
    folderBtn.textContent = label
      ? `${label} — ${names.length} video${names.length === 1 ? "" : "s"}`
      : "Choose folder…";
  }

  folderBtn.addEventListener("click", async () => {
    // Both paths need the click: showDirectoryPicker requires a user gesture,
    // and so does opening a file input.
    if (supportsDirectoryPicker) {
      if (await pickFolder()) await refreshFiles();
    } else {
      folderInput.click();
    }
  });

  folderInput.addEventListener("change", async () => {
    if (folderInput.files && adoptFileList(folderInput.files) > 0) {
      await refreshFiles();
    }
  });

  fileSelect.addEventListener("change", () => {
    store.set("source.kind", "file" as SourceKind);
    store.set("source.file", fileSelect.value);
  });
  store.subscribeKey("source.file", (v) => { fileSelect.value = String(v); });

  srcBody.appendChild(_spRow("Folder", folderBtn));
  srcBody.appendChild(folderInput);
  const fileRow = _spRow("File", fileSelect);
  srcBody.appendChild(fileRow);

  // Reconnect to a previously chosen folder. Silent when the browser has
  // dropped back to needing a prompt — the button is the way back in.
  void restoreFolder().then(refreshFiles);

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
  rateOut.textContent = fmtNum(store.get("source.playbackRate") as number, rateField.step) + "×";
  rateInput.addEventListener("input", () => {
    const v = Number(rateInput.value);
    rateOut.textContent = fmtNum(v, rateField.step) + "×";
    store.set("source.playbackRate", v);
  });
  store.subscribeKey("source.playbackRate", (v) => {
    rateInput.value = String(v);
    rateOut.textContent = fmtNum(v as number, rateField.step) + "×";
  });
  rateWrap.append(rateInput, rateOut);
  const rateRow = _spRow("Speed", rateWrap);
  srcBody.appendChild(rateRow);

  const updateSourceVis = () => {
    const kind = getUiKind();
    fileRow.style.display  = kind === "file"   ? "" : "none";
    urlRow.style.display   = kind === "url"    ? "" : "none";
    rateRow.style.display  = (kind === "file" || kind === "url") ? "" : "none";
  };
  updateSourceVis();
  store.subscribeKey("source.kind", updateSourceVis);
  return srcSec;
}

function buildViewSection(): HTMLElement {
  const { section: viewSec, body: viewBody } = _spSection("VIEW");
  const viewBtns = document.createElement("div");
  viewBtns.className = "ctrl ctrl--enum";
  for (const [key, label] of [["view.mirror", "mirror"], ["view.heatOn", "heat"], ["view.tiltOn", "tilt"], ["view.maskOn", "mask"]] as const) {
    const btn = document.createElement("button");
    btn.className = "seg-btn" + (store.get(key) ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => store.set(key, !store.get(key) as never));
    store.subscribeKey(key, (v) => btn.classList.toggle("active", !!v));
    viewBtns.appendChild(btn);
  }
  viewBody.appendChild(_spRow("Display", viewBtns));

  // Viewbox x/y/w/h — compact range sliders styled like meter bars
  const vboxGrid = document.createElement("div");
  vboxGrid.className = "vbox-grid";
  for (const [key, abbr, mn, mx] of [
    ["view.viewboxX", "X", 0, 1],
    ["view.viewboxY", "Y", 0, 1],
    ["view.viewboxW", "W", 0.05, 1],
    ["view.viewboxH", "H", 0.05, 1],
  ] as [string, string, number, number][]) {
    const cell = document.createElement("div");
    cell.className = "vbox-cell";
    const lbl = document.createElement("span");
    lbl.className = "vbox-cell__lbl";
    lbl.textContent = abbr;
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = String(mn); inp.max = String(mx); inp.step = "0.01";
    const curVal = store.get(key as SchemaKey) as number ?? mx;
    inp.value = String(curVal);
    const valSpan = document.createElement("span");
    valSpan.className = "vbox-cell__val";
    valSpan.textContent = curVal.toFixed(2);
    inp.addEventListener("input", () => {
      const v = Number(inp.value);
      valSpan.textContent = v.toFixed(2);
      store.set(key as SchemaKey, v as never);
    });
    store.subscribeKey(key as SchemaKey, (v) => {
      inp.value = String(v);
      valSpan.textContent = (v as number).toFixed(2);
    });
    cell.append(lbl, inp, valSpan);
    vboxGrid.appendChild(cell);
  }
  viewBody.appendChild(_spRow("Viewbox", vboxGrid));
  return viewSec;
}

// ── AUDIO source (listen input) — dropdown ────────────────────────────────────

function buildListenSourceSection(): HTMLElement {
  const { section, body } = _spSection("AUDIO");
  const field = SCHEMA["listen.source"] as { options: readonly string[] };
  const sel = document.createElement("select");
  sel.className = "sp-select";
  for (const opt of field.options) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    sel.appendChild(o);
  }
  sel.value = String(store.get("listen.source"));
  sel.addEventListener("change", () => store.set("listen.source", sel.value as never));
  store.subscribeKey("listen.source", (v) => { sel.value = String(v); });
  body.appendChild(_spRow("Listen input", sel));
  return section;
}

// ── HARMONY section ───────────────────────────────────────────────────────────

function buildHarmonySection(): HTMLElement {
  const { section: harmSec, body: harmBody } = _spSection("HARMONY");

  const rootSelect = document.createElement("select");
  rootSelect.className = "sp-select";
  for (const n of NOTE_NAMES) {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = n;
    rootSelect.appendChild(opt);
  }
  rootSelect.value = String(store.get("harmony.root") ?? "C");
  rootSelect.addEventListener("change", () => {
    store.set("harmony.root", rootSelect.value as never);
  });
  store.subscribeKey("harmony.root", (v) => {
    rootSelect.value = String(v ?? "C");
  });
  harmBody.appendChild(_spRow("Root", rootSelect));

  const rhField = SCHEMA["harmony.rootHue"];
  const rhWrap = document.createElement("div");
  rhWrap.className = "sp-range-wrap";
  const rhInput = document.createElement("input");
  rhInput.type = "range";
  rhInput.min = String(rhField.min); rhInput.max = String(rhField.max);
  rhInput.step = String(rhField.step);
  rhInput.value = String(store.get("harmony.rootHue") ?? 0);
  const rhOut = document.createElement("output");
  rhOut.textContent = fmtNum(store.get("harmony.rootHue") as number ?? 0, rhField.step) + "°";
  rhInput.addEventListener("input", () => {
    const v = Number(rhInput.value);
    rhOut.textContent = fmtNum(v, rhField.step) + "°";
    store.set("harmony.rootHue", v);
  });
  rhInput.addEventListener("dblclick", () => store.reset("harmony.rootHue"));
  store.subscribeKey("harmony.rootHue", (v) => {
    rhInput.value = String(v);
    rhOut.textContent = fmtNum(v as number ?? 0, rhField.step) + "°";
  });
  rhWrap.append(rhInput, rhOut);
  harmBody.appendChild(_spRow("Root hue", rhWrap));

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

  return harmSec;
}

// ── WebSocket relay form (relocated to the Global view) ───────────────────────

function buildWsRelaySection(): HTMLElement {
  const { section, body } = _spSection("RELAY");
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.className = "sp-input";
  urlInput.placeholder = "ws://192.168.x.x:3001";
  urlInput.spellcheck = false;
  const connectBtn = document.createElement("button");
  connectBtn.className = "action-btn";

  // Bind the form to the module-level relay so its state survives view switches.
  const sync = () => {
    if (relay.url && document.activeElement !== urlInput) urlInput.value = relay.url;
    connectBtn.classList.toggle("active", relay.connected);
    connectBtn.textContent = relay.connected ? "Disconnect" : "Connect";
  };
  connectBtn.addEventListener("click", () =>
    relay.connected ? relay.disconnect() : relay.connect(urlInput.value.trim()),
  );
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") relay.connect(urlInput.value.trim());
  });
  relay.onChange(sync);
  sync();

  const row = document.createElement("div");
  row.className = "relay-row";
  row.append(urlInput, connectBtn);
  body.appendChild(row);
  return section;
}

// ── Panels ────────────────────────────────────────────────────────────────────

function makePanel(name: string, side: string): { panel: HTMLElement; body: HTMLElement } {
  const panel = el("section", "ctrl-panel");
  panel.dataset.side = side;
  const hdr = el("header", "ctrl-panel__hdr");
  hdr.append(el("span", "ctrl-panel__name", name));
  panel.appendChild(hdr);
  const body = el("div", "ctrl-panel__body");
  panel.appendChild(body);
  return { panel, body };
}

/**
 * Video / Audio analysis panel — identical structure so they read side by side:
 *   notes → chroma/signal/scene → view (video only) → calibration → analysis.
 * Source pickers were relocated to the GLOBAL view (above HARMONY).
 */
function buildAnalysisPanel(side: "video" | "audio"): HTMLElement {
  const { panel, body } = makePanel(side === "video" ? "VIDEO" : "AUDIO", side);

  // 1. NOTES (video = synth-generated ground truth; audio = analyzer-detected)
  const notesHost = el("div");
  activeMonitors.push(
    side === "video"
      ? mountSynthNotesMonitor(notesHost)
      : mountDetectedNotesMonitor(notesHost),
  );

  // 2. chroma / signal / scene
  const monHost = el("div");
  activeMonitors.push(
    side === "video"
      ? mountVideoAnalysisMonitor(monHost)
      : mountAudioAnalysisMonitorCore(monHost),
  );

  // 3. VIEW (video display/viewbox only). Source pickers live in the GLOBAL view.
  const sourceSections = side === "video" ? [buildViewSection()] : [];

  // 4. CALIBRATION (video filters | audio 8-band EQ)
  const calib = el("div", "ctrl-cards");
  appendGroupCards(calib, side === "video" ? ["calibration"] : ["audioEq"]);

  // 5. ANALYSIS controls
  const analysis = el("div", "ctrl-cards");
  appendGroupCards(analysis, side === "video" ? ["analysis"] : ["audioAnalysis"]);

  body.append(notesHost, monHost, ...sourceSections, calib, analysis);
  return panel;
}

/** Sound / Visual synthesis panel. */
function buildSynthPanel(side: "sound" | "visual"): HTMLElement {
  const { panel, body } = makePanel(side === "sound" ? "SOUND" : "VISUAL", side);
  const monHost = el("div");
  activeMonitors.push(
    side === "sound"
      ? mountSoundSynthesisMonitor(monHost)
      : mountVisualSynthesisMonitor(monHost),
  );
  const cards = el("div", "ctrl-cards");
  appendGroupCards(
    cards,
    side === "sound"
      ? ["synth", "bass", "mid", "treble", "pluck", "effects", "drums", "extremes"]
      : ["visualSynthesis"],
  );
  if (side === "sound") {
    // Master synth ON/OFF goes at the top of the SYNTH card (above Gain) instead
    // of a separate section, so the monitor's chord row stays flush with the top
    // of the panel and lines up with the VISUAL panel's chord row.
    const synthBody = cards.querySelector('[data-group="synth"] .group__body');
    synthBody?.prepend(buildRow("synth.enabled"));
  }
  body.append(monHost, cards);
  return panel;
}

/** Global view — Sources (video / audio) stacked above Harmony. */
function buildHarmonyPanel(): HTMLElement {
  const { panel, body } = makePanel("SOURCES + HARMONY", "harmony");
  body.append(
    buildSourceSection(),       // VIDEO source (kind/file/url/speed + conditional rows)
    buildListenSourceSection(), // AUDIO listen input
    buildHarmonySection(),
  );
  return panel;
}

/** Global view — full settings JSON (copy / push) + relay form. */
function buildGlobalJsonPanel(): HTMLElement {
  const { panel, body } = makePanel("SETTINGS JSON", "json");

  const note = el(
    "div",
    "json-note",
    "Everything needed to restore this state. Device calibration (video filters + audio EQ) is saved locally and deliberately excluded — copying or pushing never carries or clobbers it.",
  );

  const ta = el("textarea", "json-area") as HTMLTextAreaElement;
  ta.spellcheck = false;
  const seed = () => {
    if (document.activeElement !== ta) {
      ta.value = JSON.stringify(store.exportPortable(), null, 2);
    }
  };
  seed();
  // Keep fresh as values change live (e.g. from another tab) unless being edited.
  store.subscribe(() => seed());

  const status = el("span", "json-status");

  const copyBtn = el("button", "action-btn", "Copy");
  copyBtn.addEventListener("click", () => {
    const text = JSON.stringify(store.exportPortable(), null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => { status.textContent = "Copied"; })
      .catch(() => { status.textContent = "Copy failed"; });
  });

  const pushBtn = el("button", "action-btn", "Push");
  pushBtn.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(ta.value);
      const { applied } = store.importPortable(parsed);
      status.textContent = `Pushed ${applied} key${applied === 1 ? "" : "s"}`;
    } catch {
      status.textContent = "Invalid JSON";
    }
  });

  const btnRow = el("div", "json-btns");
  btnRow.append(copyBtn, pushBtn, status);

  body.append(note, ta, btnRow, buildWsRelaySection());
  return panel;
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
  const hintText =
    "hint" in field && typeof (field as { hint?: string }).hint === "string"
      ? (field as { hint: string }).hint
      : null;
  if (hintText) {
    label.dataset.hint = hintText;
    label.title = hintText;
  }
  row.appendChild(label);

  const ctrl = buildControl(key);
  row.appendChild(ctrl);

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
    const unitStr = field.unit ? ` ${field.unit}` : "";
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
    if (input && document.activeElement !== input) input.value = String(value);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(v: number, step: number): string {
  const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  return v.toFixed(dp);
}

// ── Action handlers ───────────────────────────────────────────────────────────

// Tap tempo state — module-level so it persists across button clicks
const _tapTimes: number[] = [];

const ACTION_HANDLERS: Partial<Record<SchemaKey, () => void>> = {
  "harmony.fillTriads": () => {
    const root = store.get("harmony.root") as string;
    const scale = store.get("harmony.scale") as ScaleMode;
    const triads = buildTriadsForMode(root, scale);
    store.set("harmony.palette", triads.join(", "));
  },
  "drums.tapTempo": () => {
    const now = performance.now();
    if (_tapTimes.length > 0 && now - _tapTimes[_tapTimes.length - 1] > 2000) {
      _tapTimes.length = 0;
    }
    _tapTimes.push(now);
    if (_tapTimes.length > 4) _tapTimes.shift();
    if (_tapTimes.length >= 2) {
      let total = 0;
      for (let i = 1; i < _tapTimes.length; i++) total += _tapTimes[i] - _tapTimes[i - 1];
      const bpm = Math.round(Math.max(40, Math.min(180, 60000 / (total / (_tapTimes.length - 1)))));
      store.set("drums.bpm", bpm);
    }
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

// ── View router ───────────────────────────────────────────────────────────────

function buildNav(): void {
  const nav = document.getElementById("ctrl-nav")!;
  const tabs: [View, string][] = [
    ["analysis", "ANALYSIS"],
    ["synth", "SYNTH"],
    ["global", "GLOBAL"],
  ];
  for (const [v, label] of tabs) {
    const a = el("a", "ctrl-nav__tab" + (v === VIEW ? " active" : ""), label);
    const sp = new URLSearchParams(location.search);
    sp.set("view", v);
    a.href = `?${sp.toString()}${location.hash}`;
    nav.appendChild(a);
  }
}

function buildActiveView(): void {
  const views = document.getElementById("ctrl-views")!;
  views.dataset.view = VIEW;
  if (VIEW === "analysis") {
    views.append(buildAnalysisPanel("video"), buildAnalysisPanel("audio"));
  } else if (VIEW === "synth") {
    views.append(buildSynthPanel("sound"), buildSynthPanel("visual"));
  } else {
    views.append(buildHarmonyPanel(), buildGlobalJsonPanel());
  }
}

buildNav();
buildActiveView();

// ── Telemetry fan-out ─────────────────────────────────────────────────────────
// Merge partial frames from any number of producer windows (?view=va sends
// video+synth, ?view=av sends audio+visual) so every active monitor stays
// live. The _fresh* flags mark which stage advanced this frame so history
// sparklines push once per real producer frame, not once per merge.
interface MergedMsg extends TelemetryMsg {
  _freshVideo?: boolean;
  _freshAudio?: boolean;
}
const _merged: MergedMsg = { t: 0, fps: 0 };
let _lastMsg: MergedMsg | null = null;

new TelemetryReceiver((msg) => {
  for (const k of Object.keys(msg) as (keyof TelemetryMsg)[]) {
    const v = msg[k];
    if (v !== undefined) (_merged as unknown as Record<string, unknown>)[k] = v;
  }
  _merged._freshVideo = msg.video !== undefined;
  _merged._freshAudio = msg.audio !== undefined;
  _lastMsg = _merged;
  for (const m of activeMonitors) m.onMsg(_merged);
});

// Press D to copy a compact diagnostic JSON blob — paste into Claude instead of screenshots.
document.addEventListener("keydown", (e) => {
  if (e.key !== "d" && e.key !== "D") return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const m = _lastMsg;
  if (!m) return;
  const v = m.video;
  const a = m.audio;
  const blob = {
    vid: v ? {
      bri: Math.round((v.bri ?? 0) * 100),
      flux: Math.round((v.flux ?? 0) * 100),
      spr: Math.round((v.spread ?? 0) * 100),
      ctr: Math.round((v.contrast ?? 0) * 100),
      tilt: Math.round((v.tilt ?? 0) * 100),
      pos: Math.round(((v.pos ?? 0.5) - 0.5) * 200),
      hue: Math.round(v.hue ?? 0),
      sat: Math.round((v.sat ?? 0) * 100),
    } : null,
    aud: a ? {
      bri: Math.round((a.bri ?? 0) * 100),
      flux: Math.round((a.act ?? 0) * 100),
      spr: Math.round((a.spread ?? 0) * 100),
      ctr: Math.round((a.ctr ?? 0) * 100),
      tilt: Math.round((a.tilt ?? 0.5) * 100),
      pos: Math.round(((a.pos ?? 0.5) - 0.5) * 200),
      hue: Math.round(a.hue ?? 0),
    } : null,
    chord: a?.chord?.label ?? "—",
    synth: m.synth?.running ? "on" : "off",
    note: m.synth?.note ?? null,
  };
  const json = JSON.stringify(blob);
  navigator.clipboard.writeText(json).then(() => {
    console.log("AVVA diag:", json);
  }).catch(() => {
    console.log("AVVA diag:", json);
  });
});
