/**
 * src/main.ts — avva v2 entry point.
 *
 * Bootstraps the store then dispatches to the active view:
 *   default            → loop view      (CAM → SYNTH → ANALYZER → VIS closed-loop;
 *                                        also broadcasts the synth's master
 *                                        output via WebRTC for listener tabs)
 *   ?view=va           → loop view in video→audio-only mode (CAM → SYNTH +
 *                                        broadcast, no local blob renderer —
 *                                        the listener window draws the visuals)
 *   ?view=av           → visualize view (audio→video: receives a MediaStream
 *                                        from any broadcaster tab and runs only
 *                                        the audio analyzer + GL renderer)
 */

import { seedFromQuery } from "./store/url-seed.js";
import { startBroadcastSync } from "./store/sync.js";

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
