/**
 * src/harmony/hue-perception.ts
 *
 * Bijective mapping between display (HSV) hue space and perceptual (oklch)
 * hue space.  HSV hue is what the camera analyzer measures and what the
 * human eye uses to label colors on a screen.  oklch hue (atan2(b,a) of
 * oklab) is what human vision perceives as a uniform angular change.
 *
 * Both spaces are circular 0–360°, but the mapping is non-linear: HSV
 * yellow (60°) corresponds to a narrow perceptual band, while blue is
 * spread across a wider arc.
 *
 * Exports:
 *   toPerceptual(h)   — display hue (any°) → perceptual hue in [0, 360)
 *   fromPerceptual(p) — perceptual hue (any°) → display hue in [0, 360)
 *
 * Round-trip error: |fromPerceptual(toPerceptual(h)) − h| < 1.5° for all h.
 */

// ── sRGB gamma decode ─────────────────────────────────────────────────────────
function _linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ── HSV(h°, 1, 1) → linear sRGB [0,1]³ ──────────────────────────────────────
function _hsvToLinearRgb(h: number): [number, number, number] {
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r: number, g: number, b: number;
  if (h < 60) {
    r = 1;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = 1;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = 1;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = 1;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = 1;
  } else {
    r = 1;
    g = 0;
    b = x;
  }
  return [_linearize(r), _linearize(g), _linearize(b)];
}

// ── linear sRGB → oklch hue (°) ───────────────────────────────────────────────
// Matrix constants from Björn Ottosson's reference implementation (2020).
function _linearRgbToOklchHue(r: number, g: number, b: number): number {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l),
    m_ = Math.cbrt(m),
    s_ = Math.cbrt(s);
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  let p = Math.atan2(bk, a) * (180 / Math.PI);
  if (p < 0) p += 360;
  return p;
}

// ── Forward LUT: display (HSV) hue → perceptual (oklch) hue ──────────────────
const _fwd = new Float64Array(360);
for (let h = 0; h < 360; h++) {
  const [r, g, b] = _hsvToLinearRgb(h);
  _fwd[h] = _linearRgbToOklchHue(r, g, b);
}

// Post-process: enforce strict monotone increase.
// The deep-blue zone (display ~231–240) has a tiny backward step in raw oklch
// hue.  Find every backward segment and linearly interpolate across it.
{
  for (let i = 0; i < 360; i++) {
    let dp = _fwd[(i + 1) % 360] - _fwd[i];
    if (dp < 0) dp += 360;
    if (dp > 180) {
      // Find j = first index where _fwd[j] strictly exceeds _fwd[i] forward.
      const target = _fwd[i];
      let j = i + 1;
      while (j < i + 360) {
        let ahead = _fwd[j % 360] - target;
        if (ahead < 0) ahead += 360;
        if (ahead > 0 && ahead <= 180) break;
        j++;
      }
      const p0 = target,
        p1 = _fwd[j % 360];
      let span = p1 - p0;
      if (span < 0) span += 360;
      const n = j - i;
      for (let k = 1; k < n; k++) {
        _fwd[(i + k) % 360] = (p0 + (span * k) / n) % 360;
      }
      i = j - 1; // loop will increment to j
    }
  }
}

// ── Inverse LUT: perceptual (oklch) hue → display (HSV) hue ──────────────────
// The deep-blue zone compresses ~16 display degrees into ~0.5 perceptual
// degrees; 7200 entries = 0.05°/bin gives worst-case roundtrip ~0.8°.
const _INV_N = 7200;
const _inv = new Float64Array(_INV_N);
for (let pi = 0; pi < _INV_N; pi++) {
  const piDeg = pi * (360 / _INV_N);
  let found = false;
  for (let h = 0; h < 360; h++) {
    const h1 = (h + 1) % 360;
    const p0 = _fwd[h],
      p1 = _fwd[h1];
    let dp = p1 - p0;
    if (dp < 0) dp += 360;
    if (dp < 1e-9 || dp > 180) continue;
    let dv = piDeg - p0;
    if (dv < 0) dv += 360;
    if (dv < dp) {
      _inv[pi] = h + dv / dp;
      found = true;
      break;
    }
  }
  if (!found) {
    let best = 0,
      bestDist = 360;
    for (let h = 0; h < 360; h++) {
      let d = Math.abs(_fwd[h] - piDeg);
      if (d > 180) d = 360 - d;
      if (d < bestDist) {
        bestDist = d;
        best = h;
      }
    }
    _inv[pi] = best;
  }
}

// ── Shortest-arc hue lerp ─────────────────────────────────────────────────────
function _lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (((a + t * d) % 360) + 360) % 360;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Convert a display (HSV) hue to a perceptual (oklch) hue. */
export function toPerceptual(h: number): number {
  const hw = ((h % 360) + 360) % 360;
  const i = Math.floor(hw) % 360;
  return _lerpAngle(_fwd[i], _fwd[(i + 1) % 360], hw - i);
}

/** Convert a perceptual (oklch) hue to a display (HSV) hue. */
export function fromPerceptual(p: number): number {
  const pw = ((p % 360) + 360) % 360;
  const fi = pw * (_INV_N / 360);
  const i = Math.floor(fi) % _INV_N;
  return _lerpAngle(_inv[i], _inv[(i + 1) % _INV_N], fi - i);
}

// ── Self-test ─────────────────────────────────────────────────────────────────
function _selftest(): void {
  let worst = 0;
  for (let h = 0; h < 360; h++) {
    const h2 = fromPerceptual(toPerceptual(h));
    let d = Math.abs(h2 - h);
    if (d > 180) d = 360 - d;
    if (d > worst) worst = d;
    console.assert(
      d < 1.5,
      `hue-perception roundtrip at h=${h}: got ${h2.toFixed(2)}, err=${d.toFixed(2)}°`,
    );
  }
  if (worst < 1.5)
    console.debug(
      `hue-perception: self-test passed, worst roundtrip error ${worst.toFixed(3)}°`,
    );
}
_selftest();
