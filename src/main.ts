/**
 * src/main.ts — avva v2 entry point.
 *
 * Bootstraps the store then dispatches to the active view:
 *   default        → analysis view  (CAM → AUDIO)
 *   ?view=loop     → loop view      (CAM → AUDIO ↔ AUDIO → VIS closed-loop harness)
 */

import { seedFromQuery } from "./store/url-seed.js";
import { startBroadcastSync } from "./store/sync.js";

// Seed legacy ?query=params into the store, then start cross-window sync.
seedFromQuery();
startBroadcastSync();

const view = new URLSearchParams(location.search).get("view") ?? "analysis";

if (view === "loop") {
  import("./views/loop-view.js").then((m) => m.mountLoopView());
} else {
  import("./views/analysis-view.js").then((m) => m.mountAnalysisView());
}
