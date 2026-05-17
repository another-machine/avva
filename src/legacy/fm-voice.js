/**
 * modules/fm-voice.js
 *
 * Two-operator FM voice primitive.
 *
 *   modulator (sine)  →  modGain  →  carrier.frequency
 *   carrier   (sine)  →  outGain  →  dest
 *
 * Parameters:
 *   ratio  fm / fc.
 *          Integer ratios (1, 2, 3, …) → harmonic spectrum, musical.
 *          Near-integer (1.04, 1.96)  → chorusy, beating sidebands.
 *          Non-integer (1.41, 7.0)     → inharmonic, bell, metallic.
 *   index  modulation index — how many sidebands and how bright.
 *          Convention: modGain.gain = index × current modulator frequency.
 *          Holding this product constant keeps the timbre stable across
 *          pitches (matches how DX-style FM is normally parameterised).
 *
 * No envelopes built in. Callers schedule gain / modGain ramps for
 * sustained tones (pads) or transient strikes (pluck).
 *
 * Pure mono — stereo panning is the caller's concern so this primitive
 * stays composable.
 */

export class FMVoice {
  /**
   * @param {AudioContext} actx
   * @param {AudioNode}    dest    where outGain connects to
   * @param {object}       [opts]
   * @param {string}       [opts.carrierType='sine']
   * @param {string}       [opts.modulatorType='sine']
   * @param {number}       [opts.ratio=1]
   * @param {number}       [opts.index=0.5]
   * @param {boolean}      [opts.autostart=true]
   */
  constructor(actx, dest, opts = {}) {
    this._actx = actx;

    this.carrier = actx.createOscillator();
    this.modulator = actx.createOscillator();
    this.modGain = actx.createGain();
    this.outGain = actx.createGain();

    this.carrier.type = opts.carrierType ?? "sine";
    this.modulator.type = opts.modulatorType ?? "sine";

    this.modulator.connect(this.modGain);
    this.modGain.connect(this.carrier.frequency);
    this.carrier.connect(this.outGain);
    this.outGain.connect(dest);

    this.outGain.gain.value = 0;
    this.modGain.gain.value = 0;

    this.ratio = opts.ratio ?? 1;
    this.index = opts.index ?? 0.5;
    this._fc = 440;

    if (opts.autostart !== false) {
      this.carrier.start();
      this.modulator.start();
    }
  }

  /**
   * Glide carrier + modulator to a new carrier frequency.
   * Re-targets modGain so the modulation INDEX is preserved across the move.
   */
  glideTo(fc, tau) {
    if (!Number.isFinite(fc) || fc <= 0) return;
    const now = this._actx.currentTime;
    const fm = fc * this.ratio;
    this._fc = fc;
    this._cancel(this.carrier.frequency, now);
    this._cancel(this.modulator.frequency, now);
    this.carrier.frequency.setTargetAtTime(fc, now, tau);
    this.modulator.frequency.setTargetAtTime(fm, now, tau);
    this._cancel(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(this.index * fm, now, tau);
  }

  /** Glide modulation index (timbre brightness) over `tau` seconds. */
  setIndex(index, tau) {
    if (!Number.isFinite(index)) return;
    this.index = Math.max(0, index);
    const now = this._actx.currentTime;
    const fm = this._fc * this.ratio;
    this._cancel(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(this.index * fm, now, tau);
  }

  /**
   * Glide modulator ratio (detune sidebands).
   * Used to drift voices off-integer for chorus / inharmonic effects.
   */
  setRatio(ratio, tau) {
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
  setGain(g, tau) {
    if (!Number.isFinite(g)) return;
    const now = this._actx.currentTime;
    this._cancel(this.outGain.gain, now);
    this.outGain.gain.setTargetAtTime(Math.max(0, g), now, tau);
  }

  /**
   * Trigger a one-shot pluck.
   *
   * Modulation depth envelope decays faster than amplitude — the classic
   * DX7 "metallic ping fading into a pure tone" arc. Modulator type can
   * be temporarily overridden for character (e.g. triangle modulator on
   * the strike for a touch of grit).
   *
   * @param {number} fc                  carrier frequency
   * @param {object} [opts]
   * @param {number} [opts.peak=0.12]
   * @param {number} [opts.ampDecayTau]  required-ish; 0.04–0.6 range
   * @param {number} [opts.modDecayTau]  default = ampDecayTau × 0.35
   * @param {number} [opts.indexPeak]    default = this.index × 4
   * @param {number} [opts.attackTau=0.003]
   */
  pluck(fc, opts = {}) {
    if (!Number.isFinite(fc) || fc <= 0) return;
    const now = this._actx.currentTime;
    const fm = fc * this.ratio;
    this._fc = fc;

    const peak = opts.peak ?? 0.12;
    const ampDecayTau = opts.ampDecayTau ?? 0.18;
    const modDecayTau = opts.modDecayTau ?? ampDecayTau * 0.35;
    const indexPeak = opts.indexPeak ?? this.index * 4;
    const attackTau = opts.attackTau ?? 0.003;

    // Carrier + modulator pitches set instantly (no glide on a strike)
    this.carrier.frequency.cancelScheduledValues(now);
    this.modulator.frequency.cancelScheduledValues(now);
    this.carrier.frequency.setValueAtTime(fc, now);
    this.modulator.frequency.setValueAtTime(fm, now);

    // Modulation depth envelope — sharp peak, fast decay (timbre transient)
    this.modGain.gain.cancelScheduledValues(now);
    this.modGain.gain.setValueAtTime(0, now);
    this.modGain.gain.setTargetAtTime(indexPeak * fm, now, attackTau);
    this.modGain.gain.setTargetAtTime(0, now + attackTau * 4, modDecayTau);

    // Amplitude envelope — slower decay (the note lingers)
    this.outGain.gain.cancelScheduledValues(now);
    this.outGain.gain.setValueAtTime(0, now);
    this.outGain.gain.setTargetAtTime(peak, now, attackTau);
    this.outGain.gain.setTargetAtTime(0, now + attackTau * 5, ampDecayTau);
  }

  /**
   * cancelAndHoldAtTime where available, fallback to
   * cancel+setValueAtTime(current) for older browsers.
   */
  _cancel(param, now) {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      const v = param.value;
      param.cancelScheduledValues(0);
      param.setValueAtTime(v, now);
    }
  }
}
