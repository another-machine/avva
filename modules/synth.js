/**
 * modules/synth.js  (v0.7)
 *
 * 2-operator FM synthesizer driven by AVVA analysis output.
 *
 *   ╔════════════════════════════════════════════════════════════════════╗
 *   ║  15 PAD voices  +  3 PLUCK voices  +  1 SUB-BASS oscillator       ║
 *   ║  → per-voice panners → master gain → delay send → compressor      ║
 *   ╚════════════════════════════════════════════════════════════════════╝
 *
 *   3 tiers × 5 chord-tone voices (root, 3rd, 5th, 7th*, 9th*):
 *      tier 0 (bass,   oct −1)  ratio 2  index ← contrast
 *      tier 1 (mid,    oct  0)  ratio 1  index ← sat
 *      tier 2 (treble, oct +1)  ratio 1  index ← sat (brighter)
 *      * 7th fades in at sat > 0.35, 9th at sat > 0.65
 *
 *   Delay send: tap off master → delay (320 ms) → LPF → feedback loop
 *      actBg → feedback depth + wet level  (slow motion = reverberant)
 *
 *   Tremolo LFO: sine LFO on master.gain
 *      |dContrast| → depth  (scene structure forming/dissolving = flutter)
 *      act → rate   (fast motion = faster tremolo)
 *
 *   Sub-bass: single sine oscillator 2 octaves below root
 *      lo → amplitude  (bottom-screen brightness = sub weight)
 *
 *   Pluck polyphony: 3 concurrent FM pluck voices (round-robin by idle time)
 *
 * Public API (same as v0.5/v0.6):
 *   new Synth(config) · key · start() · stop() · toggle() · running
 *   update({ hue, bri, act, actBg, vy, spread, sat, contrast, actEdge,
 *            dContrast, lo, histBins }) · _master · _actx
 */

import { FMVoice } from "./fm-voice.js";

// Per-tier base FM ratio (carrier-relative)
const TIER_RATIO = [2, 1, 1]; // bass / mid / treble

// Per-tier × per-voice base pan position (before width scaling).
// Bass narrow → treble wide. Voices fan out evenly per tier.
const TIER_BASE_PAN = [
  [-0.18, 0.0, +0.18],
  [-0.42, 0.0, +0.42],
  [-0.7, 0.0, +0.7],
];

// Extension voice (7th, 9th) base pan positions — interleave with triad.
const TIER_BASE_PAN_EXT = [
  [+0.12, -0.12], // bass: very narrow
  [+0.32, -0.32], // mid: moderate
  [+0.55, -0.55], // treble: wider
];

// Voice ordering of the drift sign — root sits on the integer, the
// 3rd drifts up, the 5th drifts down. Extensions stay on integer ratio.
const VOICE_DRIFT_SIGN = [0, +1, -1];

// Number of concurrent polyphonic pluck voices.
const N_PLUCKS = 3;

export class Synth {
  /**
   * @param {import('./config.js').CONFIG} config
   */
  constructor(config) {
    this._cfg = config;
    this._actx = null;
    this._master = null;
    this._tiers = []; // [{ octaveShift, voices: [{fm, panner, ratioBase}×5] }×3]
    this._plucks = []; // N_PLUCKS × { fm, panner, nextAllowed }
    this._sub = null; // { osc, gain } — sub-bass sine oscillator
    this._delay = null; // { input, node, feedback, wet }
    this._tremolo = null; // { lfo, depth }
    this.key = null;
    this.running = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Create AudioContext and start oscillators (or resume if suspended).
   * Must be called from inside a user-gesture handler.
   */
  start() {
    if (this._actx) {
      this._actx.resume();
      this.running = true;
      return;
    }

    this._actx = new AudioContext();

    // Light compression keeps feedback / dense chords from clipping
    const comp = this._actx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    this._master = this._actx.createGain();
    this._master.gain.value = this._cfg.masterGain ?? 0.35;
    this._master.connect(comp);
    comp.connect(this._actx.destination);

    // Sub-bass: pure sine 2 octaves below root, driven by lo (bottom brightness).
    const subOsc = this._actx.createOscillator();
    const subGain = this._actx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.value = 110; // A2 placeholder, updated each frame
    subGain.gain.value = 0;
    subOsc.connect(subGain);
    subGain.connect(this._master);
    subOsc.start();
    this._sub = { osc: subOsc, gain: subGain };

    // Delay send: tap off master → delay (320 ms) → LPF → feedback loop.
    // Wet path: LPF → delayWet → comp. actBg drives feedback + wet level.
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
    delayFeedback.connect(delayInput); // feedback loop
    delayLpf.connect(delayWet);
    delayWet.connect(comp); // wet signal adds to comp input
    this._delay = {
      input: delayInput,
      node: delayNode,
      feedback: delayFeedback,
      wet: delayWet,
    };

    // Tremolo LFO: sine at ~6 Hz summed into master.gain.
    // |dContrast| drives depth; act drives rate.
    const tremoloLfo = this._actx.createOscillator();
    const tremoloDepth = this._actx.createGain();
    tremoloLfo.type = "sine";
    tremoloLfo.frequency.value = 6.0;
    tremoloDepth.gain.value = 0;
    tremoloLfo.connect(tremoloDepth);
    tremoloDepth.connect(this._master.gain); // summed on top of DC gain value
    tremoloLfo.start();
    this._tremolo = { lfo: tremoloLfo, depth: tremoloDepth };

    // N_PLUCKS concurrent pluck voices — polyphonic, picked by idle time.
    this._plucks = Array.from({ length: N_PLUCKS }, () => {
      const fm = new FMVoice(this._actx, this._actx.createGain(), {
        ratio: this._cfg.fmPluckRatio ?? 7,
        index: 1.0,
      });
      const panner = this._actx.createStereoPanner();
      panner.pan.value = 0;
      fm.outGain.disconnect();
      fm.outGain.connect(panner);
      panner.connect(this._master);
      return { fm, panner, nextAllowed: 0 };
    });

    // 3 tiers × 5 voices = 15 FM pad voices, each with its own panner.
    // Voices 0–2: triad (root, 3rd, 5th). Voices 3–4: extensions (7th, 9th).
    this._tiers = [];
    for (let ti = 0; ti < 3; ti++) {
      const octaveShift = ti - 1; // −1 / 0 / +1
      const ratioBase = TIER_RATIO[ti];
      const voices = [];
      for (let vi = 0; vi < 5; vi++) {
        const fm = new FMVoice(this._actx, this._master, {
          ratio: ratioBase,
          index: 0.4,
        });
        const basePan =
          vi < 3 ? TIER_BASE_PAN[ti][vi] : TIER_BASE_PAN_EXT[ti][vi - 3];
        const panner = this._actx.createStereoPanner();
        panner.pan.value = basePan * 0.25; // default width
        fm.outGain.disconnect();
        fm.outGain.connect(panner);
        panner.connect(this._master);
        voices.push({
          fm,
          panner,
          ratioBase,
          gain: fm.outGain, // v0.5 compat alias
          osc: fm.carrier, // v0.5 compat alias
        });
      }
      this._tiers.push({ octaveShift, voices });
    }

    this.running = true;
  }

  stop() {
    if (!this._actx) return;
    this._actx.suspend();
    this.running = false;
  }

  toggle() {
    if (this.running) this.stop();
    else this.start();
  }

  // ── Per-frame update ────────────────────────────────────────

  /**
   * Drive the synth from one analysis frame. Call every RAF tick.
   *
   * @param {object} out
   * @param {number} out.hue
   * @param {number} out.bri
   * @param {number} out.act      — frame-diff activity
   * @param {number} [out.actBg]  — bg-subtract activity (slowness)
   * @param {number} [out.actEdge]
   * @param {number} [out.vy]
   * @param {number} [out.spread]
   * @param {number} [out.sat]
   * @param {number} [out.contrast]
   * @param {Float32Array} [out.histBins]
   */
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
    histBins = null,
  }) {
    if (!this.running || !this.key) return;

    // Clamp everything — a stray NaN crashes setTargetAtTime hard.
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
    const safeDContrast = clamp01(Math.abs(dContrast) * 10); // amplify small derivative
    const safeLo = clamp01(lo);

    const note = this.key.hueToNote(safeHue);
    const now = this._actx.currentTime;
    const tau = Math.max(0.001, this._glideTime(safeAct) / 3);
    // Pan / index / ratio glide more slowly than freq/gain — keeps the
    // spatial + timbral motion from twitching at frame rate.
    const slowTau = Math.max(0.05, tau * 4);

    // Vertical brightness centroid → tier crossfade (unchanged from v0.5)
    const vt = safeVy * 2;
    const trebleW = vt <= 1 ? (1 - vt) * safeBri : 0;
    const midW = (vt <= 1 ? vt : 2 - vt) * safeBri;
    const bassW = vt >= 1 ? (vt - 1) * safeBri : 0;
    const tierSignals = [bassW, midW, trebleW];

    // Triad voice gating by hue spread (unchanged)
    const thirdW = clamp01((safeSpread - 0.15) / 0.25);
    const fifthW = clamp01((safeSpread - 0.4) / 0.25);
    const voiceWeights = [1.0, thirdW, fifthW];

    // Stereo width: spread opens up the field. Minimum 0.25 so there's
    // always a touch of natural width.
    const widthScale = 0.25 + safeSpread * (this._cfg.fmStereoWidth ?? 0.75);

    // Per-tier modulation index. Bass uses contrast (structured frames
    // grow growl in the low end); mid + treble use sat (vivid color =
    // bright timbre). Treble is slightly brighter at the top of its range.
    const idxBase = this._cfg.fmIndexBase ?? 0.15;
    const idxScale = this._cfg.fmIndexScale ?? 2.4;
    const tierIndex = [
      idxBase +
        Math.min(1, safeContrast * 1.4 + safeSat * 0.3) * (idxScale * 0.7),
      idxBase + safeSat * idxScale,
      idxBase + safeSat * idxScale * 1.15,
    ];

    // Spread → ratio drift. Voice 0 stays on integer, 1 drifts up,
    // 2 drifts down. Result: three slightly mistuned sidebands → chorus.
    const ratioDrift = safeSpread * (this._cfg.fmRatioDrift ?? 0.04);

    // sat → extension voice gating
    const seventhW = clamp01((safeSat - 0.35) / 0.35); // 7th fades in at sat 0.35–0.70
    const ninthW = clamp01((safeSat - 0.65) / 0.3); // 9th fades in at sat 0.65–0.95

    this._tiers.forEach(({ octaveShift, voices }, ti) => {
      const freqScale = Math.pow(2, octaveShift);
      const tierBase = Math.max(0, tierSignals[ti] * 0.25);

      // Extension frequencies — diatonic 7th and 9th, octave-shifted above the 5th.
      const d = note.degree;
      const f5ref = note.triad[2].freq * freqScale;
      let f7 = this.key.degrees[(d + 6) % 7].freq * freqScale;
      let f9 = this.key.degrees[(d + 1) % 7].freq * freqScale;
      while (f7 < f5ref && f7 > 0) f7 *= 2;
      while (f9 <= f7 && f9 > 0) f9 *= 2;
      const extFreqs = [f7, f9];
      const extOk = [
        Number.isFinite(f7) && f7 < 6000,
        Number.isFinite(f9) && f9 < 8000,
      ];

      voices.forEach(({ fm, panner, ratioBase }, vi) => {
        if (vi < 3) {
          // Triad voices: root (0), 3rd (1), 5th (2)
          const targetFreq = note.triad[vi].freq * freqScale;
          if (!Number.isFinite(targetFreq)) return;

          fm.glideTo(targetFreq, tau);
          fm.setGain(tierBase * voiceWeights[vi], tau);
          fm.setIndex(tierIndex[ti], slowTau);
          const targetRatio = ratioBase + ratioDrift * VOICE_DRIFT_SIGN[vi];
          fm.setRatio(targetRatio, slowTau);
          const targetPan = TIER_BASE_PAN[ti][vi] * widthScale;
          this._panTo(panner.pan, targetPan, slowTau, now);
        } else {
          // Extension voices: 7th (vi=3), 9th (vi=4)
          const ei = vi - 3;
          if (extOk[ei]) {
            fm.glideTo(extFreqs[ei], tau);
            fm.setGain(
              tierBase * (ei === 0 ? seventhW * 0.45 : ninthW * 0.25),
              tau,
            );
            fm.setIndex(tierIndex[ti] * (0.75 - ei * 0.15), slowTau);
            fm.setRatio(ratioBase, slowTau); // no drift on extensions
          } else {
            fm.setGain(0, tau);
          }
          const extPan = TIER_BASE_PAN_EXT[ti][ei] * widthScale;
          this._panTo(panner.pan, extPan, slowTau, now);
        }
      });
    });

    // Pluck — histogram-driven note selection (unchanged below)
    let degreeWeights = null;
    if (histBins && histBins.length > 0) {
      const nBins = histBins.length;
      const raw = new Float64Array(7);
      for (let b = 0; b < nBins; b++) {
        const di = Math.floor(((b + 0.5) / nBins) * 7) % 7;
        raw[di] += histBins[b];
      }
      const maxW = Math.max(...raw, 1e-6);
      degreeWeights = Array.from(raw, (w) => Math.max(0.04, w / maxW));
    }

    this._maybePluck(
      note,
      rawAct,
      rawActBg,
      rawActEdge,
      safeSpread,
      widthScale,
      now,
      degreeWeights,
    );

    // === Delay: actBg → reverb depth (slow motion = echoey) ===
    const dlFeedback = clamp01(rawActBg * 0.55 + 0.05);
    const dlWet = rawActBg * 0.35;
    this._delay.feedback.gain.setTargetAtTime(dlFeedback, now, slowTau);
    this._delay.wet.gain.setTargetAtTime(dlWet, now, slowTau);

    // === Tremolo: |dContrast| → depth, act → rate ===
    this._tremolo.depth.gain.setTargetAtTime(
      safeDContrast * 0.12,
      now,
      slowTau,
    );
    this._tremolo.lfo.frequency.setTargetAtTime(5 + rawAct * 4, now, slowTau);

    // === Sub-bass: root − 2 octaves, driven by lo (bottom brightness) ===
    const subFreq = this.key.degrees[note.degree].freq / 4;
    if (Number.isFinite(subFreq) && subFreq > 0) {
      this._cancelParam(this._sub.osc.frequency, now);
      this._sub.osc.frequency.setTargetAtTime(subFreq, now, tau);
    }
    this._cancelParam(this._sub.gain.gain, now);
    this._sub.gain.gain.setTargetAtTime(safeLo * 0.25, now, tau);
  }

  /**
   * Probabilistic FM pluck.
   *
   * Note selection: histogram-weighted (vs. fallback chord-tones × spread).
   * Octave: continuous shift by slowness (deep gong ↔ bright pluck).
   * Index peak: scaled by actEdge — sharp moving edges → sharper ping.
   * Pan: scaled by chosen scale-degree position × current stereo width.
   */
  _maybePluck(
    note,
    quickness,
    slowness,
    edge,
    spread,
    widthScale,
    now,
    degreeWeights = null,
  ) {
    // Pick the most-idle pluck voice (smallest nextAllowed = least recently used).
    if (!this._plucks.length) return;
    const pluck = this._plucks.reduce((best, v) =>
      v.nextAllowed < best.nextAllowed ? v : best,
    );
    if (now < pluck.nextAllowed) return; // all voices still cooling down

    const trigProb = Math.max(quickness * 0.4, slowness * 0.2);
    if (Math.random() > trigProb) return;

    // Note pick
    let weights;
    if (degreeWeights) {
      weights = degreeWeights;
    } else {
      const d = note.degree;
      const chordSet = new Set([d, (d + 2) % 7, (d + 4) % 7]);
      weights = this.key.degrees.map((_, i) =>
        chordSet.has(i) ? 1.0 : spread * 0.8,
      );
    }
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < 7; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }

    const octMult = Math.pow(2, 1 - slowness * 2);
    const fc = this.key.degrees[chosen].freq * octMult;
    if (!Number.isFinite(fc) || fc <= 0) return;

    // Envelope shaping (same character knobs as v0.5 pluck)
    const attackTau = 0.003 + slowness * 0.017;
    const ampDecayTau =
      0.04 + slowness * 0.36 + Math.random() * (0.05 + slowness * 0.15);
    const peak = 0.1 + slowness * 0.08;

    // FM specifics
    // Index peak kept low so the attack has body without harsh metallic clang.
    // Edge adds a little brightness but stays muted.
    const indexPeak = (0.6 + edge * 1.0) * (1 - slowness * 0.4);
    // Mod envelope decays very quickly — the harmonic colour snaps to a
    // near-pure tone almost immediately, giving a warm pluck/mallet character.
    const modDecayTau = ampDecayTau * (0.06 + slowness * 0.14);

    pluck.fm.pluck(fc, {
      peak,
      ampDecayTau,
      modDecayTau,
      indexPeak,
      attackTau,
    });

    // Pan from chosen degree position: tonic left → leading-tone right.
    // Scale by current stereo width × 0.75 (don't slam the corners).
    const degPan = (chosen / 6 - 0.5) * 2; // -1 .. +1
    const pluckPan = degPan * widthScale * 0.75;
    this._panTo(pluck.panner.pan, pluckPan, 0.04, now);

    pluck.nextAllowed =
      now + 0.08 + (1 - Math.max(quickness, slowness)) * 0.12 + slowness * 0.4;
  }

  // ── Helpers ─────────────────────────────────────────────────

  _panTo(param, value, tau, now) {
    if (!Number.isFinite(value)) return;
    const v = Math.max(-1, Math.min(1, value));
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      const cv = param.value;
      param.cancelScheduledValues(0);
      param.setValueAtTime(cv, now);
    }
    param.setTargetAtTime(v, now, tau);
  }

  _cancelParam(param, now) {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      const v = param.value;
      param.cancelScheduledValues(0);
      param.setValueAtTime(v, now);
    }
  }

  /**
   * Map activity (0–1) to glide duration (seconds).
   * Exponential: act=0 → glideMax (legato), act=1 → glideMin (staccato).
   */
  _glideTime(act) {
    const min = this._cfg.glideMin ?? 0.05;
    const max = this._cfg.glideMax ?? 3.0;
    const a = clamp01(act);
    return max * Math.pow(min / max, a);
  }
}

function clamp01(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}
