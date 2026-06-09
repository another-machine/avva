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
  // Clamp to [0,1]; Gaussian accumulation is naturally smooth — no threshold needed
  base = mix(base, vec3(1.0, 0.96, 0.92), clamp(pulseField, 0.0, 1.0) * 0.7);

  // ── Chord-change pulse: fragmented color burst ───────────────────────────
  vec3  flashColor = totalField > 0.001 ? totalColor / totalField : vec3(1.0);
  float flashFrag  = snoiseN(uv * 9.0 + vec2(uTime * 20.0, 0.0))
                   * snoiseN(uv * 3.5 + vec2(0.0, uTime * 13.0));
  base += flashColor * uPulse * flashFrag * 0.65;
  base += vec3(uPulse * 0.035);

  // ── Film grain ───────────────────────────────────────────────────────────
  base += vec3(snoise(uv * uRes / 2.5 + vec2(uTime * 8.0)))
        * (0.03 + uAct * 0.045);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

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
  private readonly _progCache: Map<
    number,
    { prog: WebGLProgram; u: UniformMap }
  >;
  private readonly _vao: WebGLVertexArrayObject;

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
    this._progCache.set(7, { prog: p7, u: u7 });
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
   * Reallocates the RGB buffer to match.
   */
  setN(n: number): void {
    if (n === this._activeN) return;
    this._activeN = n;
    if (!this._progCache.has(n)) {
      const prog = this._compile(makeFragSrc(n));
      const u = this._cacheUniforms(prog);
      this._progCache.set(n, { prog, u });
    }
    const entry = this._progCache.get(n)!;
    this._prog = entry.prog;
    this._u = entry.u;
    this._degreeRGBBuf = new Float32Array(n * 3);
    this._degreeRGB2Buf = new Float32Array(n * 3);
    this._slotWeights = new Float32Array(n);
    this._slotEdgeBuf = new Float32Array(n);
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

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texA!.tex);
    gl.uniform1i(u.uPrev, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._texB!.fb);
    gl.viewport(0, 0, this._w, this._h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

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

  private _compile(fragSrc: string): WebGLProgram {
    const gl = this._gl;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT_SRC);
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
}
