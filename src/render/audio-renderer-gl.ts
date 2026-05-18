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
uniform float uBandHi;
uniform float uPulse;
uniform float uFeedback;
uniform float uNoiseScale;
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

  float maxPresence = 0.0;
  vec3  blendColor  = vec3(0.0);
  float blendWeight = 0.0;

  // Activity-scaled noise scroll speed — faster/more chaotic with movement
  float nSpeed = 0.12 + uAct * 0.45;

  for (int i = 0; i < N_HUES; i++) {
    float fi = float(i);
    // Each degree scrolls in a unique direction; speed scales with activity
    vec2  noiseUV = uv * uNoiseScale
                  + vec2(fi * 17.3 + uTime * (nSpeed * 0.55 + fi * 0.013),
                         fi * 31.7 + uTime * (nSpeed         + fi * 0.009));
    float n        = snoiseN(noiseUV);
    float presence = uDegrees[i] * n;
    if (presence > maxPresence) maxPresence = presence;
    blendColor  += uDegreeRGB[i] * presence;
    blendWeight += presence;
  }

  // Feedback drift — also slightly activity-responsive
  float driftAmt = 0.00125 + uAct * 0.002;
  vec2 driftUV = uv + vec2(
    snoise(uv * 4.0 + vec2(uTime * 0.07,        0.0)),
    snoise(uv * 4.0 + vec2(uTime * 0.07 + 100.0, 0.0))
  ) * driftAmt;
  driftUV = clamp(driftUV, 0.0, 1.0);
  vec4 prev = texture(uPrev, driftUV);

  vec3  newColor  = blendWeight > 0.001 ? blendColor / blendWeight : vec3(0.0);
  float newAmount = clamp(maxPresence * 2.0, 0.0, 1.0);
  vec3  base      = mix(prev.rgb * uFeedback, newColor, newAmount);

  float bScale = uBri * 5.0;
  float bFloor = newAmount * 0.55;
  base *= clamp(max(bScale, bFloor), 0.0, 1.0);

  // Brightness overflow: tint toward current chord color rather than pure white
  float briOver   = max(0.0, bScale - 1.0);
  vec3  briTint   = blendWeight > 0.001 ? blendColor / blendWeight : vec3(1.0);
  base += mix(vec3(1.0), briTint, 0.45) * briOver * 0.4;

  float topBand    = smoothstep(0.0, 0.33, 1.0 - uv.y) * uBandHi * 0.6;
  float bottomBand = smoothstep(0.0, 0.33, uv.y)       * uBandLo * 0.6;
  base += vec3(topBand + bottomBand);

  // Fragment flash on chord change — scattered patches of the current chord
  // color instead of a flat white overlay
  vec3  flashColor = blendWeight > 0.001 ? blendColor / blendWeight : vec3(1.0);
  float flashFrag  = snoiseN(uv * 9.0  + vec2(uTime * 20.0,  0.0))
                   * snoiseN(uv * 3.5  + vec2(0.0, uTime * 13.0));
  base += flashColor * uPulse * flashFrag * 0.65;
  base += vec3(uPulse * 0.035); // faint residual white pop

  float grain    = snoise(uv * uRes / 2.5 + vec2(uTime * 8.0));
  float grainAmt = 0.04 + uAct * 0.06;
  base          += vec3(grain * grainAmt);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

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

  _staticDegreeHues: Float32Array;
  private readonly _chromaticHues: Float32Array | null;
  private readonly _mode: string;
  private _feedbackVal: number;
  private _noiseScaleVal: number;
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
  private _pulse = 0;
  private readonly _startT: number;
  private _w = 0;
  private _h = 0;
  private _texA: TexFB | null = null;
  private _texB: TexFB | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    degreeHues: Float32Array,
    opts: AudioRendererGLOpts = {},
  ) {
    this.canvas = canvas;
    this._staticDegreeHues = degreeHues;
    this._chromaticHues = opts.chromaticHues ?? null;
    this._mode = opts.mode ?? "diatonic";
    this._feedbackVal = opts.feedback ?? 0.92;
    this._noiseScaleVal = opts.noiseScale ?? 2.5;

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
    this._fillDegreeRGB(degreeHues);

    this._vao = gl.createVertexArray()!;
    gl.bindVertexArray(this._vao);

    gl.useProgram(this._prog);
    gl.uniform1f(this._u.uFeedback, this._feedbackVal);
    gl.uniform1f(this._u.uNoiseScale, this._noiseScaleVal);

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

  /** Update the noise spatial scale on all cached programs. */
  setNoiseScale(v: number): void {
    this._noiseScaleVal = v;
    const gl = this._gl;
    for (const [, entry] of this._progCache) {
      gl.useProgram(entry.prog);
      gl.uniform1f(entry.u.uNoiseScale, v);
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
    const gl = this._gl;
    gl.useProgram(this._prog);
    gl.uniform2f(this._u.uRes, this._w, this._h);
    gl.uniform1f(this._u.uFeedback, this._feedbackVal);
    gl.uniform1f(this._u.uNoiseScale, this._noiseScaleVal);
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
  render(frame: {
    chord: { change: boolean };
    slots?: Float32Array;
    degrees?: Float32Array;
    slotHues?: Float32Array;
    degreeHues?: Float32Array;
    bri: number;
    spread: number;
    act: number;
    bands: { lo: number; hi: number };
  }): void {
    const gl = this._gl;
    const u = this._u;

    if (frame.chord.change) this._pulse = 1.0;
    else this._pulse *= 0.94;

    const t = (performance.now() - this._startT) / 1000;

    const N = frame.slots ? frame.slots.length : 7;
    if (N !== this._activeN) this.setN(N);

    const hues = frame.slotHues ?? frame.degreeHues ?? this._staticDegreeHues;
    this._fillDegreeRGB(hues);

    gl.useProgram(this._prog);
    gl.uniform1f(u.uTime, t);
    const weights = frame.slots ?? frame.degrees!;
    gl.uniform1fv(u.uDegrees, weights);
    gl.uniform3fv(u.uDegreeRGB, this._degreeRGBBuf);
    gl.uniform1f(u.uBri, frame.bri);
    gl.uniform1f(u.uSpread, frame.spread);
    gl.uniform1f(u.uAct, frame.act);
    gl.uniform1f(u.uBandLo, frame.bands.lo);
    gl.uniform1f(u.uBandHi, frame.bands.hi);
    gl.uniform1f(u.uPulse, this._pulse);

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
      "uBandHi",
      "uPulse",
      "uFeedback",
      "uNoiseScale",
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

  /** (Re-)compute _degreeRGBBuf from hues using oklch(0.65, 0.32, H). */
  private _fillDegreeRGB(hues: Float32Array): void {
    const buf = this._degreeRGBBuf;
    const n = this._activeN;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = oklchToLinearRGB(0.65, 0.32, hues[i] ?? 0);
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
    }
  }
}
