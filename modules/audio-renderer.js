/**
 * modules/audio-renderer.js
 *
 * Visual renderer for Program 2. Consumes AudioAnalyzer's frame.out
 * and paints a full-page canvas designed to be camera-ingestible by
 * Program 1's video Analyzer — same oklch palette, same vertical
 * brightness contract, motion correlated with audio activity.
 *
 * Layers, in paint order:
 *   1. Background fill — oklch(L, c, dominantHue); L scales with bri.
 *   2. Twelve chromatic wedges (polar) — each at its key-mapped hue;
 *      radius & lightness ∝ chroma[i]. Wedge rotation tracks chord
 *      changes plus a slow drift so the camera sees motion.
 *   3. Top/bottom brightness bands — white overlay alpha ∝ bands.hi /
 *      bands.lo. Drives video Analyzer's hi/lo readouts symmetrically.
 *   4. Chord-change pulse ring — expanding ring whenever the chord
 *      template lookup picks a new chord.
 *
 * Canvas backs into the body and is rendered at devicePixelRatio.
 * All colors are oklch strings; canvas supports them in evergreen
 * browsers (same as va.css's gradients).
 */

export class AudioRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Float32Array}      chromaHues  Hue for each chromatic class (Key.chromaticHues)
   * @param {object}            [opts]
   */
  constructor(canvas, chromaHues, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.chromaHues = chromaHues;
    this._opts = {
      bgChroma: 0.16,
      wedgeChroma: 0.22,
      driftRate: 0.0015, // radians per frame baseline rotation
      ...opts,
    };
    this._t = 0;
    this._rot = 0;
    this._pulseT = -1000;
    this.resize();
  }

  /** Re-sync canvas backing store with display size + dpr. */
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
  }

  /** Update chromatic hue table (e.g. after key/root/mode change). */
  setChromaHues(chromaHues) {
    this.chromaHues = chromaHues;
  }

  /**
   * Paint one frame.
   * @param {object} frame  AudioAnalyzer.tick() output
   */
  render(frame) {
    const { chroma, bands, hue, bri, act, chord, spread } = frame;
    const ctx = this.ctx;
    const w = this._w, h = this._h;
    const cx = w / 2, cy = h / 2;
    const maxR = Math.hypot(w, h) / 2;
    const t = ++this._t;

    // Rotation: slow drift + activity-driven boost. Motion is what the
    // video Analyzer's act/actBg signals lock onto.
    this._rot += this._opts.driftRate + act * 0.04;

    // ── 1. Background ─────────────────────────────────────────
    const bgL = 0.05 + Math.min(0.45, bri * 0.55);
    ctx.fillStyle = `oklch(${bgL.toFixed(3)} ${this._opts.bgChroma} ${hue.toFixed(1)})`;
    ctx.fillRect(0, 0, w, h);

    // ── 2. Twelve chromatic wedges ────────────────────────────
    // Each wedge spans 30° around the center. Sat (spread) compresses
    // their radii toward zero when audio is noisy so the visual collapses
    // toward background — mirrors how a noisy frame has no clear hue.
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const wedgeHalf = (Math.PI * 2) / 24;
    const focus = 1 - spread; // high when chord is clean

    for (let i = 0; i < 12; i++) {
      const p = chroma[i];
      if (p < 0.005) continue;
      const ang =
        (this.chromaHues[i] * Math.PI) / 180 - Math.PI / 2 + this._rot;
      const r = maxR * (0.12 + p * 0.95 * (0.5 + 0.5 * focus));
      const L = 0.45 + Math.min(0.45, p * 1.2);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang - wedgeHalf, ang + wedgeHalf);
      ctx.closePath();
      ctx.fillStyle = `oklch(${L.toFixed(3)} ${this._opts.wedgeChroma} ${this.chromaHues[i].toFixed(1)})`;
      ctx.fill();
    }
    ctx.restore();

    // ── 3. Top / bottom brightness banding ────────────────────
    // White overlay; alpha = band energy. Drives video Analyzer's hi/lo.
    const bandH = h / 3;
    if (bands.hi > 0.02) {
      const a = Math.min(0.6, bands.hi * 0.7);
      const g = ctx.createLinearGradient(0, 0, 0, bandH);
      g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, bandH);
    }
    if (bands.lo > 0.02) {
      const a = Math.min(0.6, bands.lo * 0.7);
      const g = ctx.createLinearGradient(0, h - bandH, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, `rgba(255,255,255,${a.toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, h - bandH, w, bandH);
    }

    // ── 4. Chord-change pulse ring ────────────────────────────
    if (chord.change) this._pulseT = t;
    const pulseAge = t - this._pulseT;
    if (pulseAge >= 0 && pulseAge < 45) {
      const p = pulseAge / 45;
      const r = p * maxR * 1.1;
      const alpha = (1 - p) * 0.7;
      ctx.strokeStyle = `oklch(0.9 0.2 ${hue.toFixed(1)} / ${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(2, (1 - p) * 10);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
