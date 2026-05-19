/**
 * src/pipeline/stage.ts
 *
 * Typed stage interface for the four-step AVVA signal pipeline.
 * Each stage has a named ID, a run() method, and can be probed.
 */

export type StageId =
  | "videoAnalysis"
  | "soundSynthesis"
  | "audioAnalysis"
  | "visualSynthesis";

export interface Stage<I, O> {
  readonly id: StageId;
  readonly label: string;
  run(input: I): O;
}

/** Called after each stage completes. Use to record snapshots or send telemetry. */
export type StageProbe = (
  id: StageId,
  input: unknown,
  output: unknown,
  dtMs: number,
) => void;
