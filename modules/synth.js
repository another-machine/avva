/**
 * modules/synth.js
 *
 * Polyphonic glide synthesizer driven by AVVA analysis output.
 *
 * Voice = 3 triangle oscillators playing the triad chord of the
 * current scale degree (root, third, fifth).
 *
 * Three register tiers, driven by vertical spatial analysis:
 *   lo (bottom-third brightness)  → bass tier   (octave − 1)
 *   bri (overall brightness)      → mid tier    (octave 0)
 *   hi (top-third brightness)     → treble tier (octave + 1)
 *
 * Each tier can be fully silent, fully present, or anywhere between —
 * giving: just bass, just treble, both, none, or any blend.
 *
 * Activity → glide speed (portamento):
 *   act ≈ 0  →  slow glide (legato)
 *   act ≈ 1  →  fast glide (staccato)
 *
 * Usage:
 *   const synth = new Synth(config);
 *   synth.key = new Key({ root: 'A', mode: 'dorian' });
 *   // on user gesture:
 *   synth.start();
 *   // in RAF loop:
 *   synth.update(frame.out);
 */

export class Synth {
  /**
   * @param {import('./config.js').CONFIG} config
   */
  constructor(config) {
    this._cfg = config;
    this._actx = null;
    this._tiers = []; // [{ octaveShift, voices: [{osc,gain}×3] }×3]
    this._master = null;
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

    // Light compression to keep feedback loops from clipping
    const comp = this._actx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    this._master = this._actx.createGain();
    this._master.gain.value = this._cfg.masterGain ?? 0.35;
    this._master.connect(comp);
    comp.connect(this._actx.destination);

    // Pluck voice — percussive melodic events triggered by motion
    const plkOsc = this._actx.createOscillator();
    const plkGain = this._actx.createGain();
    plkOsc.type = "sine"; // contrast with the triangle pads
    plkOsc.frequency.value = 440;
    plkGain.gain.value = 0;
    plkOsc.connect(plkGain);
    plkGain.connect(this._master);
    plkOsc.start();
    this._pluck = { osc: plkOsc, gain: plkGain, nextAllowed: 0 };

    // 3 tiers (bass, mid, treble) × 3 voices each (root, third, fifth)
    for (const octaveShift of [-1, 0, 1]) {
      const voices = [];
      for (let i = 0; i < 3; i++) {
        const osc = this._actx.createOscillator();
        const gain = this._actx.createGain();
        osc.type = "triangle";
        osc.frequency.value = 440;
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(this._master);
        osc.start();
        voices.push({ osc, gain });
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
   * @param {{ hue:number, bri:number, sat:number, act:number,
   *           hi:number, lo:number, vy:number, contrast:number }} out
   */
  update({ hue, bri, act, actBg = 0, vy = 0.5, spread = 0, histBins = null }) {
    if (!this.running || !this.key) return;

    // Clamp all inputs — NaN/Infinity from any signal will crash setTargetAtTime.
    const safeHue = Number.isFinite(hue) ? hue : 0;
    const safeBri = Number.isFinite(bri) ? Math.max(0, bri) : 0;
    // Keep both raw signals so the pluck can distinguish slow from fast motion.
    const rawAct = Number.isFinite(act) ? Math.max(0, Math.min(1, act)) : 0;
    const rawActBg = Number.isFinite(actBg)
      ? Math.max(0, Math.min(1, actBg))
      : 0;
    // Combined for glide speed and tier volumes.
    const safeAct = Math.max(rawAct, rawActBg);
    const safeVy = Number.isFinite(vy) ? Math.max(0, Math.min(1, vy)) : 0.5;
    const safeSpread = Number.isFinite(spread)
      ? Math.max(0, Math.min(1, spread))
      : 0;

    const note = this.key.hueToNote(safeHue);
    const now = this._actx.currentTime;
    // Time constant must be strictly positive — floor at 1 ms.
    const tau = Math.max(0.001, this._glideTime(safeAct) / 3);

    const vt = safeVy * 2;
    const trebleW = vt <= 1 ? (1 - vt) * safeBri : 0;
    const midW = (vt <= 1 ? vt : 2 - vt) * safeBri;
    const bassW = vt >= 1 ? (vt - 1) * safeBri : 0;
    const tierSignals = [bassW, midW, trebleW];

    // Triad voice weights driven by hue spread (color diversity).
    // Monochromatic → root only; more colors → 3rd fades in; rainbow → 5th fades in.
    //   spread 0.00–0.15 → root alone
    //   spread 0.15–0.40 → 3rd crossfades in
    //   spread 0.40–0.65 → 5th crossfades in
    const thirdW = Math.max(0, Math.min(1, (safeSpread - 0.15) / 0.25));
    const fifthW = Math.max(0, Math.min(1, (safeSpread - 0.4) / 0.25));
    const voiceWeights = [1.0, thirdW, fifthW];

    this._tiers.forEach(({ octaveShift, voices }, ti) => {
      const freqScale = Math.pow(2, octaveShift);
      const tierBase = Math.max(0, tierSignals[ti] * 0.25);

      note.triad.forEach(({ freq }, vi) => {
        const targetFreq = freq * freqScale;
        if (!Number.isFinite(targetFreq)) return;
        const targetGain = tierBase * voiceWeights[vi];
        const { osc, gain } = voices[vi];
        // cancelAndHoldAtTime + setTargetAtTime for smooth glide;
        // fall back to cancelScheduledValues approach for older browsers.
        if (osc.frequency.cancelAndHoldAtTime) {
          osc.frequency.cancelAndHoldAtTime(now);
          osc.frequency.setTargetAtTime(targetFreq, now, tau);
          gain.gain.cancelAndHoldAtTime(now);
          gain.gain.setTargetAtTime(targetGain, now, tau);
        } else {
          const cf = osc.frequency.value;
          const cg = gain.gain.value;
          osc.frequency.cancelScheduledValues(0);
          osc.frequency.setValueAtTime(cf, now);
          osc.frequency.setTargetAtTime(targetFreq, now, tau);
          gain.gain.cancelScheduledValues(0);
          gain.gain.setValueAtTime(cg, now);
          gain.gain.setTargetAtTime(targetGain, now, tau);
        }
      });
    });

    // Map histogram bins → per-degree prevalence weights.
    // Each bin's center hue maps to a scale degree; its weight (sat×val) accumulates.
    // A small floor keeps all degrees reachable even when they're off-screen.
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

    this._maybePluck(note, rawAct, rawActBg, safeSpread, now, degreeWeights);
  }

  /**
   * Probabilistic melodic pluck, shaped by the balance of quickness vs slowness.
   *
   * quickness (frame-diff act)  → high octave, sharp attack, short decay
   * slowness  (bg-subtract actBg) → low octave,  mallet attack, long resonance
   *
   * Octave: Math.pow(2, 1 - slowness*2)
   *   slowness 0 → ×2  (base+1 oct, bright)
   *   slowness .5 → ×1  (base oct)
   *   slowness 1 → ×0.5 (base−1 oct, deep)
   *
   * Note selection is weighted by spread:
   *   spread ≈ 0 → only chord tones (root, 3rd, 5th)
   *   spread ≈ 1 → all 7 diatonic degrees roughly equally likely
   */
  _maybePluck(note, quickness, slowness, spread, now, degreeWeights = null) {
    if (!this._pluck || now < this._pluck.nextAllowed) return;

    // Fast motion fires more often; slow motion fires less (each note resonates longer)
    const trigProb = Math.max(quickness * 0.4, slowness * 0.2);
    if (Math.random() > trigProb) return;

    // Note selection weights.
    // If histogram data is available: each degree's weight = how much of its hue
    // range is present in the frame (already normalized + floored by update()).
    // Fallback (no histBins): chord tones boosted, non-chord tones gated by spread.
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

    // Octave: continuous shift driven by slowness (deep gong ↔ bright pluck)
    const octMult = Math.pow(2, 1 - slowness * 2);
    const freq = this.key.degrees[chosen].freq * octMult;
    if (!Number.isFinite(freq) || freq <= 0) return;

    // Attack: snappy for quickness, mallet-like bloom for slowness
    const attackTau = 0.003 + slowness * 0.017; // 3 ms → 20 ms
    // Decay: 40–90 ms τ for quickness, 400–550 ms τ for slowness
    const decayTau =
      0.04 + slowness * 0.36 + Math.random() * (0.05 + slowness * 0.15);
    // Slightly louder for resonant notes so they project through the pads
    const peak = 0.1 + slowness * 0.08;

    const pg = this._pluck.gain.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(0, now);
    pg.setTargetAtTime(peak, now, attackTau); // rise
    pg.setTargetAtTime(0, now + attackTau * 5, decayTau); // fall after bloom

    this._pluck.osc.frequency.cancelScheduledValues(now);
    this._pluck.osc.frequency.setValueAtTime(freq, now);

    // Cooldown: resonant notes need room to breathe before the next strike
    this._pluck.nextAllowed =
      now + 0.08 + (1 - Math.max(quickness, slowness)) * 0.12 + slowness * 0.4;
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Map activity (0–1) to glide duration (seconds).
   * Exponential curve: act=0 → glideMax (legato), act=1 → glideMin (staccato).
   */
  _glideTime(act) {
    const min = this._cfg.glideMin ?? 0.05;
    const max = this._cfg.glideMax ?? 3.0;
    const a = Math.max(0, Math.min(1, act));
    return max * Math.pow(min / max, a);
  }
}
