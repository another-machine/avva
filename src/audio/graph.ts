/**
 * src/audio/graph.ts
 *
 * AudioGraph — owns the AudioContext and the entire bus/routing topology.
 * Voices connect into the named bus GainNodes; downstream routing (slotting
 * filters, cassette insert, master chain, safety limiter) is wired here.
 *
 * Signal flow:
 *
 *   subBus ────────────────┐
 *   bassBus (HP45/LP800)───┤
 *   midBus  (HP140) ───────┼──► layerSum ──► masterTrim ──► dimGain ──► tremoloSum
 *   trebleBus (HP500) ─────┤                                                │
 *   pluckBus  (HP300) ─────┘                                         analysisTap  ←── stage-3 analyzer taps here
 *   ksBus / noiseBus /                                                      │
 *   shimmerBus (Phase 4) ──┘                                         headroomPad (−6 dB)
 *                                                                           │
 *                                                             [cassette insert, wired by Synth]
 *                                                                           │
 *                                                                     autoMakeup
 *                                                                           │
 *                                                                    safetyComp  (Phase 2: replaced by worklet limiter)
 *                                                                           │
 *                                                                    masterPanner
 *                                                                           │
 *                                                                        output ──► destination + broadcast tap
 */

export class AudioGraph {
  readonly actx: AudioContext;

  // ── Layer buses ──────────────────────────────────────────────
  readonly subBus: GainNode;
  readonly bassBus: GainNode;
  readonly midBus: GainNode;
  readonly trebleBus: GainNode;
  readonly pluckBus: GainNode;
  // Reserved for Phase 4
  readonly ksBus: GainNode;
  readonly noiseBus: GainNode;
  readonly shimmerBus: GainNode;

  // ── Shared signal chain ──────────────────────────────────────
  readonly layerSum: GainNode;

  /** User-controlled master gain. Updated by setMasterGain(). */
  readonly masterTrim: GainNode;

  /** Bri-driven dim: setTargetAtTime per frame. Separate from masterTrim so
   *  the two writers don't fight over the same AudioParam. */
  readonly dimGain: GainNode;

  /** Tremolo LFO connects here so it gets its own dedicated AudioParam. */
  readonly tremoloSum: GainNode;

  /** Pre-cassette tap — stage-3 audio analyzer connects here.
   *  Spectrally equivalent to old _master: post-user-gain, pre-cassette. */
  readonly analysisTap: GainNode;

  /** −6 dB headroom pad before the cassette chain. Cassette is wired
   *  externally: headroomPad → cassette chain → autoMakeup. */
  readonly headroomPad: GainNode;

  /** Post-cassette auto-makeup. Updated by updateAutoMakeup(). Compensates
   *  for the −6 dB headroom pad and for cassette-induced gain changes. */
  readonly autoMakeup: GainNode;

  readonly masterPanner: StereoPannerNode;

  /** Final output — goes to AudioContext.destination and broadcast tap.
   *  Phase 2 will insert a worklet limiter before this. */
  readonly output: GainNode;

  private readonly _safetyComp: DynamicsCompressorNode;
  /** Input/output sandwich around the limiter stage so Phase 2 can swap
   *  the safety compressor for an AudioWorklet limiter without re-wiring. */
  private readonly _limiterIn: GainNode;
  private readonly _limiterOut: GainNode;
  private _workletLimiter: AudioWorkletNode | null = null;

  /** True once the AudioWorklet lookahead limiter is active. */
  get workletActive(): boolean { return this._workletLimiter !== null; }

  constructor() {
    const ac = new AudioContext();
    this.actx = ac;

    // ── Layer sum ──────────────────────────────────────────────
    this.layerSum = ac.createGain();
    this.layerSum.gain.value = 1.0;

    // ── Bus helpers ────────────────────────────────────────────
    // Builds a bus GainNode with optional HP/LP slotting filters,
    // then connects the output of the chain to layerSum.
    const mkBus = (hp?: number, lp?: number): GainNode => {
      const bus = ac.createGain();
      bus.gain.value = 1.0;
      let tail: AudioNode = bus;
      if (hp !== undefined) {
        const f = ac.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = hp;
        f.Q.value = 0.5;
        tail.connect(f);
        tail = f;
      }
      if (lp !== undefined) {
        const f = ac.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = lp;
        f.Q.value = 0.5;
        tail.connect(f);
        tail = f;
      }
      tail.connect(this.layerSum);
      return bus;
    };

    // Slotting defaults from the plan:
    //   sub:    LP 90 Hz   — keeps sub below bass
    //   bass:   HP 45 Hz, LP 800 Hz — cleans rumble, caps upper overlap
    //   mid:    HP 140 Hz  — removes low-end mud from mid voices
    //   treble: HP 500 Hz  — prevents treble from doubling mid body
    //   pluck:  HP 300 Hz  — keeps plucks from muddying bass/lower-mid
    this.subBus = mkBus(undefined, 90);
    this.bassBus = mkBus(45, 800);
    this.midBus = mkBus(140);
    this.trebleBus = mkBus(500);
    this.pluckBus = mkBus(300);
    // Phase 4 buses — connected but silent until layers are added
    this.ksBus = mkBus();
    this.noiseBus = mkBus();
    this.shimmerBus = mkBus();

    // ── Master chain ───────────────────────────────────────────
    this.masterTrim = ac.createGain();
    this.masterTrim.gain.value = 0.28;
    this.layerSum.connect(this.masterTrim);

    this.dimGain = ac.createGain();
    this.dimGain.gain.value = 1.0;
    this.masterTrim.connect(this.dimGain);

    this.tremoloSum = ac.createGain();
    this.tremoloSum.gain.value = 1.0;
    this.dimGain.connect(this.tremoloSum);

    // Analysis tap: stage-3 audio analyzer connects here (pre-cassette)
    this.analysisTap = ac.createGain();
    this.analysisTap.gain.value = 1.0;
    this.tremoloSum.connect(this.analysisTap);

    // Headroom pad — −6 dB before cassette to prevent saturation mud-stack
    this.headroomPad = ac.createGain();
    this.headroomPad.gain.value = 0.501; // 10^(−6/20) ≈ 0.501
    this.analysisTap.connect(this.headroomPad);

    // autoMakeup connects to safetyComp once cassette is wired between
    // headroomPad and autoMakeup. Default +6 dB compensates the headroom pad.
    this.autoMakeup = ac.createGain();
    this.autoMakeup.gain.value = 2.0; // +6 dB

    // Limiter sandwich: autoMakeup → _limiterIn → [limiter] → _limiterOut → masterPanner
    // Phase 1: safety compressor as the limiter.
    // Phase 2: swapped to AudioWorklet lookahead limiter via swapToWorkletLimiter().
    this._limiterIn = ac.createGain();
    this._limiterIn.gain.value = 1.0;
    this.autoMakeup.connect(this._limiterIn);

    this._safetyComp = ac.createDynamicsCompressor();
    this._safetyComp.threshold.value = -3;
    this._safetyComp.ratio.value = 20;
    this._safetyComp.knee.value = 3;
    this._safetyComp.attack.value = 0.001;
    this._safetyComp.release.value = 0.1;
    this._limiterIn.connect(this._safetyComp);

    this._limiterOut = ac.createGain();
    this._limiterOut.gain.value = 1.0;
    this._safetyComp.connect(this._limiterOut);

    this.masterPanner = ac.createStereoPanner();
    this._limiterOut.connect(this.masterPanner);

    this.output = ac.createGain();
    this.output.gain.value = 1.0;
    this.masterPanner.connect(this.output);
    this.output.connect(ac.destination);
  }

  // ── Public control API ─────────────────────────────────────

  /**
   * Replace the safety compressor with an AudioWorklet lookahead limiter.
   * No-op if the worklet limiter is already active.
   */
  swapToWorkletLimiter(workletNode: AudioWorkletNode): void {
    if (this._workletLimiter) return;
    this._limiterIn.disconnect(this._safetyComp);
    this._safetyComp.disconnect(this._limiterOut);
    this._limiterIn.connect(workletNode);
    workletNode.connect(this._limiterOut);
    this._workletLimiter = workletNode;
  }

  setMasterGain(v: number): void {
    const target = Math.max(0, Math.min(2, v));
    this.masterTrim.gain.setTargetAtTime(target, this.actx.currentTime, 0.02);
  }

  setBriDim(bri: number, now: number): void {
    const scale = Math.min(1, bri / 0.1);
    this.dimGain.gain.setTargetAtTime(scale, now, 0.08);
  }

  /**
   * Update the post-cassette makeup gain whenever cassette parameters change.
   * Compensates the fixed −6 dB headroom pad, then backs off for the gain
   * added by mid-boost + saturation stacking.
   */
  updateAutoMakeup(satAmount: number, satWet: number, midBoostDb: number): void {
    // +6 dB base (cancels headroom pad) minus a fraction of mid-boost × wet drive.
    // Coefficient 0.35 is tuned so that the extreme lofi combo
    // (satWet=0.6, midBoostDb=4) reduces makeup by ~0.8 dB — subtle but effective.
    const makeupDb = 6 - satWet * midBoostDb * 0.35;
    const clamped = Math.max(0, Math.min(6, makeupDb));
    const now = this.actx.currentTime;
    this.autoMakeup.gain.setTargetAtTime(
      Math.pow(10, clamped / 20),
      now,
      0.1,
    );
  }
}
