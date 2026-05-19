/**
 * src/pipeline/pipeline.ts
 *
 * Orchestrates the four AVVA signal stages in order each RAF frame.
 * Probes can be registered to receive per-stage snapshots (e.g. telemetry).
 */

import type { StageProbe } from "./stage.js";

export interface PipelineStages {
  runVideo: () => unknown;
  runSynth: (videoOut: unknown) => unknown;
  runAudio: () => unknown;
  runVisual: (audioOut: unknown) => unknown;
}

export class Pipeline {
  private _probes: StageProbe[] = [];
  private _stages: PipelineStages;

  constructor(stages: PipelineStages) {
    this._stages = stages;
  }

  addProbe(fn: StageProbe): void {
    this._probes.push(fn);
  }

  tick(): {
    videoOut: unknown;
    synthOut: unknown;
    audioOut: unknown;
    visualOut: unknown;
  } {
    const s = this._stages;

    let t0 = performance.now();
    const videoOut = s.runVideo();
    const videoMs = performance.now() - t0;
    this._notify("videoAnalysis", null, videoOut, videoMs);

    t0 = performance.now();
    const synthOut = s.runSynth(videoOut);
    const synthMs = performance.now() - t0;
    this._notify("soundSynthesis", videoOut, synthOut, synthMs);

    t0 = performance.now();
    const audioOut = s.runAudio();
    const audioMs = performance.now() - t0;
    this._notify("audioAnalysis", null, audioOut, audioMs);

    t0 = performance.now();
    const visualOut = s.runVisual(audioOut);
    const visualMs = performance.now() - t0;
    this._notify("visualSynthesis", audioOut, visualOut, visualMs);

    return { videoOut, synthOut, audioOut, visualOut };
  }

  private _notify(
    id: Parameters<StageProbe>[0],
    input: unknown,
    output: unknown,
    dtMs: number,
  ): void {
    for (const probe of this._probes) probe(id, input, output, dtMs);
  }
}
