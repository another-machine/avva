/**
 * src/input/media-folder.ts
 *
 * A local folder of video files, chosen once and remembered.
 *
 * Video assets do not belong in the repo — they are hundreds of megabytes each,
 * they are not the work, and a single 3.9 GB file was enough to break `vite
 * build` outright by exceeding its 2 GiB asset limit. So there is no bundled
 * assets directory and nothing is hardcoded. You point avva at a folder and it
 * reads from there.
 *
 * The handle is stored in IndexedDB rather than re-prompted every load. That
 * matters more than it sounds: this runs in performances and installations,
 * where a reload has to come back up on its own without someone clicking
 * through a folder picker.
 *
 * Because the folder is a per-machine setting, `?source=` carries a bare
 * filename rather than a path, so a preset URL means the same thing on any
 * machine that has a folder with that file in it.
 */

const DB_NAME = "avva";
const DB_STORE = "handles";
const HANDLE_KEY = "mediaFolder";

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv)$/i;

/** Minimal typings — TS lib.dom lags the File System Access API. */
interface DirectoryHandle {
  readonly name: string;
  values(): AsyncIterableIterator<{ kind: string; name: string }>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
  queryPermission?(d: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" }): Promise<PermissionState>;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string;
    mode?: "read";
  }) => Promise<DirectoryHandle>;
};

export const supportsDirectoryPicker =
  typeof (window as PickerWindow).showDirectoryPicker === "function";

// ── IndexedDB ─────────────────────────────────────────────────────────────────
// A directory handle is structured-cloneable, so it round-trips through IDB
// as-is. It cannot go in localStorage, which is why this is here at all.

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ── Module state ──────────────────────────────────────────────────────────────

let handle: DirectoryHandle | null = null;
/** Fallback for browsers without the picker: files held in memory. */
let fallbackFiles: Map<string, File> | null = null;
/** Object URLs handed out so far, revoked when the folder changes. */
const objectUrls = new Map<string, string>();

function revokeAll(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function folderName(): string | null {
  if (handle) return handle.name;
  if (fallbackFiles) return "(selected files)";
  return null;
}

export function hasFolder(): boolean {
  return handle !== null || fallbackFiles !== null;
}

/**
 * Reconnect to the folder chosen on a previous visit.
 *
 * Returns false when there is nothing stored, or when the browser has dropped
 * back to needing a prompt — permission cannot be re-requested without a user
 * gesture, so the caller has to offer a button rather than silently retrying.
 */
export async function restoreFolder(): Promise<boolean> {
  if (handle) return true;
  let stored: DirectoryHandle | undefined;
  try {
    stored = await idbGet<DirectoryHandle>(HANDLE_KEY);
  } catch {
    return false;
  }
  if (!stored) return false;

  const state = (await stored.queryPermission?.({ mode: "read" })) ?? "granted";
  if (state !== "granted") return false;

  handle = stored;
  revokeAll();
  return true;
}

/** Prompt for a folder. Must be called from a user gesture. */
export async function pickFolder(): Promise<boolean> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return false;
  let chosen: DirectoryHandle;
  try {
    // `id` makes the browser reopen in the last-used location for this app.
    chosen = await picker({ id: "avva-media", mode: "read" });
  } catch {
    return false; // user cancelled
  }

  const state = (await chosen.requestPermission?.({ mode: "read" })) ?? "granted";
  if (state !== "granted") return false;

  handle = chosen;
  fallbackFiles = null;
  revokeAll();
  try {
    await idbSet(HANDLE_KEY, chosen);
  } catch {
    // Not fatal — the folder works for this session, it just will not persist.
  }
  return true;
}

/**
 * Adopt a FileList from an `<input webkitdirectory>`, for browsers without
 * showDirectoryPicker. Lasts only for this page load; nothing here is
 * persistable, which is exactly why the picker is preferred where it exists.
 */
export function adoptFileList(files: FileList | File[]): number {
  const map = new Map<string, File>();
  for (const file of Array.from(files)) {
    if (VIDEO_EXTENSIONS.test(file.name)) map.set(file.name, file);
  }
  if (map.size === 0) return 0;
  handle = null;
  fallbackFiles = map;
  revokeAll();
  return map.size;
}

/** Video filenames in the folder, sorted. Empty when no folder is set. */
export async function listVideos(): Promise<string[]> {
  if (fallbackFiles) return [...fallbackFiles.keys()].sort();
  if (!handle) return [];
  const names: string[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && VIDEO_EXTENSIONS.test(entry.name)) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * A playable URL for a file in the folder.
 *
 * URLs are cached per filename because cycling sources with `C` revisits the
 * same files repeatedly, and minting a fresh object URL each time would leak
 * one per switch for the life of the page.
 */
export async function urlForFile(name: string): Promise<string> {
  const cached = objectUrls.get(name);
  if (cached) return cached;

  let file: File | undefined;
  if (fallbackFiles) {
    file = fallbackFiles.get(name);
  } else if (handle) {
    try {
      file = await (await handle.getFileHandle(name)).getFile();
    } catch {
      file = undefined;
    }
  }
  if (!file) {
    throw new Error(
      `"${name}" is not in the selected folder${
        folderName() ? ` (${folderName()})` : ""
      }.`,
    );
  }

  const url = URL.createObjectURL(file);
  objectUrls.set(name, url);
  return url;
}

/**
 * True when a `?source=` value should be looked up in the chosen folder.
 *
 * Anything with a slash or a scheme is a path or a URL and is left alone, so
 * older `/assets/foo.mp4` preset links still resolve against the dev server.
 */
export function isFolderRelative(source: string): boolean {
  return !source.includes("/") && !source.includes(":");
}
