/**
 * Observable settings store.
 *
 * - Layered init: defaults ← localStorage ← URL hash. Later layers override.
 * - One write path: `set(key, value, origin?)` → notify subscribers → emit patch.
 * - Patches carry an origin tag so transports can suppress echoes.
 * - localStorage writes are debounced; URL hash is updated synchronously
 *   (cheap, and keeps the address bar in sync for shareable links).
 */

import {
  SCHEMA,
  SCHEMA_VERSION,
  type SchemaKey,
  type Settings,
} from "./schema.js";

export type Origin = "local" | "url" | "storage" | "broadcast" | "ws" | "init";

export interface Patch<K extends SchemaKey = SchemaKey> {
  key: K;
  value: Settings[K];
  origin: Origin;
}

type AnyListener = (patch: Patch) => void;

const LS_KEY = "avva.settings.v" + SCHEMA_VERSION;
const HASH_PREFIX = "s=";

function defaults(): Settings {
  const out = {} as Settings;
  for (const key of Object.keys(SCHEMA) as SchemaKey[]) {
    (out as Record<string, unknown>)[key] = SCHEMA[key].default;
  }
  return out;
}

function readLocalStorage(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return sanitize(parsed);
  } catch {
    return {};
  }
}

function readHash(): Partial<Settings> {
  const hash = location.hash.slice(1);
  if (!hash.startsWith(HASH_PREFIX)) return {};
  try {
    const json = decodeURIComponent(hash.slice(HASH_PREFIX.length));
    return sanitize(JSON.parse(json));
  } catch {
    return {};
  }
}

/** Drop unknown keys and coerce numbers. */
function sanitize(obj: unknown): Partial<Settings> {
  if (!obj || typeof obj !== "object") return {};
  const out: Partial<Settings> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!(k in SCHEMA)) continue;
    const field = SCHEMA[k as SchemaKey];
    if (field.kind === "number" && typeof v === "number" && !Number.isNaN(v)) {
      (out as Record<string, unknown>)[k] = v;
    } else if (field.kind === "boolean" && typeof v === "boolean") {
      (out as Record<string, unknown>)[k] = v;
    } else if (field.kind === "string" && typeof v === "string" && v !== "") {
      (out as Record<string, unknown>)[k] = v;
    } else if (
      field.kind === "enum" &&
      typeof v === "string" &&
      (field.options as readonly string[]).includes(v)
    ) {
      (out as Record<string, unknown>)[k] = v;
    } else if (
      (field.kind as string) === "select" &&
      typeof v === "string" &&
      "options" in field &&
      (field.options as readonly string[]).includes(v)
    ) {
      (out as Record<string, unknown>)[k] = v;
    } else if ((field.kind as string) === "json") {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export class Store {
  private state: Settings;
  private listeners = new Set<AnyListener>();
  private keyListeners = new Map<SchemaKey, Set<AnyListener>>();
  private writeTimer: number | null = null;

  constructor() {
    this.state = { ...defaults(), ...readLocalStorage(), ...readHash() };
  }

  get<K extends SchemaKey>(key: K): Settings[K] {
    return this.state[key];
  }

  /** Read multiple keys at once. */
  snapshot(): Settings {
    return { ...this.state };
  }

  /**
   * Set a value. No-op if the value is unchanged. Origin tag is forwarded
   * to subscribers so transports can suppress echoes.
   */
  set<K extends SchemaKey>(
    key: K,
    value: Settings[K],
    origin: Origin = "local",
  ): void {
    if (Object.is(this.state[key], value)) return;
    this.state[key] = value;
    const patch: Patch = { key, value, origin };
    this.emit(patch);
    this.schedulePersist();
  }

  /** Apply a batch of patches without re-persisting between each. */
  applyPatches(patches: Patch[]): void {
    let changed = false;
    for (const p of patches) {
      if (Object.is(this.state[p.key], p.value)) continue;
      this.state[p.key] = p.value as never;
      changed = true;
      this.emit(p);
    }
    if (changed) this.schedulePersist();
  }

  subscribe(fn: AnyListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeKey<K extends SchemaKey>(
    key: K,
    fn: (value: Settings[K], origin: Origin) => void,
  ): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    const wrapped: AnyListener = (p) => {
      if (p.key === key) fn(p.value as Settings[K], p.origin);
    };
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  /** Reset one key to its schema default. */
  reset<K extends SchemaKey>(key: K, origin: Origin = "local"): void {
    this.set(key, SCHEMA[key].default as Settings[K], origin);
  }

  /** Reset every key in a group to defaults. */
  resetGroup(group: string, origin: Origin = "local"): void {
    for (const key of Object.keys(SCHEMA) as SchemaKey[]) {
      if (SCHEMA[key].group === group) this.reset(key, origin);
    }
  }

  // ── internals ─────────────────────────────────────────────

  private emit(patch: Patch): void {
    for (const fn of this.listeners) fn(patch);
    const set = this.keyListeners.get(patch.key);
    if (set) for (const fn of set) fn(patch);
  }

  private schedulePersist(): void {
    if (this.writeTimer !== null) return;
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      this.persist();
    }, 100);
    // URL hash is fast — keep it always-current.
    this.writeHash();
  }

  private persist(): void {
    try {
      const diff = this.diffFromDefaults();
      if (Object.keys(diff).length === 0) {
        localStorage.removeItem(LS_KEY);
      } else {
        localStorage.setItem(LS_KEY, JSON.stringify(diff));
      }
    } catch {
      // quota or disabled — silently skip
    }
  }

  private writeHash(): void {
    try {
      const diff = this.diffFromDefaults();
      if (Object.keys(diff).length === 0) {
        if (location.hash)
          history.replaceState(null, "", location.pathname + location.search);
      } else {
        const next = HASH_PREFIX + encodeURIComponent(JSON.stringify(diff));
        if (location.hash.slice(1) !== next) {
          history.replaceState(null, "", "#" + next);
        }
      }
    } catch {
      // ignore
    }
  }

  /** Return only entries that differ from schema defaults. */
  private diffFromDefaults(): Partial<Settings> {
    const out: Partial<Settings> = {};
    for (const key of Object.keys(SCHEMA) as SchemaKey[]) {
      const def = SCHEMA[key].default;
      const cur = this.state[key];
      const same =
        typeof def === "object"
          ? JSON.stringify(def) === JSON.stringify(cur)
          : Object.is(def, cur);
      if (!same) (out as Record<string, unknown>)[key] = cur;
    }
    return out;
  }
}

/** Single shared store instance. */
export const store = new Store();
