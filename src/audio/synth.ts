/**
 * src/audio/synth.ts  (v0.8)
 *
 * 2-operator FM synthesizer driven by AVVA analysis output.
 *
 *   15 PAD voices  +  3 PLUCK voices  +  1 SUB-BASS oscillator
 *   → per-tier buses (with HP/LP slotting) → AudioGraph master chain
 *
 * Signal routing lives in AudioGraph (graph.ts); Synth owns voice creation
 * and per-frame parameter updates.
 */

import { FMVoice } from "./fm-voice.js";
import { AudioGraph } from "./graph.js";
import { loadWorklets, createLimiterNode } from "./worklet-host.js";
import type { LimiterMetrics } from "./worklet-host.js";
import type { Palette, PaletteSlot } from "../harmony/palette.js";
import type { LegacyConfig } from "../store/legacy-config.js";
import type { AnalysisOut } from "../analysis/analyzer.js";

// ── Constants ─────────────────────────────────────────────────

const TIER_RATIO = [2, 1, 1] as const;

const TIER_BASE_PAN = [
  [-0.45, 0.0, +0.45],
  [-0.42, 0.0, +0.42],
  [-0.7, 0.0, +0.7],
] as const;

const TIER_BASE_PAN_EXT = [
  [+0.32, -0.32],
  [+0.32, -0.32],
  [+0.55, -0.55],
] as const;

const VOICE_DRIFT_SIGN = [0, +1, -1] as const;
const VOICE_GLIDE_SPREAD = [0.88, 1.0, 1.18, 0.94, 1.09] as const;

const N_PLUCKS = 3;

// ── Synth-notes telemetry grid ─────────────────────────────────
// The synth knows exactly which (pitch-class, octave) notes it generates —
// true ground truth, broadcast to the controller's Video panel so it lines up
// against the audio analyzer's *detected* note grid. Octave range mirrors the
// audio analyzer default (audioAnalysis.octL/octH = 2..6) so the two grids
// align cell-for-cell.
export const SYNTH_NOTE_GRID_OCT_L = 2;
export const SYNTH_NOTE_GRID_OCT_H = 6;
const NOTE_GRID_LEN = (SYNTH_NOTE_GRID_OCT_H - SYNTH_NOTE_GRID_OCT_L + 1) * 12;
// Per-voice gains run ~0..0.25; scale into 0..1 for display.
const NOTE_GRID_GAIN_NORM = 4;

// ── Internal types ────────────────────────────────────────────

interface TierVoice {
  fm: FMVoice;
  panner: StereoPannerNode;
  ratioBase: number;
  gain: GainNode;
  osc: OscillatorNode;
}

interface Tier {
  voices: TierVoice[];
}

interface PluckVoice {
  fm: FMVoice;
  panner: StereoPannerNode;
  nextAllowed: number;
}

interface SubBass {
  osc: OscillatorNode;
  gain: GainNode;
}

interface Delay {
  input: GainNode;
  node: DelayNode;
  feedback: GainNode;
  wet: GainNode;
}

interface Tremolo {
  lfo: OscillatorNode;
  depth: GainNode;
}

interface CassetteChain {
  preLP: BiquadFilterNode;
  midBoost: BiquadFilterNode;
  tapeSat: WaveShaperNode;
  satDry: GainNode;
  satWet: GainNode;
  satOut: GainNode;
  tapeDelay: DelayNode;
  tapeDelayFb: GainNode;
  tapeDelayDamp: BiquadFilterNode;
  tapeDelayWet: GainNode;
  reverb: ConvolverNode;
  reverbWet: GainNode;
  noise: AudioBufferSourceNode;
  noiseLP: BiquadFilterNode;
  noiseGain: GainNode;
  noisePan: StereoPannerNode;
  masterLP: BiquadFilterNode;
  wowLfo: OscillatorNode;
  wowDepth: GainNode;
  flutterLfo: OscillatorNode;
  flutterDepth: GainNode;
}

export interface CassetteParams {
  midBoostDb?: number;
  masterLPHz?: number;
  satAmount?: number;
  satWet?: number;
  tapeDelayMs?: number;
  tapeDelayFb?: number;
  tapeDelayWet?: number;
  reverbWet?: number;
  noiseGain?: number;
  wowDepthCents?: number;
  flutterDepthCents?: number;
}

/** A palette note proxy. */
interface NoteProxy {
  triad: { freq: number; name: string }[];
  _palettePrimary: PaletteSlot;
}

/** Observable snapshot of what the synth computed this frame — broadcast to controller. */
export interface SynthControls {
  slotLabel: string;
  slotIndex: number;
  // Voice gate weights (0..1)
  thirdW: number;
  fifthW: number;
  seventhW: number;
  ninthW: number;
  // Tier amplitude contributions (0..1)
  bassW: number;
  midW: number;
  trebleW: number;
  // FM modulation index per tier
  fmIndexBass: number;
  fmIndexMid: number;
  fmIndexTreble: number;
  // Timing
  glideTau: number;
  masterPan: number;
  pluckFired: boolean;
}

// ── Synth ─────────────────────────────────────────────────────

export class Synth {
  private _cfg: LegacyConfig;

  private _graph: AudioGraph | null;
  _cassette: CassetteChain | null;

  private _tiers: Tier[];
  private _plucks: PluckVoice[];
  private _sub: SubBass | null;
  private _delay: Delay | null;
  private _tremolo: Tremolo | null;
  private _workletsLoaded = false;

  /** Called with limiter metrics at ~10 Hz when the worklet limiter is active. */
  onLimiterMetrics: ((m: LimiterMetrics) => void) | null = null;

  // Auto-trim servo: slowly nudges masterTrim toward −16 LUFS when bri is high.
  // Gated so it only corrects on bright scenes, preserving the bri→loudness shape.
  private _autoTrimDb = 0; // accumulated correction, ±6 dB range
  private _lastLufs = -60;
  private _lastMetricsTime = 0;

  palette: Palette | null;
  running: boolean;
  lastNote: { label: string; slotIndex: number; pitchClasses: number[] } | null;
  private _lastControls: SynthControls | null;
  private readonly _noteGrid: Float32Array = new Float32Array(NOTE_GRID_LEN);
  private _prevRootFreq: number;
  private _lastCarrierTypes: string[];
  private _periodicWaves: Map<string, PeriodicWave>;
  private _articulationEnvs: number[];
  private _pulseCounters: number[];
  private _prevNoteKey: string;
  private _lastUpdateTime: number;
  private _masterLPHzBase: number;
  private _tapeDelayDampBase: number;

  constructor(config: LegacyConfig) {
    this._cfg = config;
    this._graph = null;
    this._cassette = null;
    this._tiers = [];
    this._plucks = [];
    this._sub = null;
    this._delay = null;
    this._tremolo = null;
    this.onLimiterMetrics = null;
    this.palette = null;
    this.running = false;
    this.lastNote = null;
    this._lastControls = null;
    this._prevRootFreq = 0;
    this._lastCarrierTypes = ["sine", "sine", "sine", "sine"];
    this._periodicWaves = new Map();
    this._articulationEnvs = [1.0, 1.0, 1.0];
    this._pulseCounters = [0, 0, 0];
    this._prevNoteKey = "";
    this._lastUpdateTime = 0;
    this._masterLPHzBase = 0;
    this._tapeDelayDampBase = 6000;
  }

  // ── Accessors ──────────────────────────────────────────────
  get _actx(): AudioContext | null { return this._graph?.actx ?? null; }
  /** The AudioGraph — use for bus-level control and tap wiring. */
  get graph(): AudioGraph | null { return this._graph; }
  /** Pre-cassette tap node — stage-3 audio analyzer connects here. */
  get analysisTap(): GainNode | null { return this._graph?.analysisTap ?? null; }
  /** Final output node — broadcast and stereo analysis tap from here. */
  get outputNode(): GainNode | null { return this._graph?.output ?? null; }
  /** @deprecated Use analysisTap + outputNode. Kept for transition. */
  get _master(): GainNode | null { return this._graph?.masterTrim ?? null; }
  /** @deprecated Use outputNode. Kept for transition. */
  get _limiter(): GainNode | null { return this._graph?.output ?? null; }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    if (this._graph) {
      this._graph.actx.resume();
      this.running = true;
      return;
    }

    const graph = new AudioGraph();
    this._graph = graph;
    const ac = graph.actx;

    // Apply user gain from config (schema drives this before start())
    graph.setMasterGain(this._cfg.masterGain ?? 0.28);

    // Cassette chain: headroomPad → chain → autoMakeup
    const cassette = this._buildCassetteChain(ac, graph.headroomPad);
    cassette.masterLP.connect(graph.autoMakeup);
    this._cassette = cassette;

    // Sub-bass → subBus
    const subOsc = ac.createOscillator();
    const subGain = ac.createGain();
    subOsc.type = "sine";
    subOsc.frequency.value = 110;
    subGain.gain.value = 0;
    subOsc.connect(subGain);
    subGain.connect(graph.subBus);
    subOsc.start();
    this._sub = { osc: subOsc, gain: subGain };

    // Delay send: tap from analysisTap (pre-cassette), return to autoMakeup
    // (post-cassette). This keeps delay echo from doubling into the cassette.
    const delayInput = ac.createGain();
    delayInput.gain.value = 1.0;
    const delayNode = ac.createDelay(3.0);
    delayNode.delayTime.value = 0.32;
    const delayLpf = ac.createBiquadFilter();
    delayLpf.type = "lowpass";
    delayLpf.frequency.value = 3800;
    const delayFeedback = ac.createGain();
    delayFeedback.gain.value = 0.05;
    const delayWet = ac.createGain();
    delayWet.gain.value = 0;
    graph.analysisTap.connect(delayInput);
    delayInput.connect(delayNode);
    delayNode.connect(delayLpf);
    delayLpf.connect(delayFeedback);
    delayFeedback.connect(delayInput);
    delayLpf.connect(delayWet);
    delayWet.connect(graph.autoMakeup);
    this._delay = {
      input: delayInput,
      node: delayNode,
      feedback: delayFeedback,
      wet: delayWet,
    };

    // Tremolo LFO — modulates graph.tremoloSum.gain so it has its own
    // dedicated AudioParam and doesn't fight bri-dim or user-gain writes.
    const tremoloLfo = ac.createOscillator();
    const tremoloDepth = ac.createGain();
    tremoloLfo.type = "sine";
    tremoloLfo.frequency.value = 6.0;
    tremoloDepth.gain.value = 0;
    tremoloLfo.connect(tremoloDepth);
    tremoloDepth.connect(graph.tremoloSum.gain);
    tremoloLfo.start();
    this._tremolo = { lfo: tremoloLfo, depth: tremoloDepth };

    // Pluck voices → pluckBus
    this._plucks = Array.from({ length: N_PLUCKS }, () => {
      const fm = new FMVoice(ac, ac.createGain(), {
        ratio: this._cfg.fmPluckRatio ?? 2,
        index: 1.0,
      });
      const panner = ac.createStereoPanner();
      panner.pan.value = 0;
      fm.outGain.disconnect();
      fm.outGain.connect(panner);
      panner.connect(graph.pluckBus);
      return { fm, panner, nextAllowed: 0 };
    });

    // Tier buses: bass → bassBus, mid → midBus, treble → trebleBus
    const TIER_BUSES = [graph.bassBus, graph.midBus, graph.trebleBus] as const;
    this._tiers = [];
    for (let ti = 0; ti < 3; ti++) {
      const ratioBase = TIER_RATIO[ti];
      const tierBus = TIER_BUSES[ti];
      const voices: TierVoice[] = [];
      for (let vi = 0; vi < 5; vi++) {
        const fm = new FMVoice(ac, tierBus, {
          ratio: ratioBase,
          index: 0.4,
        });
        const basePan =
          vi < 3 ? TIER_BASE_PAN[ti][vi] : TIER_BASE_PAN_EXT[ti][vi - 3];
        const panner = ac.createStereoPanner();
        panner.pan.value = basePan * 0.25;
        fm.outGain.disconnect();
        fm.outGain.connect(panner);
        panner.connect(tierBus);
        voices.push({
          fm,
          panner,
          ratioBase,
          gain: fm.outGain,
          osc: fm.carrier,
        });
      }
      this._tiers.push({ voices });
    }

    // Connect wow/flutter LFOs to all tier carrier detuners
    for (const { voices } of this._tiers) {
      for (const { osc } of voices) {
        this._cassette!.wowDepth.connect(osc.detune);
        this._cassette!.flutterDepth.connect(osc.detune);
      }
    }

    this.running = true;

    // Activate worklet limiter asynchronously — graph is already producing
    // audio via the safety compressor fallback until the swap completes.
    void this._activateWorkletLimiter();
  }

  /** Update user-controlled master gain (call instead of writing _master.gain directly). */
  setMasterGain(v: number): void {
    this._graph?.setMasterGain(v);
  }

  /** Per-frame bri-dim: scales master down when scene is very dark. */
  setBriDim(bri: number, now: number): void {
    this._graph?.setBriDim(bri, now);
  }

  /**
   * Preload AudioWorklet modules. Call once on page init so the worklet is
   * ready before the user enables the synth. Uses a temporary throwaway
   * AudioContext (to call addModule without starting audio) — actual graph
   * construction happens in start().
   */
  async preloadWorklets(): Promise<void> {
    if (this._workletsLoaded) return;
    // AudioWorklet.addModule() needs an AudioContext, but we can use an
    // OfflineAudioContext for the module load check — the registration is
    // global per-context, but we just need the module code parsed.
    // Simpler: create a minimal suspended AudioContext just for loading.
    const tmp = new AudioContext();
    const ok = await loadWorklets(tmp);
    await tmp.close();
    this._workletsLoaded = ok;
  }

  /** Activate the worklet limiter on the graph's AudioContext. Called
   *  internally after start() creates the graph if preloadWorklets succeeded. */
  private async _activateWorkletLimiter(): Promise<void> {
    const graph = this._graph;
    if (!graph || graph.workletActive) return;
    const ok = await loadWorklets(graph.actx);
    if (!ok || !this._graph) return;
    const node = createLimiterNode(graph.actx, (m) => {
      this._lastLufs = m.lufsShort;
      this._lastMetricsTime = this._graph?.actx.currentTime ?? 0;
      this.onLimiterMetrics?.(m);
    });
    this._graph.swapToWorkletLimiter(node);
  }

  /**
   * Auto-trim servo: called each update() frame. Slowly nudges masterTrim
   * toward −16 LUFS when bri is high (gated so quiet/dark scenes are untouched).
   * Correction range: ±6 dB, τ ≈ 8 s.
   */
  private _runAutoTrim(safeBri: number, dt: number): void {
    if (!this._graph || !this._graph.workletActive) return;
    const TARGET_LUFS = -16;
    const MAX_CORRECTION_DB = 6;
    // Only servo when the scene is bright enough to indicate "should be loud"
    if (safeBri < 0.3) return;
    const error = TARGET_LUFS - this._lastLufs;
    // Servo with τ ≈ 8 s: delta per frame = error * dt / 8
    const delta = error * dt / 8;
    this._autoTrimDb = Math.max(-MAX_CORRECTION_DB,
      Math.min(MAX_CORRECTION_DB, this._autoTrimDb + delta));
    const userGain = this._cfg.masterGain ?? 0.28;
    const corrFactor = Math.pow(10, this._autoTrimDb / 20);
    this._graph.masterTrim.gain.setTargetAtTime(
      Math.max(0, userGain * corrFactor),
      this._graph.actx.currentTime,
      0.5,
    );
  }

  stop(): void {
    if (!this._graph) return;
    this._graph.actx.suspend();
    this.running = false;
    this.lastNote = null;
  }

  setPalette(p: Palette | null): void {
    this.palette = p;
  }

  toggle(): void {
    if (this.running) this.stop();
    else this.start();
  }

  get lastControls(): SynthControls | null {
    return this._lastControls;
  }

  /**
   * Ground-truth grid of the notes the synth is currently generating, indexed
   * (octave - SYNTH_NOTE_GRID_OCT_L) * 12 + pitchClass, value 0..1. Null when
   * the synth is stopped. Recomputed each update().
   */
  get lastNoteGrid(): Float32Array | null {
    return this.running ? this._noteGrid : null;
  }

  /** Fold one generated voice (freq Hz, linear gain) into the note grid. */
  private _addGridNote(freq: number, gain: number): void {
    if (!(freq > 0) || gain <= 0) return;
    // Invert _pcToFreq: semitones above C0 (A4 = pc9 oct4 = 57).
    const abs = 57 + Math.round(12 * Math.log2(freq / 440));
    const octave = Math.floor(abs / 12);
    if (octave < SYNTH_NOTE_GRID_OCT_L || octave > SYNTH_NOTE_GRID_OCT_H) return;
    const pc = ((abs % 12) + 12) % 12;
    const i = (octave - SYNTH_NOTE_GRID_OCT_L) * 12 + pc;
    const v = clamp01(gain * NOTE_GRID_GAIN_NORM);
    if (v > this._noteGrid[i]) this._noteGrid[i] = v;
  }

  // ── Per-frame update ────────────────────────────────────────

  update({
    hue,
    bri,
    flux,
    tilt,
    pos,
    spread,
    sat,
    contrast,
    lo,
  }: AnalysisOut): void {
    const palette = this.palette;
    if (!this.running || !palette || !this._graph) return;
    const graph = this._graph;

    const safeHue = Number.isFinite(hue) ? hue : 0;
    const safeBri = Number.isFinite(bri) ? Math.max(0, bri) : 0;
    const safeFlux = clamp01(flux);
    const safeTilt = Number.isFinite(tilt) ? clamp01(tilt) : 0.5;
    const safePos = Number.isFinite(pos) ? clamp01(pos) : 0.5;
    const safeSpread = clamp01(spread);
    const safeSat = clamp01(sat);
    const safeContrast = clamp01(contrast);
    const safeLo = clamp01(lo);

    // ── Palette chord data ───────────────────────────────────
    const baseOctave = 4;
    const blend = palette.hueToBlend(safeHue);
    const primarySlot = blend[0].slot;
    const secEntry = blend.length > 1 ? blend[1] : null;
    const bf2 = secEntry ? secEntry.weight * 2 : 0;
    const note2: PaletteSlot | null = secEntry ? secEntry.slot : null;
    const pcs = primarySlot.chord.pitchClasses;
    const note: NoteProxy = {
      _palettePrimary: primarySlot,
      triad: _pcsToVoicing(pcs, baseOctave).map((freq) => ({ freq, name: "" })),
    };
    this.lastNote = {
      label: primarySlot.chord.label,
      slotIndex: primarySlot.index,
      pitchClasses: pcs,
    };

    const now = this._actx!.currentTime;
    const tau = Math.max(0.001, this._glideTime(safeFlux) / 3);
    const slowTau = Math.max(0.05, tau * 4);

    // ── Per-tier octave offsets ──────────────────────────────────
    const tierOctaveOffsets = [
      (this._cfg.octaveOffsetBass ?? 3) - 4,
      (this._cfg.octaveOffsetMid ?? 4) - 4,
      (this._cfg.octaveOffsetTreble ?? 5) - 4,
    ] as const;

    // ── Carrier waveforms (per-tier + pluck) ────────────────────────
    const tierCarrierTypes: string[] = [
      this._cfg.carrierTypeBass ?? "sine",
      this._cfg.carrierTypeMid ?? "sine",
      this._cfg.carrierTypeTreble ?? "sine",
    ];
    const pluckCarrierType = this._cfg.carrierTypePluck ?? "sine";
    this._tiers.forEach(({ voices }, ti) => {
      const ct = tierCarrierTypes[ti];
      if (ct !== this._lastCarrierTypes[ti]) {
        this._lastCarrierTypes[ti] = ct;
        for (const { fm } of voices) this._applyCarrierType(fm.carrier, ct);
      }
    });
    if (pluckCarrierType !== this._lastCarrierTypes[3]) {
      this._lastCarrierTypes[3] = pluckCarrierType;
      for (const { fm } of this._plucks)
        this._applyCarrierType(fm.carrier, pluckCarrierType);
    }
    // ── Glide spread ─────────────────────────────────────────────
    const glideSpread = this._cfg.glideSpread ?? 1.0;

    this._panTo(graph.masterPanner.pan, (safePos - 0.5) * 1.4, slowTau, now);

    const vt = safeTilt * 2;
    const trebleW = vt <= 1 ? (1 - vt) * safeBri : 0;
    const midW = (vt <= 1 ? vt : 2 - vt) * safeBri;
    // Bass uses bottom-third brightness directly — vy centroid stays near 0.5
    // in typical scenes so the vy-derived signal barely fires.
    const bassW = safeLo;
    const tierSignals = [bassW, midW, trebleW];

    const thirdW = clamp01((safeSpread - 0.15) / 0.25);
    const fifthW = clamp01((safeSpread - 0.4) / 0.25);
    const voiceWeights = [1.0, thirdW, fifthW];

    const widthScale = 0.25 + safeSpread * (this._cfg.fmStereoWidth ?? 0.75);

    // Constant-power voice normalization: prevents a 5-voice lush chord from
    // being ~2× louder than a 1-voice sparse scene. Compute once from the
    // shared voice weights that apply to all three tiers.
    // seventhW/ninthW weights are computed below but their contribution here
    // uses the same thresholds from sat — approximate with current values.
    const _seventhWApprox = clamp01((safeSat - 0.35) / 0.35);
    const _ninthWApprox = clamp01((safeSat - 0.65) / 0.3);
    const activeVoiceW = 1.0 + thirdW + fifthW + _seventhWApprox * 0.45 + _ninthWApprox * 0.25;
    const cpNorm = 1.0 / Math.sqrt(Math.max(1, activeVoiceW));

    const idxBase = this._cfg.fmIndexBase ?? 0.15;
    const idxScale = this._cfg.fmIndexScale ?? 2.4;
    const tierIndex = [
      idxBase +
        Math.min(1, safeContrast * 1.4 + safeSat * 0.3) * (idxScale * 0.7),
      idxBase + safeSat * idxScale,
      idxBase + safeSat * idxScale * 1.15,
    ];

    const ratioDrift = safeSpread * (this._cfg.fmRatioDrift ?? 0.04);
    const seventhW = clamp01((safeSat - 0.35) / 0.35);
    const ninthW = clamp01((safeSat - 0.65) / 0.3);

    // Per-voice glide time with configurable spread (the tier's tau is
    // resolved per-tier below; this helper just applies the per-voice ratio).
    const _vGlide = (tauForTier: number, vi: number) => {
      const base = VOICE_GLIDE_SPREAD[vi];
      return tauForTier * (1.0 + (base - 1.0) * glideSpread);
    };

    // ── Per-tier glide scaling (multiplies the base glide time) ───
    const tierGlideScales = [
      Math.max(0.05, this._cfg.glideScaleBass ?? 1),
      Math.max(0.05, this._cfg.glideScaleMid ?? 1),
      Math.max(0.05, this._cfg.glideScaleTreble ?? 1),
    ] as const;
    const tierTaus = tierGlideScales.map((s) => Math.max(0.001, tau * s));
    const tierSlowTaus = tierTaus.map((t) => Math.max(0.05, t * 4));

    // ── Per-tier articulation + pulse rate ─────────────────────────
    const tierArticulations = [
      clamp01(this._cfg.articulationBass ?? 0),
      clamp01(this._cfg.articulationMid ?? 0),
      clamp01(this._cfg.articulationTreble ?? 0),
    ];
    const tierPulseRates = [
      Math.max(0, this._cfg.pulseRateBass ?? 0),
      Math.max(0, this._cfg.pulseRateMid ?? 0),
      Math.max(0, this._cfg.pulseRateTreble ?? 0),
    ];

    const dt = this._lastUpdateTime > 0 ? now - this._lastUpdateTime : 0;
    this._lastUpdateTime = now;

    const noteKey = String(note._palettePrimary.index);
    const chordChanged = noteKey !== this._prevNoteKey;
    this._prevNoteKey = noteKey;

    // Per-tier pulse fire (each tier maintains its own counter so tiers can
    // pulse at independent tempos).
    const tierPulseFires = [false, false, false];
    if (dt > 0 && dt < 0.5) {
      for (let ti = 0; ti < 3; ti++) {
        const rate = tierPulseRates[ti];
        if (rate <= 0) continue;
        const prev = this._pulseCounters[ti];
        this._pulseCounters[ti] += dt * rate;
        tierPulseFires[ti] =
          Math.floor(this._pulseCounters[ti]) > Math.floor(prev);
      }
    }

    // Per-tier articulation envelope decay. retrigger sources: chord change
    // (global, snaps every voice) or that tier's own pulse fire.
    for (let ti = 0; ti < 3; ti++) {
      const articulation = tierArticulations[ti];
      const retrigger = chordChanged || tierPulseFires[ti];
      if (retrigger) {
        this._articulationEnvs[ti] = 1.0;
      } else if (dt > 0 && dt < 0.5 && articulation > 0) {
        const decayTau = 2.0 + (0.05 - 2.0) * articulation;
        this._articulationEnvs[ti] *= Math.exp(-dt / decayTau);
      }
    }

    // Rebuild the ground-truth note grid from this frame's generated voices.
    this._noteGrid.fill(0);

    this._tiers.forEach(({ voices }, ti) => {
      const octaveShift = tierOctaveOffsets[ti];
      const freqScale = Math.pow(2, octaveShift);
      const articulation = tierArticulations[ti];
      const tierTau = tierTaus[ti];
      const tierSlowTau = tierSlowTaus[ti];
      const tierPitchTau = chordChanged ? 0.05 : tierTau;
      const artEnv = articulation > 0 ? this._articulationEnvs[ti] : 1.0;
      const tierBase =
        Math.max(0, tierSignals[ti] * 0.25) *
        artEnv *
        this._waveGainComp(tierCarrierTypes[ti]) *
        cpNorm;

      voices.forEach(({ fm, panner, ratioBase }, vi) => {
        if (vi < 3) {
          // Triad voices: root (0), 3rd (1), 5th (2) — fold with modulo on short chords
          let targetFreq: number;
          const nPCs = note.triad.length;
          targetFreq = note.triad[vi % nPCs].freq * freqScale;
          if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
            fm.setGain(0, tierTau);
            return;
          }

          // Mid-tier 5th voice-leading
          if (ti === 1 && vi === 2 && this._prevRootFreq > 0) {
            const fcDrop = targetFreq * 0.5;
            const logPrev = Math.log2(this._prevRootFreq);
            if (
              Math.abs(Math.log2(fcDrop) - logPrev) <
              Math.abs(Math.log2(targetFreq) - logPrev)
            ) {
              targetFreq = fcDrop;
            }
          }

          fm.glideTo(targetFreq, chordChanged ? tierPitchTau : _vGlide(tierTau, vi));
          const triadGain =
            tierBase *
            voiceWeights[vi] *
            (1 - bf2) *
            (note._palettePrimary.gain ?? 1);
          fm.setGain(triadGain, tierTau);
          this._addGridNote(targetFreq, triadGain);
          fm.setIndex(tierIndex[ti], tierSlowTau);
          const bassExtraDrift = ti === 0 ? 0.02 : 0;
          const targetRatio =
            ratioBase + (ratioDrift + bassExtraDrift) * VOICE_DRIFT_SIGN[vi];
          fm.setRatio(targetRatio, tierSlowTau);
          const targetPan = TIER_BASE_PAN[ti][vi] * widthScale;
          this._panTo(panner.pan, targetPan, tierSlowTau, now);
        } else {
          // Extension voices: 7th (vi=3), 9th (vi=4)
          const ei = vi - 3;
          {
            const pcs = note._palettePrimary.chord.pitchClasses;
            const secSlot = note2;
            let handled = false;

            if (secSlot && bf2 > 0.04) {
              const secPCs = secSlot.chord.pitchClasses;
              const si = ei === 0 ? 0 : Math.min(2, secPCs.length - 1);
              if (si < secPCs.length) {
                const sf = _pcToFreq(secPCs[si], baseOctave + octaveShift);
                fm.glideTo(sf, chordChanged ? tierPitchTau : _vGlide(tierTau, vi));
                const sg =
                  tierBase * voiceWeights[[0, 2][ei]] * bf2 * (secSlot.gain ?? 1);
                fm.setGain(sg, tierTau);
                this._addGridNote(sf, sg);
                fm.setIndex(tierIndex[ti] * 0.65, tierSlowTau);
                fm.setRatio(ratioBase, tierSlowTau);
                handled = true;
              }
            }
            if (!handled) {
              const xi = 3 + ei;
              if (xi < pcs.length) {
                const ef = _pcToFreq(pcs[xi], baseOctave + octaveShift);
                fm.glideTo(ef, chordChanged ? tierPitchTau : _vGlide(tierTau, vi));
                const xg =
                  tierBase * (ei === 0 ? seventhW * 0.45 : ninthW * 0.25);
                fm.setGain(xg, tierTau);
                this._addGridNote(ef, xg);
                fm.setIndex(tierIndex[ti] * (0.75 - ei * 0.15), tierSlowTau);
                fm.setRatio(ratioBase, tierSlowTau);
                handled = true;
              }
            }
            if (!handled) fm.setGain(0, tierTau);
          }
          const extPan = TIER_BASE_PAN_EXT[ti][ei] * widthScale;
          this._panTo(panner.pan, extPan, tierSlowTau, now);
        }
      });
    });

    this._prevRootFreq = _pcToFreq(
      note._palettePrimary.chord.pitchClasses[0],
      baseOctave,
    );

    this._maybePluck(
      note,
      safeFlux,
      safeSpread,
      widthScale,
      now,
      safePos,
      safeContrast,
    );

    const dlFeedback = clamp01(safeFlux * 0.4 + 0.05);
    const dlWet = safeFlux * 0.25;
    this._delay!.feedback.gain.setTargetAtTime(dlFeedback, now, slowTau);
    this._delay!.wet.gain.setTargetAtTime(dlWet, now, slowTau);

    this._tremolo!.depth.gain.setTargetAtTime(safeFlux * 0.12, now, slowTau);
    this._tremolo!.lfo.frequency.setTargetAtTime(5 + safeFlux * 4, now, slowTau);

    // Dynamic filters: tilt drives masterLP (±1.5 oct), contrast drives tape echo brightness
    if (this._cassette) {
      if (this._masterLPHzBase > 0) {
        const masterLPTarget = Math.max(120, Math.min(20000,
          this._masterLPHzBase * Math.pow(2, (safeTilt - 0.5) * 3),
        ));
        this._cassette.masterLP.frequency.setTargetAtTime(masterLPTarget, now, slowTau);
      }
      const dampTarget = Math.max(800, Math.min(14000,
        this._tapeDelayDampBase * Math.pow(2, (safeContrast - 0.5) * 2),
      ));
      this._cassette.tapeDelayDamp.frequency.setTargetAtTime(dampTarget, now, slowTau);
      // Noise panner carries stereo position through the cassette layer
      this._cassette.noisePan.pan.setTargetAtTime((safePos - 0.5) * 0.6, now, slowTau);
    }

    const subFreq = _pcToFreq(
      note._palettePrimary.chord.pitchClasses[0],
      baseOctave - 2,
    );
    if (Number.isFinite(subFreq) && subFreq > 0) {
      // Sub osc lives in the bass tier conceptually, so it inherits bass's
      // glide scaling. Snap on chord change so the sub never drags.
      const subPitchTau = chordChanged ? 0.05 : tierTaus[0];
      this._cancelParam(this._sub!.osc.frequency, now);
      this._sub!.osc.frequency.setTargetAtTime(subFreq, now, subPitchTau);
    }
    this._cancelParam(this._sub!.gain.gain, now);
    this._sub!.gain.gain.setTargetAtTime(safeLo * 0.15, now, tierTaus[0]);
    this._addGridNote(subFreq, safeLo * 0.15);

    this._lastControls = {
      slotLabel: primarySlot.chord.label,
      slotIndex: primarySlot.index,
      thirdW,
      fifthW,
      seventhW,
      ninthW,
      bassW,
      midW,
      trebleW,
      fmIndexBass: tierIndex[0],
      fmIndexMid: tierIndex[1],
      fmIndexTreble: tierIndex[2],
      glideTau: tau,
      masterPan: (safePos - 0.5) * 1.4,
      pluckFired: false,
    };

    this._runAutoTrim(safeBri, dt);
  }

  // ── Private — pluck ─────────────────────────────────────────

  private _maybePluck(
    note: NoteProxy,
    flux: number,
    spread: number,
    widthScale: number,
    now: number,
    pos: number,
    contrast: number,
  ): void {
    if (!this._plucks.length) return;
    const pluck = this._plucks.reduce((best, v) =>
      v.nextAllowed < best.nextAllowed ? v : best,
    );
    if (now < pluck.nextAllowed) return;

    // Plucks have their own dedicated knob: flux sensitivity. Replaces the
    // old pad-articulation coupling — pluck triggering is now independent of
    // the pad tiers' percussiveness. 0 = silent, 1 = default, higher = more
    // frequent plucks at any flux level.
    const fluxSens = Math.max(0, this._cfg.pluckFluxSensitivity ?? 1);
    if (fluxSens <= 0) return;
    const pluckGainComp = this._waveGainComp(
      this._cfg.carrierTypePluck ?? "sine",
    );
    const trigProb = Math.min(1, flux * 0.5 * (1 + fluxSens * 3));
    if (Math.random() > trigProb) return;

    const spacious = 1 - flux;
    const peak = (0.04 + flux * 0.16) * pluckGainComp;
    const attackTau = 0.014 - flux * 0.011;
    const baseDecay = 0.06 + flux * 0.4;
    const ampDecayTau =
      baseDecay * (1 + spacious * 1.8) +
      Math.random() * (0.05 + flux * 0.12);
    const indexPeak = Math.min(
      1.0,
      (0.25 + flux * 0.75) * (1 - flux * 0.3) * (0.5 + contrast * 0.5),
    );
    const modDecayTau = ampDecayTau * (0.04 + flux * 0.14);

    let fc: number, pluckPan: number;
    const pluckAbsoluteOctave = this._cfg.octaveOffsetPluck ?? 5;

    if (this.palette) {
      const pcs = note._palettePrimary.chord.pitchClasses;
      const nUnlocked = Math.max(1, Math.round(1 + spread * (pcs.length - 1)));
      const chosenIdx = Math.floor(Math.random() * nUnlocked);
      fc = _pcToFreq(pcs[chosenIdx], pluckAbsoluteOctave + Math.round(1 - flux * 2));
      const pcFrac = pcs.length > 1 ? chosenIdx / (pcs.length - 1) : 0.5;
      pluckPan =
        (pcFrac - 0.5) * 2 * widthScale * (0.35 + spacious * 1.1) +
        (pos - 0.5) * 0.8;
    } else {
      return;
    }

    if (!Number.isFinite(fc) || fc <= 0) return;

    pluck.fm.pluck(fc, {
      peak,
      ampDecayTau,
      modDecayTau,
      indexPeak,
      attackTau,
    });
    this._panTo(
      pluck.panner.pan,
      Math.max(-1, Math.min(1, pluckPan)),
      0.04,
      now,
    );

    pluck.nextAllowed =
      now +
      (0.06 + spacious * 0.5 + flux * 0.25) /
        Math.max(0.25, 0.5 + fluxSens);
  }

  // ── Helpers ─────────────────────────────────────────────────

  // Gain compensation so all waveforms have similar perceived loudness.
  private _waveGainComp(name: string): number {
    switch (name) {
      case "triangle":
        return 0.92;
      case "square":
        return 0.56;
      case "sawtooth":
        return 0.65;
      case "pwm":
        return 0.62;
      case "organ":
        return 0.78;
      case "softsaw":
        return 0.7;
      case "softsquare":
        return 0.72;
      case "softtri":
        return 0.95;
      case "chip":
        return 0.6;
      case "pulse12":
        return 0.58;
      case "reed":
        return 0.78;
      case "vox":
        return 0.7;
      case "bell":
        return 0.72;
      case "brass":
        return 0.68;
      default:
        return 1.0; // sine
    }
  }

  // Build (and cache) a PeriodicWave for custom waveform types.
  private _getOrBuildWave(name: string): PeriodicWave {
    if (this._periodicWaves.has(name)) return this._periodicWaves.get(name)!;
    const N = 32;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    if (name === "softsaw") {
      // Sawtooth with 1/n² harmonic rolloff — warm, analogue-rounded
      for (let n = 1; n < N; n++) {
        imag[n] = ((2 / Math.PI) * (n % 2 === 0 ? -1 : 1)) / (n * n);
      }
    } else if (name === "softsquare") {
      // Square with 1/n² rolloff on odd harmonics — mellow, hollow but rounded
      for (let n = 1; n < N; n += 2) {
        imag[n] = (4 / Math.PI) / (n * n);
      }
    } else if (name === "softtri") {
      // Triangle with extra 1/n⁴ rolloff — near-sine with a hint of body
      for (let n = 1; n < N; n += 2) {
        const sign = ((n - 1) / 2) % 2 === 0 ? 1 : -1;
        imag[n] = (sign * (8 / (Math.PI * Math.PI))) / (n * n * n * n);
      }
    } else if (name === "pwm") {
      // 25% duty-cycle pulse — nasal, hollow, cutting
      const d = 0.25;
      for (let n = 1; n < N; n++) {
        real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
      }
    } else if (name === "pulse12") {
      // 12.5% duty-cycle pulse — thin, nasal, classic chiptune lead
      const d = 0.125;
      for (let n = 1; n < N; n++) {
        real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
      }
    } else if (name === "chip") {
      // 8-bit-style square: hard 50% pulse, harmonics cut off after the 9th —
      // produces that crunchy, band-limited NES buzz.
      const maxN = 9;
      for (let n = 1; n <= maxN && n < N; n += 2) {
        imag[n] = (4 / Math.PI) / n;
      }
    } else if (name === "organ") {
      // Hammond-style drawbar blend: partials 1, 2, 3, 4, 6
      imag[1] = 1.0;
      imag[2] = 0.8;
      imag[3] = 0.5;
      imag[4] = 0.35;
      imag[6] = 0.15;
    } else if (name === "reed") {
      // Clarinet-ish: odd harmonics, gentle descending energy — woody, hollow
      const weights = [1.0, 0.75, 0.5, 0.28, 0.15, 0.08, 0.04];
      for (let k = 0; k < weights.length; k++) {
        const n = 2 * k + 1;
        if (n < N) imag[n] = weights[k];
      }
    } else if (name === "vox") {
      // Vocal/formant blend: low formant around partials 2-3, upper around 8-10.
      // Sounds like a soft "ahh"/"ohh" pad.
      imag[1] = 0.7;
      imag[2] = 1.0;
      imag[3] = 0.85;
      imag[4] = 0.4;
      imag[5] = 0.2;
      imag[6] = 0.15;
      imag[7] = 0.3;
      imag[8] = 0.55;
      imag[9] = 0.45;
      imag[10] = 0.25;
      imag[11] = 0.12;
    } else if (name === "bell") {
      // Bell/tine-like: emphasize 1st, 3rd, 6th, 10th partials; suppress evens
      // adjacent to them — chimey and metallic within harmonic constraints.
      imag[1] = 1.0;
      imag[3] = 0.7;
      imag[5] = 0.18;
      imag[6] = 0.55;
      imag[10] = 0.35;
      imag[14] = 0.18;
    } else if (name === "brass") {
      // Saw-like spectrum with a formant lift around partials 3-5 — bright,
      // tonal, and a little aggressive without being harsh.
      for (let n = 1; n < N; n++) {
        const base = 1 / n;
        const formant = Math.exp(-Math.pow((n - 4) / 2.2, 2)) * 0.6;
        imag[n] = (n % 2 === 0 ? -base : base) * (0.55 + formant);
      }
    }
    const wave = this._actx!.createPeriodicWave(real, imag, {
      disableNormalization: false,
    });
    this._periodicWaves.set(name, wave);
    return wave;
  }

  // Apply a carrier wave by name — native OscillatorType or PeriodicWave.
  private _applyCarrierType(osc: OscillatorNode, name: string): void {
    if (
      name === "sine" ||
      name === "triangle" ||
      name === "square" ||
      name === "sawtooth"
    ) {
      osc.type = name as OscillatorType;
    } else {
      osc.setPeriodicWave(this._getOrBuildWave(name));
    }
  }

  private _panTo(
    param: AudioParam,
    value: number,
    tau: number,
    now: number,
  ): void {
    if (!Number.isFinite(value)) return;
    const v = Math.max(-1, Math.min(1, value));
    this._cancelParam(param, now);
    param.setTargetAtTime(v, now, tau);
  }

  private _cancelParam(param: AudioParam, now: number): void {
    type ExtParam = AudioParam & {
      cancelAndHoldAtTime?: (t: number) => AudioParam;
    };
    if (typeof (param as ExtParam).cancelAndHoldAtTime === "function") {
      (param as ExtParam).cancelAndHoldAtTime!(now);
    } else {
      const v = param.value;
      param.cancelScheduledValues(0);
      param.setValueAtTime(v, now);
    }
  }

  private _glideTime(act: number): number {
    const min = this._cfg.glideMin ?? 0.05;
    const max = this._cfg.glideMax ?? 3.0;
    const a = clamp01(act);
    return max * Math.pow(min / max, a);
  }

  // ── Cassette effects ────────────────────────────────────────

  private static _makeTapeSat(
    actx: AudioContext,
    amount: number,
  ): WaveShaperNode {
    const ws = actx.createWaveShaper();
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(x * Math.max(0.01, amount));
    }
    ws.curve = curve;
    ws.oversample = "4x";
    return ws;
  }

  private _buildCassetteChain(
    actx: AudioContext,
    input: AudioNode,
  ): CassetteChain {
    // Pre-LP: shave extreme highs before the saturation stage
    const preLP = actx.createBiquadFilter();
    preLP.type = "lowpass";
    preLP.frequency.value = 10000;
    preLP.Q.value = 0.7;

    // Mid-presence boost: adds cassette body/crunch around 1.2 kHz
    // Q widened to 1.4 (from 0.9) so the boost is gentler and less prone to
    // mud-stacking at high levels.
    const midBoost = actx.createBiquadFilter();
    midBoost.type = "peaking";
    midBoost.frequency.value = 1200;
    midBoost.gain.value = 3;
    midBoost.Q.value = 1.4;

    // Parallel tape saturation (dry/wet blend so clean transients survive)
    const tapeSat = Synth._makeTapeSat(actx, 8);
    const satDry = actx.createGain();
    const satWet = actx.createGain();
    const satOut = actx.createGain();
    satDry.gain.value = 0.6;
    satWet.gain.value = 0.4;
    midBoost.connect(satDry);
    midBoost.connect(tapeSat);
    tapeSat.connect(satWet);
    satDry.connect(satOut);
    satWet.connect(satOut);

    // Short tape delay: 120 ms slapback echo with a damped feedback loop
    const tapeDelay = actx.createDelay(1.0);
    tapeDelay.delayTime.value = 0.12;
    const tapeDelayFb = actx.createGain();
    tapeDelayFb.gain.value = 0.22;
    const tapeDelayDamp = actx.createBiquadFilter();
    tapeDelayDamp.type = "lowpass";
    tapeDelayDamp.frequency.value = 6000;
    const tapeDelayWet = actx.createGain();
    tapeDelayWet.gain.value = 0.18;
    satOut.connect(tapeDelay);
    tapeDelay.connect(tapeDelayDamp);
    tapeDelayDamp.connect(tapeDelayFb);
    tapeDelayFb.connect(tapeDelay); // feedback loop
    tapeDelayDamp.connect(tapeDelayWet);

    // Pre-reverb mix (dry + delayed signal)
    const preReverbMix = actx.createGain();
    satOut.connect(preReverbMix);
    tapeDelayWet.connect(preReverbMix);

    // Small warm reverb via generated exponential-decay IR
    const reverb = actx.createConvolver();
    const irLen = Math.floor(actx.sampleRate * 0.9);
    const irBuf = actx.createBuffer(2, irLen, actx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = irBuf.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3) * 0.25;
      }
    }
    reverb.buffer = irBuf;
    const reverbWet = actx.createGain();
    reverbWet.gain.value = 0.1;
    preReverbMix.connect(reverb);
    reverb.connect(reverbWet);

    // Final dry+reverb mix
    const finalMix = actx.createGain();
    preReverbMix.connect(finalMix);
    reverbWet.connect(finalMix);

    // Cassette hiss: bandlimited noise looped from a 2-second buffer
    const hissBuf = actx.createBuffer(1, 2 * actx.sampleRate, actx.sampleRate);
    const hissData = hissBuf.getChannelData(0);
    for (let i = 0; i < hissData.length; i++) {
      hissData[i] = (Math.random() * 2 - 1) * 0.5;
    }
    const noise = actx.createBufferSource();
    noise.buffer = hissBuf;
    noise.loop = true;
    const noiseLP = actx.createBiquadFilter();
    noiseLP.type = "lowpass";
    noiseLP.frequency.value = 7000;
    const noiseGain = actx.createGain();
    noiseGain.gain.value = 0.015;
    const noisePan = actx.createStereoPanner();
    noisePan.pan.value = 0;
    noise.connect(noiseLP);
    noiseLP.connect(noiseGain);
    noiseGain.connect(noisePan);
    noisePan.connect(finalMix);
    noise.start();

    // Master LP: final cassette bandwidth roll-off
    const masterLP = actx.createBiquadFilter();
    masterLP.type = "lowpass";
    masterLP.frequency.value = 12000;
    finalMix.connect(masterLP);

    // Wow LFO: slow pitch drift (±6 cents, 0.35 Hz)
    const wowLfo = actx.createOscillator();
    const wowDepth = actx.createGain();
    wowLfo.type = "sine";
    wowLfo.frequency.value = 0.35;
    wowDepth.gain.value = 6;
    wowLfo.connect(wowDepth);
    wowLfo.start();

    // Flutter LFO: fast pitch instability (±1.5 cents, 4.5 Hz)
    const flutterLfo = actx.createOscillator();
    const flutterDepth = actx.createGain();
    flutterLfo.type = "sine";
    flutterLfo.frequency.value = 4.5;
    flutterDepth.gain.value = 1.5;
    flutterLfo.connect(flutterDepth);
    flutterLfo.start();

    // Wire input through the chain
    input.connect(preLP);
    preLP.connect(midBoost);
    // midBoost continues through satDry/satWet paths defined above

    return {
      preLP,
      midBoost,
      tapeSat,
      satDry,
      satWet,
      satOut,
      tapeDelay,
      tapeDelayFb,
      tapeDelayDamp,
      tapeDelayWet,
      reverb,
      reverbWet,
      noise,
      noiseLP,
      noiseGain,
      noisePan,
      masterLP,
      wowLfo,
      wowDepth,
      flutterLfo,
      flutterDepth,
    };
  }

  /** Live-update cassette parameters. Uses setTargetAtTime for smooth transitions. */
  setCassetteParams(p: CassetteParams): void {
    const c = this._cassette;
    const ac = this._graph?.actx;
    if (!c || !ac) return;
    const now = ac.currentTime;
    const tau = 0.05;

    if (p.midBoostDb !== undefined)
      c.midBoost.gain.setTargetAtTime(p.midBoostDb, now, tau);
    if (p.masterLPHz !== undefined) this._masterLPHzBase = p.masterLPHz;
    if (p.satWet !== undefined) {
      const wet = Math.max(0, Math.min(1, p.satWet));
      c.satWet.gain.setTargetAtTime(wet, now, tau);
      c.satDry.gain.setTargetAtTime(1 - wet, now, tau);
    }
    if (p.satAmount !== undefined) {
      // Brief fade-out on satWet to reduce the click from node-swap, then restore.
      const newSat = Synth._makeTapeSat(ac, p.satAmount);
      c.satWet.gain.setTargetAtTime(0, now, 0.01);
      setTimeout(() => {
        if (!this._cassette) return;
        try { c.tapeSat.disconnect(); } catch { /* no-op */ }
        c.midBoost.connect(newSat);
        newSat.connect(c.satWet);
        (c as { tapeSat: WaveShaperNode }).tapeSat = newSat;
        const wetTarget = Math.max(0, Math.min(1, p.satWet ?? c.satWet.gain.value));
        c.satWet.gain.setTargetAtTime(wetTarget, ac.currentTime, 0.03);
      }, 30);
    }
    if (p.tapeDelayMs !== undefined)
      c.tapeDelay.delayTime.setTargetAtTime(p.tapeDelayMs / 1000, now, tau);
    if (p.tapeDelayFb !== undefined)
      c.tapeDelayFb.gain.setTargetAtTime(p.tapeDelayFb, now, tau);
    if (p.tapeDelayWet !== undefined)
      c.tapeDelayWet.gain.setTargetAtTime(p.tapeDelayWet, now, tau);
    if (p.reverbWet !== undefined)
      c.reverbWet.gain.setTargetAtTime(p.reverbWet, now, tau);
    if (p.noiseGain !== undefined)
      c.noiseGain.gain.setTargetAtTime(p.noiseGain, now, tau);
    if (p.wowDepthCents !== undefined)
      c.wowDepth.gain.setTargetAtTime(p.wowDepthCents, now, tau);
    if (p.flutterDepthCents !== undefined)
      c.flutterDepth.gain.setTargetAtTime(p.flutterDepthCents, now, tau);

    // Update auto-makeup whenever gain-affecting params change
    if (p.satAmount !== undefined || p.satWet !== undefined || p.midBoostDb !== undefined) {
      const satAmount = p.satAmount ?? 8;
      const satWet = p.satWet ?? c.satWet.gain.value;
      const midBoostDb = p.midBoostDb !== undefined ? p.midBoostDb : c.midBoost.gain.value;
      this._graph?.updateAutoMakeup(satAmount, satWet, midBoostDb);
    }
  }
}

// ── Module helpers ────────────────────────────────────────────

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function _pcToFreq(pc: number, octave: number): number {
  return 440 * Math.pow(2, (pc - 9 + (octave - 4) * 12) / 12);
}

// Build a close-voiced frequency array from pitch classes in user-defined order.
// Each note is placed in the lowest octave that puts it strictly above the previous
// note, so "GBD" → G4, B4, D5 (not D4, G4, B4 which the old ascending-sort produced).
function _pcsToVoicing(pcs: number[], rootOctave: number): number[] {
  const freqs: number[] = [];
  for (let i = 0; i < pcs.length; i++) {
    if (i === 0) {
      freqs.push(_pcToFreq(pcs[i], rootOctave));
    } else {
      const prev = freqs[i - 1];
      let oct = rootOctave - 1;
      let f = _pcToFreq(pcs[i], oct);
      while (f <= prev && oct < rootOctave + 5) {
        oct++;
        f = _pcToFreq(pcs[i], oct);
      }
      freqs.push(f);
    }
  }
  return freqs;
}
