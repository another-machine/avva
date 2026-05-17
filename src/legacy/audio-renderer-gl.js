/**
 * modules/audio-renderer-gl.js
 *
 * WebGL2 renderer for Program 2.
 *
 * Single fullscreen quad; the fragment shader does all the work.
 * Frame-to-frame feedback via a ping-pong pair of RGBA textures.
 *
 * Phases 3–6 are all compiled into the fragment shader:
 *   Phase 3  — 7 diatonic degree territories, value noise, feedback
 *   Phase 4  — procedural film grain, activity-modulated
 *   Phase 5  — brightness banding (top/bottom) + chord-change pulse
 *   Phase 6  — structural seam for future key-agnostic 12-class mode
 *
 * Tunable via URL params:
 *   ?feedback=0.92    frame-to-frame decay (closer to 1 = longer trail)
 *   ?noiseScale=2.5   noise domain scale for territory blobs
 *
 * Constructor:
 *   new AudioRendererGL(canvas, degreeHues, opts)
 *   degreeHues  — Float32Array(7), static sector-center hues from Key.degreeHues
 *   opts.feedback    — override CONFIG.feedback
 *   opts.noiseScale  — override CONFIG.noiseScale
 *   opts.mode        — "diatonic" (default) | "chromatic" (future)
 *   opts.chromaticHues — Float32Array(12), reserved for chromatic mode
 */

// ── oklch → linear sRGB ──────────────────────────────────────────────────────
// Converts oklch(L, C, H°) to [r, g, b] in linear light.
// Oklab inverse matrices from Björn Ottosson's reference implementation.
function oklchToLinearRGB(L, C, H) {
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

// ── Vertex shader ────────────────────────────────────────────────────────────
// Fullscreen triangle via gl_VertexID — no VBO required.
const VERT_SRC = `#version 300 es
out vec2 vUV;
void main() {
  // Fullscreen triangle covering the viewport
  vec2 pos;
  if      (gl_VertexID == 0) pos = vec2(-1.0, -1.0);
  else if (gl_VertexID == 1) pos = vec2( 3.0, -1.0);
  else                       pos = vec2(-1.0,  3.0);
  vUV         = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// ── Fragment shader factory ───────────────────────────────────────────────────
// Phase 6: parametrised by N_HUES so the same source can compile as either
// the 7-degree diatonic shader or a future 12-class chromatic shader.
// Only the diatonic path (N_HUES=7) is executed at runtime for now.
function makeFragSrc(nHues) {
  return `#version 300 es
#define N_HUES ${nHues}
precision highp float;

in  vec2 vUV;
out vec4 outColor;

uniform vec2  uRes;          // canvas size in physical px
uniform float uTime;         // seconds since renderer start
uniform float uDegrees[N_HUES];    // per-degree energy weights, sum ~1 when signal present
uniform vec3  uDegreeRGB[N_HUES];  // pre-converted linear-sRGB color per degree
uniform float uBri;          // full-band loudness 0..1
uniform float uSpread;       // chroma spread 0..1
uniform float uAct;          // frame-to-frame chroma activity 0..1
uniform float uBandLo;       // low-octave band energy 0..1
uniform float uBandHi;       // high-octave band energy 0..1
uniform float uPulse;        // chord-change pulse, decays 0..1
uniform float uFeedback;     // frame-to-frame feedback decay
uniform float uNoiseScale;   // noise spatial scale
uniform sampler2D uPrev;     // previous rendered frame

// ── Gradient (value) noise — approx -1..1 ────────────────────────────────────
// Hash produces a gradient direction per lattice corner.
vec2 _h2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float snoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);  // smoothstep blend
  float a = dot(_h2(i),                  f);
  float b = dot(_h2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(_h2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(_h2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Remapped to 0..1 for territory presence
float snoiseN(vec2 p) { return snoise(p) * 0.5 + 0.5; }

void main() {
  vec2 uv = vUV;

  // ── Phase 3: Degree territories ──────────────────────────────────────────
  // All degrees contribute a weighted colour so territory boundaries blend
  // through intermediate hues rather than hard-cutting to a single winner.
  float maxPresence = 0.0;
  vec3  blendColor  = vec3(0.0);
  float blendWeight = 0.0;

  for (int i = 0; i < N_HUES; i++) {
    vec2  noiseUV  = uv * uNoiseScale
                   + vec2(float(i) * 17.3,
                          uTime * (0.04 + float(i) * 0.007));
    float n        = snoiseN(noiseUV);
    float presence = uDegrees[i] * n;
    if (presence > maxPresence) maxPresence = presence;
    blendColor  += uDegreeRGB[i] * presence;
    blendWeight += presence;
  }

  // ── Phase 3: Previous frame with fluid drift ──────────────────────────────
  // A noise-driven offset makes the feedback feel alive rather than static.
  vec2 driftUV = uv + vec2(
    snoise(uv * 4.0 + vec2(uTime * 0.05,        0.0)),
    snoise(uv * 4.0 + vec2(uTime * 0.05 + 100.0, 0.0))
  ) * 0.00125;
  driftUV = clamp(driftUV, 0.0, 1.0);
  vec4 prev = texture(uPrev, driftUV);

  // ── Phase 3: Color computation + feedback mix ─────────────────────────────
  // Weighted-average colour blends all active territories; maxPresence drives
  // how much new colour replaces the feedback trail.
  vec3  newColor  = blendWeight > 0.001 ? blendColor / blendWeight : vec3(0.0);
  float newAmount = clamp(maxPresence * 2.0, 0.0, 1.0);
  vec3  base      = mix(prev.rgb * uFeedback, newColor, newAmount);

  // Dynamic range: silence→black, chord→vivid color, loud→white.
  // Territory presence (newAmount) provides a floor so an active chord stays
  // visible even at soft volume; bri drives the full black↔white envelope.
  float bScale = uBri * 5.0;
  float bFloor = newAmount * 0.55;             // active chord = at least 55% intensity
  base *= clamp(max(bScale, bFloor), 0.0, 1.0);
  base += vec3(max(0.0, bScale - 1.0) * 0.4); // white bloom above bri~0.2

  // ── Phase 5: Top/bottom brightness banding ────────────────────────────────
  // Keeps the camera's hi/lo signals meaningful when the loop is closed.
  float topBand    = smoothstep(0.0, 0.33, 1.0 - uv.y) * uBandHi * 0.6;
  float bottomBand = smoothstep(0.0, 0.33, uv.y)       * uBandLo * 0.6;
  base += vec3(topBand + bottomBand);

  // ── Phase 5: Chord-change pulse ───────────────────────────────────────────
  // Global lightness swell that decays over ~30 frames after a chord change.
  base += vec3(uPulse * 0.15);

  // ── Phase 4: Film grain ───────────────────────────────────────────────────
  // Pixel-scale noise reseeded every frame; amplitude scales with activity.
  float grain    = snoise(uv * uRes / 2.5 + vec2(uTime * 8.0));
  float grainAmt = 0.04 + uAct * 0.06;
  base          += vec3(grain * grainAmt);

  outColor = vec4(clamp(base, 0.0, 1.0), 1.0);
}`;
}

// ── AudioRendererGL ──────────────────────────────────────────────────────────

export class AudioRendererGL {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Float32Array}      degreeHues  Static sector-center hues from Key.degreeHues
   * @param {object}            [opts]
   * @param {number}            [opts.feedback=0.92]
   * @param {number}            [opts.noiseScale=2.5]
   * @param {string}            [opts.mode="diatonic"]   Phase 6 seam
   * @param {Float32Array|null} [opts.chromaticHues=null] Phase 6 seam
   */
  constructor(canvas, degreeHues, opts = {}) {
    this.canvas = canvas;

    // Phase 6: store both hue arrays and mode selector
    this._staticDegreeHues = degreeHues;
    this._chromaticHues = opts.chromaticHues ?? null; // reserved
    this._mode = opts.mode ?? "diatonic";

    this._feedbackVal = opts.feedback ?? 0.92;
    this._noiseScaleVal = opts.noiseScale ?? 2.5;

    // WebGL2 context — throw clearly if unavailable
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("AudioRendererGL: WebGL2 is not available.");
    this._gl = gl;

    // On-demand shader cache keyed by N (number of hue/slot sectors).
    // N=7 compiled upfront; other values compiled lazily by setN().
    this._progCache = new Map();
    this._activeN = 7;
    const p7 = this._compile(makeFragSrc(7));
    const u7 = this._cacheUniforms(p7);
    this._progCache.set(7, { prog: p7, u: u7 });
    this._prog = p7;
    this._u = u7;

    // Linear-RGB buffer for sector colors (updated per-frame from hues)
    this._degreeRGBBuf = new Float32Array(7 * 3);
    this._fillDegreeRGB(degreeHues);

    // Empty VAO — no vertex attributes needed (fullscreen triangle via gl_VertexID)
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);

    // Set static uniforms (feedback, noiseScale)
    gl.useProgram(this._prog);
    gl.uniform1f(this._u.uFeedback, this._feedbackVal);
    gl.uniform1f(this._u.uNoiseScale, this._noiseScaleVal);

    // Runtime state
    this._pulse = 0;
    this._startT = performance.now();
    this._w = 0;
    this._h = 0;
    this._texA = null;
    this._texB = null;

    this.resize();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Switch the active shader to one compiled for N hue sectors.
   * Compiles a new program on the fly if this N hasn't been seen before.
   * Also reallocates the RGB buffer to match.
   * @param {number} n
   */
  setN(n) {
    if (n === this._activeN) return;
    this._activeN = n;
    if (!this._progCache.has(n)) {
      const prog = this._compile(makeFragSrc(n));
      const u = this._cacheUniforms(prog);
      this._progCache.set(n, { prog, u });
    }
    const entry = this._progCache.get(n);
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
  resize() {
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

  /**
   * Render one frame.
   * @param {object} frame  AudioAnalyzer.tick() output
   */
  render(frame) {
    const gl = this._gl;
    const u = this._u;

    // Pulse: snap to 1 on chord change, decay geometrically otherwise
    if (frame.chord.change) this._pulse = 1.0;
    else this._pulse *= 0.94;

    const t = (performance.now() - this._startT) / 1000;

    // Switch shader if N has changed (e.g. palette with different slot count)
    const N = frame.slots ? frame.slots.length : 7;
    if (N !== this._activeN) this.setN(N);

    // Update per-frame sector colors from slot/degree weighted hues if available
    const hues = frame.slotHues ?? frame.degreeHues ?? this._staticDegreeHues;
    this._fillDegreeRGB(hues);

    gl.useProgram(this._prog);

    gl.uniform1f(u.uTime, t);
    const weights = frame.slots ?? frame.degrees;
    gl.uniform1fv(u.uDegrees, weights);
    gl.uniform3fv(u.uDegreeRGB, this._degreeRGBBuf);
    gl.uniform1f(u.uBri, frame.bri);
    gl.uniform1f(u.uSpread, frame.spread);
    gl.uniform1f(u.uAct, frame.act);
    gl.uniform1f(u.uBandLo, frame.bands.lo);
    gl.uniform1f(u.uBandHi, frame.bands.hi);
    gl.uniform1f(u.uPulse, this._pulse);

    // Bind the previous frame (texA) as uPrev
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texA.tex);
    gl.uniform1i(u.uPrev, 0);

    // Render into texB's framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._texB.fb);
    gl.viewport(0, 0, this._w, this._h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Blit texB → default framebuffer (screen)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._texB.fb);
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

    // Restore default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Swap ping-pong buffers: texB becomes the new "previous" frame
    const tmp = this._texA;
    this._texA = this._texB;
    this._texB = tmp;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Compile a fragment shader source against the shared vertex shader. */
  _compile(fragSrc) {
    const gl = this._gl;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
      throw new Error(
        "AudioRendererGL vertex shader:\n" + gl.getShaderInfoLog(vs),
      );

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
      throw new Error(
        "AudioRendererGL fragment shader:\n" + gl.getShaderInfoLog(fs),
      );

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error("AudioRendererGL link:\n" + gl.getProgramInfoLog(prog));

    // Shaders no longer needed after linking
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  /** Return an object of { uniformName: location } for a compiled program. */
  _cacheUniforms(prog) {
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
    const locs = {};
    for (const n of names) locs[n] = gl.getUniformLocation(prog, n);
    return locs;
  }

  /**
   * Allocate (or re-allocate) the ping-pong texture+framebuffer pair.
   * Called by resize(); also called on construction.
   */
  _allocTextures(w, h) {
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

  /** Create one RGBA8 texture + framebuffer at the given size. */
  _makeTexFB(w, h) {
    const gl = this._gl;
    const tex = gl.createTexture();

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

    const fb = gl.createFramebuffer();
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
   * (Re-)compute _degreeRGBBuf from hues.
   * Called once at construction and every frame via render().
   * Uses oklch(0.65, 0.22, H) — matching va.css --spectrum-l / --spectrum-c.
   */
  _fillDegreeRGB(hues) {
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
