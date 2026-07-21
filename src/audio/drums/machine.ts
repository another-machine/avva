/**
 * DrumMachine — lookahead scheduler driving DrumSynth voices.
 *
 * Uses the "A Tale of Two Clocks" pattern: a setTimeout loop checks
 * ctx.currentTime every 25 ms and pre-schedules hits within a 100 ms
 * lookahead window. This decouples the scheduler from the audio thread
 * and handles tab-background throttling gracefully.
 */

import { DrumSynth } from "./synth.js";
import { PATTERNS, type PatternName } from "./patterns.js";

const LOOKAHEAD = 0.1;   // seconds to schedule ahead
const INTERVAL  = 25;    // ms between scheduler ticks

export class DrumMachine {
  private _synth: DrumSynth;
  private _bpm = 85;
  private _patternName: PatternName = "rock";
  private _step = 0;
  private _nextNoteTime = 0;
  private _timerID: ReturnType<typeof setTimeout> | null = null;

  // Tap tempo state
  private _taps: number[] = [];

  constructor(drumSynth: DrumSynth) {
    this._synth = drumSynth;
  }

  get bpm(): number { return this._bpm; }
  get running(): boolean { return this._timerID !== null; }

  start(): void {
    if (this.running) return;
    this._step = 0;
    this._nextNoteTime = 0; // will be reset on first tick
    this._tick();
  }

  stop(): void {
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
  }

  setBpm(bpm: number): void {
    this._bpm = Math.max(40, Math.min(180, bpm));
  }

  setPattern(name: string): void {
    if (name in PATTERNS) {
      if (name !== this._patternName) {
        this._patternName = name as PatternName;
        this._step = 0; // restart pattern on switch
      }
    }
  }

  tap(): void {
    const now = performance.now();
    // Reset if gap > 2 s
    if (this._taps.length > 0 && now - this._taps[this._taps.length - 1] > 2000) {
      this._taps = [];
    }
    this._taps.push(now);
    // Keep last 4 taps
    if (this._taps.length > 4) this._taps.shift();
    if (this._taps.length >= 2) {
      // Average inter-tap interval
      let totalGap = 0;
      for (let i = 1; i < this._taps.length; i++) {
        totalGap += this._taps[i] - this._taps[i - 1];
      }
      const avgMs = totalGap / (this._taps.length - 1);
      this._bpm = Math.round(Math.max(40, Math.min(180, 60000 / avgMs)));
    }
  }

  private _tick(): void {
    // Lazily grab the AudioContext time via the synth's first hit node.
    // We get ctx from the synth indirectly via a stored reference we add below.
    const ctx = (this._synth as unknown as { _ctx: AudioContext })._ctx;
    if (!ctx) {
      this._timerID = setTimeout(() => this._tick(), INTERVAL);
      return;
    }

    if (this._nextNoteTime === 0) {
      this._nextNoteTime = ctx.currentTime + 0.05;
    }

    const pattern = PATTERNS[this._patternName];
    const stepLen = 60 / this._bpm / 4; // one 16th note

    while (this._nextNoteTime < ctx.currentTime + LOOKAHEAD) {
      const s = this._step % pattern.steps;
      const t = this._nextNoteTime;

      if (pattern.kick[s]   > 0) this._synth.kick(t, pattern.kick[s]);
      if (pattern.snare[s]  > 0) this._synth.snare(t, pattern.snare[s]);
      if (pattern.hihatC[s] > 0) this._synth.hihatClosed(t, pattern.hihatC[s]);
      if (pattern.hihatO[s] > 0) this._synth.hihatOpen(t, pattern.hihatO[s]);
      if (pattern.rim[s]    > 0) this._synth.rim(t, pattern.rim[s]);

      this._nextNoteTime += stepLen;
      this._step = (this._step + 1) % pattern.steps;
    }

    this._timerID = setTimeout(() => this._tick(), INTERVAL);
  }
}
