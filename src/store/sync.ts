/**
 * Cross-window/cross-device sync transports for the store.
 *
 * Two transports speak the same patch format:
 *   - BroadcastChannel (same-origin, same browser) — instant, zero infra.
 *   - WebSocket relay (server/relay.ts) — for phone / multi-machine. Stubbed
 *     in phase 1; flesh out when needed.
 *
 * Origin tag on each patch prevents echo loops: a patch we received from
 * "broadcast" is re-emitted to local subscribers only, never re-broadcast.
 */

import { store, type Patch } from "./store.js";

const CHANNEL = "avva-store";

let bc: BroadcastChannel | null = null;

export function startBroadcastSync(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  bc = new BroadcastChannel(CHANNEL);

  const unsub = store.subscribe((patch) => {
    if (patch.origin === "broadcast" || patch.origin === "ws") return;
    bc!.postMessage(patch);
  });

  bc.onmessage = (e: MessageEvent<Patch>) => {
    const p = e.data;
    if (!p || typeof p !== "object" || !("key" in p)) return;
    store.set(p.key, p.value as never, "broadcast");
  };

  return () => {
    unsub();
    bc?.close();
    bc = null;
  };
}

// ── WebSocket relay (stub) ──────────────────────────────────────
// Wire this up when phase 3 lands. Keeping the API in place so callers
// can opt in early without changing shape.

let ws: WebSocket | null = null;

export function startWebSocketSync(url: string): () => void {
  try {
    ws = new WebSocket(url);
  } catch {
    return () => {};
  }

  const unsub = store.subscribe((patch) => {
    if (patch.origin === "ws" || patch.origin === "broadcast") return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(patch));
    }
  });

  ws.addEventListener("message", (e) => {
    try {
      const p = JSON.parse(e.data) as Patch;
      if (p && typeof p === "object" && "key" in p) {
        store.set(p.key, p.value as never, "ws");
      }
    } catch {
      // ignore
    }
  });

  return () => {
    unsub();
    ws?.close();
    ws = null;
  };
}
