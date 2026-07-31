import type { AnalysisOut } from "../analysis/analyzer.js";
import type { AudioFrame } from "../analysis/audio-analyzer.js";
import type { SynthControls } from "../audio/synth.js";
import type { LimiterMetrics } from "@amplib/sound-synthesis";
import type { VisualUniforms } from "../render/audio-renderer-gl.js";

export interface TelemetryMsg {
  t: number;
  fps: number;
  sourceLabel?: string;
  resLabel?: string;
  video?: AnalysisOut;
  histBins?: Float32Array;
  audio?: AudioFrame;
  synth?: {
    running: boolean;
    keyLabel?: string;
    note?: { label: string; slotIndex: number } | null;
    /**
     * Ground-truth grid of notes the synth is generating, indexed
     * (octave - noteGridOctL) * 12 + pitchClass, value 0..1. Omitted when the
     * synth is off. Rendered in the controller's Video panel against the audio
     * analyzer's detected-notes grid.
     */
    noteGrid?: Float32Array;
    noteGridOctL?: number;
    noteGridOctH?: number;
  };
  synthControls?: SynthControls;
  limiterMetrics?: LimiterMetrics;
  visualUniforms?: VisualUniforms;
}

const CHANNEL = "avva-telemetry";

export class TelemetrySender {
  private _ch: BroadcastChannel;
  constructor() {
    this._ch = new BroadcastChannel(CHANNEL);
  }
  send(msg: TelemetryMsg): void {
    this._ch.postMessage(msg);
  }
  close(): void {
    this._ch.close();
  }
}

export class TelemetryReceiver {
  private _ch: BroadcastChannel;
  constructor(onMsg: (msg: TelemetryMsg) => void) {
    this._ch = new BroadcastChannel(CHANNEL);
    this._ch.onmessage = (e) => onMsg(e.data as TelemetryMsg);
  }
  close(): void {
    this._ch.close();
  }
}
