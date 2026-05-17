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
   */
  pluck(fc: number, opts: PluckOptions = {}): void {
    if (!Number.isFinite(fc) || fc <= 0) return;
    const now = this._actx.currentTime;
    const fm = fc * this.ratio;
    this._fc = fc;

    const peak = opts.peak ?? 0.12;
    const ampDecayTau = opts.ampDecayTau ?? 0.18;
    const modDecayTau = opts.modDecayTau ?? ampDecayTau * 0.35;
    const indexPeak = opts.indexPeak ?? this.index * 4;
    const attackTau = opts.attackTau ?? 0.003;

    this.carrier.frequency.cancelScheduledValues(now);
    this.modulator.frequency.cancelScheduledValues(now);
    this.carrier.frequency.setValueAtTime(fc, now);
    this.modulator.frequency.setValueAtTime(fm, now);

    this.modGain.gain.cancelScheduledValues(now);
    this.modGain.gain.setValueAtTime(0, now);
    this.modGain.gain.setTargetAtTime(indexPeak * fm, now, attackTau);
    this.modGain.gain.setTargetAtTime(0, now + attackTau * 4, modDecayTau);

    this.outGain.gain.cancelScheduledValues(now);
    this.outGain.gain.setValueAtTime(0, now);
    this.outGain.gain.setTargetAtTime(peak, now, attackTau);
    this.outGain.gain.setTargetAtTime(0, now + attackTau * 5, ampDecayTau);
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
