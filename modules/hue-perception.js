/**
 * modules/hue-perception.js
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
 * Both functions linearly interpolate a 360-entry precomputed LUT.
 * Round-trip error: |fromPerceptual(toPerceptual(h)) − h| < 1.5° for all h.
 */

// ── sRGB gamma decode ─────────────────────────────────────────────────────────
function _linearize(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ── HSV(h°, 1, 1) → linear sRGB [0,1]³ ──────────────────────────────────────
function _hsvToLinearRgb(h) {
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r, g, b;
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
// Forward transform; inverse of the oklchToLinearRGB in audio-renderer-gl.js.
// Matrix constants from Björn Ottosson's reference implementation (2020).
function _linearRgbToOklchHue(r, g, b) {
  // linear sRGB → LMS
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  // non-linear cone responses (cube root)
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  // LMS → oklab a, b channels (L not needed)
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  let p = Math.atan2(bk, a) * (180 / Math.PI);
  if (p < 0) p += 360;
  return p;
}

// ── Forward LUT: display (HSV) hue → perceptual (oklch) hue ─────────────────
// _fwd[h] = oklch hue for integer HSV hue h (0..359)
const _fwd = new Float64Array(360);
for (let h = 0; h < 360; h++) {
  const [r, g, b] = _hsvToLinearRgb(h);
  _fwd[h] = _linearRgbToOklchHue(r, g, b);
}

// ── Inverse LUT: perceptual (oklch) hue → display (HSV) hue ─────────────────
// For each integer perceptual hue pi, find the display hue h (as a float)
// such that toPerceptual(h) ≈ pi.  We scan for the consecutive pair of HSV
// integer samples that straddles pi in the forward direction, then lerp.
const _inv = new Float64Array(360);
for (let pi = 0; pi < 360; pi++) {
  let found = false;
  for (let h = 0; h < 360; h++) {
    const h1 = (h + 1) % 360;
    const p0 = _fwd[h];
    const p1 = _fwd[h1];
    // Forward arc p0 → p1 in [0, 360)
    let dp = p1 - p0;
    if (dp < 0) dp += 360;
    if (dp < 1e-9) continue; // degenerate (shouldn't happen for full-sat HSV)
    // Forward arc p0 → pi
    let dv = pi - p0;
    if (dv < 0) dv += 360;
    if (dv < dp) {
      _inv[pi] = h + dv / dp;
      found = true;
      break;
    }
  }
  if (!found) {
    // Fallback: use the closest forward entry (shouldn't be reached)
    let best = 0,
      bestDist = 360;
    for (let h = 0; h < 360; h++) {
      let d = Math.abs(_fwd[h] - pi);
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
function _lerpAngle(a, b, t) {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (((a + t * d) % 360) + 360) % 360;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a display (HSV) hue to a perceptual (oklch) hue.
 * @param {number} h  Display hue, any value (wraps to [0, 360))
 * @returns {number}  Perceptual hue in [0, 360)
 */
export function toPerceptual(h) {
  const hw = ((h % 360) + 360) % 360;
  const i = Math.floor(hw) % 360;
  return _lerpAngle(_fwd[i], _fwd[(i + 1) % 360], hw - i);
}

/**
 * Convert a perceptual (oklch) hue to a display (HSV) hue.
 * @param {number} p  Perceptual hue, any value (wraps to [0, 360))
 * @returns {number}  Display hue in [0, 360)
 */
export function fromPerceptual(p) {
  const pw = ((p % 360) + 360) % 360;
  const i = Math.floor(pw) % 360;
  return _lerpAngle(_inv[i], _inv[(i + 1) % 360], pw - i);
}

// ── Self-test ─────────────────────────────────────────────────────────────────
function _selftest() {
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
