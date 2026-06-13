/**
 * src/render/audio-renderer-gl.ts
 *
 * WebGL2 renderer for the AUDIO→VIS side of the closed-loop harness.
 * TypeScript port of modules/audio-renderer-gl.js. Behaviour is identical.
 *
 * Single fullscreen quad; the fragment shader does all the work.
 * Frame-to-frame feedback via a ping-pong pair of RGBA8 textures.
 *
 * Constructor:
 *   new AudioRendererGL(canvas, degreeHues, opts?)
 *   degreeHues  — Float32Array(7) of sector-center hues from Key.degreeHues
 *   opts.feedback   — frame decay (default 0.92; closer to 1 = longer trail)
 *   opts.noiseScale — noise spatial scale (default 2.5)
 */

// ── Hue helpers ───────────────────────────────────────────────────────────────

// Shortest-arc lerp in display hue space (0–360). Ensures interpolation always
// goes the short way around the circle — critical for slot 0 which straddles 0°.
function _hueArcLerp(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return ((a + d * t) % 360 + 360) % 360;
}

// ── oklch → linear sRGB ───────────────────────────────────────────────────────
function oklchToLinearRGB(
  L: number,
  C: number,
  H: number,
): [number, number, number] {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.6956202966 * s),
  ];
}

// ── Vertex shader ─────────────────────────────────────────────────────────────
const VERT_SRC = `#version 300 es
out vec2 vUV;
void main() {
  vec2 pos;
  if      (gl_VertexID == 0) pos = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) pos = vec2( 3.0, -1.0);
  else                       pos = vec2(-1.0,  3.0);
  vUV         = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// ── Fragment shader factory ───────────────────────────────────────────────────
function makeFragSrc(nHues: number): string {
  return `#version 300 es
#define N_HUES ${nHues}
precision highp float;

in  vec2 vUV;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uDegrees[N_HUES];
uniform vec3  uDegreeRGB[N_HUES];
uniform float uBri;
uniform float uSpread;
uniform float uAct;
uniform float uBandLo;
uniform float uPulse;
uniform float uFeedback;
uniform float uBlobWarp;
uniform float uBlobSpeed;
uniform float uBlobDrive;
uniform float uBlobSize;
uniform float uBlobSharp;
uniform float uShiftSpeed;
uniform float uPulseReactivity;
uniform float uBriScale;
uniform float uTilt;
uniform float uPos;
uniform float uCtr;
uniform vec3  uDegreeRGB2[N_HUES];
// Per-slot signed edge bias in [-1, +1]. -1 pulls the blob's gradient mix
// toward the slot's left-boundary color, +1 toward the right-boundary color.
// Derived from where the continuous audio hue sits within / next to each slot.
uniform float uSlotEdge[N_HUES];
uniform sampler2D uPrev;

vec2 _h2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float snoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(_h2(i),                  f);
  float b = dot(_h2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(_h2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(_h2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float snoiseN(vec2 p) { return snoise(p) * 0.5 + 0.5; }

void main() {
  vec2 uv = vUV;

  // Correct for aspect ratio so blobs are round not oval
  float aspect = uRes.x / uRes.y;
  vec2 uvA = vec2(uv.x * aspect, uv.y);

  // Activity speeds everything up; chord-change pulse adds a velocity burst
  float tSpeed = uBlobSpeed + uAct * uBlobDrive;
  float t = uTime * (tSpeed + uPulse * uShiftSpeed);

  // Global rotation sense, free-running. dir = sin(uTime*dirRate) is the SIGNED
  // angular speed; swirl is its integral, so an orbit phase of (swirl * rate)
  // winds one way for ~39s (≈ a full turn), slows, then unwinds the other way.
  // Peak speed matches the old constant orbit; only the direction reverses.
  float dirRate = 0.08;
  float swirl   = -cos(uTime * dirRate) / dirRate;

  // Organic edge warp — small noise displacement before distance test.
  // Animate the warp noise on a small circular path instead of scrolling it
  // along one axis: the old t*0.09 on x made the blob's surface texture
  // ripple steadily leftward, which reads as the whole cloud streaming
  // right-to-left. Orbiting the offset keeps the shimmer with no net direction.
  float warpAmt = uBlobWarp + uAct * 0.014;
  vec2 warpFlow = vec2(cos(t * 0.10), sin(t * 0.10)) * 1.2;
  // Sample in aspect-corrected uvA space so the warp cells are isotropic on
  // wide displays (uv space stretches them ~aspect× horizontally).
  vec2 uvW = uvA + vec2(
    snoise(uvA * 2.8 + warpFlow),
    snoise(uvA * 2.8 + warpFlow + 5.7)
  ) * warpAmt;

  // ── Metaball accumulation ────────────────────────────────────────────────
  // Each active degree drives 2 blobs on independent Lissajous paths.
  // Field = Σ presence * (r² / d²); threshold crossing = inside a blob.
  float totalField = 0.0;
  vec3  totalColor = vec3(0.0);

  // pos shifts the whole cloud left/right; tilt translates it up/down
  // tilt=0 (bright top of frame) → blobs shift up; tilt=1 (bright bottom) → down
  float posShift   = (uPos - 0.5) * 0.4 * aspect;
  float tiltOffset = (0.5 - uTilt) * 0.4;

  for (int i = 0; i < N_HUES; i++) {
    float presence = uDegrees[i];
    if (presence < 0.005) continue;

    float fi   = float(i);
    float seed = fi * 1.618;
    float r    = (uBlobSize + presence * 0.10) * aspect;

    // Spread widens the Lissajous orbits: focused chord → tight cluster, rich → wide scatter
    float orbitA = 0.22 + uSpread * 0.20;
    float orbitB = orbitA * 0.83;

    // Blob A — true circle ON SCREEN. Screen position = uvA * H (uniform), so the
    // x and y orbit AMPLITUDES must be equal in uvA space to look circular. The
    // old orbitA*aspect on x (but plain orbitA on y) stretched the orbit into
    // a horizontal ellipse ~aspect× wide — the real source of the right-to-left
    // drift. Aspect stays only on the CENTER (0.5*aspect) to keep it centered.
    // wA bumped so a full loop takes ~25s and the curl is visible while watching.
    float wA = 0.24 + fi * 0.030;
    float pA = swirl * wA + seed;
    vec2 cA = vec2(
      posShift + 0.5 * aspect + orbitA * sin(pA)
                              + 0.07 * sin(t * (0.23 + fi * 0.041) + seed + 2.4),
      0.5 + tiltOffset        + orbitA * cos(pA)
                              + 0.07 * sin(t * (0.19 + fi * 0.031) + seed + 4.1)
    );

    // Blob B — circular too, counter-rotating (note the -cos) at a different
    // rate, so the pair sweeps around and through each other. No aspect on the
    // amplitudes here either, for the same reason.
    float wB = 0.20 + fi * 0.034;
    float pB = swirl * wB + seed + 3.1;
    vec2 cB = vec2(
      posShift + 0.5 * aspect + orbitB * sin(pB)
                              + 0.06 * sin(t * (0.31 + fi * 0.017) + seed + 0.8),
      0.5 + tiltOffset        - orbitB * cos(pB)
                              + 0.06 * sin(t * (0.27 + fi * 0.037) + seed + 2.0)
    );

    float rB = r * 0.72;
    vec2 dA  = uvW - cA;
    vec2 dB  = uvW - cB;
    float fA = (r  * r ) / (dot(dA, dA) + 0.0001);
    float fB = (rB * rB) / (dot(dB, dB) + 0.0001);

    float contrib = (fA + fB) * presence;
    totalField   += contrib;
    // Organic gradient: tilt pushes blend toward uDegreeRGB2 (boundary color)
    // at high tilt (treble-dominant), noise provides base organic movement.
    // Edge bias slides the blob's gradient toward whichever side of the
    // slot's hue arc the heard chroma is closest to (per-slot signed shift).
    // Orbit the color-noise offset (not a linear x-scroll) so the gradient
    // inside each blob shimmers in place instead of drifting right-to-left.
    vec2 colorFlow = vec2(cos(t * 0.03), sin(t * 0.03)) * 0.7;
    float blend = clamp(
      snoise(uvW * 1.8 + vec2(fi * 7.31, fi * 2.17) + colorFlow) * 0.5 + 0.5
        + uTilt * 0.3 - 0.15
        + uSlotEdge[i] * 0.4,
      0.0, 1.0);
    totalColor   += mix(uDegreeRGB[i], uDegreeRGB2[i], blend) * contrib;
  }

  vec3  blobColor = totalField > 0.001 ? totalColor / totalField : vec3(0.0);
  // CTR sharpens blobs: high contrast (peaky spectrum) → tighter isosurface edge
  float effectiveSharp = uBlobSharp * (1.4 - 0.8 * uCtr);
  float newAmount = smoothstep(1.2 - effectiveSharp, 1.2 + effectiveSharp, totalField);

  // ── Feedback (ping-pong) ─────────────────────────────────────────────────
  // Advect the persistent buffer along a turning flow. What reads as "the flow"
  // is the noise pattern sliding, and its direction is the VELOCITY of flowScroll
  // (its tangent), not its position. So to make the drift visibly turn, the
  // heading must sweep through all directions over seconds, not minutes.
  // Small amplitude × higher frequency keeps the drift speed (~0.06) the same
  // while rotating the heading roughly once every ~15s. Slightly different freqs
  // per axis (incommensurate) make it precess and wander instead of looping.
  vec2 flowScroll = vec2(
    0.14 * sin(uTime * 0.40) + 0.05 * sin(uTime * 0.23 + 1.3),
    0.14 * cos(uTime * 0.35) + 0.05 * sin(uTime * 0.29 + 4.1)
  );
  float driftAmt = 0.0015 + uAct * 0.002;
  // Sample noise in aspect-corrected uvA space (isotropic cells), and divide the
  // x displacement by aspect so a unit of drift moves the same number of PHYSICAL
  // pixels horizontally as vertically. driftUV is in uv space, where x spans the
  // full width — without /aspect, on a 2.85:1 display the feedback smears stretch
  // ~2.85x horizontally. That anisotropy was the right-to-left streaking.
  vec2 driftRaw = vec2(
    snoise(uvA * 4.0 + flowScroll),
    snoise(uvA * 4.0 + flowScroll + 100.0)
  ) * driftAmt;
  vec2 driftUV = uv + vec2(driftRaw.x / aspect, driftRaw.y);
  vec4 prev = texture(uPrev, clamp(driftUV, 0.0, 1.0));

  // Background glow — centered at (pos, tilt), chord-tinted, BRI-driven
  // tilt=0 maps to top of screen (GL y=1); tilt=1 to bottom (GL y=0)
  vec3 bgColor = totalField > 0.001 ? totalColor / totalField : vec3(0.0);
  float bgDist = dot(uvA, uvA);
  float bgGlow = exp(-bgDist * 2.5) * (uBri + uBandLo * 0.3) * 0.4;

  vec3 bgBase = prev.rgb * uFeedback + bgColor * bgGlow;
  vec3 base = mix(bgBase, blobColor, newAmount);

  // ── Brightness ───────────────────────────────────────────────────────────
  float bScale = uBri * uBriScale;
  base *= clamp(max(bScale, newAmount * 0.55), 0.0, 1.0);
  float briOver = max(0.0, bScale - 1.0);
  base += blobColor * briOver * 0.5;

  // ── Band-driven pulse blobs ───────────────────────────────────────────────
  // Soft Gaussian glows on independent Lissajous paths (distinct phase from
  // the metaballs so they drift away from center and look randomly placed).
  // exp(-d²/2σ²) gives a smooth, naturally-blurred profile — no threshold.
  float pulseField = 0.0;
  for (int i = 0; i < N_HUES; i++) {
    float presence = uDegrees[i];
    if (presence < 0.005) continue;
    float fi   = float(i);
    float seed = fi * 2.399; // golden-angle offset — different from main blobs
    // σ controls glow radius; larger → wider, softer bloom
    float sigma = (0.13 + presence * 0.09) * aspect;
    // Circular (quadrature) orbit, no aspect on the AMPLITUDE — same un-stretch
    // fix as the main blobs. The old 0.32*aspect on x (plain 0.32 on y), plus a
    // slower x frequency, made these big blooms sweep nearly the full screen
    // width horizontally — the main piece of the residual right-to-left.
    float wP = 0.15 + fi * 0.022;
    float pP = swirl * wP + seed + 1.2;
    vec2 cP = vec2(
      0.5 * aspect + 0.32 * sin(pP)
                   + 0.09 * sin(t * (0.19 + fi * 0.053) + seed + 3.7),
      0.5          + 0.32 * cos(pP)
                   + 0.09 * sin(t * (0.24 + fi * 0.043) + seed + 0.9)
    );
    vec2 dP = uvW - cP;
    float g = exp(-dot(dP, dP) / (2.0 * sigma * sigma));
    pulseField += g * presence * (uBri * uCtr + uTilt * 0.3) * uPulseReactivity;
  }
  float pStr = clamp(pulseField, 0.0, 1.0) * 0.7;
  vec3 pOv = mix(2.0 * base * blobColor, 1.0 - 2.0 * (1.0 - base) * (1.0 - blobColor), step(0.5, base));
  base = mix(base, pOv, pStr);

  // ── Chord-change pulse: fragmented color burst ───────────────────────────
  base += vec3(uPulse * 0.035);

  // ── Film grain ───────────────────────────────────────────────────────────
  base += vec3(snoise(uv * uRes / 2.5 + vec2(uTime * 8.0)))
        * (0.03 + uAct * 0.045);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

// ── Aurora fragment shader factory ───────────────────────────────────────────
// Alternative "style" to the metaball blobs. Identical uniform set, identical
// palette colors (oklch slot gradients) and brightness model — but instead of
// discrete round blobs the chord paints flowing, marbled veils via a
// domain-warped fBm field. Reads as drifting smoke / aurora curtains rather
// than a lava lamp, while presenting the same colors and loudness response.
function makeAuroraFragSrc(nHues: number): string {
  return `#version 300 es
#define N_HUES ${nHues}
precision highp float;

in  vec2 vUV;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uDegrees[N_HUES];
uniform vec3  uDegreeRGB[N_HUES];
uniform float uBri;
uniform float uSpread;
uniform float uAct;
uniform float uBandLo;
uniform float uPulse;
uniform float uFeedback;
uniform float uBlobWarp;
uniform float uBlobSpeed;
uniform float uBlobDrive;
uniform float uBlobSize;
uniform float uBlobSharp;
uniform float uShiftSpeed;
uniform float uPulseReactivity;
uniform float uBriScale;
uniform float uTilt;
uniform float uPos;
uniform float uCtr;
uniform vec3  uDegreeRGB2[N_HUES];
uniform float uSlotEdge[N_HUES];
uniform sampler2D uPrev;

vec2 _h2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float snoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(_h2(i),                  f);
  float b = dot(_h2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(_h2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(_h2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float snoiseN(vec2 p) { return snoise(p) * 0.5 + 0.5; }

// 4-octave fractal Brownian motion — the base texture for the veils.
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * snoise(p); p *= 2.0; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = vUV;
  float aspect = uRes.x / uRes.y;
  vec2 uvA = vec2(uv.x * aspect, uv.y);

  // Activity speeds the flow; chord-change pulse adds a velocity burst.
  float tSpeed = uBlobSpeed + uAct * uBlobDrive;
  float t = uTime * (tSpeed + uPulse * uShiftSpeed);

  // POS shifts the field left/right, TILT up/down (same sense as the blob view).
  vec2 p = uvA;
  p.x -= (uPos - 0.5) * 0.5 * aspect;
  p.y -= (0.5 - uTilt) * 0.4;

  // SPR sets turbulence scale: focused chord -> broad smooth veils, rich chord
  // -> fine filaments. Size nudges the overall feature scale (bigger = coarser).
  float scale = mix(1.3, 3.2, uSpread) / max(0.4, uBlobSize * 2.5);

  // Center p before multiplying by scale so zoom origin is screen center, not
  // bottom-left (which is where p=uvA starts). Without this, audio-driven SPR
  // changes cause the whole field to zoom from the corner.
  vec2 pC = p - vec2(0.5 * aspect, 0.5);

  // Two wandering flow offsets, one per warp octave — same turning-drift idea as
  // the blob feedback. CRITICAL: these must be bounded oscillations, NOT a linear
  // t-scroll. A term like (... + 0.1*t) added to the sample coord advances the
  // pattern at constant velocity along one axis, which reads as the whole field
  // sliding toward a corner. Incommensurate sin/cos keep the offset bounded so
  // the field morphs and locally drifts, but with no net heading. Warp widens
  // the path so the streaming is more pronounced.
  float warpAmp = 0.5 + uBlobWarp * 4.0;
  vec2 flow = vec2(cos(t * 0.10) + 0.5 * sin(t * 0.043),
                   sin(t * 0.08) + 0.5 * cos(t * 0.037)) * warpAmp;
  vec2 flow2 = vec2(sin(t * 0.11) + 0.5 * cos(t * 0.037),
                    cos(t * 0.09) + 0.5 * sin(t * 0.041)) * warpAmp;

  // Domain-warped fBm — marbled, smoke-like structure. Each octave evolves only
  // through its bounded flow offset, so there is no constant-velocity drift.
  vec2 q = vec2(fbm(pC * scale + flow),
                fbm(pC * scale + flow + 7.3));
  vec2 r = vec2(fbm(pC * scale + 1.7 * q + flow2),
                fbm(pC * scale + 1.7 * q + flow2 + 5.1));
  float master = clamp(fbm(pC * scale + 2.0 * r) * 0.5 + 0.5, 0.0, 1.0);

  // ── Palette veils ──────────────────────────────────────────────────────────
  // Each active slot weaves its own band through the warped field, tinted with
  // that slot's gradient (the same oklch boundary colors the blobs use).
  float totalW = 0.0;
  vec3  totalColor = vec3(0.0);
  float softness   = clamp(uBlobSharp * 0.5, 0.04, 0.7); // veil edge width
  float ctrTighten = 0.7 + 0.6 * uCtr;                   // CTR tightens bands
  for (int i = 0; i < N_HUES; i++) {
    float presence = uDegrees[i];
    if (presence < 0.005) continue;
    float fi   = float(i);
    float band = fbm(pC * scale + 1.7 * r + vec2(fi * 3.1, fi * 1.7)) * 0.5 + 0.5;
    band = pow(band, ctrTighten);
    float w = smoothstep(0.5 - softness, 0.5 + softness, band);
    // Gradient across the veil: tilt + per-slot edge bias slide lo<->hi color.
    float blend = clamp(band + uTilt * 0.3 - 0.15 + uSlotEdge[i] * 0.4, 0.0, 1.0);
    vec3  c = mix(uDegreeRGB[i], uDegreeRGB2[i], blend);
    float contrib = w * presence;
    totalColor += c * contrib;
    totalW     += contrib;
  }
  vec3  veilColor = totalW > 0.001 ? totalColor / totalW : vec3(0.0);
  float coverage  = clamp(totalW, 0.0, 1.0);

  float bScale = uBri * uBriScale;
  // Luminous ribbons where the master field crests — the aurora's bright streaks.
  float crest = smoothstep(0.55, 0.95, master);

  // ── Feedback (ping-pong), advected along a turning flow ─────────────────────
  vec2 flowScroll = vec2(
    0.14 * sin(uTime * 0.40) + 0.05 * sin(uTime * 0.23 + 1.3),
    0.14 * cos(uTime * 0.35) + 0.05 * sin(uTime * 0.29 + 4.1)
  );
  float driftAmt = 0.0015 + uAct * 0.002;
  vec2 driftRaw = vec2(
    snoise(uvA * 4.0 + flowScroll),
    snoise(uvA * 4.0 + flowScroll + 100.0)
  ) * driftAmt;
  vec2 driftUV = uv + vec2(driftRaw.x / aspect, driftRaw.y);
  vec4 prev = texture(uPrev, clamp(driftUV, 0.0, 1.0));

  // Background glow centered at (pos, tilt), chord-tinted, BRI-driven.
  // tilt=0 maps to top of screen (GL y=1); tilt=1 to bottom (GL y=0).
  vec2  glowCtr = vec2(0.5 * aspect + (uPos - 0.5) * 0.5 * aspect, 1.0 - uTilt);
  float bgDist  = dot(uvA - glowCtr, uvA - glowCtr);
  float bgGlow  = exp(-bgDist * 2.5) * (uBri + uBandLo * 0.3) * 0.4;

  vec3 bgBase = prev.rgb * uFeedback + veilColor * bgGlow;
  vec3 base   = mix(bgBase, veilColor, coverage);

  // ── Brightness — same model as the blob view ───────────────────────────────
  base *= clamp(max(bScale, coverage * 0.55), 0.0, 1.0);
  float briOver = max(0.0, bScale - 1.0);
  base += veilColor * briOver * 0.5;
  // Crest highlight rides on top, scaled by loudness.
  base += veilColor * crest * coverage * (0.35 + bScale * 0.5);

  // ── Band-driven pulse glows (same soft Gaussian bloom as the blob view) ─────
  float pulseField = 0.0;
  for (int i = 0; i < N_HUES; i++) {
    float presence = uDegrees[i];
    if (presence < 0.005) continue;
    float fi    = float(i);
    float seed  = fi * 2.399;
    float sigma = (0.13 + presence * 0.09) * aspect;
    float wP = 0.15 + fi * 0.022;
    float pP = t * wP + seed + 1.2;
    vec2  cP = vec2(
      0.5 * aspect + 0.32 * sin(pP) + 0.09 * sin(t * (0.19 + fi * 0.053) + seed + 3.7),
      0.5          + 0.32 * cos(pP) + 0.09 * sin(t * (0.24 + fi * 0.043) + seed + 0.9)
    );
    vec2  dP = uvA - cP;
    float g  = exp(-dot(dP, dP) / (2.0 * sigma * sigma));
    pulseField += g * presence * (uBri * uCtr + uTilt * 0.3) * uPulseReactivity;
  }
  float pStr = clamp(pulseField, 0.0, 1.0) * 0.7;
  vec3 pOv = mix(2.0 * base * veilColor, 1.0 - 2.0 * (1.0 - base) * (1.0 - veilColor), step(0.5, base));
  base = mix(base, pOv, pStr);

  // ── Chord-change flash: fragmented color burst ──────────────────────────────
  base += vec3(uPulse * 0.035);

  // ── Film grain ──────────────────────────────────────────────────────────────
  base += vec3(snoise(uv * uRes / 2.5 + vec2(uTime * 8.0)))
        * (0.03 + uAct * 0.045);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

// ── Chladni base modes: (m,n) per palette slot ────────────────────────────────
// Low-order, mixed parity so adjacent slots never share the same nodal topology.
// Indexed i % 8; TILT adds a continuous shift so TILT=0 → simple, TILT=1 → +3.
const CHLADNI_BASE_MODES: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 3], [1, 3], [3, 4], [2, 5], [1, 4], [3, 5], [4, 5],
];

// ── Chladni background / sheen fragment shader ────────────────────────────────
// Same uniform header as blobs/aurora so all existing plumbing works unchanged.
// Renders: trail-decay feedback + faint nodal-line sheen + chord flash + grain.
function makeChladniBgFragSrc(nHues: number): string {
  return `#version 300 es
#define N_HUES ${nHues}
#define PI 3.14159265358979
precision highp float;

in  vec2 vUV;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uDegrees[N_HUES];
uniform vec3  uDegreeRGB[N_HUES];
uniform float uBri;
uniform float uSpread;
uniform float uAct;
uniform float uBandLo;
uniform float uPulse;
uniform float uFeedback;
uniform float uBlobWarp;
uniform float uBlobSpeed;
uniform float uBlobDrive;
uniform float uBlobSize;
uniform float uBlobSharp;
uniform float uShiftSpeed;
uniform float uPulseReactivity;
uniform float uBriScale;
uniform float uTilt;
uniform float uPos;
uniform float uCtr;
uniform vec3  uDegreeRGB2[N_HUES];
uniform float uSlotEdge[N_HUES];
uniform sampler2D uPrev;
uniform float uModeM[N_HUES];
uniform float uModeN[N_HUES];
uniform float uModeS;

vec2 _h2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float snoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(_h2(i),                  f);
  float b = dot(_h2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(_h2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(_h2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float snoiseN(vec2 p) { return snoise(p) * 0.5 + 0.5; }

float chladniW(vec2 p, float m, float n) {
  return cos(m * PI * p.x) * cos(n * PI * p.y)
       + uModeS * cos(n * PI * p.x) * cos(m * PI * p.y);
}

float chladniD(vec2 p) {
  float kSpr = mix(2.5, 1.0, uSpread);
  float d = 0.0;
  for (int i = 0; i < N_HUES; i++)
    d += pow(max(uDegrees[i], 0.0), kSpr) * chladniW(p, uModeM[i], uModeN[i]);
  return d;
}

void main() {
  vec2 uv = vUV;
  float aspect = uRes.x / uRes.y;
  vec2 uvA = vec2(uv.x * aspect, uv.y);

  // Time scaled by speed + activity, same as blobs/aurora — used by pulse bloom
  float tSpeed = uBlobSpeed + uAct * uBlobDrive;
  float t = uTime * (tSpeed + uPulse * uShiftSpeed);

  // Trail decay: subtle turning-flow advection (same pattern as blobs)
  vec2 flowScroll = vec2(
    0.14 * sin(uTime * 0.40) + 0.05 * sin(uTime * 0.23 + 1.3),
    0.14 * cos(uTime * 0.35) + 0.05 * sin(uTime * 0.29 + 4.1)
  );
  float driftAmt = 0.0004 + uAct * 0.0006;
  vec2 driftRaw = vec2(
    snoise(uvA * 4.0 + flowScroll),
    snoise(uvA * 4.0 + flowScroll + 100.0)
  ) * driftAmt;
  vec2 driftUV = uv + vec2(driftRaw.x / aspect, driftRaw.y);
  vec4 prev = texture(uPrev, clamp(driftUV, 0.0, 1.0));
  vec3 base = prev.rgb * uFeedback;

  // Slot color blend for the sheen tint
  float kSpr = mix(2.5, 1.0, uSpread);
  vec3 totalColor = vec3(0.0);
  float totalW = 0.0;
  for (int i = 0; i < N_HUES; i++) {
    float wi = pow(max(uDegrees[i], 0.0), kSpr) + 1e-6;
    float blend = clamp(0.5 + uTilt * 0.3 - 0.15 + uSlotEdge[i] * 0.4, 0.0, 1.0);
    totalColor += mix(uDegreeRGB[i], uDegreeRGB2[i], blend) * wi;
    totalW += wi;
  }
  vec3 sheenColor = totalColor / totalW;

  // Plate sheen: faint nodal glow + antinode tint
  // uBlobSharp (Softness) controls glow width: low = tight bright lines, high = wide diffuse halo.
  // 0.06 + sharp*0.3 → at default 0.4 = 0.18 (same as before); max 1.5 → 0.51 wide.
  float Dv = chladniD(uv);
  float nodEdge = 0.06 + uBlobSharp * 0.3;
  float nodalGlow = 1.0 - smoothstep(0.0, nodEdge, abs(Dv));
  float briScale = uBri * uBriScale;
  base += sheenColor * nodalGlow * (0.05 + briScale * 0.07);
  base += sheenColor * abs(Dv) * 0.015;

  // Orbit-based excitation glows — same Gaussian bloom as blobs/aurora.
  // uPulseReactivity scales intensity; orbits travel at the chord-speed t.
  float pulseField = 0.0;
  for (int i = 0; i < N_HUES; i++) {
    float presence = uDegrees[i];
    if (presence < 0.005) continue;
    float fi    = float(i);
    float seed  = fi * 2.399;
    float sigma = (0.13 + presence * 0.09) * aspect;
    float wP = 0.15 + fi * 0.022;
    float pP = t * wP + seed + 1.2;
    vec2  cP = vec2(
      0.5 * aspect + 0.32 * sin(pP) + 0.09 * sin(t * (0.19 + fi * 0.053) + seed + 3.7),
      0.5          + 0.32 * cos(pP) + 0.09 * sin(t * (0.24 + fi * 0.043) + seed + 0.9)
    );
    vec2  dP = uvA - cP;
    float g  = exp(-dot(dP, dP) / (2.0 * sigma * sigma));
    pulseField += g * presence * (uBri * uCtr + uTilt * 0.3) * uPulseReactivity;
  }
  float pStr = clamp(pulseField, 0.0, 1.0) * 0.7;
  vec3 pOv = mix(2.0 * base * sheenColor, 1.0 - 2.0 * (1.0 - base) * (1.0 - sheenColor), step(0.5, base));
  base = mix(base, pOv, pStr);

  base += vec3(uPulse * 0.035);

  // Film grain
  base += vec3(snoise(uv * uRes / 2.5 + vec2(uTime * 8.0)))
        * (0.03 + uAct * 0.045);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

// ── Chladni particle simulation update shader ─────────────────────────────────
// Runs once per frame over the 512×512 position/velocity texture (ping-pong).
// Force = -sign(D)·∇D pushes particles toward nodal lines (D≈0).
function makeChladniSimFragSrc(nHues: number): string {
  return `#version 300 es
#define N_HUES ${nHues}
#define PI 3.14159265358979
precision highp float;

in  vec2 vUV;
out vec4 outPos;

uniform sampler2D uPosTex;
uniform vec2  uSimRes;
uniform float uTime;
uniform float uDt;
uniform float uModeM[N_HUES];
uniform float uModeN[N_HUES];
uniform float uModeS;
uniform float uDegrees[N_HUES];
uniform float uBri;
uniform float uAct;
uniform float uSpread;
uniform float uPulse;
uniform float uBlobSpeed;
uniform float uBlobDrive;
uniform float uBlobWarp;
uniform float uShiftSpeed;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

float chladniW(vec2 p, float m, float n) {
  return cos(m * PI * p.x) * cos(n * PI * p.y)
       + uModeS * cos(n * PI * p.x) * cos(m * PI * p.y);
}

float chladniD(vec2 p) {
  float kSpr = mix(2.5, 1.0, uSpread);
  float d = 0.0;
  for (int i = 0; i < N_HUES; i++)
    d += pow(max(uDegrees[i], 0.0), kSpr) * chladniW(p, uModeM[i], uModeN[i]);
  return d;
}

void main() {
  vec4 P = texture(uPosTex, vUV);
  vec2 p = P.xy;
  vec2 v = P.zw;

  // Gradient via central differences
  float e = 0.0015;
  float Dp = chladniD(p);
  vec2 grad = vec2(
    chladniD(p + vec2(e, 0.0)) - chladniD(p - vec2(e, 0.0)),
    chladniD(p + vec2(0.0, e)) - chladniD(p - vec2(0.0, e))
  ) / (2.0 * e);

  // Force: descend |D| landscape; BRI scales drive strength
  float drive = 0.018 * (0.35 + uBri + uAct * uBlobDrive * 0.3);
  vec2 force = -sign(Dp) * grad * drive;

  // Jitter: thermal noise (ACT) + chord-change scatter (pulse)
  vec2 rnd = hash22(p * 311.7 + vUV * 97.3 + uTime * 0.1) * 2.0 - 1.0;
  float jit = uBlobWarp * 8.0 * (0.15 + uAct) + uPulse * uShiftSpeed * 0.02;

  float dt = uDt * (0.5 + uBlobSpeed);
  v = v * 0.88 + force + rnd * jit;
  v = clamp(v, vec2(-0.02), vec2(0.02));
  p += v * dt * 60.0;

  // Inward edge repulsion: pushes particles away from the plate boundary
  float edgeMask = 1.0 - smoothstep(0.0, 0.04,
    min(min(p.x, p.y), min(1.0 - p.x, 1.0 - p.y)));
  v += (vec2(0.5) - p) * edgeMask * 0.004;
  p = clamp(p, vec2(0.004), vec2(0.996));

  outPos = vec4(p, v);
}`;
}

// ── Chladni point vertex shader factory ──────────────────────────────────────
// Custom vertex shader for the gl.POINTS pass. Reads particle position from the
// sim texture and computes per-grain color from weighted slot contributions.
function makeChladniPointVertSrc(nHues: number, simN: number): string {
  return `#version 300 es
#define N_HUES ${nHues}
#define SIM_N ${simN}
#define PI 3.14159265358979
precision highp float;

uniform sampler2D uPosTex;
uniform vec2  uRes;
uniform float uModeM[N_HUES];
uniform float uModeN[N_HUES];
uniform float uModeS;
uniform float uDegrees[N_HUES];
uniform float uSlotEdge[N_HUES];
uniform vec3  uDegreeRGB[N_HUES];
uniform vec3  uDegreeRGB2[N_HUES];
uniform float uTilt;
uniform float uSpread;
uniform float uCtr;
uniform float uBri;
uniform float uBriScale;
uniform float uBlobSize;

out vec3  vColor;
out float vGlow;

float chladniW(vec2 p, float m, float n) {
  return cos(m * PI * p.x) * cos(n * PI * p.y)
       + uModeS * cos(n * PI * p.x) * cos(m * PI * p.y);
}

void main() {
  ivec2 tc = ivec2(gl_VertexID % SIM_N, gl_VertexID / SIM_N);
  vec4 P = texelFetch(uPosTex, tc, 0);
  vec2 p = P.xy;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  float dpr = max(uRes.y / 1080.0, 0.5);
  gl_PointSize = clamp((0.6 + uBlobSize * 4.0) * dpr, 1.0, 4.0);

  // Weighted slot color from local mode contributions (same gradient law as blobs)
  float kSpr = mix(3.0, 1.0, uSpread);
  vec3  acc = vec3(0.0);
  float wSum = 0.0;
  float dLocal = 0.0;
  for (int i = 0; i < N_HUES; i++) {
    float Wi = chladniW(p, uModeM[i], uModeN[i]);
    float wi = pow(max(uDegrees[i], 0.0) * abs(Wi), kSpr) + 1e-6;
    float blend = clamp(0.5 + uTilt * 0.3 - 0.15 + uSlotEdge[i] * 0.4, 0.0, 1.0);
    acc += mix(uDegreeRGB[i], uDegreeRGB2[i], blend) * wi;
    wSum += wi;
    dLocal += uDegrees[i] * Wi;
  }
  vColor = acc / wSum;
  // CTR: dim off-node grains → sharper nodal figures
  vGlow = mix(1.0, exp(-abs(dLocal) * 7.0), uCtr) * (0.25 + uBri * uBriScale * 0.6);
}`;
}

// ── Chladni point fragment shader (constant — not n-dependent) ────────────────
const CHLADNI_POINT_FRAG = `#version 300 es
precision highp float;
in  vec3  vColor;
in  float vGlow;
out vec4  outColor;
void main() {
  vec2  q = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.15, length(q));
  outColor = vec4(vColor * vGlow * a * 0.06, 1.0);
}`;

// ── Chladni seed fragment shader — randomises particle positions at startup ────
const CHLADNI_SEED_FRAG = `#version 300 es
precision highp float;
in  vec2  vUV;
out vec4  outPos;
uniform float uSeed;
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}
void main() {
  vec2 pos = hash22(vUV * 1371.3 + uSeed * 100.0) * 0.96 + 0.02;
  outPos = vec4(pos, 0.0, 0.0);
}`;

// ── Types ─────────────────────────────────────────────────────────────────────

import type { AudioFrame } from "../analysis/audio-analyzer.js";
import { toPerceptual } from "../harmony/hue-perception.js";

/** Observable snapshot of what the GL renderer sent to the shader this frame. */
export interface VisualUniforms {
  slotWeights: Float32Array;
  pulse: number;
  bri: number;
  spread: number;
  act: number;
  bandLo: number;
  bandHi: number;
  tilt: number;
  pos: number;
  ctr: number;
}

export interface AudioRendererGLOpts {
  feedback?: number;
  noiseScale?: number;
  mode?: "diatonic" | "chromatic";
  chromaticHues?: Float32Array | null;
}

interface TexFB {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

// ── AudioRendererGL ───────────────────────────────────────────────────────────

export class AudioRendererGL {
  readonly canvas: HTMLCanvasElement;

  private readonly _chromaticHues: Float32Array | null;
  private readonly _mode: string;
  private _feedbackVal: number;
  private _blobWarpVal: number;
  private _blobSpeedVal = 1.0;
  private _blobDriveVal = 1.2;
  private _blobSizeVal = 0.2;
  private _blobSharpVal = 0.4;
  private _shiftSpeedVal = 1.5;
  private _pulseReactivityVal = 1.0;
  private _briScaleVal = 1.5;
  private readonly _gl: WebGL2RenderingContext;
  // Compiled programs, keyed by `${style}:${nHues}` (e.g. "blobs:7", "aurora:5").
  private readonly _progCache: Map<
    string,
    { prog: WebGLProgram; u: UniformMap }
  >;
  private readonly _vao: WebGLVertexArrayObject;

  private _style = "blobs";
  private _activeN: number;
  private _prog: WebGLProgram;
  private _u: UniformMap;
  private _degreeRGBBuf: Float32Array;
  private _degreeRGB2Buf: Float32Array;
  private _slotWeights: Float32Array;
  private _slotEdgeBuf: Float32Array;
  private _pulse = 0;
  private readonly _startT: number;
  private _w = 0;
  private _h = 0;
  private _texA: TexFB | null = null;
  private _texB: TexFB | null = null;

  // ── Chladni particle simulation state (allocated lazily on first activation) ──
  private readonly _simN = 512;      // sim texture side: 512² = 262,144 particles
  private _simPosA: TexFB | null = null;
  private _simPosB: TexFB | null = null;
  private _simInternalFmt = 0;       // gl.RGBA32F or gl.RGBA16F after probe
  private _simFloatType = 0;         // gl.FLOAT or gl.HALF_FLOAT after probe
  private _chladniReady = false;     // sim textures + programs ready
  private _chladniOk = true;         // false if float FBO probe failed
  private _chladniSimProg: WebGLProgram | null = null;
  private _chladniSimU: UniformMap | null = null;
  private _chladniPtsProg: WebGLProgram | null = null;
  private _chladniPtsU: UniformMap | null = null;
  private _tiltSm = 0.5;            // EMA-smoothed tilt (load-bearing: raw tilt thrashes modes)
  private _posSm = 0.5;             // EMA-smoothed pos
  private _modeS = 1.0;             // plate symmetry scalar derived from pos
  private _modeM: Float32Array | null = null;  // per-slot m mode order
  private _modeN: Float32Array | null = null;  // per-slot n mode order
  private _lastBri = 0;
  private _lastAct = 0;
  private _lastSpread = 0.5;
  private _lastTilt = 0.5;
  private _lastPos = 0.5;
  private _lastCtr = 0;

  constructor(
    canvas: HTMLCanvasElement,
    degreeHues: Float32Array = new Float32Array(7),
    opts: AudioRendererGLOpts = {},
  ) {
    this.canvas = canvas;
    this._chromaticHues = opts.chromaticHues ?? null;
    this._mode = opts.mode ?? "diatonic";
    this._feedbackVal = opts.feedback ?? 0.92;
    this._blobWarpVal = opts.noiseScale ?? 0.022;

    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("AudioRendererGL: WebGL2 is not available.");
    this._gl = gl;

    this._progCache = new Map();
    this._activeN = 7;
    const p7 = this._compile(makeFragSrc(7));
    const u7 = this._cacheUniforms(p7);
    this._progCache.set(this._progKey("blobs", 7), { prog: p7, u: u7 });
    this._prog = p7;
    this._u = u7;

    this._degreeRGBBuf = new Float32Array(7 * 3);
    this._degreeRGB2Buf = new Float32Array(7 * 3);
    this._slotWeights = new Float32Array(7);
    this._slotEdgeBuf = new Float32Array(7);
    this._fillDegreeRGB(degreeHues);

    this._vao = gl.createVertexArray()!;
    gl.bindVertexArray(this._vao);

    gl.useProgram(this._prog);
    gl.uniform1f(this._u.uFeedback, this._feedbackVal);
    gl.uniform1f(this._u.uBlobWarp, this._blobWarpVal);
    gl.uniform1f(this._u.uBlobSpeed, this._blobSpeedVal);
    gl.uniform1f(this._u.uBlobDrive, this._blobDriveVal);
    gl.uniform1f(this._u.uBlobSize, this._blobSizeVal);
    gl.uniform1f(this._u.uBlobSharp, this._blobSharpVal);
    gl.uniform1f(this._u.uShiftSpeed, this._shiftSpeedVal);
    gl.uniform1f(this._u.uPulseReactivity, this._pulseReactivityVal);
    gl.uniform1f(this._u.uBriScale, this._briScaleVal);

    this._startT = performance.now();
    this.resize();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Update the frame-feedback decay coefficient on all cached programs. */
  setFeedback(v: number): void {
    this._feedbackVal = v;
    const gl = this._gl;
    for (const [, entry] of this._progCache) {
      gl.useProgram(entry.prog);
      gl.uniform1f(entry.u.uFeedback, v);
    }
    gl.useProgram(this._prog);
  }

  setBlobWarp(v: number): void {
    this._setAll("uBlobWarp", (this._blobWarpVal = v));
  }
  setBlobSpeed(v: number): void {
    this._setAll("uBlobSpeed", (this._blobSpeedVal = v));
  }
  setBlobDrive(v: number): void {
    this._setAll("uBlobDrive", (this._blobDriveVal = v));
  }
  setBlobSize(v: number): void {
    this._setAll("uBlobSize", (this._blobSizeVal = v));
  }
  setBlobSharp(v: number): void {
    this._setAll("uBlobSharp", (this._blobSharpVal = v));
  }
  setShiftSpeed(v: number): void {
    this._setAll("uShiftSpeed", (this._shiftSpeedVal = v));
  }
  setPulseReactivity(v: number): void {
    this._setAll("uPulseReactivity", (this._pulseReactivityVal = v));
  }
  setBriScale(v: number): void {
    this._setAll("uBriScale", (this._briScaleVal = v));
  }

  private _setAll(name: string, v: number): void {
    const gl = this._gl;
    for (const [, entry] of this._progCache) {
      gl.useProgram(entry.prog);
      gl.uniform1f(entry.u[name], v);
    }
    gl.useProgram(this._prog);
  }

  /**
   * Switch to a shader compiled for N hue sectors (compiles on first use).
   * Reallocates the per-slot buffers to match.
   */
  setN(n: number): void {
    if (n === this._activeN) return;
    this._activate(this._style, n);
  }

  /**
   * Switch the visual style ("blobs" | "aurora"). Compiles the matching program
   * on first use; both styles share the exact same uniform set, so all params
   * (palette, brightness, feedback, …) carry over and keep updating live.
   */
  setStyle(style: string): void {
    if (style === this._style) return;
    this._activate(style, this._activeN);
  }

  private _progKey(style: string, n: number): string {
    return `${style}:${n}`;
  }

  private _fragFor(style: string, n: number): string {
    if (style === "aurora")   return makeAuroraFragSrc(n);
    if (style === "chladni")  return makeChladniBgFragSrc(n);
    return makeFragSrc(n);
  }

  /**
   * Make (style, n) the active program: compile+cache on first use, swap the
   * program/uniform handles, reallocate per-slot buffers if n changed, and
   * re-push every param uniform (uniforms are per-program, so a fresh program
   * starts at defaults until we set them).
   */
  private _activate(style: string, n: number): void {
    const key = this._progKey(style, n);
    if (!this._progCache.has(key)) {
      const prog = this._compile(this._fragFor(style, n));
      const u = this._cacheUniforms(prog);
      this._progCache.set(key, { prog, u });
    }
    const entry = this._progCache.get(key)!;
    this._prog = entry.prog;
    this._u = entry.u;
    this._style = style;

    if (n !== this._activeN) {
      this._activeN = n;
      this._degreeRGBBuf = new Float32Array(n * 3);
      this._degreeRGB2Buf = new Float32Array(n * 3);
      this._slotWeights = new Float32Array(n);
      this._slotEdgeBuf = new Float32Array(n);
    }

    const gl = this._gl;
    gl.useProgram(this._prog);
    gl.uniform2f(this._u.uRes, this._w, this._h);
    gl.uniform1f(this._u.uFeedback, this._feedbackVal);
    gl.uniform1f(this._u.uBlobWarp, this._blobWarpVal);
    gl.uniform1f(this._u.uBlobSpeed, this._blobSpeedVal);
    gl.uniform1f(this._u.uBlobDrive, this._blobDriveVal);
    gl.uniform1f(this._u.uBlobSize, this._blobSizeVal);
    gl.uniform1f(this._u.uBlobSharp, this._blobSharpVal);
    gl.uniform1f(this._u.uShiftSpeed, this._shiftSpeedVal);
    gl.uniform1f(this._u.uPulseReactivity, this._pulseReactivityVal);
    gl.uniform1f(this._u.uBriScale, this._briScaleVal);

    if (style === "chladni") this._ensureChladni(n);
  }

  /** Resize canvas backing store to CSS px × min(2, dpr). Re-allocates textures. */
  resize(): void {
    const gl = this._gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round((this.canvas.clientWidth || window.innerWidth) * dpr);
    const h = Math.round(
      (this.canvas.clientHeight || window.innerHeight) * dpr,
    );
    if (w === this._w && h === this._h) return;

    this.canvas.width = w;
    this.canvas.height = h;
    this._w = w;
    this._h = h;
    this._allocTextures(w, h);

    gl.viewport(0, 0, w, h);
    gl.useProgram(this._prog);
    gl.uniform2f(this._u.uRes, w, h);

    if (this._chladniReady) {
      this._reseedParticles();
      if (this._chladniSimProg && this._chladniSimU) {
        gl.useProgram(this._chladniSimProg);
        gl.uniform2f(this._chladniSimU.uRes, w, h);
      }
      if (this._chladniPtsProg && this._chladniPtsU) {
        gl.useProgram(this._chladniPtsProg);
        gl.uniform2f(this._chladniPtsU.uRes, w, h);
      }
      gl.useProgram(this._prog);
    }
  }

  /** Render one frame from an AudioAnalyzer.tick() output object. */
  render(frame: AudioFrame): VisualUniforms {
    const gl = this._gl;
    const u = this._u;

    if (frame.chord.change) this._pulse = 1.0;
    else this._pulse *= 0.94;

    const t = (performance.now() - this._startT) / 1000;

    const N = frame.slots.length;
    if (N !== this._activeN) this.setN(N);

    // Top-2 slots: winner always shows; runner-up shows only if it scores
    // ≥80% of winner (tight threshold keeps colors clean — only genuine
    // boundary crossings between adjacent palette slots show two blobs).
    let winner = 0,
      runnerUp = -1;
    let winnerScore = 0,
      runnerScore = -1;
    for (let i = 0; i < N; i++) {
      if (frame.slots[i] > winnerScore) {
        runnerUp = winner;
        runnerScore = winnerScore;
        winner = i;
        winnerScore = frame.slots[i];
      } else if (runnerUp < 0 || frame.slots[i] > runnerScore) {
        runnerUp = i;
        runnerScore = frame.slots[i];
      }
    }
    const runnerThreshold = winnerScore * 0.80;
    for (let i = 0; i < N; i++) {
      let target = 0;
      if (i === winner) target = winnerScore;
      else if (i === runnerUp && runnerScore >= runnerThreshold)
        target = runnerScore;
      this._slotWeights[i] += (target - this._slotWeights[i]) * 0.3;
    }

    // Smooth per-slot edge bias so blob color doesn't pop when audio.hue
    // crosses a boundary. Uses the same EMA factor as slot weights.
    if (frame.slotEdge && this._slotEdgeBuf.length === N) {
      for (let i = 0; i < N; i++) {
        const target = frame.slotEdge[i] ?? 0;
        this._slotEdgeBuf[i] += (target - this._slotEdgeBuf[i]) * 0.2;
      }
    }

    this._fillDegreeRGB(frame.slotHues, frame.slotBoundaryHues, frame.bandClarity ?? 0);

    gl.useProgram(this._prog);
    gl.uniform1f(u.uTime, t);
    gl.uniform1fv(u.uDegrees, this._slotWeights);
    gl.uniform3fv(u.uDegreeRGB, this._degreeRGBBuf);
    gl.uniform3fv(u.uDegreeRGB2, this._degreeRGB2Buf);
    gl.uniform1fv(u.uSlotEdge, this._slotEdgeBuf);
    gl.uniform1f(u.uBri, frame.bri);
    gl.uniform1f(u.uSpread, frame.spread);
    gl.uniform1f(u.uAct, frame.act);
    gl.uniform1f(u.uBandLo, frame.bands.lo);
    gl.uniform1f(u.uPulse, this._pulse);
    gl.uniform1f(u.uPulseReactivity, this._pulseReactivityVal);
    gl.uniform1f(u.uBriScale, this._briScaleVal);
    gl.uniform1f(u.uTilt, frame.tilt ?? 0.5);
    gl.uniform1f(u.uPos, frame.pos ?? 0.5);
    gl.uniform1f(u.uCtr, frame.ctr ?? 0);

    // Stash per-frame values for the chladni multi-pass renderer
    this._lastBri    = frame.bri;
    this._lastAct    = frame.act;
    this._lastSpread = frame.spread;
    this._lastTilt   = frame.tilt  ?? 0.5;
    this._lastPos    = frame.pos   ?? 0.5;
    this._lastCtr    = frame.ctr   ?? 0;

    if (this._style === "chladni" && this._chladniReady) {
      this._renderChladni(t);
    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texA!.tex);
      gl.uniform1i(u.uPrev, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._texB!.fb);
      gl.viewport(0, 0, this._w, this._h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._texB!.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      this._w,
      this._h,
      0,
      0,
      this._w,
      this._h,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Swap ping-pong
    const tmp = this._texA!;
    this._texA = this._texB;
    this._texB = tmp;

    return {
      slotWeights: new Float32Array(this._slotWeights),
      pulse: this._pulse,
      bri: frame.bri,
      spread: frame.spread,
      act: frame.act,
      bandLo: frame.bands.lo,
      bandHi: frame.bands.hi,
      tilt: frame.tilt ?? 0.5,
      pos: frame.pos ?? 0.5,
      ctr: frame.ctr ?? 0,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _compile(fragSrc: string, vertSrc = VERT_SRC): WebGLProgram {
    const gl = this._gl;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vertSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
      throw new Error(
        "AudioRendererGL vertex shader:\n" + gl.getShaderInfoLog(vs),
      );

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
      throw new Error(
        "AudioRendererGL fragment shader:\n" + gl.getShaderInfoLog(fs),
      );

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error("AudioRendererGL link:\n" + gl.getProgramInfoLog(prog));

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  private _cacheUniforms(prog: WebGLProgram): UniformMap {
    const gl = this._gl;
    const names = [
      "uRes",
      "uTime",
      "uDegrees",
      "uDegreeRGB",
      "uBri",
      "uSpread",
      "uAct",
      "uBandLo",
      "uPulse",
      "uFeedback",
      "uBlobWarp",
      "uBlobSpeed",
      "uBlobDrive",
      "uBlobSize",
      "uBlobSharp",
      "uShiftSpeed",
      "uPulseReactivity",
      "uBriScale",
      "uTilt",
      "uPos",
      "uCtr",
      "uDegreeRGB2",
      "uSlotEdge",
      "uPrev",
      // Chladni-specific (null on blobs/aurora — silent no-op via getUniformLocation)
      "uModeM",
      "uModeN",
      "uModeS",
      "uPosTex",
      "uSimRes",
      "uDt",
      "uSeed",
    ];
    const locs: UniformMap = {};
    for (const n of names) locs[n] = gl.getUniformLocation(prog, n);
    return locs;
  }

  private _allocTextures(w: number, h: number): void {
    const gl = this._gl;
    if (this._texA) {
      gl.deleteTexture(this._texA.tex);
      gl.deleteFramebuffer(this._texA.fb);
    }
    if (this._texB) {
      gl.deleteTexture(this._texB.tex);
      gl.deleteFramebuffer(this._texB.fb);
    }
    this._texA = this._makeTexFB(w, h);
    this._texB = this._makeTexFB(w, h);
  }

  private _makeTexFB(w: number, h: number): TexFB {
    const gl = this._gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, fb };
  }

  /**
   * Fill uDegreeRGB (left-edge color) and uDegreeRGB2 (right-edge color) for
   * each slot. When boundaryHues is supplied (N+1 values from Palette), uses the
   * actual hue arc edges so each blob spans its true spectrum range.
   */
  private _fillDegreeRGB(
    centerHues: Float32Array,
    boundaryHues?: Float32Array,
    bandClarity = 0,
  ): void {
    const buf = this._degreeRGBBuf;
    const buf2 = this._degreeRGB2Buf;
    const n = this._activeN;
    const fallbackHalfStep = 180 / n;
    for (let i = 0; i < n; i++) {
      const center = centerHues[i];
      const hLeftFull = boundaryHues
        ? boundaryHues[i] ?? center - fallbackHalfStep
        : center - fallbackHalfStep;
      const hRightRaw = boundaryHues
        ? (boundaryHues[i + 1] ?? boundaryHues[0] + 360)
        : center + fallbackHalfStep;
      // If the right boundary wraps below the left (last slot touching 360→0),
      // unwrap it so the gradient direction is always forward.
      const hRightFull = hRightRaw < hLeftFull ? hRightRaw + 360 : hRightRaw;
      // Squeeze edges toward center hue when bandClarity is high.
      // Use shortest-arc lerp — slot 0 straddles the display-space 0°/360° wrap,
      // so linear arithmetic would go the wrong way around the circle.
      const squeeze = bandClarity * 0.85;
      const hRightNorm = ((hRightFull % 360) + 360) % 360;
      const hLeft  = _hueArcLerp(hLeftFull, center, squeeze);
      const hRight = _hueArcLerp(hRightNorm, center, squeeze);
      const [r, g, b] = oklchToLinearRGB(0.65, 0.32, toPerceptual(hLeft));
      const [r2, g2, b2] = oklchToLinearRGB(0.72, 0.28, toPerceptual(hRight));
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
      buf2[i * 3] = r2;
      buf2[i * 3 + 1] = g2;
      buf2[i * 3 + 2] = b2;
    }
  }

  // ── Chladni private methods ────────────────────────────────────────────────

  /**
   * Lazy setup on first "chladni" activation: probe float FBO support, allocate
   * sim textures, compile per-n sim/points programs, initialise mode arrays, seed.
   * Idempotent for the same n; compiles fresh programs if n changes.
   */
  private _ensureChladni(n: number): void {
    const gl = this._gl;

    // One-time float FBO probe + sim texture allocation
    if (!this._simPosA) {
      if (!this._chladniOk) return;

      // Request extensions then test FB completeness (safest cross-browser probe)
      gl.getExtension("EXT_color_buffer_float");
      gl.getExtension("EXT_color_buffer_half_float");

      const candidates: Array<[number, number]> = [
        [gl.RGBA32F, gl.FLOAT],
        [gl.RGBA16F, gl.HALF_FLOAT],
      ];
      let found = false;
      for (const [ifmt, type] of candidates) {
        const testTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, testTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, 2, 2, 0, gl.RGBA, type, null);
        const testFB = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, testFB);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, testTex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.deleteFramebuffer(testFB);
        gl.deleteTexture(testTex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (ok) {
          this._simInternalFmt = ifmt;
          this._simFloatType   = type;
          found = true;
          break;
        }
      }

      if (!found) {
        console.warn("AudioRendererGL: chladni — no float FBO support; sand disabled");
        this._chladniOk = false;
        return;
      }

      this._simPosA = this._makeSimTexFB(this._simN, this._simN);
      this._simPosB = this._makeSimTexFB(this._simN, this._simN);

      // Seed program (not n-dependent)
      const seedKey = "chladni-seed:0";
      if (!this._progCache.has(seedKey)) {
        const prog = this._compile(CHLADNI_SEED_FRAG);
        this._progCache.set(seedKey, { prog, u: this._cacheUniforms(prog) });
      }
      this._reseedParticles();
    }

    // Compile per-n programs
    const simKey = `chladni-sim:${n}`;
    const ptsKey = `chladni-pts:${n}`;

    if (!this._progCache.has(simKey)) {
      const prog = this._compile(makeChladniSimFragSrc(n));
      const u    = this._cacheUniforms(prog);
      this._progCache.set(simKey, { prog, u });
      gl.useProgram(prog);
      gl.uniform1f(u.uFeedback,         this._feedbackVal);
      gl.uniform1f(u.uBlobWarp,         this._blobWarpVal);
      gl.uniform1f(u.uBlobSpeed,        this._blobSpeedVal);
      gl.uniform1f(u.uBlobDrive,        this._blobDriveVal);
      gl.uniform1f(u.uBlobSize,         this._blobSizeVal);
      gl.uniform1f(u.uBlobSharp,        this._blobSharpVal);
      gl.uniform1f(u.uShiftSpeed,       this._shiftSpeedVal);
      gl.uniform1f(u.uPulseReactivity,  this._pulseReactivityVal);
      gl.uniform1f(u.uBriScale,         this._briScaleVal);
      gl.uniform2f(u.uRes,              this._w, this._h);
      gl.uniform2f(u.uSimRes,           this._simN, this._simN);
      gl.useProgram(this._prog);
    }

    if (!this._progCache.has(ptsKey)) {
      const prog = this._compile(CHLADNI_POINT_FRAG, makeChladniPointVertSrc(n, this._simN));
      const u    = this._cacheUniforms(prog);
      this._progCache.set(ptsKey, { prog, u });
      gl.useProgram(prog);
      gl.uniform1f(u.uFeedback,         this._feedbackVal);
      gl.uniform1f(u.uBlobWarp,         this._blobWarpVal);
      gl.uniform1f(u.uBlobSpeed,        this._blobSpeedVal);
      gl.uniform1f(u.uBlobDrive,        this._blobDriveVal);
      gl.uniform1f(u.uBlobSize,         this._blobSizeVal);
      gl.uniform1f(u.uBlobSharp,        this._blobSharpVal);
      gl.uniform1f(u.uShiftSpeed,       this._shiftSpeedVal);
      gl.uniform1f(u.uPulseReactivity,  this._pulseReactivityVal);
      gl.uniform1f(u.uBriScale,         this._briScaleVal);
      gl.uniform2f(u.uRes,              this._w, this._h);
      gl.useProgram(this._prog);
    }

    const simEntry = this._progCache.get(simKey)!;
    const ptsEntry = this._progCache.get(ptsKey)!;
    this._chladniSimProg = simEntry.prog;
    this._chladniSimU    = simEntry.u;
    this._chladniPtsProg = ptsEntry.prog;
    this._chladniPtsU    = ptsEntry.u;

    // Reallocate mode arrays when n changes
    if (!this._modeM || this._modeM.length !== n) {
      this._modeM = new Float32Array(n);
      this._modeN = new Float32Array(n);
    }

    this._chladniReady = true;
  }

  /** Allocate a float-format sim FBO (format set by _ensureChladni probe). */
  private _makeSimTexFB(w: number, h: number): TexFB {
    const gl  = this._gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this._simInternalFmt, w, h, 0, gl.RGBA, this._simFloatType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, fb };
  }

  /**
   * Render random positions [0,1]² into both sim ping-pong textures.
   * Uses a GLSL hash so half-float textures need no CPU packing.
   */
  private _reseedParticles(): void {
    const gl = this._gl;
    const { prog, u } = this._progCache.get("chladni-seed:0")!;
    gl.useProgram(prog);
    gl.viewport(0, 0, this._simN, this._simN);
    for (let seed = 0; seed < 2; seed++) {
      gl.uniform1f(u.uSeed, seed);
      gl.bindFramebuffer(gl.FRAMEBUFFER, seed === 0 ? this._simPosA!.fb : this._simPosB!.fb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._w, this._h);
    gl.useProgram(this._prog);
  }

  /**
   * Update per-slot mode orders from smoothed tilt and pos.
   * Quantized glide keeps figures on true integer plate modes most of the time,
   * then transitions quickly in the upper quarter of each integer interval.
   */
  private _updateModeBank(n: number, tilt: number, pos: number): void {
    this._tiltSm += (tilt - this._tiltSm) * 0.05;
    this._posSm  += (pos  - this._posSm)  * 0.05;

    const k      = this._tiltSm * 3.0;
    const kFloor = Math.floor(k);
    const kFrac  = k - kFloor;
    // Sit on integer plateau for the first 75% of each interval, then glide quickly
    const shift  = kFloor + (kFrac > 0.75 ? (kFrac - 0.75) / 0.25 : 0.0);

    for (let i = 0; i < n; i++) {
      const [bm, bn] = CHLADNI_BASE_MODES[i % CHLADNI_BASE_MODES.length];
      this._modeM![i] = Math.max(1.0, bm + shift);
      this._modeN![i] = Math.max(1.0, bn + shift);
    }
    // POS skews plate symmetry: s=1 is a symmetric plate, deviations break mirror symmetry
    this._modeS = 0.4 + this._posSm * 1.2;
  }

  /**
   * Multi-pass chladni render: sim update → background sheen → point sand grains.
   * Leaves the composite in _texB so the shared blit + swap in render() is unchanged.
   */
  private _renderChladni(t: number): void {
    const gl = this._gl;
    const n  = this._activeN;

    this._updateModeBank(n, this._lastTilt, this._lastPos);

    // ── 1. Sim pass: update particle positions into _simPosB ─────────────────
    gl.useProgram(this._chladniSimProg!);
    const su = this._chladniSimU!;
    gl.uniform1f(su.uTime,    t);
    gl.uniform1f(su.uDt,      1.0);
    gl.uniform1fv(su.uModeM,  this._modeM!);
    gl.uniform1fv(su.uModeN,  this._modeN!);
    gl.uniform1f(su.uModeS,   this._modeS);
    gl.uniform1fv(su.uDegrees, this._slotWeights);
    gl.uniform1f(su.uBri,     this._lastBri);
    gl.uniform1f(su.uAct,     this._lastAct);
    gl.uniform1f(su.uSpread,  this._lastSpread);
    gl.uniform1f(su.uPulse,   this._pulse);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._simPosA!.tex);
    gl.uniform1i(su.uPosTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._simPosB!.fb);
    gl.viewport(0, 0, this._simN, this._simN);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Swap sim ping-pong: _simPosA now holds fresh positions
    const tmpSim    = this._simPosA!;
    this._simPosA   = this._simPosB;
    this._simPosB   = tmpSim;

    // ── 2. Background / sheen pass into _texB ────────────────────────────────
    // Standard uniforms were already pushed by render()'s common block onto this._prog.
    gl.useProgram(this._prog);
    gl.uniform1fv(this._u.uModeM,  this._modeM!);
    gl.uniform1fv(this._u.uModeN,  this._modeN!);
    gl.uniform1f(this._u.uModeS,   this._modeS);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texA!.tex);
    gl.uniform1i(this._u.uPrev, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._texB!.fb);
    gl.viewport(0, 0, this._w, this._h);  // restore after sim pass
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ── 3. Points pass: draw sand grains additively into the same _texB ──────
    gl.useProgram(this._chladniPtsProg!);
    const pu = this._chladniPtsU!;
    gl.uniform1fv(pu.uModeM,   this._modeM!);
    gl.uniform1fv(pu.uModeN,   this._modeN!);
    gl.uniform1f(pu.uModeS,    this._modeS);
    gl.uniform1fv(pu.uDegrees, this._slotWeights);
    gl.uniform1fv(pu.uDegreeRGB,  this._degreeRGBBuf);
    gl.uniform1fv(pu.uDegreeRGB2, this._degreeRGB2Buf);
    gl.uniform1fv(pu.uSlotEdge,   this._slotEdgeBuf);
    gl.uniform1f(pu.uTilt,    this._lastTilt);
    gl.uniform1f(pu.uSpread,  this._lastSpread);
    gl.uniform1f(pu.uCtr,     this._lastCtr);
    gl.uniform1f(pu.uBri,     this._lastBri);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._simPosA!.tex);
    gl.uniform1i(pu.uPosTex, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this._simN * this._simN);
    gl.disable(gl.BLEND);

    // Restore to bg program so the shared blit in render() has the right state
    gl.useProgram(this._prog);
  }
}
