/* Vendored from @amplib/sound-synthesis @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
interface AudioGraphParams {
    audioContext: AudioContext;
}
/**
 * The bus and routing topology for a layered synth. Voices connect into the
 * named bus GainNodes; everything downstream — slotting filters, the insert
 * point, the master chain, the limiter — is wired here.
 *
 *   subBus     (LP 90) ─────┐
 *   bassBus    (HP 45/LP800)┤
 *   midBus     (HP 140) ────┼──► layerSum ──► masterTrim ──► dimGain ──► tremoloSum
 *   trebleBus  (HP 500) ────┤                                                │
 *   pluckBus   (HP 300) ────┤                                          analysisTap
 *   ksBus      (HP 200) ────┤                                                │
 *   noiseBus   (HP 100) ────┤                                          headroomPad (−6 dB)
 *   shimmerBus (HP 1k) ─────┘                                                │
 *                                                   [insert, wired by the caller]
 *                                                                            │
 *                                                                      autoMakeup
 *                                                                            │
 *                                                        safetyComp or worklet limiter
 *                                                                            │
 *                                                                      masterPanner
 *                                                                            │
 *                                                          output ──► destination
 *
 * Each bus is high-passed at the bottom of its own range. Without that,
 * every layer contributes low end and the sum turns to mud long before any
 * single layer sounds too heavy on its own.
 */
declare class AudioGraph {
    readonly audioContext: AudioContext;
    readonly subBus: GainNode;
    readonly bassBus: GainNode;
    readonly midBus: GainNode;
    readonly trebleBus: GainNode;
    readonly pluckBus: GainNode;
    readonly ksBus: GainNode;
    readonly noiseBus: GainNode;
    readonly shimmerBus: GainNode;
    readonly layerSum: GainNode;
    /** User-facing master gain. */
    readonly masterTrim: GainNode;
    /**
     * Separate from masterTrim so a per-frame brightness dim and the user's own
     * volume are never writing to the same AudioParam — two writers on one param
     * means whichever ran last wins and the other silently stops working.
     */
    readonly dimGain: GainNode;
    /** Tremolo LFOs connect here, so they get a dedicated AudioParam too. */
    readonly tremoloSum: GainNode;
    /** Post-gain, pre-insert tap. Analyzers connect here. */
    readonly analysisTap: GainNode;
    /** −6 dB before the insert chain, so saturation has room to work. */
    readonly headroomPad: GainNode;
    /** Post-insert makeup. Compensates headroomPad and any insert-induced gain. */
    readonly autoMakeup: GainNode;
    readonly masterPanner: StereoPannerNode;
    readonly output: GainNode;
    private readonly safetyComp;
    /** A sandwich around the limiter stage, so it can be swapped without rewiring. */
    private readonly limiterIn;
    private readonly limiterOut;
    private workletLimiter;
    /** True once the AudioWorklet lookahead limiter has replaced the compressor. */
    get workletActive(): boolean;
    constructor({ audioContext }: AudioGraphParams);
    /**
     * Connect headroomPad straight to autoMakeup, for callers with no insert
     * chain. Skip this if you are wiring something in between.
     */
    bypassInsert(): void;
    /** Replace the safety compressor with a lookahead limiter. Idempotent. */
    swapToWorkletLimiter(workletNode: AudioWorkletNode): void;
    setMasterGain(value: number): void;
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
    setBrightnessDim(brightness: number, now: number, extremesScale?: number): void;
    /**
     * Recompute makeup gain when the insert chain's parameters change.
     *
     * Starts from the +6 dB that cancels headroomPad, then backs off for what
     * the insert added: measured at roughly 0.5 dB of output per dB of mid-boost
     * at full wet, plus about 0.6 dB more from saturation at amount 10 / wet 0.6.
     * The 0.55 and 0.9 coefficients hold the result within ±1 dB of the dry
     * baseline across the usable range.
     */
    updateAutoMakeup({ saturationAmount, saturationWet, midBoostDb, }: {
        saturationAmount: number;
        saturationWet: number;
        midBoostDb: number;
    }): void;
}

type Notation = "C" | "C#" | "D" | "D#" | "E" | "F" | "F#" | "G" | "G#" | "A" | "A#" | "B";
type NotationAlternate = "C" | "Db" | "D" | "Eb" | "E" | "F" | "Gb" | "G" | "Ab" | "A" | "Bb" | "B";
declare class Note {
    /**
     * Frequency hz for this note
     */
    frequency: number;
    /**
     * A unique identifier for this note
     */
    id: string;
    /**
     * Global index of the note on a keyboard (
     * 0 through 107
     */
    index: number;
    /**
     * Primary notation for the note
     */
    notation: Notation;
    /**
     * Optional secondary notation for the note
     */
    notationAlternate?: NotationAlternate;
    /**
     * Global octave number for the note
     * 0 through 8
     */
    octave: number;
    /**
     * Index of the note within the octave
     * 0 through 11
     */
    octaveIndex: number;
    constructor({ octave, step }: {
        octave: number;
        step: number;
    });
    static notationIndex(notation: Notation | NotationAlternate): number;
    static noteIdFromNotationAndOctave(notation: Notation, octave: number): string;
    static get notations(): Notation[];
    static get notationsAlternate(): NotationAlternate[];
    static get notationsUnique(): (Notation | NotationAlternate)[];
    static get octaveStepFrequencies(): {
        [K in number]: {
            [K in number]: number;
        };
    };
    static stringIsNotation(string: string): string is Notation | NotationAlternate;
}

type IntervalName = "Augmented" | "Diminished" | "Major" | "Minor";
type IntervalType = "aug" | "dim" | "maj" | "min";
interface IntervalNote {
    /**
     * Notation for the note
     */
    notation: Notation;
    /**
     * Octave relative to the first interval's root octave.
     * 0 | 1 | 2
     */
    octave: number;
}
declare class Interval {
    /**
     * Common representation of the interval
     */
    label: string;
    /**
     * Metadata
     */
    meta: {
        /**
         * Interval name
         */
        name: IntervalName;
        /**
         * Interval roman numeral syntax
         */
        numeral: string;
        /**
         * Interval type
         */
        type: IntervalType;
    };
    /**
     * Primary identifier of the interval root note
     */
    notation: Notation;
    /**
     * Optional secondary identifier of the interval root note
     */
    notationAlternate?: NotationAlternate;
    /**
     * Interval triad notes
     */
    notes: IntervalNote[];
    /**
     * Octave relative octave to first interval's root note.
     * 0 | 1
     */
    octave: number;
    /**
     * Interval step in the mode
     * 0 through 6
     */
    step: number;
    constructor(step: number, offset: number, type: IntervalType);
    static intervalsFromModeType(mode: "melodic" | "harmonic"): IntervalType[];
    static intervalsFromOffset(offset: number): IntervalType[];
    static nameFromType(type: IntervalType): IntervalName;
    static numeralFromType(step: number, type: IntervalType): string;
    static notesFromIndexOctaveAndType(offset: number, octave: number, type: IntervalType): IntervalNote[];
}

type ModeType = "ionian" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "aeolian" | "locrian" | "melodic" | "harmonic";
type ModeTypeVanity = "major" | "minor";
interface ModeParams {
    type: ModeType | ModeTypeVanity;
}
declare class Mode {
    intervals: IntervalType[];
    name: string;
    steps: number[];
    type: ModeType | ModeTypeVanity;
    constructor({ type }: ModeParams);
    static get types(): (ModeType | ModeTypeVanity)[];
    static intervalsFromType(type: ModeType | ModeTypeVanity): IntervalType[];
    static nameFromType(type: ModeType | ModeTypeVanity): "Ionian" | "Dorian" | "Phrygian" | "Lydian" | "Mixolydian" | "Aeolian" | "Locrian" | "Melodic Minor" | "Harmonic Minor";
    static stepsFromType(type: ModeType | ModeTypeVanity): number[];
    static stepsFromIncrements(increments: (1 | 2 | 3)[]): number[];
    static stringIsModeType(string: string): string is ModeType | ModeTypeVanity;
}

interface ScaleParams {
    /**
     * The root of the scale. Can be alternative format (flat instead of sharp).
     */
    root: Notation | NotationAlternate;
    /**
     * The scale mode, can provide vanity modes (major, minor).
     */
    mode: ModeParams["type"];
}
declare class Scale {
    /**
     * Array of 7 intervals in the scale
     */
    intervals: Interval[];
    /**
     * Common label for the scale's key.
     */
    label: string;
    /**
     * Library of all notes
     */
    library: {
        [noteId: string]: Note;
    };
    /**
     * Scale's mode. Can be a vanity mode (minor, major)
     */
    mode: Mode;
    /**
     * Array of playable note ids in the scale
     */
    noteIds: string[];
    /**
     * Notation or alternative notation for the root of the scale.
     */
    root: Notation | NotationAlternate;
    /**
     * Index of the root
     */
    rootOffset: number;
    constructor(params: ScaleParams);
    update({ root, mode }: ScaleParams): void;
    static buildLibrary(): {
        [noteId: string]: Note;
    };
    /**
     * Array of playable notes in the scale.
     */
    get notes(): Note[];
}

interface Envelope {
    attack: number;
    release: number;
    volume: number;
}
interface EnvelopeModifier {
    attack?: number;
    release?: number;
    volume?: number;
}
interface FMSynthSettings {
    envelope: Envelope;
    carrier: {
        type: OscillatorType;
    };
    modulation: {
        type: OscillatorType;
    };
    /** Modulator frequency as a multiple of the carrier. 1 is harmonic. */
    ratio: number;
    /** Modulation index. Higher is brighter and buzzier. */
    index: number;
}
interface ChromaticWallParams {
    audioContext: AudioContext;
    volume: number;
    mainChance: number;
    twinkleChance: number;
    /**
     * Voices held open for plucking. Notes steal the least recently used voice,
     * so this is the ceiling on how many can overlap before the oldest gets cut
     * off. The default comfortably covers the longest release at typical tick
     * rates.
     */
    voiceCount?: number;
}
/**
 * A drifting wall of notes drawn from a scale, thickened by a sparser layer of
 * high twinkles.
 *
 * Notes are played by a fixed pool of FMVoice objects rather than by building
 * an oscillator pair per note. The audible difference is in the timbre: this
 * used to run its modulator at a fixed 14.3 Hz into `carrier.detune`, which at
 * ±10 cents is a slow vibrato rather than frequency modulation. FMVoice runs
 * the modulator at a ratio of the carrier and into `carrier.frequency`, which
 * puts real sidebands in the tone. Set `index` to 0 on either synth to get
 * back a plain oscillator.
 */
declare class ChromaticWall {
    audioContext: AudioContext;
    volume: number;
    mainChance: number;
    twinkleChance: number;
    triadNoteIndices: number[];
    synthMain: FMSynthSettings;
    synthTwinkle: FMSynthSettings;
    stepPosition: number;
    on: boolean;
    channelOutput: GainNode;
    effectHighpassFilter: BiquadFilterNode;
    effectLowpassFilter: BiquadFilterNode;
    private readonly voices;
    private nextVoice;
    constructor({ audioContext, volume, mainChance, twinkleChance, voiceCount, }: ChromaticWallParams);
    static modifiedEnvelope(envelope: Envelope, modifiers: EnvelopeModifier): {
        attack: number;
        release: number;
        volume: number;
    };
    start(): void;
    stop(): void;
    tick({ scale, stepFactor, highpassFactor, lowpassFactor, mainEnvelopeModifier, twinkleEnvelopeModifier, }: {
        scale: Scale;
        stepFactor: number;
        highpassFactor: number;
        lowpassFactor: number;
        mainEnvelopeModifier?: EnvelopeModifier;
        twinkleEnvelopeModifier?: EnvelopeModifier;
    }): void;
    toggle(): void;
    triggerNote({ hz, synth, envelopeModifier, }: {
        hz: number;
        synth: FMSynthSettings;
        envelopeModifier: EnvelopeModifier;
    }): void;
    disconnect(): void;
}

type BeatCallback = (info: {
    timestamp: number;
    beatIndex: number;
}) => void;
type ClockOptions = {
    bpm?: number;
    swing?: number;
    subdivision?: number;
};
declare class Clock {
    private worker;
    private started;
    private swing;
    private callbacks;
    subdivision: number;
    bpm: number;
    constructor(options?: ClockOptions);
    onBeat(callback: BeatCallback): () => void;
    start(): void;
    stop(): void;
    setBPM(bpm: number): void;
    setResolution(swing: number, subdivision?: number): void;
    dispose(): void;
}

interface DrumSynthParams {
    audioContext: AudioContext;
    /** Where the drum bus connects — typically a layer sum or a bus GainNode. */
    destination: AudioNode;
}
/**
 * Sample-free percussive voices.
 *
 * Every hit builds its own nodes, schedules them, and lets them fall out of
 * scope once stopped. That is the right shape here and the wrong shape for a
 * pitched voice: drums are short and sparse, so the allocation never stacks
 * up, and each hit wants its own envelope from silence rather than a
 * retrigger crossfade.
 */
declare class DrumSynth {
    readonly audioContext: AudioContext;
    private readonly bus;
    private readonly filter;
    private readonly echoDelay;
    private readonly echoFeedback;
    private readonly echoDamp;
    private readonly echoWet;
    private readonly noiseBuffer;
    constructor({ audioContext, destination }: DrumSynthParams);
    setVolume(value: number): void;
    setFilter({ frequency, q }: {
        frequency: number;
        q: number;
    }): void;
    setEcho({ timeMs, feedback, wet, }: {
        timeMs: number;
        feedback: number;
        wet: number;
    }): void;
    /** Sine with a 150 → 45 Hz pitch drop over 50 ms. */
    kick(time: number, velocity?: number): void;
    /** A 200 Hz body under a high-passed noise snap. */
    snare(time: number, velocity?: number): void;
    hihatClosed(time: number, velocity?: number): void;
    hihatOpen(time: number, velocity?: number): void;
    rim(time: number, velocity?: number): void;
    /** Filtered noise burst — the snap in the snare, and all three of the metals. */
    private noiseHit;
    disconnect(): void;
}

/**
 * Omnichord-style beat patterns.
 *
 * Sixteen steps for 4/4, twelve for 3/4 — `steps` is the loop length, not a
 * fixed grid, so a waltz is not padded out to sixteen with silence. Values
 * are velocities from 0 to 1; 0 means the voice does not fire on that step.
 *
 * Origin: another-machine/avva, src/audio/drums/patterns.ts
 */
type DrumPattern = {
    label: string;
    steps: number;
    kick: number[];
    snare: number[];
    hihatC: number[];
    hihatO: number[];
    rim: number[];
};
declare const PATTERN_NAMES: readonly ["rock", "bossanova", "waltz", "march", "slow-rock", "cha-cha", "samba", "ballad"];
type PatternName = typeof PATTERN_NAMES[number];
declare const PATTERNS: Record<PatternName, DrumPattern>;

interface DrumMachineParams {
    drumSynth: DrumSynth;
    bpm?: number;
    pattern?: PatternName;
}
interface DrumStep {
    /** Step index within the current pattern. */
    index: number;
    /** AudioContext time this step plays at. Pass it straight to a voice. */
    time: number;
    /** Seconds per step at the current tempo — one sixteenth. */
    stepLength: number;
    pattern: PatternName;
}
type DrumStepListener = (step: DrumStep) => void;
/**
 * A lookahead scheduler driving DrumSynth.
 *
 * This is the "Tale of Two Clocks" pattern: a setTimeout loop wakes every
 * 25 ms and schedules every hit falling inside a 100 ms window on the audio
 * clock. Timing comes from AudioContext.currentTime, never from the timer, so
 * jitter in setTimeout — and browsers throttle it hard in background tabs —
 * moves when hits get scheduled but not when they play.
 */
declare class DrumMachine {
    private readonly synth;
    private currentBpm;
    private patternName;
    private step;
    private nextNoteTime;
    private timerId;
    private taps;
    private stepListeners;
    constructor({ drumSynth, bpm, pattern }: DrumMachineParams);
    get bpm(): number;
    get pattern(): PatternName;
    get running(): boolean;
    start(): void;
    stop(): void;
    setBpm(bpm: number): void;
    setPattern(name: PatternName): void;
    /**
     * Subscribe to steps as they are scheduled. Returns an unsubscribe function.
     *
     * Listeners fire during the lookahead pass, so `time` is up to 100 ms in the
     * future — that is the point. Anything that wants to play in time with the
     * drums should schedule against that value rather than playing immediately,
     * because "immediately" is the wall clock and the drums are on the audio
     * clock. The two drift, and the drift is audible.
     */
    onStep(listener: DrumStepListener): () => void;
    /**
     * Tap tempo. Averages the gaps between the last four taps; a gap over two
     * seconds is treated as the start of a new attempt rather than a very slow
     * tempo.
     */
    tap(): void;
    private tick;
}

interface FMVoiceParams {
    audioContext: AudioContext;
    /** Where the voice's output gain connects. Usually a panner or a bus. */
    destination: AudioNode;
    /** Modulator frequency as a multiple of the carrier. 1 = same pitch. */
    ratio?: number;
    /** Modulation index. Higher is brighter and more inharmonic. */
    index?: number;
    carrierType?: OscillatorType;
    modulatorType?: OscillatorType;
}
interface FMVoicePluckParams {
    peak?: number;
    ampDecayTau?: number;
    modDecayTau?: number;
    indexPeak?: number;
    attackTau?: number;
    /**
     * AudioContext time to play at. Defaults to now.
     *
     * Pass this to place a note on the audio clock instead of the wall clock.
     * Any lookahead scheduler — DrumMachine's, or your own — decides *ahead of
     * time* that a note belongs at a particular instant, and a voice that can
     * only ever start "now" cannot honour that. Driving one from setTimeout
     * instead puts the note wherever the timer happened to fire, which is how
     * a melody ends up drifting against a beat that is scheduled properly.
     */
    when?: number;
}
/**
 * A two-operator FM voice: modulator → modGain → carrier.frequency,
 * carrier → outGain → destination.
 *
 * The oscillators start in the constructor and never stop. A voice is a
 * persistent thing you glide and re-pluck, not a node-per-hit — starting an
 * OscillatorNode per note is what makes dense passages allocate, and the
 * retrigger crossfade in `pluck` only works if the carrier is already running.
 * For polyphony, hold a pool of these and round-robin them.
 */
declare class FMVoice {
    ratio: number;
    index: number;
    readonly carrier: OscillatorNode;
    readonly modulator: OscillatorNode;
    readonly modGain: GainNode;
    readonly outGain: GainNode;
    private audioContext;
    private carrierFrequency;
    constructor({ audioContext, destination, ratio, index, carrierType, modulatorType, }: FMVoiceParams);
    /** Glide carrier frequency over `tau` seconds. */
    glideTo(frequency: number, tau: number): void;
    /** Glide modulation index — timbre brightness. */
    setIndex(index: number, tau: number): void;
    /** Glide modulator ratio — detunes sidebands for chorus and inharmonic tones. */
    setRatio(ratio: number, tau: number): void;
    /** Glide output amplitude. */
    setGain(gain: number, tau: number): void;
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
    pluck(frequency: number, params?: FMVoicePluckParams): void;
    disconnect(): void;
}

interface NoiseLayerParams {
    audioContext: AudioContext;
    bus: GainNode;
}
interface NoiseLayerUpdateParams {
    /** Active pitch classes, root first. */
    pitchClasses: number[];
    octave: number;
    /** Layer weight, 0 to 1. */
    weight: number;
    /** AudioContext.currentTime. */
    now: number;
    /** Smoothing time constant in seconds. */
    tau: number;
}
/**
 * Looped white noise through a bank of high-Q bandpass filters tuned to the
 * current chord — an airy textural wash instead of another pad.
 *
 * At Q 28 each band is narrow enough that the result still reads as pitched to
 * a chroma analyzer, which matters if something downstream is listening to
 * this output and trying to name the chord.
 */
declare class NoiseLayer {
    private readonly noise;
    private readonly bands;
    private readonly outGain;
    private currentWeight;
    constructor({ audioContext, bus }: NoiseLayerParams);
    update({ pitchClasses, octave, weight, now, tau, }: NoiseLayerUpdateParams): void;
    get weight(): number;
    disconnect(): void;
}

interface ShimmerLayerParams {
    audioContext: AudioContext;
    bus: GainNode;
}
interface ShimmerLayerUpdateParams {
    rootPitchClass: number;
    /** Base octave of the pads this sits above. */
    octave: number;
    /** Horizontal position 0 to 1, for a little pan drift. */
    position: number;
    /** Layer weight, 0 to 1. */
    weight: number;
    /** AudioContext.currentTime. */
    now: number;
    /** Smoothing time constant in seconds. */
    tau: number;
}
/**
 * Two sine voices an octave and two octaves above the root, each under a very
 * slow amplitude LFO.
 *
 * The two LFO rates are close but not equal, and each gets a small random
 * detune at construction. That is the whole trick: matched rates would beat
 * against each other in a fixed audible cycle, whereas slightly mismatched
 * ones drift in and out of phase and never quite repeat. It reads as glassy
 * rather than as two oscillators pulsing.
 */
declare class ShimmerLayer {
    private readonly voices;
    private readonly outGain;
    private currentWeight;
    constructor({ audioContext, bus }: ShimmerLayerParams);
    update({ rootPitchClass, octave, position, weight, now, tau, }: ShimmerLayerUpdateParams): void;
    get weight(): number;
    disconnect(): void;
}

/**
 * Both backends are fixed at five voices because the fm-tier worklet's
 * parameter buffer is laid out for five. Changing this means changing the
 * worklet's stride too.
 */
declare const TIER_VOICE_COUNT = 5;
/**
 * One five-voice FM tier, behind an interface with two implementations.
 *
 * The point is that a caller's update loop is engine-agnostic: write params
 * through the setters, call flush once a frame, and it does not matter whether
 * the voices are a node graph or a worklet. That also makes the two directly
 * A/B-able, which is the only honest way to tell whether the worklet actually
 * sounds better or just different.
 */
interface TierBackend {
    readonly voiceCount: number;
    /** Wire the voice outputs into a bus. Call once, after construction. */
    connect(bus: GainNode): void;
    /**
     * AudioParams a wow/flutter LFO can drive — one per carrier in node mode,
     * a single shared param in worklet mode.
     */
    detuneTargets(): AudioParam[];
    glideTo(voice: number, frequency: number, tau: number): void;
    setIndex(voice: number, index: number, tau: number): void;
    setRatio(voice: number, ratio: number, tau: number): void;
    setGain(voice: number, gain: number, tau: number): void;
    /**
     * `now` is AudioContext.currentTime. NodeTierBackend needs it to cancel
     * automation; WorkletTierBackend ignores it and smooths per-sample.
     */
    setPan(voice: number, pan: number, tau: number, now: number): void;
    setCarrierWave(voice: number, name: string): void;
    /** Push buffered params to the worklet. A no-op on the node backend. */
    flush(): void;
}
interface NodeTierBackendParams {
    audioContext: AudioContext;
    /** Starting modulator ratio for every voice. */
    ratio: number;
    /**
     * Sets a carrier's waveform by name. Supplied by the caller so a shared
     * PeriodicWave cache can be reused rather than rebuilt per voice.
     */
    applyWave: (oscillator: OscillatorNode, name: string) => void;
}
/**
 * The node-graph tier: an FMVoice and a StereoPannerNode per voice. Safe
 * default, and the reference the worklet backend gets compared against.
 */
declare class NodeTierBackend implements TierBackend {
    readonly voiceCount = 5;
    private readonly voices;
    private readonly applyWave;
    constructor({ audioContext, ratio, applyWave }: NodeTierBackendParams);
    connect(bus: GainNode): void;
    detuneTargets(): AudioParam[];
    glideTo(voice: number, frequency: number, tau: number): void;
    setIndex(voice: number, index: number, tau: number): void;
    setRatio(voice: number, ratio: number, tau: number): void;
    setGain(voice: number, gain: number, tau: number): void;
    setPan(voice: number, pan: number, tau: number, now: number): void;
    setCarrierWave(voice: number, name: string): void;
    flush(): void;
}
/**
 * The worklet tier: one fm-tier AudioWorkletNode carrying all five voices.
 *
 * Parameter writes accumulate in a Float32Array and go across in a single
 * postMessage per flush, i.e. once a frame. Posting per setter instead would
 * put dozens of messages a frame on the control bus, and that backs up long
 * before the audio thread does.
 *
 * Requires the fm-tier module to be loaded first — see loadFMTierWorklet.
 */
declare class WorkletTierBackend implements TierBackend {
    readonly voiceCount = 5;
    private readonly node;
    /** [freq, freqTau, index, indexTau, ratio, ratioTau, gain, gainTau, pan, panTau] × 5 */
    private readonly buffer;
    constructor({ audioContext }: {
        audioContext: AudioContext;
    });
    connect(bus: GainNode): void;
    /**
     * A single "detune" param shared by all five voices. Wow and flutter both
     * connect to it and sum, exactly as they do across the five separate
     * carriers in node mode.
     */
    detuneTargets(): AudioParam[];
    glideTo(voice: number, frequency: number, tau: number): void;
    setIndex(voice: number, index: number, tau: number): void;
    setRatio(voice: number, ratio: number, tau: number): void;
    setGain(voice: number, gain: number, tau: number): void;
    setPan(voice: number, pan: number, tau: number, _now: number): void;
    setCarrierWave(voice: number, name: string): void;
    flush(): void;
}

interface LimiterMetrics {
    lufsShort: number;
    gr: number;
}
type LimiterMetricsCallback = (metrics: LimiterMetrics) => void;
/**
 * Load the lookahead-limiter worklet. Returns false rather than throwing so
 * the caller can keep a DynamicsCompressor fallback in place — AudioGraph is
 * built to run either way.
 */
declare function loadLimiterWorklet(audioContext: AudioContext): Promise<boolean>;
/** Load the fm-tier worklet. False means the caller should use NodeTierBackend. */
declare function loadFMTierWorklet(audioContext: AudioContext): Promise<boolean>;
/** Load the ks-string worklet. */
declare function loadKSStringWorklet(audioContext: AudioContext): Promise<boolean>;
/**
 * Create a ks-string node (4-voice Karplus-Strong). Only call this after
 * loadKSStringWorklet resolved true on the same AudioContext.
 */
declare function createKSStringNode(audioContext: AudioContext): AudioWorkletNode;
/**
 * Create the lookahead-limiter node. Only call this after loadLimiterWorklet
 * resolved true on the same AudioContext.
 */
declare function createLimiterNode({ audioContext, onMetrics, }: {
    audioContext: AudioContext;
    /** Receives meter data at roughly 10 Hz. */
    onMetrics?: LimiterMetricsCallback;
}): AudioWorkletNode;

/**
 * Pitch-class to frequency, shared by the layers and the drum-free voices.
 *
 * Pitch class 0 = C, 9 = A. A4 = 440 Hz, so pc 9 at octave 4 is the anchor.
 * This lives here rather than in @amplib/music-theory because it is a raw
 * numeric conversion with no Notation or Scale involved — the layers work in
 * pitch classes coming out of an analyzer, not in named notes.
 */
declare function pitchClassToFrequency(pitchClass: number, octave: number): number;
/**
 * cancelAndHoldAtTime where the browser has it, otherwise cancel and pin the
 * current value. Safari shipped setTargetAtTime long before cancelAndHold, and
 * without the fallback a cancel there resets the param to its default instead
 * of holding — an audible jump rather than a smooth takeover.
 */
declare function cancelParam(param: AudioParam, now: number): void;

export { AudioGraph, type AudioGraphParams, ChromaticWall, type ChromaticWallParams, Clock, DrumMachine, type DrumMachineParams, type DrumPattern, type DrumStep, type DrumStepListener, DrumSynth, type DrumSynthParams, type FMSynthSettings, FMVoice, type FMVoiceParams, type FMVoicePluckParams, type LimiterMetrics, type LimiterMetricsCallback, NodeTierBackend, type NodeTierBackendParams, NoiseLayer, type NoiseLayerParams, type NoiseLayerUpdateParams, PATTERNS, PATTERN_NAMES, type PatternName, ShimmerLayer, type ShimmerLayerParams, type ShimmerLayerUpdateParams, TIER_VOICE_COUNT, type TierBackend, WorkletTierBackend, cancelParam, createKSStringNode, createLimiterNode, loadFMTierWorklet, loadKSStringWorklet, loadLimiterWorklet, pitchClassToFrequency };
