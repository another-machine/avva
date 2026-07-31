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
  document.getElementById("menu")?.classList.remove("hide");
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
