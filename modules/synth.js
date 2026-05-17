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

// Per-voice glide-time multipliers — gives each chord voice a slightly
// different legato speed so unison chords don't move in lockstep.
const VOICE_GLIDE_SPREAD = [0.88, 1.0, 1.18, 0.94, 1.09];

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
    this._masterPanner = null; // final StereoPannerNode — driven by mx centroid
    this.key = null;
    this.running = false;
    this._prevRootFreq = 0; // mid-tier root freq, used for voice-leading the 5th
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

    // Master panner: sits after the compressor so all voices track together.
    // Driven by mx (horizontal motion centroid) to create the tracking illusion.
    const masterPanner = this._actx.createStereoPanner();
    masterPanner.pan.value = 0;
    comp.connect(masterPanner);
    masterPanner.connect(this._actx.destination);
    this._masterPanner = masterPanner;

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
    mx = 0.5,
    my = 0.5,
    vmx = 0,
    vmy = 0,
    sx = 0.5,
    sy = 0.5,
    mass = 0,
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

    // Moment-derived signals.
    // vMag: speed of the weighted motion centroid, scaled to 0–1.
    // vmx/vmy are frame-delta of normalised coordinates (≈ 0.002 per pixel/frame)
    // so ×20 maps a fast hand-sweep (~0.05 units/frame) to ~1.
    const safeMx = Number.isFinite(mx) ? clamp01(mx) : 0.5;
    const vMag = clamp01(Math.sqrt(vmx * vmx + vmy * vmy) * 20);
    // compactness: 0 = diffuse wash, 1 = tight concentrated blob.
    // sx/sy are std-devs of normalised coords; typical tight blob ≈ 0.10, diffuse ≈ 0.35.
    const compactness = clamp01(1 - (sx + sy) * 3);

    const note = this.key.hueToNote(safeHue);
    // Sector-boundary crossfade: blendFactor 0 = sector centre, 0.5 = exact edge
    const { blendDegree, blendFactor } = this.key.hueToBlend(safeHue, 0.25);
    const note2 = blendFactor > 0.02 ? this.key.degrees[blendDegree] : null;
    const bf2 = blendFactor * 2; // normalised 0→1 blend amount
    const now = this._actx.currentTime;
    const tau = Math.max(0.001, this._glideTime(safeAct) / 3);
    // Pan / index / ratio glide more slowly than freq/gain — keeps the
    // spatial + timbral motion from twitching at frame rate.
    const slowTau = Math.max(0.05, tau * 4);

    // mx → master stereo pan. Object left of frame → image shifts left.
    // Range: mx=0 (hard left) → pan −0.7; mx=1 (hard right) → pan +0.7.
    this._panTo(this._masterPanner.pan, (safeMx - 0.5) * 1.4, slowTau, now);

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
          let targetFreq = note.triad[vi].freq * freqScale;
          if (!Number.isFinite(targetFreq)) return;

          // Mid-tier 5th: voice-lead by choosing the octave closest to where
          // the previous root sat. Keeps the 5th from leaping when chords change
          // and naturally produces open voicing when the root hasn't moved far.
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
          fm.setGain(tierBase * voiceWeights[vi] * (1 - bf2), tau);
          fm.setIndex(tierIndex[ti], slowTau);
          const targetRatio = ratioBase + ratioDrift * VOICE_DRIFT_SIGN[vi];
          fm.setRatio(targetRatio, slowTau);
          const targetPan = TIER_BASE_PAN[ti][vi] * widthScale;
          this._panTo(panner.pan, targetPan, slowTau, now);
        } else {
          // Extension voices: 7th (vi=3), 9th (vi=4)
          const ei = vi - 3;
          if (note2 && bf2 > 0.04) {
            // Crossfade zone: repurpose extension slots for secondary chord
            // root (ei=0) and 5th (ei=1), fading in with the blend factor.
            const secTriad = [0, 2]; // triad indices: root, 5th
            const secFreq = note2.triad[secTriad[ei]].freq * freqScale;
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
            fm.setRatio(ratioBase, slowTau); // no drift on extensions
          } else {
            fm.setGain(0, tau);
          }
          const extPan = TIER_BASE_PAN_EXT[ti][ei] * widthScale;
          this._panTo(panner.pan, extPan, slowTau, now);
        }
      });
    });

    // Store mid-tier root for voice-leading on the next frame.
    this._prevRootFreq = note.triad[0].freq; // freqScale=1 for mid tier

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
    mx = 0.5,
    vMag = 0,
    compactness = 0.5,
  ) {
    // Pick the most-idle pluck voice (smallest nextAllowed = least recently used).
    if (!this._plucks.length) return;
    const pluck = this._plucks.reduce((best, v) =>
      v.nextAllowed < best.nextAllowed ? v : best,
    );
    if (now < pluck.nextAllowed) return; // all voices still cooling down

    // Directed motion (vmx/vmy magnitude) supplements the activity gate so a
    // deliberate hand-sweep fires even in an otherwise still scene.
    const trigProb = Math.max(quickness * 0.4, slowness * 0.2, vMag * 0.5);
    if (Math.random() > trigProb) return;

    // Note pick: degrees ordered by consonance from root (root→5th→3rd→7th→6th→4th→2nd).
    // Triad tones first, then extensions, then suspensions, then the dissonant 2nd last.
    // spread gates how many are reachable: monochromatic → root only; full spectrum → all 7.
    const d = note.degree;
    const CONSONANCE_STEPS = [0, 4, 2, 6, 5, 3, 1];
    const orderedDegrees = CONSONANCE_STEPS.map((s) => (d + s) % 7);
    const nUnlocked = Math.round(1 + spread * 6); // 1 at spread=0, 7 at spread=1
    const chosen = orderedDegrees[Math.floor(Math.random() * nUnlocked)];

    // Snap to nearest integer octave so the pluck is always in tune.
    // slowness 0–0.25 → +1 oct, 0.25–0.75 → same oct, 0.75–1 → −1 oct.
    const octShift = Math.round(1 - slowness * 2);
    const fc = this.key.degrees[chosen].freq * Math.pow(2, octShift);
    if (!Number.isFinite(fc) || fc <= 0) return;

    // Activity-driven spatial vs. prominent character.
    // quickness=0 (still scene) → spacious, distant, wide, lingering.
    // quickness=1 (busy scene) → tight, punchy, centred, short.
    const spacious = 1 - quickness;

    // Amplitude: soft when spacious, present when active.
    const peak = 0.04 + quickness * 0.13 + slowness * 0.03;

    // Attack: slow diffuse onset when spacious; sharp transient when active.
    const attackTau = 0.014 - quickness * 0.011; // 0.014 → 0.003

    // Decay: long and lingering when spacious; tight when active.
    const baseDecay = 0.06 + slowness * 0.4;
    const ampDecayTau =
      baseDecay * (1 + spacious * 1.8) +
      Math.random() * (0.05 + slowness * 0.12);

    // FM: more harmonic colour on the attack when active.
    // Tight blob (high compactness) → full brightness; diffuse wash → softer ping.
    const indexPeak =
      (0.3 + quickness * 0.7 + edge * 0.6) *
      (1 - slowness * 0.3) *
      (0.5 + compactness * 0.5);
    const modDecayTau = ampDecayTau * (0.04 + slowness * 0.14);

    pluck.fm.pluck(fc, {
      peak,
      ampDecayTau,
      modDecayTau,
      indexPeak,
      attackTau,
    });

    // Pan: wide and spatial when quiet; centred and present when active.
    // mx centroid pulls the pluck toward the horizontal position of the moving thing.
    const degPan = (chosen / 6 - 0.5) * 2; // −1..+1 from scale degree position
    const mxBias = (mx - 0.5) * 0.8; // ±0.4 pull toward weighted centroid
    const panMult = 0.35 + spacious * 1.1; // 0.35 (tight) → 1.45 (wide)
    const pluckPan = degPan * widthScale * panMult + mxBias;
    this._panTo(pluck.panner.pan, pluckPan, 0.04, now);

    // Cooldown: rare, widely-spaced plucks when still; busier when active.
    pluck.nextAllowed = now + 0.06 + spacious * 0.5 + slowness * 0.25;
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
