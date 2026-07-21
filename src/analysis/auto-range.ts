/**
 * AxisRange — adaptive per-axis normalization ("forgiving constraints").
 *
 * Tracks the observed low/high envelope of a signal with an asymmetric
 * follower: bounds *expand* quickly toward new extremes (τ ≈ 0.5 s) and
 * *contract* slowly back toward the recent range (τ = the configured window),
 * approximating a sliding-window percentile at O(1) cost. norm() remaps the
 * signal so whatever range the current scene actually produces spans the full
 * 0..1 — a dim gallery and a sunlit studio both exercise the piece's whole
 * expressive range.
 *
 * When the observed span is tiny (a static scene), norm() returns the raw
 * value instead of amplifying noise into a full-range thrash.
 */

const EXPAND_TAU = 0.5;
const MIN_SPAN = 0.05;

export class AxisRange {
  private _lo: number | null = null;
  private _hi: number | null = null;

  /** Feed one raw sample. dt in seconds; windowSec = contraction time-constant. */
  update(x: number, dt: number, windowSec: number): void {
    if (!Number.isFinite(x)) return;
    if (this._lo === null || this._hi === null) {
      this._lo = x;
      this._hi = x;
      return;
    }
    const kExpand = 1 - Math.exp(-dt / EXPAND_TAU);
    const kContract = 1 - Math.exp(-dt / Math.max(1, windowSec));
    this._lo += (x - this._lo) * (x < this._lo ? kExpand : kContract);
    this._hi += (x - this._hi) * (x > this._hi ? kExpand : kContract);
  }

  /** Remap x onto the tracked range, blended by amount (0 = raw, 1 = fully normalized). */
  apply(x: number, amount: number): number {
    if (amount <= 0 || this._lo === null || this._hi === null) return x;
    const span = this._hi - this._lo;
    if (span < MIN_SPAN) return x;
    const normed = Math.max(0, Math.min(1, (x - this._lo) / span));
    return x + (normed - x) * Math.max(0, Math.min(1, amount));
  }
}

/** A bank of AxisRange trackers keyed by axis name. */
export class AutoRange {
  private _ranges = new Map<string, AxisRange>();
  private _lastT = 0;
  private _dt = 1 / 60;

  /** Call once per frame before apply() calls — derives dt from a wall clock. */
  tick(nowMs: number): void {
    if (this._lastT > 0) {
      this._dt = Math.min(0.25, Math.max(0.001, (nowMs - this._lastT) / 1000));
    }
    this._lastT = nowMs;
  }

  /** Track raw x for `axis` and return it normalized by `amount` over `windowSec`. */
  apply(axis: string, x: number, amount: number, windowSec: number): number {
    let r = this._ranges.get(axis);
    if (!r) {
      r = new AxisRange();
      this._ranges.set(axis, r);
    }
    r.update(x, this._dt, windowSec);
    return r.apply(x, amount);
  }
}
