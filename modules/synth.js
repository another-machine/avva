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
  update({ hue, bri, act, actBg = 0, vy = 0.5 }) {
    if (!this.running || !this.key) return;

    // Clamp all inputs — NaN/Infinity from any signal will crash setTargetAtTime.
    const safeHue = Number.isFinite(hue) ? hue : 0;
    const safeBri = Number.isFinite(bri) ? Math.max(0, bri) : 0;
    // Use the larger of frame-diff activity and background-subtraction activity.
    // actBg catches slow movers that frame-diff misses (only sees edge pixels).
    const safeAct = Math.max(
      Number.isFinite(act) ? Math.max(0, Math.min(1, act)) : 0,
      Number.isFinite(actBg) ? Math.max(0, Math.min(1, actBg)) : 0,
    );
    const safeVy = Number.isFinite(vy) ? Math.max(0, Math.min(1, vy)) : 0.5;

    const note = this.key.hueToNote(safeHue);
    const now = this._actx.currentTime;
    // Time constant must be strictly positive — floor at 1 ms.
    const tau = Math.max(0.001, this._glideTime(safeAct) / 3);

    const vt = safeVy * 2;
    const trebleW = vt <= 1 ? (1 - vt) * safeBri : 0;
    const midW = (vt <= 1 ? vt : 2 - vt) * safeBri;
    const bassW = vt >= 1 ? (vt - 1) * safeBri : 0;
    const tierSignals = [bassW, midW, trebleW];

    this._tiers.forEach(({ octaveShift, voices }, ti) => {
      const freqScale = Math.pow(2, octaveShift);
      const targetGain = Math.max(0, (tierSignals[ti] * 0.25) / 3);

      note.triad.forEach(({ freq }, vi) => {
        const targetFreq = freq * freqScale;
        if (!Number.isFinite(targetFreq)) return;
        const { osc, gain } = voices[vi];
        osc.frequency.cancelAndHoldAtTime(now);
        osc.frequency.setTargetAtTime(targetFreq, now, tau);
        gain.gain.cancelAndHoldAtTime(now);
        gain.gain.setTargetAtTime(targetGain, now, tau);
      });
    });
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
