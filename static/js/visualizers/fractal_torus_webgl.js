// static/js/visualizers/fractal_torus_webgl.js
// Fractal Torus Tunnel (WebGL) -- Shadertoy-inspired (bal-khan MdBczW), adapted to ObsVizHost contract.
// Two-pass: BufferA (feedback + audio row) -> Image (raymarch).
// Overlay-friendly: no opaque page background; final alpha derived from luminance.

export class FractalTorusWebGL {
  static id = "fractal_torus";
  static name = "Fractal Torus Tunnel (WebGL)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const glOpts = {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    };

    this.gl =
      canvas.getContext("webgl", glOpts) ||
      canvas.getContext("experimental-webgl", glOpts);

    if (!this.gl) throw new Error("WebGL not available");

    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // Fullscreen quad
    this._vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]),
      gl.STATIC_DRAW
    );

    // Programs
    this._progA = this._createProgram(VS, FS_BUFFER_A);
    this._progI = this._createProgram(VS, FS_IMAGE);

    // Locs BufferA
    this._locA = {
      a_pos: gl.getAttribLocation(this._progA, "a_pos"),
      u_prev: gl.getUniformLocation(this._progA, "u_prev"),
      u_audio: gl.getUniformLocation(this._progA, "u_audio"),
      u_res: gl.getUniformLocation(this._progA, "u_res"),
      u_time: gl.getUniformLocation(this._progA, "u_time"),
    };

    // Locs Image
    this._locI = {
      a_pos: gl.getAttribLocation(this._progI, "a_pos"),
      u_buf: gl.getUniformLocation(this._progI, "u_buf"),
      u_res: gl.getUniformLocation(this._progI, "u_res"),
      u_time: gl.getUniformLocation(this._progI, "u_time"),
    };

    // Ping-pong for BufferA
    this._w = 0;
    this._h = 0;
    this._texA = null;
    this._fbA = null;
    this._texB = null;
    this._fbB = null;
    this._readTex = null;
    this._readFB = null;
    this._writeTex = null;
    this._writeFB = null;

    // Audio texture (spectrum) used by BufferA to write row 0
    this._audioW = 512; // POT, cheap
    this._audioTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._audioTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this._audioW,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._audioPixels = new Uint8Array(this._audioW * 4);

    // Fast AGC for spectrum so it moves at normal levels
    this._agcSpec = 1e-3;
    this._invSpec = 1.0;

    this._t0 = performance.now();
    this._lastTs = 0;
    this._failed = false;
  }

  onResize(w, h, dpr) {
    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;
    if (cw === this._w && ch === this._h && this._readTex) return;
    this._w = cw;
    this._h = ch;
    this._recreateTargets(cw, ch);
  }

  onFrame(frame) {
    if (this._failed) return;

    const gl = this.gl;
    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    if (!this._readTex || w !== this._w || h !== this._h) {
      this._w = w;
      this._h = h;
      this._recreateTargets(w, h);
    }

    try {
      // dt seconds
      const ts = (typeof frame?.ts === "number") ? frame.ts : performance.now();
      let dt = 0.016;
      if (this._lastTs) dt = (ts - this._lastTs) * 0.001;
      this._lastTs = ts;
      if (!isFinite(dt) || dt <= 0) dt = 0.016;
      if (dt > 0.1) dt = 0.1;

      const t = (performance.now() - this._t0) * 0.001;
      const spec = frame?.spectrum;
      const gain = frame?.gain || 1.0;

      // Update audio texture (spectrum -> row)
      this._updateAudioTexture(spec, gain, dt);

      // -------- Pass A: feedback buffer --------
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._writeFB);
      gl.viewport(0, 0, w, h);

      gl.useProgram(this._progA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
      gl.enableVertexAttribArray(this._locA.a_pos);
      gl.vertexAttribPointer(this._locA.a_pos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._readTex);
      gl.uniform1i(this._locA.u_prev, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._audioTex);
      gl.uniform1i(this._locA.u_audio, 1);

      gl.uniform2f(this._locA.u_res, w, h);
      gl.uniform1f(this._locA.u_time, t);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // -------- Pass I: final image --------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);

      gl.useProgram(this._progI);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
      gl.enableVertexAttribArray(this._locI.a_pos);
      gl.vertexAttribPointer(this._locI.a_pos, 2, gl.FLOAT, false, 0, 0);

      // IMPORTANT: Image reads the current BufferA output (writeTex)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
      gl.uniform1i(this._locI.u_buf, 0);

      gl.uniform2f(this._locI.u_res, w, h);
      gl.uniform1f(this._locI.u_time, t);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap
      this._swap();
    } catch (err) {
      this._failed = true;
      console.error("[FractalTorusWebGL] render failed:", err);
      throw err;
    }
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    try {
      gl.deleteProgram(this._progA);
      gl.deleteProgram(this._progI);
      gl.deleteBuffer(this._vb);

      if (this._audioTex) gl.deleteTexture(this._audioTex);

      this._deleteTarget(this._texA, this._fbA);
      this._deleteTarget(this._texB, this._fbB);
    } catch (_) {}
  }

  // ---------------- internals ----------------

  _updateAudioTexture(spec, gain, dt) {
    const gl = this.gl;
    const N = this._audioW;
    const px = this._audioPixels;

    // AGC from spectrum peak (fast, stable)
    let peak = 0;
    if (spec && spec.length > 8) {
      for (let i = 1; i < spec.length; i += 8) {
        const v = spec[i];
        if (v > peak) peak = v;
      }
    }
    const inst = (peak || 0) * (gain || 1.0);
    const decay = Math.exp(-dt / 0.8);
    this._agcSpec = Math.max(inst, this._agcSpec * decay, 1e-3);
    this._invSpec = 1.0 / (this._agcSpec + 1e-6);

    // Fill: R channel used by shadertoy logic (m)
    const specLen = spec && spec.length ? spec.length : 0;
    for (let i = 0; i < N; i++) {
      let s = 0;
      if (specLen > 2) {
        const si = 1 + ((i * (specLen - 2) / (N - 1)) | 0);
        const v = (spec[si] || 0) * (gain || 1.0) * this._invSpec;
        // Make it obvious: boost + sqrt curve (no screaming required)
        s = Math.sqrt(Math.max(0, Math.min(1, v * 4.5)));
      }
      const b = (s * 255) | 0;
      const o = i * 4;
      px[o + 0] = b;
      px[o + 1] = b;
      px[o + 2] = b;
      px[o + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this._audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _swap() {
    const rt = this._readTex;
    const rf = this._readFB;
    this._readTex = this._writeTex;
    this._readFB = this._writeFB;
    this._writeTex = rt;
    this._writeFB = rf;
  }

  _recreateTargets(w, h) {
    const gl = this.gl;

    this._deleteTarget(this._texA, this._fbA);
    this._deleteTarget(this._texB, this._fbB);

    const A = this._createTarget(w, h);
    const B = this._createTarget(w, h);
    this._texA = A.tex;
    this._fbA = A.fb;
    this._texB = B.tex;
    this._fbB = B.fb;

    // Init both to transparent black
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbA);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbB);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._readTex = this._texA;
    this._readFB = this._fbA;
    this._writeTex = this._texB;
    this._writeFB = this._fbB;
  }

  _createTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  _deleteTarget(tex, fb) {
    const gl = this.gl;
    if (!gl) return;
    if (fb) gl.deleteFramebuffer(fb);
    if (tex) gl.deleteTexture(tex);
  }

  _createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) || "unknown";
      gl.deleteProgram(p);
      throw new Error("Program link failed: " + log);
    }
    return p;
  }

  _compile(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || "unknown";
      gl.deleteShader(s);
      throw new Error("Shader compile failed: " + log);
    }
    return s;
  }
}

// ---------------- Shaders ----------------

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Shadertoy Buffer A adapted
const FS_BUFFER_A = `
precision mediump float;
varying vec2 v_uv;

uniform sampler2D u_prev;   // previous BufferA
uniform sampler2D u_audio;  // spectrum strip (R)
uniform vec2 u_res;
uniform float u_time;

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / u_res.xy;
  vec2 o = vec2(0.0, 1.1 / u_res.y);

  // For y <= 1px, write the audio row from u_audio. Else, feedback from previous frame.
  float topRow = max(ceil(1.0 - fragCoord.y), 0.0); // 1 on first row, 0 otherwise
  float m = mix(
    texture2D(u_prev, uv - o).r,
    texture2D(u_audio, vec2(uv.x, 0.33)).r,
    topRow
  );

  m *= (1.0 - pow(1.0 - uv.x, 5.0)) * 0.3 + 0.75;
  gl_FragColor = vec4(m, m, m, 1.0);
}
`;

// Shadertoy Image adapted (bal-khan MdBczW) with alpha derived from luminance
const FS_IMAGE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;

uniform sampler2D u_buf; // current BufferA
uniform vec2 u_res;
uniform float u_time;

#define I_MAX 100
#define E 0.0005

float g;
float t;
float a;
vec3 ss;
vec4 vv;

void rotate(inout vec2 v, float angle) {
  v = vec2(cos(angle)*v.x + sin(angle)*v.y, -sin(angle)*v.x + cos(angle)*v.y);
}

float sdTorus(vec3 p, vec2 tt) {
  vec2 q = vec2(length(p.zy) - tt.x, p.x);
  return length(q) - tt.y;
}

vec3 blackbody(float Temp) {
  vec3 col = vec3(255.0);
  col.x = 56100000.0 * pow(Temp, (-3.0/2.0)) + 148.0;
  col.y = 100.04 * log(Temp) - 623.6;
  if (Temp > 6500.0) col.y = 35200000.0 * pow(Temp, (-3.0/2.0)) + 184.0;
  col.z = 194.18 * log(Temp) - 1448.6;
  col = clamp(col, 0.0, 255.0) / 255.0;
  if (Temp < 1000.0) col *= Temp / 1000.0;
  return col;
}

float scene(vec3 p) {
  float scale = 1.0;
  float r2, k;
  a = cos(0.5 * (p.z) + t);
  rotate(p.yx, a);
  p.xy += vec2(cos(t), sin(t)) * 0.25 + 1.0;
  p.z -= t;

  ss = p;
  for (int i = 0; i < 4; i++) {
    p.xyz = 1.0 - 2.0 * fract(0.5 * p.xyz + 0.5);
    r2 = sdTorus(p, vec2(0.21, 0.4 * vv[i] + 0.21));
    k = 1.0 / (r2);
    p *= k;
    scale *= k;
  }
  ss = p * (fract(ss) + 0.5);
  return (0.25 * (abs(p.x) + length(fract(ss.xz) - 0.5) * 0.1) / scale);
}

vec2 march(vec3 pos, vec3 dir) {
  vec2 dist = vec2(0.0);
  vec3 p = vec3(0.0);
  vec2 s = vec2(0.0);

  vec3 dirr;
  for (int i = 0; i < I_MAX; ++i) {
    dirr = dir;
    p = pos + dirr * dist.y;
    dist.x = scene(p);
    dist.y += dist.x;

    if (dist.x < E || dist.y > 6.0) {
      p = ss;
      g = p.y;
      g += (step(sin(5.0*p.x), 0.5) + step(sin(20.0*p.x), 0.5));
      break;
    }
    s.x += 1.0;
  }
  s.y = dist.y;
  return s;
}

vec3 camera(vec2 uv) {
  float fov = 1.0;
  vec3 forw  = vec3(0.0, 0.0, -1.0);
  vec3 right = vec3(1.0, 0.0, 0.0);
  vec3 up    = vec3(0.0, 1.0, 0.0);
  return normalize(uv.x * right + uv.y * up + fov * forw);
}

void main() {
  t = u_time * 0.5;

  // Read 4 control values from BufferA's top row (audio row written by BufferA)
  for (int i = 0; i < 4; i++) {
    vv[i] = texture2D(u_buf, vec2(float(i) / 6.0, 0.01)).r;
  }

  vec2 R = u_res.xy;
  vec2 f = gl_FragCoord.xy;
  vec2 uv = (f - R * 0.5) / R.y;

  vec3 dir = camera(uv);
  vec3 pos = vec3(0.0);

  vec2 inter = march(pos, dir);

  vec3 col = vec3(inter.y * 0.051 - (inter.x) * 0.001);
  col += blackbody((15.0 - (2.0 * inter.y - 0.1 * inter.x)) * 50.0);
  col = sin(col * 6.0 - 0.4) * 0.5 + 0.5;

  // Full-screen effect: opaque output.
  // Keep vignette on color only (optional aesthetic), but alpha stays 1.
  float v = smoothstep(1.25, 0.15, length(uv));
  col *= v;

  gl_FragColor = vec4(col, 1.0);
}
`;
