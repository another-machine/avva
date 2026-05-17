/**
 * src/audio/synth.ts  (v0.7)
 *
 * 2-operator FM synthesizer driven by AVVA analysis output.
 *
 *   15 PAD voices  +  3 PLUCK voices  +  1 SUB-BASS oscillator
 *   → per-voice panners → master gain → delay send → compressor
 *
 * See legacy synth.js for full architecture comments.
 */

import { FMVoice } from "./fm-voice.js";
import type { Key, DegreeInfo, HueToNoteResult } from "../harmony/music.js";
import type { Palette, PaletteSlot } from "../harmony/palette.js";
import type { LegacyConfig } from "../store/legacy-config.js";

// ── Constants ─────────────────────────────────────────────────

const TIER_RATIO = [2, 1, 1] as const;

const TIER_BASE_PAN = [
  [-0.18, 0.0, +0.18],
  [-0.42, 0.0, +0.42],
  [-0.7, 0.0, +0.7],
] as const;

const TIER_BASE_PAN_EXT = [
  [+0.12, -0.12],
  [+0.32, -0.32],
  [+0.55, -0.55],
] as const;

const VOICE_DRIFT_SIGN = [0, +1, -1] as const;
const VOICE_GLIDE_SPREAD = [0.88, 1.0, 1.18, 0.94, 1.09] as const;

const N_PLUCKS = 3;

// ── Internal types ────────────────────────────────────────────

interface TierVoice {
  fm: FMVoice;
  panner: StereoPannerNode;
  ratioBase: number;
  gain: GainNode;
  osc: OscillatorNode;
}

interface Tier {
  octaveShift: number;
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

/** A note-like proxy that works for both Key and Palette mode. */
interface NoteProxy {
  degree: number;
  triad: { freq: number; name: string }[];
  _palettePrimary?: PaletteSlot;
  _paletteBf2?: number;
}

export interface AnalysisSnapshot {
  hue: number;
  bri: number;
  act: number;
  actBg?: number;
  actEdge?: number;
  vy?: number;
  spread?: number;
  sat?: number;
  contrast?: number;
  dContrast?: number;
  lo?: number;
  histBins?: Float32Array | null;
  mx?: number;
  my?: number;
  vmx?: number;
  vmy?: number;
  sx?: number;
  sy?: number;
  mass?: number;
}

// ── Synth ─────────────────────────────────────────────────────

export class Synth {
  private _cfg: LegacyConfig;

  _actx: AudioContext | null;
  _master: GainNode | null;

  private _tiers: Tier[];
  private _plucks: PluckVoice[];
  private _sub: SubBass | null;
  private _delay: Delay | null;
  private _tremolo: Tremolo | null;
  private _masterPanner: StereoPannerNode | null;
  private _limiter: WaveShaperNode | null;

  key: Key | null;
  palette: Palette | null;
  running: boolean;
  private _prevRootFreq: number;

  constructor(config: LegacyConfig) {
    this._cfg = config;
    this._actx = null;
    this._master = null;
    this._tiers = [];
    this._plucks = [];
    this._sub = null;
    this._delay = null;
    this._tremolo = null;
    this._masterPanner = null;
    this._limiter = null;
    this.key = null;
    this.palette = null;
    this.running = false;
    this._prevRootFreq = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    if (this._actx) {
      this._actx.resume();
      this.running = true;
      return;
    }

    this._actx = new AudioContext();

    const comp = this._actx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 6;
    comp.attack.value = 0.001;
    comp.release.value = 0.25;

    this._master = this._actx.createGain();
    this._master.gain.value = this._cfg.masterGain ?? 0.28;
    this._master.connect(comp);

    const masterPanner = this._actx.createStereoPanner();
    masterPanner.pan.value = 0;
    comp.connect(masterPanner);
    this._masterPanner = masterPanner;

    const limiter = this._actx.createWaveShaper();
    const N = 2048;
    const curve = new Float32Array(N);
    const drive = 1.5;
    const norm = Math.tanh(drive);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / norm;
    }
    limiter.curve = curve;
    limiter.oversample = "4x";
    masterPanner.connect(limiter);
    limiter.connect(this._actx.destination);
    this._limiter = limiter;

    // Sub-bass
    const subOsc = this._actx.createOscillator();
    const subGain = this._actx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.value = 110;
    subGain.gain.value = 0;
    subOsc.connect(subGain);
    subGain.connect(this._master);
    subOsc.start();
    this._sub = { osc: subOsc, gain: subGain };

    // Delay send
    const delayInput = this._actx.createGain();
    delayInput.gain.value = 1.0;
    const delayNode = this._actx.createDelay(3.0);
    delayNode.delayTime.value = 0.32;
    const delayLpf = this._actx.createBiquadFilter();
    delayLpf.type = "lowpass";
    delayLpf.frequency.value = 3800;
    const delayFeedback = this._actx.createGain();
    delayFeedback.gain.value = 0.05;
    const delayWet = this._actx.createGain();
    delayWet.gain.value = 0;
    this._master.connect(delayInput);
    delayInput.connect(delayNode);
    delayNode.connect(delayLpf);
    delayLpf.connect(delayFeedback);
    delayFeedback.connect(delayInput);
    delayLpf.connect(delayWet);
    delayWet.connect(comp);
    this._delay = {
      input: delayInput,
      node: delayNode,
      feedback: delayFeedback,
      wet: delayWet,
    };

    // Tremolo LFO
    const tremoloLfo = this._actx.createOscillator();
    const tremoloDepth = this._actx.createGain();
    tremoloLfo.type = "sine";
    tremoloLfo.frequency.value = 6.0;
    tremoloDepth.gain.value = 0;
    tremoloLfo.connect(tremoloDepth);
    tremoloDepth.connect(this._master.gain);
    tremoloLfo.start();
    this._tremolo = { lfo: tremoloLfo, depth: tremoloDepth };

    // Pluck voices
    this._plucks = Array.from({ length: N_PLUCKS }, () => {
      const fm = new FMVoice(this._actx!, this._actx!.createGain(), {
        ratio: this._cfg.fmPluckRatio ?? 2,
        index: 1.0,
      });
      const panner = this._actx!.createStereoPanner();
      panner.pan.value = 0;
      fm.outGain.disconnect();
      fm.outGain.connect(panner);
      panner.connect(this._master!);
      return { fm, panner, nextAllowed: 0 };
    });

    // Tier pad voices
    this._tiers = [];
    for (let ti = 0; ti < 3; ti++) {
      const octaveShift = ti - 1;
      const ratioBase = TIER_RATIO[ti];
      const voices: TierVoice[] = [];
      for (let vi = 0; vi < 5; vi++) {
        const fm = new FMVoice(this._actx, this._master, {
          ratio: ratioBase,
          index: 0.4,
        });
        const basePan =
          vi < 3 ? TIER_BASE_PAN[ti][vi] : TIER_BASE_PAN_EXT[ti][vi - 3];
        const panner = this._actx.createStereoPanner();
        panner.pan.value = basePan * 0.25;
        fm.outGain.disconnect();
        fm.outGain.connect(panner);
        panner.connect(this._master);
        voices.push({
          fm,
          panner,
          ratioBase,
          gain: fm.outGain,
          osc: fm.carrier,
        });
      }
      this._tiers.push({ octaveShift, voices });
    }

    this.running = true;
  }

  stop(): void {
    if (!this._actx) return;
    this._actx.suspend();
    this.running = false;
  }

  setPalette(p: Palette | null): void {
    this.palette = p;
  }

  toggle(): void {
    if (this.running) this.stop();
    else this.start();
  }

  // ── Per-frame update ────────────────────────────────────────

  update({
    hue,
    bri,
    act,
    actBg = 0,
    actEdge = 0,
    vy = 0.5,
    spread = 0,
    sat = 0,
    contrast = 0,
    dContrast = 0,
    lo = 0,
    mx = 0.5,
    my = 0.5,
    vmx = 0,
    vmy = 0,
    sx = 0.5,
    sy = 0.5,
    mass = 0,
  }: AnalysisSnapshot): void {
    const key = this.key;
    const palette = this.palette;
    if (!this.running || (!key && !palette)) return;

    const safeHue = Number.isFinite(hue) ? hue : 0;
    const safeBri = Number.isFinite(bri) ? Math.max(0, bri) : 0;
    const rawAct = clamp01(act);
    const rawActBg = clamp01(actBg);
    const rawActEdge = clamp01(actEdge);
    const safeAct = Math.max(rawAct, rawActBg);
    const safeVy = Number.isFinite(vy) ? clamp01(vy) : 0.5;
    const safeSpread = clamp01(spread);
    const safeSat = clamp01(sat);
    const safeContrast = clamp01(contrast);
    const safeDContrast = clamp01(Math.abs(dContrast) * 10);
    const safeLo = clamp01(lo);
    const safeMx = Number.isFinite(mx) ? clamp01(mx) : 0.5;
    const vMag = clamp01(Math.sqrt(vmx * vmx + vmy * vmy) * 20);
    const compactness = clamp01(1 - (sx + sy) * 3);

    // ── Source: Key or Palette chord data ───────────────────
    let note: NoteProxy;
    let note2: NoteProxy | PaletteSlot | DegreeInfo | null;
    let bf2: number;
    const baseOctave = this._cfg.octave ?? 4;

    if (palette) {
      const blend = palette.hueToBlend(safeHue);
      const primarySlot = blend[0].slot;
      const secEntry = blend.length > 1 ? blend[1] : null;
      bf2 = secEntry ? secEntry.weight * 2 : 0;
      note2 = secEntry ? secEntry.slot : null;
      const pcs = primarySlot.chord.pitchClasses;
      note = {
        degree: 0,
        _palettePrimary: primarySlot,
        _paletteBf2: bf2,
        triad: pcs.slice(0, 3).map((pc) => ({
          freq: _pcToFreq(pc, baseOctave),
          name: "",
        })),
      };
    } else {
      note = key!.hueToNote(safeHue) as NoteProxy;
      const { blendDegree, blendFactor } = key!.hueToBlend(safeHue, 0.25);
      note2 = blendFactor > 0.02 ? key!.degrees[blendDegree] : null;
      bf2 = blendFactor * 2;
    }

    const now = this._actx!.currentTime;
    const tau = Math.max(0.001, this._glideTime(safeAct) / 3);
    const slowTau = Math.max(0.05, tau * 4);

    this._panTo(this._masterPanner!.pan, (safeMx - 0.5) * 1.4, slowTau, now);

    const vt = safeVy * 2;
    const trebleW = vt <= 1 ? (1 - vt) * safeBri : 0;
    const midW = (vt <= 1 ? vt : 2 - vt) * safeBri;
    const bassW = vt >= 1 ? (vt - 1) * safeBri : 0;
    const tierSignals = [bassW, midW, trebleW];

    const thirdW = clamp01((safeSpread - 0.15) / 0.25);
    const fifthW = clamp01((safeSpread - 0.4) / 0.25);
    const voiceWeights = [1.0, thirdW, fifthW];

    const widthScale = 0.25 + safeSpread * (this._cfg.fmStereoWidth ?? 0.75);

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

    this._tiers.forEach(({ octaveShift, voices }, ti) => {
      const freqScale = Math.pow(2, octaveShift);
      const tierBase = Math.max(0, tierSignals[ti] * 0.25);

      let extFreqs: [number, number] = [0, 0];
      let extOk: [boolean, boolean] = [false, false];
      if (!palette) {
        const d = note.degree;
        const f5ref = note.triad[2].freq * freqScale;
        let f7 = key!.degrees[(d + 6) % 7].freq * freqScale;
        let f9 = key!.degrees[(d + 1) % 7].freq * freqScale;
        while (f7 < f5ref && f7 > 0) f7 *= 2;
        while (f9 <= f7 && f9 > 0) f9 *= 2;
        extFreqs = [f7, f9];
        extOk = [
          Number.isFinite(f7) && f7 < 6000,
          Number.isFinite(f9) && f9 < 8000,
        ];
      }

      voices.forEach(({ fm, panner, ratioBase }, vi) => {
        if (vi < 3) {
          // Triad voices: root (0), 3rd (1), 5th (2)
          let targetFreq: number;
          if (palette) {
            const pcs = note._palettePrimary!.chord.pitchClasses;
            if (vi >= pcs.length) {
              fm.setGain(0, tau);
              return;
            }
            targetFreq = _pcToFreq(pcs[vi], baseOctave + octaveShift);
          } else {
            targetFreq = note.triad[vi].freq * freqScale;
          }
          if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
            fm.setGain(0, tau);
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

          fm.glideTo(targetFreq, tau * VOICE_GLIDE_SPREAD[vi]);
          const triadGain = palette
            ? tierBase *
              voiceWeights[vi] *
              (1 - bf2) *
              (note._palettePrimary!.gain ?? 1)
            : tierBase * voiceWeights[vi] * (1 - bf2);
          fm.setGain(triadGain, tau);
          fm.setIndex(tierIndex[ti], slowTau);
          const targetRatio = ratioBase + ratioDrift * VOICE_DRIFT_SIGN[vi];
          fm.setRatio(targetRatio, slowTau);
          const targetPan = TIER_BASE_PAN[ti][vi] * widthScale;
          this._panTo(panner.pan, targetPan, slowTau, now);
        } else {
          // Extension voices: 7th (vi=3), 9th (vi=4)
          const ei = vi - 3;
          if (palette) {
            const pcs = note._palettePrimary!.chord.pitchClasses;
            const secSlot = note2 as PaletteSlot | null;
            let handled = false;

            if (secSlot && bf2 > 0.04) {
              const secPCs = secSlot.chord.pitchClasses;
              const si = ei === 0 ? 0 : Math.min(2, secPCs.length - 1);
              if (si < secPCs.length) {
                const sf = _pcToFreq(secPCs[si], baseOctave + octaveShift);
                fm.glideTo(sf, tau * VOICE_GLIDE_SPREAD[vi]);
                fm.setGain(
                  tierBase *
                    voiceWeights[[0, 2][ei]] *
                    bf2 *
                    (secSlot.gain ?? 1),
                  tau,
                );
                fm.setIndex(tierIndex[ti] * 0.65, slowTau);
                fm.setRatio(ratioBase, slowTau);
                handled = true;
              }
            }
            if (!handled) {
              const xi = 3 + ei;
              if (xi < pcs.length) {
                const ef = _pcToFreq(pcs[xi], baseOctave + octaveShift);
                fm.glideTo(ef, tau * VOICE_GLIDE_SPREAD[vi]);
                fm.setGain(
                  tierBase * (ei === 0 ? seventhW * 0.45 : ninthW * 0.25),
                  tau,
                );
                fm.setIndex(tierIndex[ti] * (0.75 - ei * 0.15), slowTau);
                fm.setRatio(ratioBase, slowTau);
                handled = true;
              }
            }
            if (!handled) fm.setGain(0, tau);
          } else {
            const secDegree = note2 as DegreeInfo | null;
            if (secDegree && bf2 > 0.04) {
              const secTriad = [0, 2] as const;
              const secFreq =
                (secDegree as DegreeInfo & { triad: { freq: number }[] })
                  .triad?.[secTriad[ei]]?.freq * freqScale;
              if (Number.isFinite(secFreq) && secFreq > 0 && secFreq < 8000) {
                fm.glideTo(secFreq, tau * VOICE_GLIDE_SPREAD[vi]);
                fm.setGain(tierBase * voiceWeights[secTriad[ei]] * bf2, tau);
                fm.setIndex(tierIndex[ti] * 0.65, slowTau);
                fm.setRatio(ratioBase, slowTau);
              } else {
                fm.setGain(0, tau);
              }
            } else if (extOk[ei]) {
              fm.glideTo(extFreqs[ei], tau * VOICE_GLIDE_SPREAD[vi]);
              fm.setGain(
                tierBase * (ei === 0 ? seventhW * 0.45 : ninthW * 0.25),
                tau,
              );
              fm.setIndex(tierIndex[ti] * (0.75 - ei * 0.15), slowTau);
              fm.setRatio(ratioBase, slowTau);
            } else {
              fm.setGain(0, tau);
            }
          }
          const extPan = TIER_BASE_PAN_EXT[ti][ei] * widthScale;
          this._panTo(panner.pan, extPan, slowTau, now);
        }
      });
    });

    this._prevRootFreq = palette
      ? _pcToFreq(note._palettePrimary!.chord.pitchClasses[0], baseOctave)
      : note.triad[0].freq;

    this._maybePluck(
      note,
      rawAct,
      rawActBg,
      rawActEdge,
      safeSpread,
      widthScale,
      now,
      safeMx,
      vMag,
      compactness,
    );

    const dlFeedback = clamp01(rawActBg * 0.55 + 0.05);
    const dlWet = rawActBg * 0.35;
    this._delay!.feedback.gain.setTargetAtTime(dlFeedback, now, slowTau);
    this._delay!.wet.gain.setTargetAtTime(dlWet, now, slowTau);

    this._tremolo!.depth.gain.setTargetAtTime(
      safeDContrast * 0.12,
      now,
      slowTau,
    );
    this._tremolo!.lfo.frequency.setTargetAtTime(5 + rawAct * 4, now, slowTau);

    const subFreq = palette
      ? _pcToFreq(note._palettePrimary!.chord.pitchClasses[0], baseOctave - 2)
      : key!.degrees[note.degree].freq / 4;
    if (Number.isFinite(subFreq) && subFreq > 0) {
      this._cancelParam(this._sub!.osc.frequency, now);
      this._sub!.osc.frequency.setTargetAtTime(subFreq, now, tau);
    }
    this._cancelParam(this._sub!.gain.gain, now);
    this._sub!.gain.gain.setTargetAtTime(safeLo * 0.25, now, tau);
  }

  // ── Private — pluck ─────────────────────────────────────────

  private _maybePluck(
    note: NoteProxy,
    quickness: number,
    slowness: number,
    edge: number,
    spread: number,
    widthScale: number,
    now: number,
    mx: number,
    vMag: number,
    compactness: number,
  ): void {
    if (!this._plucks.length) return;
    const pluck = this._plucks.reduce((best, v) =>
      v.nextAllowed < best.nextAllowed ? v : best,
    );
    if (now < pluck.nextAllowed) return;

    const trigProb = Math.max(quickness * 0.4, slowness * 0.2, vMag * 0.5);
    if (Math.random() > trigProb) return;

    const spacious = 1 - quickness;
    const peak = 0.04 + quickness * 0.13 + slowness * 0.03;
    const attackTau = 0.014 - quickness * 0.011;
    const baseDecay = 0.06 + slowness * 0.4;
    const ampDecayTau =
      baseDecay * (1 + spacious * 1.8) +
      Math.random() * (0.05 + slowness * 0.12);
    const indexPeak = Math.min(
      1.0,
      (0.25 + quickness * 0.45 + edge * 0.3) *
        (1 - slowness * 0.3) *
        (0.5 + compactness * 0.5),
    );
    const modDecayTau = ampDecayTau * (0.04 + slowness * 0.14);

    let fc: number, pluckPan: number;
    const baseOctave = this._cfg.octave ?? 4;

    if (this.palette) {
      const pcs = note._palettePrimary!.chord.pitchClasses;
      const nUnlocked = Math.max(1, Math.round(1 + spread * (pcs.length - 1)));
      const chosenIdx = Math.floor(Math.random() * nUnlocked);
      const octShift = Math.round(1 - slowness * 2);
      fc = _pcToFreq(pcs[chosenIdx], baseOctave + octShift);
      const pcFrac = pcs.length > 1 ? chosenIdx / (pcs.length - 1) : 0.5;
      pluckPan =
        (pcFrac - 0.5) * 2 * widthScale * (0.35 + spacious * 1.1) +
        (mx - 0.5) * 0.8;
    } else {
      const d = note.degree;
      const CONSONANCE_STEPS = [0, 4, 2, 6, 5, 3, 1];
      const orderedDegrees = CONSONANCE_STEPS.map((s) => (d + s) % 7);
      const nUnlocked = Math.round(1 + spread * 6);
      const chosen = orderedDegrees[Math.floor(Math.random() * nUnlocked)];
      const octShift = Math.round(1 - slowness * 2);
      fc = this.key!.degrees[chosen].freq * Math.pow(2, octShift);
      const degPan = (chosen / 6 - 0.5) * 2;
      pluckPan =
        degPan * widthScale * (0.35 + spacious * 1.1) + (mx - 0.5) * 0.8;
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

    pluck.nextAllowed = now + 0.06 + spacious * 0.5 + slowness * 0.25;
  }

  // ── Helpers ─────────────────────────────────────────────────

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
}

// ── Module helpers ────────────────────────────────────────────

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function _pcToFreq(pc: number, octave: number): number {
  return 440 * Math.pow(2, (pc - 9 + (octave - 4) * 12) / 12);
}
