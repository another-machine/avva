/**
 * src/audio/worklet-host.ts
 *
 * Loads AudioWorklet modules and exposes typed node creation helpers.
 * Gracefully falls back to the Phase-1 safety compressor if addModule fails.
 */

import limiterUrl from "./worklets/limiter.js?url";
import fmTierUrl from "./worklets/fm-tier.js?url";
import ksStringUrl from "./worklets/ks-string.js?url";

export interface LimiterMetrics {
  lufsShort: number;
  gr: number;
}

export type MetricsCallback = (m: LimiterMetrics) => void;

/**
 * Load the lookahead-limiter worklet module.
 * Returns true on success; caller keeps the safety-compressor fallback on failure.
 */
export async function loadWorklets(actx: AudioContext): Promise<boolean> {
  try {
    await actx.audioWorklet.addModule(limiterUrl);
    return true;
  } catch (e) {
    console.warn("[worklet-host] Limiter AudioWorklet load failed — keeping safety compressor:", e);
    return false;
  }
}

/**
 * Load the fm-tier worklet module. Returns true on success; caller falls back
 * to NodeTierBackend on failure.
 */
export async function loadFMWorklets(actx: AudioContext): Promise<boolean> {
  try {
    await actx.audioWorklet.addModule(fmTierUrl);
    return true;
  } catch (e) {
    console.warn("[worklet-host] FM-tier AudioWorklet load failed — falling back to node-graph FM:", e);
    return false;
  }
}

/**
 * Load the ks-string worklet module. Returns true on success.
 */
export async function loadKSWorklet(actx: AudioContext): Promise<boolean> {
  try {
    await actx.audioWorklet.addModule(ksStringUrl);
    return true;
  } catch (e) {
    console.warn("[worklet-host] KS-string AudioWorklet load failed:", e);
    return false;
  }
}

/**
 * Create a ks-string AudioWorkletNode (4-voice Karplus-Strong).
 * Call only after loadKSWorklet() resolved true on the same AudioContext.
 */
export function createKSNode(actx: AudioContext): AudioWorkletNode {
  return new AudioWorkletNode(actx, "ks-string", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });
}

/**
 * Create the lookahead-limiter AudioWorkletNode. Call only after loadWorklets()
 * has resolved with true.
 *
 * @param actx       The AudioContext that loaded the module.
 * @param onMetrics  Optional callback receiving meter data at ~10 Hz.
 */
export function createLimiterNode(
  actx: AudioContext,
  onMetrics?: MetricsCallback,
): AudioWorkletNode {
  const node = new AudioWorkletNode(actx, "lookahead-limiter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });

  if (onMetrics) {
    node.port.onmessage = (e: MessageEvent<LimiterMetrics>) => {
      onMetrics(e.data);
    };
  }

  return node;
}
