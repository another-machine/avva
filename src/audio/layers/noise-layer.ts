/**
 * src/audio/layers/noise-layer.ts
 *
 * Noise resonator bank: looped white noise → N high-Q bandpass biquads tuned
 * to chord notes → noiseBus. Driven by SPR×(1−CTR) — diffuse, spread,
 * low-contrast scenes get an airy textural wash instead of pure FM pads.
 *
 * Band count adapts to chord size (3–5 resonators). Q = 28 for narrow
 * pitch-centred bands; still chroma-readable by the stage-3 analyzer.
 */

const BAND_Q = 28;    // high-Q biquad — narrows the band but stays tonal
const N_BANDS = 5;    // max simultaneous resonators (one per chord note)
const NOISE_SECS = 4; // looped noise buffer length

function pcToFreq(pc: number, octave: number): number {
  return 440 * Math.pow(2, (pc - 9 + (octave - 4) * 12) / 12);
}

interface Band {
  bp: BiquadFilterNode;
  gain: GainNode;
}

export class NoiseLayer {
  private readonly _actx: AudioContext;
  private readonly _noise: AudioBufferSourceNode;
  private readonly _bands: Band[];
  private readonly _outGain: GainNode;
  private _weight = 0;

  constructor(actx: AudioContext, bus: GainNode) {
    this._actx = actx;

    // Looped white noise source
    const noiseBuf = actx.createBuffer(1, Math.floor(NOISE_SECS * actx.sampleRate), actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this._noise = actx.createBufferSource();
    this._noise.buffer = noiseBuf;
    this._noise.loop = true;

    // Layer output gain (layer weight drives this)
    this._outGain = actx.createGain();
    this._outGain.gain.value = 0;
    this._outGain.connect(bus);

    // Pre-allocate N_BANDS bandpass biquads
    this._bands = Array.from({ length: N_BANDS }, () => {
      const bp = actx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 440;
      bp.Q.value = BAND_Q;
      const g = actx.createGain();
      g.gain.value = 0;
      this._noise.connect(bp);
      bp.connect(g);
      g.connect(this._outGain);
      return { bp, gain: g };
    });

    this._noise.start();
  }

  /** Update resonator frequencies + layer weight from current chord and axis values.
   *  @param pitchClasses  Active pitch classes in order (root first)
   *  @param octave        Base octave for resonators
   *  @param weight        Layer weight 0..1 (SPR×(1−CTR))
   *  @param now           AudioContext.currentTime
   *  @param slowTau       Smoothing time constant (seconds)
   */
  update(
    pitchClasses: number[],
    octave: number,
    weight: number,
    now: number,
    slowTau: number,
  ): void {
    this._weight = weight;

    // Layer output gain: weight * per-band level compensation
    const nBands = Math.min(pitchClasses.length, N_BANDS);
    // Compensate so total power stays roughly constant as band count changes
    const bandComp = nBands > 0 ? 1 / Math.sqrt(nBands) : 1;
    this._outGain.gain.setTargetAtTime(weight * 0.35 * bandComp, now, slowTau);

    for (let bi = 0; bi < N_BANDS; bi++) {
      const { bp, gain } = this._bands[bi];
      if (bi < nBands) {
        const freq = pcToFreq(pitchClasses[bi], octave);
        if (Number.isFinite(freq) && freq > 20) {
          bp.frequency.setTargetAtTime(freq, now, slowTau);
        }
        gain.gain.setTargetAtTime(1, now, slowTau);
      } else {
        gain.gain.setTargetAtTime(0, now, slowTau);
      }
    }
  }

  get weight(): number { return this._weight; }
}
