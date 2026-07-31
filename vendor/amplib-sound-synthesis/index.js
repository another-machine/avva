/* Vendored from @amplib/sound-synthesis @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
// src/AudioGraph.ts
var AudioGraph = class {
  audioContext;
  subBus;
  bassBus;
  midBus;
  trebleBus;
  pluckBus;
  ksBus;
  noiseBus;
  shimmerBus;
  layerSum;
  /** User-facing master gain. */
  masterTrim;
  /**
   * Separate from masterTrim so a per-frame brightness dim and the user's own
   * volume are never writing to the same AudioParam — two writers on one param
   * means whichever ran last wins and the other silently stops working.
   */
  dimGain;
  /** Tremolo LFOs connect here, so they get a dedicated AudioParam too. */
  tremoloSum;
  /** Post-gain, pre-insert tap. Analyzers connect here. */
  analysisTap;
  /** −6 dB before the insert chain, so saturation has room to work. */
  headroomPad;
  /** Post-insert makeup. Compensates headroomPad and any insert-induced gain. */
  autoMakeup;
  masterPanner;
  output;
  safetyComp;
  /** A sandwich around the limiter stage, so it can be swapped without rewiring. */
  limiterIn;
  limiterOut;
  workletLimiter = null;
  /** True once the AudioWorklet lookahead limiter has replaced the compressor. */
  get workletActive() {
    return this.workletLimiter !== null;
  }
  constructor({ audioContext }) {
    this.audioContext = audioContext;
    this.layerSum = audioContext.createGain();
    this.layerSum.gain.value = 1;
    const makeBus = (highpass, lowpass) => {
      const bus = audioContext.createGain();
      bus.gain.value = 1;
      let tail = bus;
      if (highpass !== void 0) {
        const filter = audioContext.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = highpass;
        filter.Q.value = 0.5;
        tail.connect(filter);
        tail = filter;
      }
      if (lowpass !== void 0) {
        const filter = audioContext.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = lowpass;
        filter.Q.value = 0.5;
        tail.connect(filter);
        tail = filter;
      }
      tail.connect(this.layerSum);
      return bus;
    };
    this.subBus = makeBus(void 0, 90);
    this.bassBus = makeBus(45, 800);
    this.midBus = makeBus(140);
    this.trebleBus = makeBus(500);
    this.pluckBus = makeBus(300);
    this.ksBus = makeBus(200);
    this.noiseBus = makeBus(100);
    this.shimmerBus = makeBus(1e3);
    this.masterTrim = audioContext.createGain();
    this.masterTrim.gain.value = 0.28;
    this.layerSum.connect(this.masterTrim);
    this.dimGain = audioContext.createGain();
    this.dimGain.gain.value = 1;
    this.masterTrim.connect(this.dimGain);
    this.tremoloSum = audioContext.createGain();
    this.tremoloSum.gain.value = 1;
    this.dimGain.connect(this.tremoloSum);
    this.analysisTap = audioContext.createGain();
    this.analysisTap.gain.value = 1;
    this.tremoloSum.connect(this.analysisTap);
    this.headroomPad = audioContext.createGain();
    this.headroomPad.gain.value = 0.501;
    this.analysisTap.connect(this.headroomPad);
    this.autoMakeup = audioContext.createGain();
    this.autoMakeup.gain.value = 2;
    this.limiterIn = audioContext.createGain();
    this.limiterIn.gain.value = 1;
    this.autoMakeup.connect(this.limiterIn);
    this.safetyComp = audioContext.createDynamicsCompressor();
    this.safetyComp.threshold.value = -3;
    this.safetyComp.ratio.value = 20;
    this.safetyComp.knee.value = 3;
    this.safetyComp.attack.value = 1e-3;
    this.safetyComp.release.value = 0.1;
    this.limiterIn.connect(this.safetyComp);
    this.limiterOut = audioContext.createGain();
    this.limiterOut.gain.value = 1;
    this.safetyComp.connect(this.limiterOut);
    this.masterPanner = audioContext.createStereoPanner();
    this.limiterOut.connect(this.masterPanner);
    this.output = audioContext.createGain();
    this.output.gain.value = 1;
    this.masterPanner.connect(this.output);
    this.output.connect(audioContext.destination);
  }
  /**
   * Connect headroomPad straight to autoMakeup, for callers with no insert
   * chain. Skip this if you are wiring something in between.
   */
  bypassInsert() {
    this.headroomPad.connect(this.autoMakeup);
  }
  /** Replace the safety compressor with a lookahead limiter. Idempotent. */
  swapToWorkletLimiter(workletNode) {
    if (this.workletLimiter) return;
    this.limiterIn.disconnect(this.safetyComp);
    this.safetyComp.disconnect(this.limiterOut);
    this.limiterIn.connect(workletNode);
    workletNode.connect(this.limiterOut);
    this.workletLimiter = workletNode;
  }
  setMasterGain(value) {
    const target = Math.max(0, Math.min(2, value));
    this.masterTrim.gain.setTargetAtTime(
      target,
      this.audioContext.currentTime,
      0.02
    );
  }
  /**
   * Drive the dim from a 0..1 brightness value.
   *
   * Loudness tracks brightness with roughly a 0.6 exponent (the sones
   * approximation), and below 0.08 an extra linear fade takes over — without
   * it a nearly-black frame still plays at close to full volume, because the
   * power curve is steep near zero but never actually reaches it.
   *
   * `scale` above 1 is allowed on purpose, for a whiteout climax. The limiter
   * is what keeps that safe.
   */
  setBrightnessDim(brightness, now, extremesScale = 1) {
    const ramp = Math.min(1, brightness / 0.08);
    const perceptual = Math.pow(Math.max(0, brightness), 0.6);
    const scale = Math.min(1, ramp * perceptual) * Math.max(0, extremesScale);
    this.dimGain.gain.setTargetAtTime(scale, now, 0.08);
  }
  /**
   * Recompute makeup gain when the insert chain's parameters change.
   *
   * Starts from the +6 dB that cancels headroomPad, then backs off for what
   * the insert added: measured at roughly 0.5 dB of output per dB of mid-boost
   * at full wet, plus about 0.6 dB more from saturation at amount 10 / wet 0.6.
   * The 0.55 and 0.9 coefficients hold the result within ±1 dB of the dry
   * baseline across the usable range.
   */
  updateAutoMakeup({
    saturationAmount,
    saturationWet,
    midBoostDb
  }) {
    const makeupDb = 6 - saturationWet * midBoostDb * 0.55 - saturationWet * Math.log10(Math.max(1, saturationAmount)) * 0.9;
    const clamped = Math.max(0, Math.min(6, makeupDb));
    this.autoMakeup.gain.setTargetAtTime(
      Math.pow(10, clamped / 20),
      this.audioContext.currentTime,
      0.1
    );
  }
};

// ../amplib-music-theory/src/Note.ts
var Note = class _Note {
  /**
   * Frequency hz for this note
   */
  frequency;
  /**
   * A unique identifier for this note
   */
  id;
  /**
   * Global index of the note on a keyboard (
   * 0 through 107
   */
  index;
  /**
   * Primary notation for the note
   */
  notation;
  /**
   * Optional secondary notation for the note
   */
  notationAlternate;
  /**
   * Global octave number for the note
   * 0 through 8
   */
  octave;
  /**
   * Index of the note within the octave
   * 0 through 11
   */
  octaveIndex;
  constructor({ octave, step }) {
    const notation = _Note.notations[step];
    const alternate = _Note.notationsAlternate[step];
    this.frequency = _Note.octaveStepFrequencies[octave][step];
    this.id = _Note.noteIdFromNotationAndOctave(notation, octave);
    this.index = step + octave * 12;
    this.notation = notation;
    this.notationAlternate = alternate === this.notation ? void 0 : alternate;
    this.octave = octave;
    this.octaveIndex = step;
  }
  static notationIndex(notation) {
    const notationsIndex = _Note.notations.indexOf(notation);
    if (notationsIndex !== -1) {
      return notationsIndex;
    }
    const notationsAlternateIndex = _Note.notationsAlternate.indexOf(
      notation
    );
    if (notationsAlternateIndex !== -1) {
      return notationsAlternateIndex;
    }
    return -1;
  }
  static noteIdFromNotationAndOctave(notation, octave) {
    return `${notation}${octave}`;
  }
  static get notations() {
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  }
  static get notationsAlternate() {
    return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  }
  static get notationsUnique() {
    return Array.from(/* @__PURE__ */ new Set([..._Note.notations, ..._Note.notationsAlternate]));
  }
  // prettier-ignore
  static get octaveStepFrequencies() {
    return {
      0: { 0: 16.352, 1: 17.324, 2: 18.354, 3: 19.445, 4: 20.602, 5: 21.827, 6: 23.125, 7: 24.5, 8: 25.957, 9: 27.5, 10: 29.135, 11: 30.868 },
      1: { 0: 32.703, 1: 34.648, 2: 36.708, 3: 38.891, 4: 41.203, 5: 43.654, 6: 46.249, 7: 48.999, 8: 51.913, 9: 55, 10: 58.27, 11: 61.735 },
      2: { 0: 65.406, 1: 69.296, 2: 73.416, 3: 77.782, 4: 82.407, 5: 87.307, 6: 92.499, 7: 97.999, 8: 103.826, 9: 110, 10: 116.541, 11: 123.471 },
      3: { 0: 130.813, 1: 138.591, 2: 146.832, 3: 155.563, 4: 164.814, 5: 174.614, 6: 184.997, 7: 195.998, 8: 207.652, 9: 220, 10: 233.082, 11: 246.942 },
      4: { 0: 261.626, 1: 277.183, 2: 293.665, 3: 311.127, 4: 329.628, 5: 349.228, 6: 369.994, 7: 391.995, 8: 415.305, 9: 440, 10: 466.164, 11: 493.883 },
      5: { 0: 523.251, 1: 554.365, 2: 587.33, 3: 622.254, 4: 659.255, 5: 698.456, 6: 739.989, 7: 783.991, 8: 830.609, 9: 880, 10: 932.328, 11: 987.767 },
      6: { 0: 1046.502, 1: 1108.731, 2: 1174.659, 3: 1244.508, 4: 1318.51, 5: 1396.913, 6: 1479.978, 7: 1567.982, 8: 1661.219, 9: 1760, 10: 1864.655, 11: 1975.533 },
      7: { 0: 2093.005, 1: 2217.461, 2: 2349.318, 3: 2489.016, 4: 2637.02, 5: 2793.826, 6: 2959.955, 7: 3135.963, 8: 3322.438, 9: 3520, 10: 3729.31, 11: 3951.066 },
      8: { 0: 4186.01, 1: 4434.92, 2: 4698.63, 3: 4978.03, 4: 5274.04, 5: 5587.65, 6: 5919.91, 7: 6271.93, 8: 6644.88, 9: 7040, 10: 7458.62, 11: 7902.13 }
    };
  }
  static stringIsNotation(string) {
    return _Note.notations.includes(string) || _Note.notationsAlternate.includes(string);
  }
};

// src/pitch.ts
function pitchClassToFrequency(pitchClass, octave) {
  return 440 * Math.pow(2, (pitchClass - 9 + (octave - 4) * 12) / 12);
}
function cancelParam(param, now) {
  const extended = param;
  if (typeof extended.cancelAndHoldAtTime === "function") {
    extended.cancelAndHoldAtTime(now);
  } else {
    const value = param.value;
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, now);
  }
}

// src/FMVoice.ts
var FMVoice = class {
  ratio;
  index;
  carrier;
  modulator;
  modGain;
  outGain;
  audioContext;
  carrierFrequency;
  constructor({
    audioContext,
    destination,
    ratio = 1,
    index = 0,
    carrierType = "sine",
    modulatorType = "sine"
  }) {
    this.audioContext = audioContext;
    this.ratio = ratio;
    this.index = index;
    this.carrierFrequency = 220;
    this.carrier = audioContext.createOscillator();
    this.modulator = audioContext.createOscillator();
    this.modGain = audioContext.createGain();
    this.outGain = audioContext.createGain();
    this.carrier.type = carrierType;
    this.modulator.type = modulatorType;
    this.carrier.frequency.value = this.carrierFrequency;
    const modulatorFrequency = this.carrierFrequency * this.ratio;
    this.modulator.frequency.value = modulatorFrequency;
    this.modGain.gain.value = this.index * modulatorFrequency;
    this.outGain.gain.value = 0;
    this.modulator.connect(this.modGain);
    this.modGain.connect(this.carrier.frequency);
    this.carrier.connect(this.outGain);
    this.outGain.connect(destination);
    this.modulator.start();
    this.carrier.start();
  }
  /** Glide carrier frequency over `tau` seconds. */
  glideTo(frequency, tau) {
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    this.carrierFrequency = frequency;
    const now = this.audioContext.currentTime;
    const modulatorFrequency = frequency * this.ratio;
    cancelParam(this.carrier.frequency, now);
    this.carrier.frequency.setTargetAtTime(frequency, now, tau);
    cancelParam(this.modulator.frequency, now);
    this.modulator.frequency.setTargetAtTime(modulatorFrequency, now, tau);
    cancelParam(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(
      this.index * modulatorFrequency,
      now,
      tau
    );
  }
  /** Glide modulation index — timbre brightness. */
  setIndex(index, tau) {
    if (!Number.isFinite(index)) return;
    this.index = Math.max(0, index);
    const now = this.audioContext.currentTime;
    const modulatorFrequency = this.carrierFrequency * this.ratio;
    cancelParam(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(
      this.index * modulatorFrequency,
      now,
      tau
    );
  }
  /** Glide modulator ratio — detunes sidebands for chorus and inharmonic tones. */
  setRatio(ratio, tau) {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.ratio = ratio;
    const now = this.audioContext.currentTime;
    const modulatorFrequency = this.carrierFrequency * ratio;
    cancelParam(this.modulator.frequency, now);
    this.modulator.frequency.setTargetAtTime(modulatorFrequency, now, tau);
    cancelParam(this.modGain.gain, now);
    this.modGain.gain.setTargetAtTime(
      this.index * modulatorFrequency,
      now,
      tau
    );
  }
  /** Glide output amplitude. */
  setGain(gain, tau) {
    if (!Number.isFinite(gain)) return;
    const now = this.audioContext.currentTime;
    cancelParam(this.outGain.gain, now);
    this.outGain.gain.setTargetAtTime(Math.max(0, gain), now, tau);
  }
  /**
   * Trigger a one-shot pluck. The modulation-depth envelope decays faster than
   * the amplitude envelope, which is the classic DX7 arc — bright on the
   * transient, mellow on the tail.
   *
   * The 3 ms crossfade at the top is not cosmetic. Re-plucking a voice whose
   * previous decay is still running means cancelScheduledValues plus
   * setValueAtTime(0) yanks a mid-decay amplitude straight to zero, and that
   * discontinuity clicks. Fading to silence first makes the frequency snap
   * inaudible.
   */
  pluck(frequency, params = {}) {
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    const {
      peak = 0.12,
      ampDecayTau = 0.18,
      modDecayTau = ampDecayTau * 0.35,
      indexPeak = this.index * 4,
      attackTau = 3e-3,
      when
    } = params;
    const now = this.audioContext.currentTime;
    const at = when !== void 0 && when > now ? when : now;
    const crossfade = 3e-3;
    const start = at + crossfade;
    const modulatorFrequency = frequency * this.ratio;
    this.carrierFrequency = frequency;
    cancelParam(this.outGain.gain, at);
    this.outGain.gain.setTargetAtTime(0, at, 1e-3);
    this.carrier.frequency.cancelScheduledValues(at);
    this.modulator.frequency.cancelScheduledValues(at);
    this.carrier.frequency.setValueAtTime(frequency, start);
    this.modulator.frequency.setValueAtTime(modulatorFrequency, start);
    this.modGain.gain.cancelScheduledValues(at);
    this.modGain.gain.setValueAtTime(0, start);
    this.modGain.gain.setTargetAtTime(
      indexPeak * modulatorFrequency,
      start,
      attackTau
    );
    this.modGain.gain.setTargetAtTime(
      0,
      start + attackTau * 4,
      modDecayTau
    );
    this.outGain.gain.setValueAtTime(0, start);
    this.outGain.gain.setTargetAtTime(peak, start, attackTau);
    this.outGain.gain.setTargetAtTime(0, start + attackTau * 5, ampDecayTau);
  }
  disconnect() {
    this.outGain.disconnect();
    this.modGain.disconnect();
    this.carrier.disconnect();
    this.modulator.disconnect();
  }
};

// src/ChromaticWall.ts
var ChromaticWall = class _ChromaticWall {
  audioContext;
  volume;
  mainChance;
  twinkleChance;
  triadNoteIndices = [0, 1, 2];
  synthMain = {
    envelope: { attack: 0.01, release: 0.8, volume: 0.4 },
    carrier: { type: "triangle" },
    modulation: { type: "sine" },
    ratio: 1,
    index: 1.2
  };
  synthTwinkle = {
    envelope: { attack: 1e-3, release: 0.2, volume: 0.1 },
    carrier: { type: "sine" },
    modulation: { type: "sawtooth" },
    ratio: 2,
    index: 0.8
  };
  stepPosition = 0;
  on = false;
  channelOutput;
  effectHighpassFilter;
  effectLowpassFilter;
  voices;
  nextVoice = 0;
  constructor({
    audioContext,
    volume,
    mainChance,
    twinkleChance,
    voiceCount = 16
  }) {
    this.audioContext = audioContext;
    this.volume = volume;
    this.mainChance = mainChance;
    this.twinkleChance = twinkleChance;
    this.channelOutput = audioContext.createGain();
    this.effectHighpassFilter = audioContext.createBiquadFilter();
    this.effectLowpassFilter = audioContext.createBiquadFilter();
    this.effectLowpassFilter.connect(this.effectHighpassFilter);
    this.effectHighpassFilter.connect(this.channelOutput);
    this.channelOutput.connect(audioContext.destination);
    this.channelOutput.gain.value = this.volume;
    this.effectLowpassFilter.type = "lowpass";
    this.effectLowpassFilter.frequency.value = 22050;
    this.effectLowpassFilter.Q.value = 1;
    this.effectHighpassFilter.type = "highpass";
    this.effectHighpassFilter.frequency.value = 0;
    this.effectHighpassFilter.Q.value = 1;
    this.voices = Array.from({ length: voiceCount }, () => {
      const panner = audioContext.createStereoPanner();
      panner.connect(this.effectLowpassFilter);
      const voice = new FMVoice({
        audioContext,
        destination: panner,
        ratio: this.synthMain.ratio,
        index: this.synthMain.index,
        carrierType: this.synthMain.carrier.type,
        modulatorType: this.synthMain.modulation.type
      });
      return { voice, panner };
    });
  }
  static modifiedEnvelope(envelope, modifiers) {
    const defaultToOne = (item) => item === void 0 ? 1 : item;
    return {
      attack: envelope.attack * defaultToOne(modifiers.attack),
      release: envelope.release * defaultToOne(modifiers.release),
      volume: envelope.volume * defaultToOne(modifiers.volume)
    };
  }
  start() {
    this.on = true;
    this.channelOutput.gain.linearRampToValueAtTime(
      this.volume,
      this.audioContext.currentTime + 1
    );
  }
  stop() {
    this.on = false;
    this.channelOutput.gain.linearRampToValueAtTime(
      1e-7,
      this.audioContext.currentTime + 1
    );
  }
  tick({
    scale,
    stepFactor,
    highpassFactor,
    lowpassFactor,
    mainEnvelopeModifier,
    twinkleEnvelopeModifier
  }) {
    if (!this.on) {
      return;
    }
    this.effectHighpassFilter.frequency.linearRampToValueAtTime(
      Math.round(highpassFactor * 12e3 + 100),
      this.audioContext.currentTime + 0.05
    );
    this.effectLowpassFilter.frequency.linearRampToValueAtTime(
      Math.round(lowpassFactor * 12e3 + 100),
      this.audioContext.currentTime + 0.05
    );
    const step = Math.min(
      Math.floor(stepFactor * scale.intervals.length),
      scale.intervals.length - 1
    );
    const { notes } = scale.intervals[step];
    const { notation, octave } = notes[this.stepPosition % notes.length];
    const selectRandom = (array) => array[Math.floor(Math.random() * array.length)];
    if (Math.random() > this.mainChance) {
      const octaveOffset = selectRandom([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5]) + 1;
      this.triggerNote({
        hz: Note.octaveStepFrequencies[octave + octaveOffset][Note.notationIndex(notation)],
        synth: this.synthMain,
        envelopeModifier: mainEnvelopeModifier || {}
      });
      this.stepPosition++;
    }
    if (Math.random() > this.twinkleChance) {
      const octaveOffset = Math.round(Math.random() * 2) + 4;
      this.triggerNote({
        hz: Note.octaveStepFrequencies[octave + octaveOffset][Note.notationIndex(notation)],
        synth: this.synthTwinkle,
        envelopeModifier: twinkleEnvelopeModifier || {}
      });
    }
  }
  toggle() {
    if (this.on) {
      this.stop();
    } else {
      this.start();
    }
  }
  triggerNote({
    hz,
    synth,
    envelopeModifier
  }) {
    if (!Number.isFinite(hz) || hz <= 0) return;
    const { attack, release, volume } = _ChromaticWall.modifiedEnvelope(
      synth.envelope,
      envelopeModifier
    );
    const { voice, panner } = this.voices[this.nextVoice];
    this.nextVoice = (this.nextVoice + 1) % this.voices.length;
    panner.pan.setValueAtTime(
      Math.random() * 2 - 1,
      this.audioContext.currentTime
    );
    voice.carrier.type = synth.carrier.type;
    voice.modulator.type = synth.modulation.type;
    voice.ratio = synth.ratio;
    voice.index = synth.index;
    voice.pluck(hz, {
      peak: volume,
      attackTau: Math.max(1e-3, attack / 3),
      ampDecayTau: Math.max(0.01, release / 3)
    });
  }
  disconnect() {
    for (const { voice, panner } of this.voices) {
      voice.disconnect();
      panner.disconnect();
    }
    this.effectLowpassFilter.disconnect();
    this.effectHighpassFilter.disconnect();
    this.channelOutput.disconnect();
  }
};

// src/clock-worker.ts
var worker = (
  /* js */
  `
let nextTick = 0;
let timeoutId = null;
let isRunning = false;
let startTime = 0;
let beatIndex = 0;
let bpm = 120;
let swing = 0;  // 0-1 range
let subdivision = 8;

const getTime = () => performance.now();

const calculateSwingOffset = (beatIndex) => {
  // Allow all beats to trigger, don't return early if swing is 0
  const isSwingBeat = beatIndex % 2 === 1;
  if (!isSwingBeat) return 0;
  
  const baseInterval = (60 / bpm) * (4 / subdivision) * 1000;
  // At swing = 1, offset will be 66% of the interval
  return swing * 0.66 * baseInterval;
};

const calculateNextTick = (now) => {
  const baseIntervalMs = (60 / bpm) * (4 / subdivision) * 1000;
  const swingOffset = calculateSwingOffset(beatIndex);
  const expectedTime = startTime + (beatIndex * baseIntervalMs) + swingOffset;
  
  if (Math.abs(now - expectedTime) > 100) {
    startTime = now;
    beatIndex = 0;
    return now + baseIntervalMs;
  }
  
  return expectedTime + baseIntervalMs + 
         (beatIndex % 2 === 0 ? calculateSwingOffset(beatIndex + 1) : 0);
};

const scheduleNextTick = () => {
  if (!isRunning) return;

  const now = getTime();
  nextTick = calculateNextTick(now);
  const delay = Math.max(0, nextTick - now);

  if (delay > 25) {
    timeoutId = setTimeout(() => requestAnimationFrame(tick), delay - 16);
  } else {
    requestAnimationFrame(tick);
  }
};

const tick = () => {
  if (!isRunning) return;

  const now = getTime();
  
  if (now >= nextTick - 16) {
    self.postMessage({ 
      type: 'tick',
      timestamp: now,
      beatIndex,
    });
    
    beatIndex++;
    scheduleNextTick();
  } else {
    requestAnimationFrame(tick);
  }
};

self.onmessage = (e) => {
  switch (e.data.command) {
    case 'start':
      if (isRunning) return;
      bpm = e.data.bpm || 120;
      swing = e.data.swing ?? 0;
      subdivision = e.data.subdivision ?? 8;
      isRunning = true;
      startTime = getTime();
      beatIndex = 0;
      scheduleNextTick();
      break;
      
    case 'stop':
      isRunning = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      break;
      
    case 'set-bpm':
      bpm = e.data.bpm;
      startTime = getTime();
      beatIndex = 0;
      break;
      
    case 'set-swing':
      swing = Math.min(1, Math.max(0, e.data.swing));
      subdivision = e.data.subdivision ?? subdivision;
      console.log('Swing set to:', swing); // Debug log
      break;
  }
};
`
);

// src/Clock.ts
var Clock = class {
  worker;
  started;
  swing;
  callbacks;
  subdivision;
  bpm;
  constructor(options = {}) {
    this.callbacks = /* @__PURE__ */ new Set();
    this.bpm = options.bpm || 120;
    this.started = false;
    this.worker = new Worker(
      URL.createObjectURL(
        new Blob([worker], { type: "application/javascript" })
      )
    );
    this.worker.onmessage = (e) => {
      if (e.data.type === "tick") {
        this.callbacks.forEach((callback) => callback(e.data));
      }
    };
    this.setResolution(options.swing || 0, options.subdivision || 8);
  }
  onBeat(callback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.bpm = this.bpm;
    this.worker.postMessage({
      command: "start",
      bpm: this.bpm,
      swing: this.swing,
      subdivision: this.subdivision
    });
  }
  stop() {
    if (!this.started) return;
    this.started = false;
    this.worker.postMessage({ command: "stop" });
  }
  setBPM(bpm) {
    this.bpm = bpm;
    this.worker.postMessage({ command: "set-bpm", bpm });
  }
  setResolution(swing, subdivision) {
    this.swing = swing;
    if (subdivision !== void 0) {
      this.subdivision = subdivision;
    }
    this.worker.postMessage({
      command: "set-swing",
      swing: this.swing,
      subdivision: this.subdivision
    });
  }
  dispose() {
    this.stop();
    this.worker.terminate();
    this.callbacks.clear();
  }
};

// src/drumPatterns.ts
var PATTERN_NAMES = [
  "rock",
  "bossanova",
  "waltz",
  "march",
  "slow-rock",
  "cha-cha",
  "samba",
  "ballad"
];
var PATTERNS = {
  "rock": {
    label: "Rock",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihatC: [1, 0, 0.6, 0, 1, 0, 0.6, 0, 1, 0, 0.6, 0, 1, 0, 0.6, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  "bossanova": {
    label: "Bossa Nova",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0.6, 0, 0, 1, 0, 0, 0.6, 0, 0, 0, 0, 0.6, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hihatC: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]
  },
  "waltz": {
    label: "Waltz",
    steps: 12,
    // 3/4 time — 3 beats × 4 16th-note subdivisions
    //          1     +     2     +     3     +
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    hihatC: [0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  "march": {
    label: "March",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    hihatC: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  "slow-rock": {
    label: "Slow Rock",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    hihatC: [0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  "cha-cha": {
    label: "Cha-Cha",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    hihatC: [0.8, 0, 0.6, 1, 0, 0.6, 1, 0, 0.8, 0, 0.6, 1, 0, 0.6, 1, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0.6, 0, 0, 0.6, 0, 0, 0, 0, 0.6, 0, 0, 0.6, 0]
  },
  "samba": {
    label: "Samba",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0.6, 0, 0, 0.6, 0, 1, 0, 0, 0.6, 0, 0, 0.6, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hihatC: [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]
  },
  "ballad": {
    label: "Ballad",
    steps: 16,
    //          1     +     2     +     3     +     4     +
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0],
    hihatC: [0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0],
    hihatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rim: [0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0]
  }
};

// src/DrumMachine.ts
var LOOKAHEAD = 0.1;
var INTERVAL = 25;
var DrumMachine = class {
  synth;
  currentBpm;
  patternName;
  step = 0;
  nextNoteTime = 0;
  timerId = null;
  taps = [];
  stepListeners = [];
  constructor({ drumSynth, bpm = 85, pattern = "rock" }) {
    this.synth = drumSynth;
    this.currentBpm = bpm;
    this.patternName = pattern;
  }
  get bpm() {
    return this.currentBpm;
  }
  get pattern() {
    return this.patternName;
  }
  get running() {
    return this.timerId !== null;
  }
  start() {
    if (this.running) return;
    this.step = 0;
    this.nextNoteTime = 0;
    this.tick();
  }
  stop() {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
  setBpm(bpm) {
    this.currentBpm = Math.max(40, Math.min(180, bpm));
  }
  setPattern(name) {
    if (!(name in PATTERNS) || name === this.patternName) return;
    this.patternName = name;
    this.step = 0;
  }
  /**
   * Subscribe to steps as they are scheduled. Returns an unsubscribe function.
   *
   * Listeners fire during the lookahead pass, so `time` is up to 100 ms in the
   * future — that is the point. Anything that wants to play in time with the
   * drums should schedule against that value rather than playing immediately,
   * because "immediately" is the wall clock and the drums are on the audio
   * clock. The two drift, and the drift is audible.
   */
  onStep(listener) {
    this.stepListeners.push(listener);
    return () => {
      const index = this.stepListeners.indexOf(listener);
      if (index >= 0) this.stepListeners.splice(index, 1);
    };
  }
  /**
   * Tap tempo. Averages the gaps between the last four taps; a gap over two
   * seconds is treated as the start of a new attempt rather than a very slow
   * tempo.
   */
  tap() {
    const now = performance.now();
    const last = this.taps[this.taps.length - 1];
    if (last !== void 0 && now - last > 2e3) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 4) this.taps.shift();
    if (this.taps.length < 2) return;
    let total = 0;
    for (let i = 1; i < this.taps.length; i++) {
      total += this.taps[i] - this.taps[i - 1];
    }
    const averageMs = total / (this.taps.length - 1);
    this.currentBpm = Math.round(
      Math.max(40, Math.min(180, 6e4 / averageMs))
    );
  }
  tick() {
    const { audioContext } = this.synth;
    if (this.nextNoteTime === 0) {
      this.nextNoteTime = audioContext.currentTime + 0.05;
    }
    const pattern = PATTERNS[this.patternName];
    const stepLength = 60 / this.currentBpm / 4;
    while (this.nextNoteTime < audioContext.currentTime + LOOKAHEAD) {
      const index = this.step % pattern.steps;
      const time = this.nextNoteTime;
      if (pattern.kick[index] > 0)
        this.synth.kick(time, pattern.kick[index]);
      if (pattern.snare[index] > 0)
        this.synth.snare(time, pattern.snare[index]);
      if (pattern.hihatC[index] > 0)
        this.synth.hihatClosed(time, pattern.hihatC[index]);
      if (pattern.hihatO[index] > 0)
        this.synth.hihatOpen(time, pattern.hihatO[index]);
      if (pattern.rim[index] > 0) this.synth.rim(time, pattern.rim[index]);
      for (const listener of this.stepListeners) {
        listener({
          index,
          time,
          stepLength,
          pattern: this.patternName
        });
      }
      this.nextNoteTime += stepLength;
      this.step = (this.step + 1) % pattern.steps;
    }
    this.timerId = setTimeout(() => this.tick(), INTERVAL);
  }
};

// src/DrumSynth.ts
var DrumSynth = class {
  audioContext;
  bus;
  filter;
  echoDelay;
  echoFeedback;
  echoDamp;
  echoWet;
  noiseBuffer;
  constructor({ audioContext, destination }) {
    this.audioContext = audioContext;
    this.bus = audioContext.createGain();
    this.bus.gain.value = 0.7;
    this.filter = audioContext.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 12e3;
    this.filter.Q.value = 0.7;
    this.bus.connect(this.filter);
    this.filter.connect(destination);
    this.echoDelay = audioContext.createDelay(1);
    this.echoDelay.delayTime.value = 0.22;
    this.echoFeedback = audioContext.createGain();
    this.echoFeedback.gain.value = 0.35;
    this.echoDamp = audioContext.createBiquadFilter();
    this.echoDamp.type = "lowpass";
    this.echoDamp.frequency.value = 3500;
    this.echoWet = audioContext.createGain();
    this.echoWet.gain.value = 0;
    this.filter.connect(this.echoDelay);
    this.echoDelay.connect(this.echoDamp);
    this.echoDamp.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDamp.connect(this.echoWet);
    this.echoWet.connect(destination);
    const length = Math.floor(audioContext.sampleRate * 0.5);
    this.noiseBuffer = audioContext.createBuffer(
      1,
      length,
      audioContext.sampleRate
    );
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  setVolume(value) {
    this.bus.gain.setTargetAtTime(
      Math.max(0, Math.min(1, value)),
      this.audioContext.currentTime,
      0.02
    );
  }
  setFilter({ frequency, q }) {
    const now = this.audioContext.currentTime;
    this.filter.frequency.setTargetAtTime(Math.max(100, frequency), now, 0.03);
    this.filter.Q.setTargetAtTime(Math.max(0.1, Math.min(12, q)), now, 0.03);
  }
  setEcho({
    timeMs,
    feedback,
    wet
  }) {
    const now = this.audioContext.currentTime;
    this.echoDelay.delayTime.setTargetAtTime(
      Math.max(0.01, Math.min(1, timeMs / 1e3)),
      now,
      0.05
    );
    this.echoFeedback.gain.setTargetAtTime(
      Math.max(0, Math.min(0.9, feedback)),
      now,
      0.03
    );
    this.echoWet.gain.setTargetAtTime(Math.max(0, Math.min(1, wet)), now, 0.03);
  }
  /** Sine with a 150 → 45 Hz pitch drop over 50 ms. */
  kick(time, velocity = 1) {
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(150, time);
    oscillator.frequency.exponentialRampToValueAtTime(45, time + 0.05);
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(1e-3, time + 0.35);
    oscillator.connect(gain);
    gain.connect(this.bus);
    oscillator.start(time);
    oscillator.stop(time + 0.36);
  }
  /** A 200 Hz body under a high-passed noise snap. */
  snare(time, velocity = 1) {
    const bodyOscillator = this.audioContext.createOscillator();
    const bodyGain = this.audioContext.createGain();
    bodyOscillator.type = "sine";
    bodyOscillator.frequency.value = 200;
    bodyGain.gain.setValueAtTime(velocity * 0.6, time);
    bodyGain.gain.exponentialRampToValueAtTime(1e-3, time + 0.08);
    bodyOscillator.connect(bodyGain);
    bodyGain.connect(this.bus);
    bodyOscillator.start(time);
    bodyOscillator.stop(time + 0.09);
    this.noiseHit({
      time,
      velocity: velocity * 0.5,
      decay: 0.12,
      type: "highpass",
      frequency: 1500,
      q: 0.7
    });
  }
  hihatClosed(time, velocity = 1) {
    this.noiseHit({
      time,
      velocity: velocity * 0.3,
      decay: 0.05,
      type: "highpass",
      frequency: 8e3,
      q: 0.5
    });
  }
  hihatOpen(time, velocity = 1) {
    this.noiseHit({
      time,
      velocity: velocity * 0.25,
      decay: 0.3,
      type: "highpass",
      frequency: 6e3,
      q: 0.3
    });
  }
  rim(time, velocity = 1) {
    this.noiseHit({
      time,
      velocity: velocity * 0.45,
      decay: 0.025,
      type: "bandpass",
      frequency: 1200,
      q: 2.5
    });
  }
  /** Filtered noise burst — the snap in the snare, and all three of the metals. */
  noiseHit({
    time,
    velocity,
    decay,
    type,
    frequency,
    q
  }) {
    const source = this.audioContext.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.audioContext.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(1e-3, time + decay);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.bus);
    source.start(time);
    source.stop(time + decay + 0.01);
  }
  disconnect() {
    this.bus.disconnect();
    this.filter.disconnect();
    this.echoDelay.disconnect();
    this.echoDamp.disconnect();
    this.echoFeedback.disconnect();
    this.echoWet.disconnect();
  }
};

// src/NoiseLayer.ts
var BAND_Q = 28;
var BAND_COUNT = 5;
var NOISE_SECONDS = 4;
var NoiseLayer = class {
  noise;
  bands;
  outGain;
  currentWeight = 0;
  constructor({ audioContext, bus }) {
    const buffer = audioContext.createBuffer(
      1,
      Math.floor(NOISE_SECONDS * audioContext.sampleRate),
      audioContext.sampleRate
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = audioContext.createBufferSource();
    this.noise.buffer = buffer;
    this.noise.loop = true;
    this.outGain = audioContext.createGain();
    this.outGain.gain.value = 0;
    this.outGain.connect(bus);
    this.bands = Array.from({ length: BAND_COUNT }, () => {
      const filter = audioContext.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 440;
      filter.Q.value = BAND_Q;
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      this.noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.outGain);
      return { filter, gain };
    });
    this.noise.start();
  }
  update({
    pitchClasses,
    octave,
    weight,
    now,
    tau
  }) {
    this.currentWeight = weight;
    const activeCount = Math.min(pitchClasses.length, BAND_COUNT);
    const compensation = activeCount > 0 ? 1 / Math.sqrt(activeCount) : 1;
    this.outGain.gain.setTargetAtTime(
      weight * 0.35 * compensation,
      now,
      tau
    );
    for (let index = 0; index < BAND_COUNT; index++) {
      const { filter, gain } = this.bands[index];
      if (index < activeCount) {
        const frequency = pitchClassToFrequency(pitchClasses[index], octave);
        if (Number.isFinite(frequency) && frequency > 20) {
          filter.frequency.setTargetAtTime(frequency, now, tau);
        }
        gain.gain.setTargetAtTime(1, now, tau);
      } else {
        gain.gain.setTargetAtTime(0, now, tau);
      }
    }
  }
  get weight() {
    return this.currentWeight;
  }
  disconnect() {
    this.noise.stop();
    this.noise.disconnect();
    for (const { filter, gain } of this.bands) {
      filter.disconnect();
      gain.disconnect();
    }
    this.outGain.disconnect();
  }
};

// src/ShimmerLayer.ts
var LFO_RATES = [0.08, 0.13];
var OCTAVES_UP = [1, 2];
var ShimmerLayer = class {
  voices;
  outGain;
  currentWeight = 0;
  constructor({ audioContext, bus }) {
    this.outGain = audioContext.createGain();
    this.outGain.gain.value = 0;
    this.outGain.connect(bus);
    this.voices = LFO_RATES.map((rate, index) => {
      const carrier = audioContext.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = 880;
      const lfo = audioContext.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = rate + (Math.random() * 0.04 - 0.02);
      const lfoDepth = audioContext.createGain();
      lfoDepth.gain.value = 0.4;
      const outGain = audioContext.createGain();
      outGain.gain.value = 0.5;
      const panner = audioContext.createStereoPanner();
      panner.pan.value = index === 0 ? -0.4 : 0.4;
      lfo.connect(lfoDepth);
      lfoDepth.connect(outGain.gain);
      carrier.connect(panner);
      panner.connect(outGain);
      outGain.connect(this.outGain);
      carrier.start();
      lfo.start();
      return { carrier, lfo, lfoDepth, outGain, panner };
    });
  }
  update({
    rootPitchClass,
    octave,
    position,
    weight,
    now,
    tau
  }) {
    this.currentWeight = weight;
    this.outGain.gain.setTargetAtTime(weight * 0.12, now, tau);
    for (let index = 0; index < this.voices.length; index++) {
      const { carrier, panner } = this.voices[index];
      const frequency = pitchClassToFrequency(
        rootPitchClass,
        octave + OCTAVES_UP[index]
      );
      if (Number.isFinite(frequency) && frequency > 0 && frequency < 2e4) {
        carrier.frequency.setTargetAtTime(frequency, now, tau);
      }
      const basePan = index === 0 ? -0.4 : 0.4;
      panner.pan.setTargetAtTime(basePan + (position - 0.5) * 0.3, now, tau);
    }
  }
  get weight() {
    return this.currentWeight;
  }
  disconnect() {
    for (const { carrier, lfo, lfoDepth, outGain, panner } of this.voices) {
      carrier.stop();
      lfo.stop();
      carrier.disconnect();
      lfo.disconnect();
      lfoDepth.disconnect();
      outGain.disconnect();
      panner.disconnect();
    }
    this.outGain.disconnect();
  }
};

// src/TierBackend.ts
var TIER_VOICE_COUNT = 5;
var NodeTierBackend = class {
  voiceCount = TIER_VOICE_COUNT;
  voices;
  applyWave;
  constructor({ audioContext, ratio, applyWave }) {
    this.applyWave = applyWave;
    this.voices = Array.from({ length: TIER_VOICE_COUNT }, () => {
      const panner = audioContext.createStereoPanner();
      panner.pan.value = 0;
      const voice = new FMVoice({
        audioContext,
        destination: panner,
        ratio,
        index: 0.4
      });
      return { voice, panner };
    });
  }
  connect(bus) {
    for (const { panner } of this.voices) panner.connect(bus);
  }
  detuneTargets() {
    return this.voices.map(({ voice }) => voice.carrier.detune);
  }
  glideTo(voice, frequency, tau) {
    this.voices[voice].voice.glideTo(frequency, tau);
  }
  setIndex(voice, index, tau) {
    this.voices[voice].voice.setIndex(index, tau);
  }
  setRatio(voice, ratio, tau) {
    this.voices[voice].voice.setRatio(ratio, tau);
  }
  setGain(voice, gain, tau) {
    this.voices[voice].voice.setGain(gain, tau);
  }
  setPan(voice, pan, tau, now) {
    if (!Number.isFinite(pan)) return;
    const clamped = Math.max(-1, Math.min(1, pan));
    cancelParam(this.voices[voice].panner.pan, now);
    this.voices[voice].panner.pan.setTargetAtTime(clamped, now, tau);
  }
  setCarrierWave(voice, name) {
    this.applyWave(this.voices[voice].voice.carrier, name);
  }
  flush() {
  }
};
var PARAMS_PER_VOICE = 10;
var PARAM_BUFFER_SIZE = TIER_VOICE_COUNT * PARAMS_PER_VOICE;
var WorkletTierBackend = class {
  voiceCount = TIER_VOICE_COUNT;
  node;
  /** [freq, freqTau, index, indexTau, ratio, ratioTau, gain, gainTau, pan, panTau] × 5 */
  buffer;
  constructor({ audioContext }) {
    this.node = new AudioWorkletNode(audioContext, "fm-tier", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit"
    });
    this.buffer = new Float32Array(PARAM_BUFFER_SIZE);
    for (let voice = 0; voice < TIER_VOICE_COUNT; voice++) {
      const offset = voice * PARAMS_PER_VOICE;
      this.buffer[offset + 0] = 220;
      this.buffer[offset + 2] = 0.4;
      this.buffer[offset + 4] = 1;
    }
  }
  connect(bus) {
    this.node.connect(bus);
  }
  /**
   * A single "detune" param shared by all five voices. Wow and flutter both
   * connect to it and sum, exactly as they do across the five separate
   * carriers in node mode.
   */
  detuneTargets() {
    const param = this.node.parameters.get("detune");
    return param ? [param] : [];
  }
  glideTo(voice, frequency, tau) {
    const offset = voice * PARAMS_PER_VOICE;
    this.buffer[offset + 0] = frequency;
    this.buffer[offset + 1] = tau;
  }
  setIndex(voice, index, tau) {
    const offset = voice * PARAMS_PER_VOICE;
    this.buffer[offset + 2] = index;
    this.buffer[offset + 3] = tau;
  }
  setRatio(voice, ratio, tau) {
    const offset = voice * PARAMS_PER_VOICE;
    this.buffer[offset + 4] = ratio;
    this.buffer[offset + 5] = tau;
  }
  setGain(voice, gain, tau) {
    const offset = voice * PARAMS_PER_VOICE;
    this.buffer[offset + 6] = gain;
    this.buffer[offset + 7] = tau;
  }
  setPan(voice, pan, tau, _now) {
    const offset = voice * PARAMS_PER_VOICE;
    this.buffer[offset + 8] = pan;
    this.buffer[offset + 9] = tau;
  }
  setCarrierWave(voice, name) {
    this.node.port.postMessage({ type: "wave", vi: voice, name });
  }
  flush() {
    this.node.port.postMessage({ type: "params", voices: this.buffer });
  }
};

// src/worklets/fmTier.ts
var FM_TIER_WORKLET = (
  /* js */
  `
/**
 * src/audio/worklets/fm-tier.js
 *
 * AudioWorkletProcessor: 5-voice 2-operator FM synthesizer (one per tier).
 * Replaces 5\xD7(carrier+modulator+modGain+outGain+panner) node-graph with a
 * single worklet that processes all voices at sample rate.
 *
 * Key features vs the node-graph FM:
 *   \u2022 Phase-accumulator oscillators with wavetable carrier lookup
 *   \u2022 2\xD7 oversampling + 2-point averaging decimation
 *   \u2022 Nyquist-based FM index ceiling (principal harshness fix)
 *   \u2022 Per-sample exponential glide on all parameters \u2014 no AudioParam races
 *   \u2022 Equal-power stereo pan per voice
 *   \u2022 "detune" AudioParam (a-rate, cents) \u2014 wow/flutter LFOs connect here
 *
 * Message protocol (main \u2192 worklet):
 *   { type:"params", voices:Float32Array(50) }
 *     voices[v*10+0] = targetFreq Hz      voices[v*10+1] = freqTau s
 *     voices[v*10+2] = FM index           voices[v*10+3] = indexTau s
 *     voices[v*10+4] = modulator ratio    voices[v*10+5] = ratioTau s
 *     voices[v*10+6] = output gain        voices[v*10+7] = gainTau s
 *     voices[v*10+8] = pan \u22121..1          voices[v*10+9] = panTau s
 *   { type:"wave", vi:0..4, name:string }
 */

/* global sampleRate, registerProcessor, AudioWorkletProcessor */

const VOICES   = 5;
const WAVE_N   = 32;    // harmonic count \u2014 matches synth.ts _getOrBuildWave
const WAVE_SZ  = 2048;  // wavetable resolution
const TWO_PI   = 2 * Math.PI;
const QPAN     = Math.PI / 4; // equal-power angle scale: (pan+1)*QPAN \u2192 0..\u03C0/2

// \u2500\u2500 wavetable builders \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildSine() {
  const t = new Float32Array(WAVE_SZ);
  for (let n = 0; n < WAVE_SZ; n++) t[n] = Math.sin((TWO_PI * n) / WAVE_SZ);
  return t;
}

/** Build wavetable from Fourier coefficients. Normalises to peak = 1.0. */
function buildFromHarmonics(real, imag) {
  const r  = real || new Float64Array(WAVE_N);
  const im = imag || new Float64Array(WAVE_N);
  const t  = new Float32Array(WAVE_SZ);
  for (let n = 0; n < WAVE_SZ; n++) {
    const ph = (TWO_PI * n) / WAVE_SZ;
    let s = r[0];
    for (let k = 1; k < WAVE_N; k++) s += r[k] * Math.cos(k * ph) - im[k] * Math.sin(k * ph);
    t[n] = s;
  }
  let peak = 0;
  for (let n = 0; n < WAVE_SZ; n++) { const a = Math.abs(t[n]); if (a > peak) peak = a; }
  if (peak > 1e-10) { const inv = 1 / peak; for (let n = 0; n < WAVE_SZ; n++) t[n] *= inv; }
  return t;
}

function h_triangle() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n += 2) {
    im[n] = (((n - 1) / 2) % 2 === 0 ? 1 : -1) * (8 / (Math.PI * Math.PI)) / (n * n);
  }
  return im;
}
function h_square() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n += 2) im[n] = (4 / Math.PI) / n;
  return im;
}
function h_sawtooth() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n++) im[n] = (n % 2 === 0 ? -1 : 1) * 2 / (Math.PI * n);
  return im;
}
function h_softsaw() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n++) im[n] = ((2 / Math.PI) * (n % 2 === 0 ? -1 : 1)) / (n * n);
  return im;
}
function h_softsquare() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n += 2) im[n] = (4 / Math.PI) / (n * n);
  return im;
}
function h_softtri() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n += 2)
    im[n] = (((n - 1) / 2) % 2 === 0 ? 1 : -1) * (8 / (Math.PI * Math.PI)) / (n * n * n * n);
  return im;
}
function h_pwm(duty) {
  const r = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n++) r[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return r;
}
function h_chip() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n <= 9 && n < WAVE_N; n += 2) im[n] = (4 / Math.PI) / n;
  return im;
}
function h_organ() {
  const im = new Float64Array(WAVE_N);
  im[1]=1.0; im[2]=0.8; im[3]=0.5; im[4]=0.35; im[6]=0.15;
  return im;
}
function h_reed() {
  const im = new Float64Array(WAVE_N);
  const wts = [1.0, 0.75, 0.5, 0.28, 0.15, 0.08, 0.04];
  for (let k = 0; k < wts.length; k++) { const n = 2*k+1; if (n < WAVE_N) im[n] = wts[k]; }
  return im;
}
function h_vox() {
  const im = new Float64Array(WAVE_N);
  const v = [0.7,1.0,0.85,0.4,0.2,0.15,0.3,0.55,0.45,0.25,0.12];
  for (let k = 0; k < v.length; k++) im[k+1] = v[k];
  return im;
}
function h_bell() {
  const im = new Float64Array(WAVE_N);
  im[1]=1.0; im[3]=0.7; im[5]=0.18; im[6]=0.55; im[10]=0.35; im[14]=0.18;
  return im;
}
function h_brass() {
  const im = new Float64Array(WAVE_N);
  for (let n = 1; n < WAVE_N; n++) {
    const base = 1 / n;
    const formant = Math.exp(-Math.pow((n - 4) / 2.2, 2)) * 0.6;
    im[n] = (n % 2 === 0 ? -base : base) * (0.55 + formant);
  }
  return im;
}

function buildAllWaves() {
  return {
    sine:       buildSine(),
    triangle:   buildFromHarmonics(null, h_triangle()),
    square:     buildFromHarmonics(null, h_square()),
    sawtooth:   buildFromHarmonics(null, h_sawtooth()),
    softsaw:    buildFromHarmonics(null, h_softsaw()),
    softsquare: buildFromHarmonics(null, h_softsquare()),
    softtri:    buildFromHarmonics(null, h_softtri()),
    pwm:        buildFromHarmonics(h_pwm(0.25),  null),
    pulse12:    buildFromHarmonics(h_pwm(0.125), null),
    chip:       buildFromHarmonics(null, h_chip()),
    organ:      buildFromHarmonics(null, h_organ()),
    reed:       buildFromHarmonics(null, h_reed()),
    vox:        buildFromHarmonics(null, h_vox()),
    bell:       buildFromHarmonics(null, h_bell()),
    brass:      buildFromHarmonics(null, h_brass()),
  };
}

/** Linear-interpolated wavetable lookup. phase01 \u2208 [0,1). */
function wtLookup(table, phase01) {
  const pos = ((phase01 % 1 + 1) % 1) * WAVE_SZ;
  const i0  = pos | 0;
  const frac = pos - i0;
  const i1  = i0 + 1 < WAVE_SZ ? i0 + 1 : 0;
  return table[i0] + frac * (table[i1] - table[i0]);
}

// \u2500\u2500 Processor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class FMTierProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "detune",
      defaultValue: 0,
      minValue: -200,
      maxValue: 200,
      automationRate: "a-rate",
    }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this._sr  = sr;
    this._nyq = sr / 2;

    // Current smoothed parameter values
    this._fc    = new Float64Array(VOICES).fill(220);
    this._idx   = new Float64Array(VOICES).fill(0.4);
    this._ratio = new Float64Array(VOICES).fill(1.0);
    this._gain  = new Float64Array(VOICES);
    this._pan   = new Float64Array(VOICES);

    // Exponential convergence: x += alpha*(target-x); alpha=1\u2192snap, small\u2192slow
    this._fcAlpha    = new Float64Array(VOICES).fill(1);
    this._idxAlpha   = new Float64Array(VOICES).fill(1);
    this._ratioAlpha = new Float64Array(VOICES).fill(1);
    this._gainAlpha  = new Float64Array(VOICES).fill(1);
    this._panAlpha   = new Float64Array(VOICES).fill(1);

    // Targets (updated from postMessage)
    this._fcTgt    = new Float64Array(VOICES).fill(220);
    this._idxTgt   = new Float64Array(VOICES).fill(0.4);
    this._ratioTgt = new Float64Array(VOICES).fill(1.0);
    this._gainTgt  = new Float64Array(VOICES);
    this._panTgt   = new Float64Array(VOICES);

    // Phase accumulators (0..1 normalised)
    this._carrPh = new Float64Array(VOICES);
    this._modPh  = new Float64Array(VOICES);

    // Wavetables
    this._waveMap   = buildAllWaves();
    // Per-voice active wavetable (direct reference, no string lookup per sample)
    this._voiceWave = new Array(VOICES).fill(this._waveMap.sine);

    this.port.onmessage = (e) => this._onMsg(e.data);
  }

  /** tau=0 \u2192 alpha=1 (instant snap); tau>0 \u2192 1\u2212exp(\u22121/(tau\xD7sr)). */
  _tau2a(tau) {
    return tau <= 0 ? 1 : 1 - Math.exp(-1 / (tau * this._sr));
  }

  _onMsg(data) {
    if (data.type === "params") {
      const v = data.voices; // Float32Array(50)
      for (let vi = 0; vi < VOICES; vi++) {
        const o = vi * 10;
        const fc    = v[o + 0]; const fTau = v[o + 1];
        const idx   = v[o + 2]; const iTau = v[o + 3];
        const ratio = v[o + 4]; const rTau = v[o + 5];
        const gain  = v[o + 6]; const gTau = v[o + 7];
        const pan   = v[o + 8]; const pTau = v[o + 9];

        if (fc    >  0) this._fcTgt[vi]    = fc;
        if (idx   >= 0) this._idxTgt[vi]   = idx;
        if (ratio >  0) this._ratioTgt[vi] = ratio;
        if (gain  >= 0) this._gainTgt[vi]  = gain;
        this._panTgt[vi] = pan;

        this._fcAlpha[vi]    = this._tau2a(fTau);
        this._idxAlpha[vi]   = this._tau2a(iTau);
        this._ratioAlpha[vi] = this._tau2a(rTau);
        this._gainAlpha[vi]  = this._tau2a(gTau);
        this._panAlpha[vi]   = this._tau2a(pTau);
      }
    } else if (data.type === "wave") {
      const vi = data.vi;
      if (vi >= 0 && vi < VOICES) {
        this._voiceWave[vi] = this._waveMap[data.name] || this._waveMap.sine;
      }
    }
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n    = outL.length; // 128

    const detArr    = parameters.detune;
    const detConst  = detArr.length === 1;
    const nyq       = this._nyq;
    const invOsSR   = 0.5 / this._sr; // 1/(sr\xD72): period at 2\xD7 oversampled rate

    for (let i = 0; i < n; i++) {
      const dc = detConst ? detArr[0] : detArr[i];
      // Detune in cents \u2192 frequency ratio (skip pow for zero)
      const dRatio = dc === 0 ? 1.0 : Math.pow(2, dc / 1200);

      let sumL = 0;
      let sumR = 0;

      for (let v = 0; v < VOICES; v++) {
        // \u2500\u2500 Per-sample exponential param smoothing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        this._fc[v]    += this._fcAlpha[v]    * (this._fcTgt[v]    - this._fc[v]);
        this._idx[v]   += this._idxAlpha[v]   * (this._idxTgt[v]   - this._idx[v]);
        this._ratio[v] += this._ratioAlpha[v] * (this._ratioTgt[v] - this._ratio[v]);
        this._gain[v]  += this._gainAlpha[v]  * (this._gainTgt[v]  - this._gain[v]);
        this._pan[v]   += this._panAlpha[v]   * (this._panTgt[v]   - this._pan[v]);

        const fc    = this._fc[v] * dRatio;
        const ratio = this._ratio[v];
        const fm    = fc * ratio;

        // \u2500\u2500 Sideband ceiling: clamp index so highest sideband < Nyquist \u2500\u2500\u2500\u2500
        // Highest sideband \u2248 fc + index\xD7fm; ceiling = (nyq\u2212fc)/fm
        const maxIdx     = fm > 0 ? Math.max(0, (nyq - fc) / fm) : 1e6;
        const clampedIdx = Math.min(this._idx[v], maxIdx);
        const modDepth   = clampedIdx * fm; // absolute FM deviation, Hz

        // \u2500\u2500 2\xD7 oversampling: generate 2 samples, average for 1 output \u2500\u2500\u2500\u2500\u2500\u2500
        let osSum = 0;
        for (let os = 0; os < 2; os++) {
          // Modulator phase (pure sine modulator)
          this._modPh[v] += fm * invOsSR;
          if (this._modPh[v] >= 1) this._modPh[v] -= 1;
          else if (this._modPh[v] < 0) this._modPh[v] += 1;

          const modOut = Math.sin(this._modPh[v] * TWO_PI) * modDepth;

          // Carrier phase with FM
          this._carrPh[v] += (fc + modOut) * invOsSR;
          if (this._carrPh[v] >= 1) this._carrPh[v] -= 1;
          else if (this._carrPh[v] < 0) this._carrPh[v] += 1;

          osSum += wtLookup(this._voiceWave[v], this._carrPh[v]);
        }

        // Decimate (2-point average; index ceiling keeps content well below SR/4)
        const sample = osSum * 0.5 * this._gain[v];

        // \u2500\u2500 Equal-power stereo pan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const angle = (this._pan[v] + 1) * QPAN; // 0..\u03C0/2
        sumL += sample * Math.cos(angle);
        sumR += sample * Math.sin(angle);
      }

      outL[i] = sumL;
      outR[i] = sumR;
    }

    return true;
  }
}

registerProcessor("fm-tier", FMTierProcessor);
`
);

// src/worklets/ksString.ts
var KS_STRING_WORKLET = (
  /* js */
  `
/**
 * src/audio/worklets/ks-string.js
 *
 * AudioWorkletProcessor: 4-voice Karplus-Strong string synthesizer.
 * Triggered by FLUX\xD7CTR axis signals via postMessage from synth.ts.
 *
 * Message protocol:
 *   { type:"trigger", vi:0..3, freq:Hz, gain, damp, pan }
 *     vi   = voice slot (oldest silent voice is auto-stolen by host)
 *     freq = fundamental frequency in Hz
 *     gain = initial amplitude (linear)
 *     damp = per-sample decay factor (0.990=long sustain, 0.980=short)
 *     pan  = \u22121..1 stereo position
 *
 *   { type:"set-pan", vi, pan }
 *     Update pan of an already-playing voice.
 */

/* global sampleRate, registerProcessor, AudioWorkletProcessor */

const VOICES  = 4;
const BUF_SZ  = 8192; // max delay samples (supports ~6 Hz at 48kHz)

class KSStringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this._sr = sr;

    this._active  = new Uint8Array(VOICES);
    this._damp    = new Float64Array(VOICES).fill(0.995);
    this._gain    = new Float64Array(VOICES);
    this._pan     = new Float64Array(VOICES);
    this._prevOut = new Float64Array(VOICES);

    // Ring buffers, one per voice
    this._buf     = Array.from({ length: VOICES }, () => new Float32Array(BUF_SZ));
    this._wPtr    = new Int32Array(VOICES); // write pointer
    this._delayN  = new Float64Array(VOICES); // fractional delay length

    this.port.onmessage = (e) => this._onMsg(e.data);
  }

  _onMsg(data) {
    if (data.type === "trigger") {
      const { vi, freq, gain, damp, pan } = data;
      if (vi < 0 || vi >= VOICES || !(freq > 0)) return;

      const sr  = this._sr;
      const len = sr / freq;          // fractional delay length
      const N   = Math.min(Math.ceil(len) + 1, BUF_SZ - 1);

      const buf = this._buf[vi];
      // Fill delay buffer with bandlimited noise (simple LPF: running avg of 3)
      let s0 = 0, s1 = 0;
      for (let i = 0; i < N; i++) {
        const raw = (Math.random() * 2 - 1) * gain;
        const s2 = (s0 + s1 + raw) / 3;
        buf[i] = s2;
        s0 = s1; s1 = s2;
      }
      // Zero the rest
      for (let i = N; i < BUF_SZ; i++) buf[i] = 0;

      this._delayN[vi]  = len;
      this._wPtr[vi]    = N % BUF_SZ;
      this._damp[vi]    = Math.max(0.9, Math.min(0.9999, damp ?? 0.995));
      this._gain[vi]    = gain;
      this._pan[vi]     = Math.max(-1, Math.min(1, pan ?? 0));
      this._prevOut[vi] = 0;
      this._active[vi]  = 1;
    } else if (data.type === "set-pan") {
      const { vi, pan } = data;
      if (vi >= 0 && vi < VOICES) this._pan[vi] = Math.max(-1, Math.min(1, pan));
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n    = outL.length;

    for (let i = 0; i < n; i++) {
      let sumL = 0, sumR = 0;

      for (let v = 0; v < VOICES; v++) {
        if (!this._active[v]) continue;

        const buf     = this._buf[v];
        const wPtr    = this._wPtr[v];
        const delayN  = this._delayN[v];
        const N       = BUF_SZ;

        // Fractional read position (wPtr is where we're writing next, so the
        // delay line starts at wPtr-1 and goes back delayN samples).
        const rPos  = ((wPtr - delayN % N + N) % N);
        const ri    = rPos | 0;
        const frac  = rPos - ri;
        const r1    = (ri + 1) % N;
        const s0    = buf[ri];
        const s1    = buf[r1];
        const sample = s0 + frac * (s1 - s0);

        // Averaging lowpass + damping (single-pole KS filter)
        const filtered = 0.5 * (sample + this._prevOut[v]) * this._damp[v];
        this._prevOut[v] = sample;

        buf[wPtr] = filtered;
        this._wPtr[v] = (wPtr + 1) % N;

        // Decay detection
        if (Math.abs(filtered) < 1e-7 && Math.abs(sample) < 1e-7) {
          this._active[v] = 0;
          continue;
        }

        // Equal-power pan
        const angle = (this._pan[v] + 1) * Math.PI * 0.25;
        sumL += sample * Math.cos(angle);
        sumR += sample * Math.sin(angle);
      }

      outL[i] = sumL;
      outR[i] = sumR;
    }

    return true;
  }
}

registerProcessor("ks-string", KSStringProcessor);
`
);

// src/worklets/limiter.ts
var LIMITER_WORKLET = (
  /* js */
  `
/**
 * src/audio/worklets/limiter.js
 *
 * Lookahead limiter + LUFS-ish short-term RMS metering.
 * Loaded via AudioContext.audioWorklet.addModule(); must be a plain JS module
 * with no imports (AudioWorklet global scope constraint).
 *
 * Algorithm:
 *   - 3 ms ring-buffer lookahead delays output so the gain envelope has time
 *     to snap before the loud sample reaches the output.
 *   - Instantaneous attack (gain snaps down when a new peak exceeds ceiling).
 *   - Exponential release (\u03C4 = 80 ms) \u2014 smooth recovery without pumping.
 *   - Ceiling: \u22121 dBFS (\u2248 0.891 linear).
 *   - Posts { lufsShort, gr } over port at ~10 Hz.
 */

const CEIL_DB = -1;
const CEIL = Math.pow(10, CEIL_DB / 20); // \u2248 0.891
const RELEASE_TAU_S = 0.08;              // 80 ms release
const LOOKAHEAD_MS = 3;                 // 3 ms lookahead
const METER_INTERVAL_S = 0.1;           // post metrics every 100 ms
const METER_WINDOW_S = 0.4;             // 400 ms short-term RMS window

class LookaheadLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return []; }

  constructor() {
    super();
    this._initialized = false;
    this._gainEnv = 1.0;
    this._sqSumL = 0;
    this._sqSumR = 0;
    this._samplesSincePost = 0;
    this._meterPos = 0;
  }

  _init() {
    const sr = sampleRate;
    this._releaseCoeff = Math.exp(-1 / (RELEASE_TAU_S * sr));
    this._lookaheadSamples = Math.max(1, Math.ceil((LOOKAHEAD_MS / 1000) * sr));
    this._delayL = new Float32Array(this._lookaheadSamples);
    this._delayR = new Float32Array(this._lookaheadSamples);
    this._writePos = 0;
    this._meterSize = Math.max(1, Math.ceil(METER_WINDOW_S * sr));
    this._meterBufL = new Float32Array(this._meterSize);
    this._meterBufR = new Float32Array(this._meterSize);
    this._meterPos = 0;
    this._sqSumL = 0;
    this._sqSumR = 0;
    this._samplesSincePost = 0;
    this._postInterval = Math.max(1, Math.ceil(METER_INTERVAL_S * sr));
    this._initialized = true;
  }

  process(inputs, outputs) {
    if (!this._initialized) this._init();

    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    const inL = input[0] || new Float32Array(128);
    const inR = input[1] || inL;
    const outL = output[0];
    const outR = output[1] || output[0];

    const n = inL.length;
    const lhs = this._lookaheadSamples;
    const delL = this._delayL;
    const delR = this._delayR;
    const mBufL = this._meterBufL;
    const mBufR = this._meterBufR;
    const mSz = this._meterSize;
    const rc = this._releaseCoeff;

    let wp = this._writePos;
    let ge = this._gainEnv;
    let sqSumL = this._sqSumL;
    let sqSumR = this._sqSumR;
    let mPos = this._meterPos;
    let sincePost = this._samplesSincePost;

    for (let i = 0; i < n; i++) {
      // Oldest delayed sample (will be output this cycle)
      const dL = delL[wp];
      const dR = delR[wp];

      // Write new input into delay ring
      delL[wp] = inL[i];
      delR[wp] = inR[i];
      wp = (wp + 1) % lhs;

      // True-peak detect on the NEW input sample
      const peak = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
      const targetGain = peak > CEIL ? CEIL / Math.max(peak, 1e-9) : 1.0;

      // Gain envelope: instant attack, exponential release
      ge = targetGain < ge ? targetGain : ge * rc + targetGain * (1 - rc);

      // Apply gain to delayed sample
      const oL = dL * ge;
      const oR = dR * ge;
      outL[i] = oL;
      if (outR !== outL) outR[i] = oR;

      // Meter: running sum-of-squares over METER_WINDOW_S
      const oldL = mBufL[mPos];
      const oldR = mBufR[mPos];
      sqSumL = sqSumL - oldL * oldL + oL * oL;
      sqSumR = sqSumR - oldR * oldR + oR * oR;
      mBufL[mPos] = oL;
      mBufR[mPos] = oR;
      mPos = (mPos + 1) % mSz;
    }

    this._writePos = wp;
    this._gainEnv = ge;
    this._sqSumL = Math.max(0, sqSumL);
    this._sqSumR = Math.max(0, sqSumR);
    this._meterPos = mPos;

    this._samplesSincePost = sincePost + n;
    if (this._samplesSincePost >= this._postInterval) {
      this._samplesSincePost = 0;
      const rmsL = Math.sqrt(this._sqSumL / mSz);
      const rmsR = Math.sqrt(this._sqSumR / mSz);
      const rms = (rmsL + rmsR) * 0.5;
      const lufsShort = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
      const gr = ge < 1 ? 20 * Math.log10(Math.max(ge, 1e-9)) : 0;
      this.port.postMessage({ lufsShort, gr });
    }

    return true;
  }
}

registerProcessor("lookahead-limiter", LookaheadLimiter);
`
);

// src/WorkletHost.ts
async function addModuleFromSource(audioContext, source) {
  const url = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function loadLimiterWorklet(audioContext) {
  try {
    await addModuleFromSource(audioContext, LIMITER_WORKLET);
    return true;
  } catch (error) {
    console.warn(
      "[sound-synthesis] limiter worklet failed to load \u2014 keeping the safety compressor:",
      error
    );
    return false;
  }
}
async function loadFMTierWorklet(audioContext) {
  try {
    await addModuleFromSource(audioContext, FM_TIER_WORKLET);
    return true;
  } catch (error) {
    console.warn(
      "[sound-synthesis] fm-tier worklet failed to load \u2014 falling back to the node graph:",
      error
    );
    return false;
  }
}
async function loadKSStringWorklet(audioContext) {
  try {
    await addModuleFromSource(audioContext, KS_STRING_WORKLET);
    return true;
  } catch (error) {
    console.warn("[sound-synthesis] ks-string worklet failed to load:", error);
    return false;
  }
}
function createKSStringNode(audioContext) {
  return new AudioWorkletNode(audioContext, "ks-string", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit"
  });
}
function createLimiterNode({
  audioContext,
  onMetrics
}) {
  const node = new AudioWorkletNode(audioContext, "lookahead-limiter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit"
  });
  if (onMetrics) {
    node.port.onmessage = (event) => {
      onMetrics(event.data);
    };
  }
  return node;
}
export {
  AudioGraph,
  ChromaticWall,
  Clock,
  DrumMachine,
  DrumSynth,
  FMVoice,
  NodeTierBackend,
  NoiseLayer,
  PATTERNS,
  PATTERN_NAMES,
  ShimmerLayer,
  TIER_VOICE_COUNT,
  WorkletTierBackend,
  cancelParam,
  createKSStringNode,
  createLimiterNode,
  loadFMTierWorklet,
  loadKSStringWorklet,
  loadLimiterWorklet,
  pitchClassToFrequency
};
//# sourceMappingURL=index.js.map