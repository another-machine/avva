/**
 * src/audio/voices.ts
 *
 * TierBackend abstraction: two implementations of the same 5-voice FM tier.
 *   NodeTierBackend  — existing FMVoice node-graph (safe fallback, A/B reference)
 *   WorkletTierBackend — fm-tier AudioWorkletNode (Phase 3, behind synth.engine flag)
 *
 * Both backends expose the same API so synth.ts update() is engine-agnostic.
 * Param writes go through setGain/setIndex/setRatio/setPan/glideTo; the worklet
 * backend batches them into a single Float32Array postMessage per flush() call.
 */

import { FMVoice } from "./fm-voice.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Cancel pending AudioParam automation and hold current value. */
function cancelParam(param: AudioParam, now: number): void {
  type EP = AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof (param as EP).cancelAndHoldAtTime === "function") {
    (param as EP).cancelAndHoldAtTime!(now);
  } else {
    const v = param.value;
    param.cancelScheduledValues(0);
    param.setValueAtTime(v, now);
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface TierBackend {
  readonly voiceCount: number;
  /** Wire voice outputs into bus (call once after construction). */
  connect(bus: GainNode): void;
  /** AudioParams for the wow/flutter LFO connection (one per carrier in node
   *  mode; single shared param in worklet mode). */
  detuneTargets(): AudioParam[];
  glideTo(vi: number, fc: number, tau: number): void;
  setIndex(vi: number, index: number, tau: number): void;
  setRatio(vi: number, ratio: number, tau: number): void;
  setGain(vi: number, gain: number, tau: number): void;
  /** now = AudioContext.currentTime — used by NodeTierBackend for AudioParam
   *  cancellation; WorkletTierBackend ignores it (uses per-sample smoothing). */
  setPan(vi: number, pan: number, tau: number, now: number): void;
  /** Notify backend of carrier waveform change for voice vi. */
  setCarrierWave(vi: number, name: string): void;
  /** Send buffered params to the worklet (no-op for NodeTierBackend). */
  flush(): void;
}

// ── NodeTierBackend ───────────────────────────────────────────────────────────

interface NodeVoice {
  fm: FMVoice;
  panner: StereoPannerNode;
}

/**
 * Node-graph tier backend: mirrors the original FMVoice + StereoPannerNode per
 * voice setup. Used as the default engine and as an A/B reference.
 *
 * @param applyWave  Callback that sets a carrier OscillatorNode's waveform by
 *   name — provided by Synth so it can reuse the shared PeriodicWave cache.
 */
export class NodeTierBackend implements TierBackend {
  readonly voiceCount = 5;
  private readonly _actx: AudioContext;
  private readonly _voices: NodeVoice[];
  private readonly _applyWave: (osc: OscillatorNode, name: string) => void;

  constructor(
    actx: AudioContext,
    ratioBase: number,
    applyWave: (osc: OscillatorNode, name: string) => void,
  ) {
    this._actx = actx;
    this._applyWave = applyWave;
    this._voices = Array.from({ length: 5 }, (_, vi) => {
      const panner = actx.createStereoPanner();
      panner.pan.value = 0;
      // Construct FMVoice with panner as its output destination (outGain → panner)
      const fm = new FMVoice(actx, panner, { ratio: ratioBase, index: 0.4 });
      return { fm, panner };
    });
  }

  connect(bus: GainNode): void {
    for (const { panner } of this._voices) panner.connect(bus);
  }

  detuneTargets(): AudioParam[] {
    return this._voices.map((v) => v.fm.carrier.detune);
  }

  glideTo(vi: number, fc: number, tau: number): void {
    this._voices[vi].fm.glideTo(fc, tau);
  }

  setIndex(vi: number, index: number, tau: number): void {
    this._voices[vi].fm.setIndex(index, tau);
  }

  setRatio(vi: number, ratio: number, tau: number): void {
    this._voices[vi].fm.setRatio(ratio, tau);
  }

  setGain(vi: number, gain: number, tau: number): void {
    this._voices[vi].fm.setGain(gain, tau);
  }

  setPan(vi: number, pan: number, tau: number, now: number): void {
    if (!Number.isFinite(pan)) return;
    const p = Math.max(-1, Math.min(1, pan));
    cancelParam(this._voices[vi].panner.pan, now);
    this._voices[vi].panner.pan.setTargetAtTime(p, now, tau);
  }

  setCarrierWave(vi: number, name: string): void {
    this._applyWave(this._voices[vi].fm.carrier, name);
  }

  flush(): void { /* no-op: all writes go directly to AudioParams */ }
}

// ── WorkletTierBackend ────────────────────────────────────────────────────────

const PARAMS_PER_VOICE = 10;
const BUF_SIZE = 5 * PARAMS_PER_VOICE; // 50 floats

/**
 * Worklet tier backend: wraps one fm-tier AudioWorkletNode (5-voice stereo).
 * Parameter writes are batched into a Float32Array and sent via postMessage
 * once per flush() (once per rAF frame), keeping the message bus quiet.
 */
export class WorkletTierBackend implements TierBackend {
  readonly voiceCount = 5;
  private readonly _node: AudioWorkletNode;
  /** Param buffer: [freq, freqTau, idx, idxTau, ratio, ratioTau, gain, gainTau, pan, panTau] × 5 */
  private readonly _buf: Float32Array;

  constructor(actx: AudioContext) {
    this._node = new AudioWorkletNode(actx, "fm-tier", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    this._buf = new Float32Array(BUF_SIZE);
    // Safe initial defaults: freq=220, idx=0.4, ratio=1, gain=0, pan=0
    for (let v = 0; v < 5; v++) {
      const o = v * PARAMS_PER_VOICE;
      this._buf[o + 0] = 220; // freq
      this._buf[o + 2] = 0.4; // index
      this._buf[o + 4] = 1.0; // ratio
    }
  }

  connect(bus: GainNode): void {
    this._node.connect(bus);
  }

  /** Returns the single "detune" AudioParam shared by all 5 voices.
   *  Both wow and flutter LFOs connect to it (they sum, same as in node mode). */
  detuneTargets(): AudioParam[] {
    const p = this._node.parameters.get("detune");
    return p ? [p] : [];
  }

  glideTo(vi: number, fc: number, tau: number): void {
    const o = vi * PARAMS_PER_VOICE;
    this._buf[o + 0] = fc;
    this._buf[o + 1] = tau;
  }

  setIndex(vi: number, index: number, tau: number): void {
    const o = vi * PARAMS_PER_VOICE;
    this._buf[o + 2] = index;
    this._buf[o + 3] = tau;
  }

  setRatio(vi: number, ratio: number, tau: number): void {
    const o = vi * PARAMS_PER_VOICE;
    this._buf[o + 4] = ratio;
    this._buf[o + 5] = tau;
  }

  setGain(vi: number, gain: number, tau: number): void {
    const o = vi * PARAMS_PER_VOICE;
    this._buf[o + 6] = gain;
    this._buf[o + 7] = tau;
  }

  setPan(vi: number, pan: number, tau: number, _now: number): void {
    const o = vi * PARAMS_PER_VOICE;
    this._buf[o + 8] = pan;
    this._buf[o + 9] = tau;
  }

  setCarrierWave(vi: number, name: string): void {
    this._node.port.postMessage({ type: "wave", vi, name });
  }

  /** Send all buffered param updates to the worklet in one message. */
  flush(): void {
    // Structured-clone copy (200 bytes) — cheaper than allocating a new array
    this._node.port.postMessage({ type: "params", voices: this._buf });
  }
}
