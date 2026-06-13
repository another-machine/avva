/**
 * src/audio/fm-voice.ts
 *
 * Two-operator FM voice: modulator → modGain → carrier.frequency.
 * carrier → outGain → dest.
 */

export interface FMVoiceOptions {
  ratio?: number;
  index?: number;
  carrierType?: OscillatorType;
  modulatorType?: OscillatorType;
}

export interface PluckOptions {
  peak?: number;
  ampDecayTau?: number;
  modDecayTau?: number;
  indexPeak?: number;
  attackTau?: number;
}

export class FMVoice {
  ratio: number;
  index: number;

  readonly carrier: OscillatorNode;
  readonly modulator: OscillatorNode;
  readonly modGain: GainNode;
  readonly outGain: GainNode;

  private _actx: AudioContext;
  private _fc: number;

  constructor(actx: AudioContext, dest: AudioNode, opts: FMVoiceOptions = {}) {
    this._actx = actx;
    this.ratio = opts.ratio ?? 1;
    this.index = opts.index ?? 0;
    this._fc = 220;

    this.carrier = actx.createOscillator();
    this.modulator = actx.createOscillator();
    this.modGain = actx.createGain();
    this.outGain = actx.createGain();

    this.carrier.type = opts.carrierType ?? "sine";
    this.modulator.type = opts.modulatorType ?? "sine";

    this.carrier.frequency.value = this._fc;
    const fm = this._fc * this.ratio;
    this.modulator.frequency.value = fm;
    this.modGain.gain.value = this.index * fm;
    this.outGain.gain.value = 0;

    // Routing: modulator → modGain → carrier.frequency
    this.modulator.connect(this.modGain);
    this.modGain.connect(this.carrier.frequency);

    // carrier → outGain → dest
    this.carrier.connect(this.outGain);
    this.outGain.connect(dest);

    this.modulator.start();
    this.carrier.start();
  }

  /** Glide carrier frequency over `tau` seconds. */
  glideTo(fc: number, tau: number): void {
    if (!Number.isFinite(fc) || fc <= 0) return;
    this._fc = fc;
    const now = this._actx.currentTime;
    const fm = fc * this.ratio;
    this._cancel(this.carrier.frequency, now);
    this.carrier.frequency.setTargetAtTime(fc, now, tau);
    this._cancel(this.modulator.frequency, now);
    this.modulator.frequency.setTargetAtTime(fm, now, tau);
    this._cancel(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(this.index * fm, now, tau);
  }

  /** Glide modulation index (timbre brightness) over `tau` seconds. */
  setIndex(index: number, tau: number): void {
    if (!Number.isFinite(index)) return;
    this.index = Math.max(0, index);
    const now = this._actx.currentTime;
    const fm = this._fc * this.ratio;
    this._cancel(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(this.index * fm, now, tau);
  }

  /** Glide modulator ratio (detune sidebands for chorus / inharmonic effects). */
  setRatio(ratio: number, tau: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.ratio = ratio;
    const now = this._actx.currentTime;
    const fm = this._fc * ratio;
    this._cancel(this.modulator.frequency, now);
    this.modulator.frequency.setTargetAtTime(fm, now, tau);
    this._cancel(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(this.index * fm, now, tau);
  }

  /** Glide output amplitude. */
  setGain(g: number, tau: number): void {
    if (!Number.isFinite(g)) return;
    const now = this._actx.currentTime;
    this._cancel(this.outGain.gain, now);
    this.outGain.gain.setTargetAtTime(Math.max(0, g), now, tau);
  }

  /**
   * Trigger a one-shot pluck.
   * Modulation depth envelope decays faster than amplitude — classic DX7 arc.
   *
   * Retrigger safety: a 3ms crossfade silences any in-progress decay before
   * the new note starts. This prevents the click that occurs when
   * cancelScheduledValues + setValueAtTime(0) instantly yanks a mid-decay
   * amplitude to zero.
   */
  pluck(fc: number, opts: PluckOptions = {}): void {
    if (!Number.isFinite(fc) || fc <= 0) return;
    const now = this._actx.currentTime;
    const XFADE = 0.003; // 3ms — inaudible delay, eliminates retrigger click
    const t = now + XFADE;
    const fm = fc * this.ratio;
    this._fc = fc;

    const peak = opts.peak ?? 0.12;
    const ampDecayTau = opts.ampDecayTau ?? 0.18;
    const modDecayTau = opts.modDecayTau ?? ampDecayTau * 0.35;
    const indexPeak = opts.indexPeak ?? this.index * 4;
    const attackTau = opts.attackTau ?? 0.003;

    // Hold current amplitude, fade to ~0 over 3ms so any in-progress decay
    // doesn't produce a discontinuity when the frequency snaps to the new pitch.
    this._cancel(this.outGain.gain, now);
    this.outGain.gain.setTargetAtTime(0, now, 0.001);

    // Frequency snaps at time t (near-zero amplitude → phase glitch is silent).
    this.carrier.frequency.cancelScheduledValues(now);
    this.modulator.frequency.cancelScheduledValues(now);
    this.carrier.frequency.setValueAtTime(fc, t);
    this.modulator.frequency.setValueAtTime(fm, t);

    // FM index envelope — starts from 0 at t.
    this.modGain.gain.cancelScheduledValues(now);
    this.modGain.gain.setValueAtTime(0, t);
    this.modGain.gain.setTargetAtTime(indexPeak * fm, t, attackTau);
    this.modGain.gain.setTargetAtTime(0, t + attackTau * 4, modDecayTau);

    // Amplitude envelope — starts from 0 at t.
    this.outGain.gain.setValueAtTime(0, t);
    this.outGain.gain.setTargetAtTime(peak, t, attackTau);
    this.outGain.gain.setTargetAtTime(0, t + attackTau * 5, ampDecayTau);
  }

  /**
   * cancelAndHoldAtTime where available, fallback to cancel+setValueAtTime.
   */
  private _cancel(param: AudioParam, now: number): void {
    if (
      typeof (
        param as AudioParam & {
          cancelAndHoldAtTime?: (time: number) => AudioParam;
        }
      ).cancelAndHoldAtTime === "function"
    ) {
      (
        param as AudioParam & {
          cancelAndHoldAtTime: (time: number) => AudioParam;
        }
      ).cancelAndHoldAtTime(now);
    } else {
      const v = param.value;
      param.cancelScheduledValues(0);
      param.setValueAtTime(v, now);
    }
  }
}
