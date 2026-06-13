/**
 * src/audio/worklet-host.ts
 *
 * Loads AudioWorklet modules and exposes typed node creation helpers.
 * Gracefully falls back to the Phase-1 safety compressor if addModule fails.
 */

import limiterUrl from "./worklets/limiter.js?url";

export interface LimiterMetrics {
  lufsShort: number;
  gr: number;
}

export type MetricsCallback = (m: LimiterMetrics) => void;

/**
 * Attempt to load all AudioWorklet modules for the given AudioContext.
 * Returns true if loading succeeded, false on any error (caller keeps the
 * safety-compressor fallback in place).
 */
export async function loadWorklets(actx: AudioContext): Promise<boolean> {
  try {
    await actx.audioWorklet.addModule(limiterUrl);
    return true;
  } catch (e) {
    console.warn("[worklet-host] AudioWorklet load failed — keeping safety compressor:", e);
    return false;
  }
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
