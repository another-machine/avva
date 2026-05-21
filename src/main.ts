/**
 * src/main.ts — avva v2 entry point.
 *
 * Bootstraps the store then dispatches to the active view:
 *   default            → loop view      (CAM → SYNTH → ANALYZER → VIS closed-loop;
 *                                        also broadcasts the synth's master
 *                                        output via WebRTC for listener tabs)
 *   ?view=visualize    → visualize view (receives a MediaStream from any
 *                                        broadcaster tab and runs only the
 *                                        audio analyzer + GL renderer)
 */

import { seedFromQuery } from "./store/url-seed.js";
import { startBroadcastSync } from "./store/sync.js";

seedFromQuery();
startBroadcastSync();

const view = new URLSearchParams(location.search).get("view");

if (view === "visualize") {
  import("./views/visualize-view.js").then((m) => m.mountVisualizeView());
} else {
  import("./views/loop-view.js").then((m) => m.mountLoopView());
}
