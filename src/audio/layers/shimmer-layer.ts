/**
 * src/audio/layers/shimmer-layer.ts
 *
 * Shimmer layer: 2 pure-sine FM voices pitched 1–2 octaves above the root,
 * with slow random amplitude modulation (0.05–0.3 Hz LFO per voice) that
 * gives a granular, glassy shimmer without a true grain scheduler.
 *
 * Driven by TILT_high × (1−FLUX): brightest, calmest scenes get an airy
 * high-frequency sheen on top of the FM pads.
 */

const N_VOICES = 2;
const LFO_HZ  = [0.08, 0.13]; // slow wobble per voice
const OCT_UP  = [1, 2] as const; // voice 0: +1 octave, voice 1: +2 octaves

function pcToFreq(pc: number, octave: number): number {
  return 440 * Math.pow(2, (pc - 9 + (octave - 4) * 12) / 12);
}

interface ShimmerVoice {
  carrier: OscillatorNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  outGain: GainNode;
  panner: StereoPannerNode;
}

export class ShimmerLayer {
  private readonly _voices: ShimmerVoice[];
  private readonly _outGain: GainNode;
  private _weight = 0;

  constructor(actx: AudioContext, bus: GainNode) {
    this._outGain = actx.createGain();
    this._outGain.gain.value = 0;
    this._outGain.connect(bus);

    this._voices = LFO_HZ.map((lfoHz, vi) => {
      // Carrier: sine oscillator at +octave above root
      const carrier = actx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = 880;

      // Slow AM LFO
      const lfo = actx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = lfoHz + (Math.random() * 0.04 - 0.02); // slight detune
      const lfoDepth = actx.createGain();
      lfoDepth.gain.value = 0.4; // LFO depth: ±0.4 of base gain

      // Output gain (base level)
      const outGain = actx.createGain();
      outGain.gain.value = 0.5; // base level before LFO

      // Panner (voices spread L/R)
      const panner = actx.createStereoPanner();
      panner.pan.value = vi === 0 ? -0.4 : 0.4;

      // Wire: carrier → panner → outGain → _outGain
      //       lfo → lfoDepth → outGain.gain (AM)
      lfo.connect(lfoDepth);
      lfoDepth.connect(outGain.gain);
      carrier.connect(panner);
      panner.connect(outGain);
      outGain.connect(this._outGain);

      carrier.start();
      lfo.start();

      return { carrier, lfo, lfoDepth, outGain, panner };
    });
  }

  /** Update shimmer frequencies + layer weight.
   *  @param rootPc    Root pitch class
   *  @param baseOctave Base octave of the FM pad tiers
   *  @param pos        Horizontal position (0..1) for subtle pan drift
   *  @param weight     Layer weight 0..1 (TILT_high × (1−FLUX))
   *  @param now        AudioContext.currentTime
   *  @param slowTau    Smoothing time constant (seconds)
   */
  update(
    rootPc: number,
    baseOctave: number,
    pos: number,
    weight: number,
    now: number,
    slowTau: number,
  ): void {
    this._weight = weight;
    this._outGain.gain.setTargetAtTime(weight * 0.12, now, slowTau);

    for (let vi = 0; vi < N_VOICES; vi++) {
      const { carrier, panner } = this._voices[vi];
      const freq = pcToFreq(rootPc, baseOctave + OCT_UP[vi]);
      if (Number.isFinite(freq) && freq > 0 && freq < 20000) {
        carrier.frequency.setTargetAtTime(freq, now, slowTau);
      }
      // Pos shifts pan slightly
      const basePan = vi === 0 ? -0.4 : 0.4;
      panner.pan.setTargetAtTime(basePan + (pos - 0.5) * 0.3, now, slowTau);
    }
  }

  get weight(): number { return this._weight; }
}
