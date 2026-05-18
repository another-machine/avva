/**
 * src/main.ts — avva v2 entry point.
 *
 * Bootstraps the store then dispatches to the active view:
 *   default        → analysis view  (CAM → AUDIO)
 *   ?view=loop     → loop view      (CAM → AUDIO ↔ AUDIO → VIS closed-loop harness)
 */

import { seedFromQuery } from "./store/url-seed.js";
import { startBroadcastSync } from "./store/sync.js";

seedFromQuery();
startBroadcastSync();

import("./views/loop-view.js").then((m) => m.mountLoopView());
