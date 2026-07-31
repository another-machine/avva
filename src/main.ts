/**
 * src/main.ts — avva v2 entry point.
 *
 * A bare root URL shows the launcher. Anything with a query string boots a
 * view, so every preset URL — which always carries params — is unaffected.
 *
 * Bootstraps the store then dispatches to the active view:
 *   ?view=loop         → loop view      (CAM → SYNTH → ANALYZER → VIS closed-loop;
 *                                        also broadcasts the synth's master
 *                                        output via WebRTC for listener tabs)
 *   ?view=va           → loop view in video→audio-only mode (CAM → SYNTH +
 *                                        broadcast, no local blob renderer —
 *                                        the listener window draws the visuals)
 *   ?view=av           → visualize view (audio→video: receives a MediaStream
 *                                        from any broadcaster tab and runs only
 *                                        the audio analyzer + GL renderer)
 *   anything else      → loop view, as before
 */

import { seedFromQuery } from "./store/url-seed.js";
import { startBroadcastSync } from "./store/sync.js";

// The launcher is the only thing that renders without a query string. Checked
// before the store is seeded so a bare visit costs nothing — no camera prompt,
// no AudioContext, no WebRTC.
if (!location.search) {
  // amplib-ui is loaded here and nowhere else, on purpose.
  //
  // Its base layer styles bare <video> and <canvas>: an opaque background, a
  // hairline border, `inline-size: 100%` and `max-block-size: 60svh`. Being
  // layered, it loses to avva's unlayered index.css — but only for properties
  // index.css actually declares, and the views declare `width`/`height` rather
  // than the logical `inline-size`/`block-size`, which are different
  // properties entirely. So a site-wide load left the camera feed capped in
  // height and sitting under opaque canvas fills, with #heat's
  // mix-blend-mode: difference compositing against a solid colour.
  //
  // Awaited so the launcher paints once, already styled.
  import("../vendor/amplib-ui.css").then(() => {
    writeRelayNote();
    document.getElementById("menu")?.classList.remove("hide");
  });
} else {
  seedFromQuery();
  startBroadcastSync();

  const view = new URLSearchParams(location.search).get("view");

  if (view === "av") {
    import("./views/visualize-view.js").then((m) => m.mountVisualizeView());
  } else if (view === "va") {
    // video → audio only: camera + analysis + synth + broadcast, no local blobs.
    import("./views/loop-view.js").then((m) =>
      m.mountLoopView({ renderVisuals: false }),
    );
  } else {
    import("./views/loop-view.js").then((m) => m.mountLoopView());
  }
}

/**
 * True where the dev server plausibly is: loopback, a LAN address, or an mDNS
 * name. A phone on the same network hits one of these, and that is exactly the
 * case where running the relay is worth suggesting.
 */
export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Tell the truth about the relay for wherever this build happens to be served.
 *
 * The relay is a Node WebSocket server. From the dev machine it is one npm
 * script away; served as static files it cannot exist at all, and the page
 * being HTTPS blocks an insecure ws:// socket on top of that. One bundle serves
 * both, so the note is written at runtime — the static text it replaces told
 * deployed visitors to run a command that could not help them.
 *
 * A pure function of the hostname, so both branches are testable without
 * needing to actually be on either host.
 */
export function relayNoteFor(host: string): string {
  const code = (text: string) => `<code class="ht-type-code">${text}</code>`;
  return isLocalHost(host)
    ? `Cross-device sync needs the relay: ${code("npm run relay")}, then open ` +
      `the controller with ${code("?relay=ws://&lt;lan-ip&gt;:3001")}.`
    : `Tabs in this browser sync on their own. Cross-device sync needs a relay, ` +
      `which is a Node server and cannot run on static hosting &mdash; point at ` +
      `one with ${code("?relay=wss://&lt;host&gt;")}. It must be ` +
      `${code("wss://")}, since this page is HTTPS.`;
}

function writeRelayNote(): void {
  const el = document.querySelector<HTMLElement>("[data-relay-note]");
  if (el) el.innerHTML = relayNoteFor(location.hostname);
}
