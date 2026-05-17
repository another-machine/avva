/**
 * src/analysis/ema.ts — Exponential moving average utilities.
 */

/** Scalar EMA: prev approaches target at rate k (0 = frozen, 1 = instant). */
export function ema(prev: number, target: number, k: number): number {
  return prev + (target - prev) * k;
}

/** Circular EMA for hue (0–360°): always takes the shortest arc. */
export function emaHue(prev: number, target: number, k: number): number {
  const d = ((target - prev + 540) % 360) - 180;
  return (prev + d * k + 360) % 360;
}

/** Asymmetric EMA: separate rates for rising (attack) vs falling (release). */
export function emaAsym(
  prev: number,
  target: number,
  attack: number,
  release: number,
): number {
  return prev + (target - prev) * (target > prev ? attack : release);
}
