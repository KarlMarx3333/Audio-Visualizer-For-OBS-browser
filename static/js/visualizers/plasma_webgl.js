// static/js/visualizers/plasma_webgl.js
// Neon Plasma (WebGL) -- BufferA + Image pipeline with audio row feed.

export class PlasmaWebGL {
  static id = "plasma";
  static name = "Neon Plasma (WebGL)";
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
    gl.disable(gl.BLEND);

    // Fullscreen quad
    this._vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    // Programs
    this._progA = this._createProgram(VS, FS_BUFFER_A);
    this._progI = this._createProgram(VS, FS_IMAGE);

    // Locations (BufferA)
    this._locA = {
      a_pos: gl.getAttribLocation(this._progA, "a_pos"),
      u_prev: gl.getUniformLocation(this._progA, "u_prev"),
      u_audio: gl.getUniformLocation(this._progA, "u_audio"),
      u_res: gl.getUniformLocation(this._progA, "u_res"),
      u_time: gl.getUniformLocation(this._progA, "u_time"),
      u_dt: gl.getUniformLocation(this._progA, "u_dt"),
    };

    // Locations (Image)
    this._locI = {
      a_pos: gl.getAttribLocation(this._progI, "a_pos"),
      u_buf: gl.getUniformLocation(this._progI, "u_buf"),
      u_res: gl.getUniformLocation(this._progI, "u_res"),
      u_time: gl.getUniformLocation(this._progI, "u_time"),
      u_phase: gl.getUniformLocation(this._progI, "u_phase"),
      u_energy: gl.getUniformLocation(this._progI, "u_energy"),
      u_bass: gl.getUniformLocation(this._progI, "u_bass"),
      u_treble: gl.getUniformLocation(this._progI, "u_treble"),
      u_overlay: gl.getUniformLocation(this._progI, "u_overlay"),
      u_overlayBoost: gl.getUniformLocation(this._progI, "u_overlayBoost"),
      u_viewScale: gl.getUniformLocation(this._progI, "u_viewScale"),
    };

    // Ping-pong targets
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

    // Audio texture (spectrum row)
    this._audioW = 512;
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
    this._agcSpec = 1e-3;
    this._invSpec = 1.0;

    this._t0 = performance.now();
    this._t = 0;
    this._phase = 0;
    this._lastNow = this._t0;
    this._energy = 0;
    this._bass = 0;
    this._treble = 0;
    this._specBuf = null;

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

  _band(spec, b0, b1) {
    b0 = Math.max(0, Math.min(spec.length - 1, b0));
    b1 = Math.max(b0 + 1, Math.min(spec.length, b1));
    let sum = 0;
    for (let i = b0; i < b1; i++) sum += spec[i];
    return sum / (b1 - b0);
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
      const now = performance.now();
      let dt = (now - this._lastNow) * 0.001;
      this._lastNow = now;
      if (!isFinite(dt) || dt <= 0) dt = 0.016;
      if (dt > 0.1) dt = 0.1;

      // spectrum copy (read-only safety)
      const srcSpec = frame?.spectrum;
      let spec = srcSpec;
      if (srcSpec) {
        if (!this._specBuf || this._specBuf.length !== srcSpec.length) {
          this._specBuf = new Float32Array(srcSpec.length);
        }
        this._specBuf.set(srcSpec);
        spec = this._specBuf;
      }
      const rms = (frame?.rms && frame.rms[0]) ? frame.rms[0] : 0;
      const gain = frame?.gain || 1.0;
      const overlay = !!frame?.overlay;

      const bass = this._band(spec, 2, 50) * gain;
      const treble = this._band(spec, Math.floor(spec.length * 0.55), Math.floor(spec.length * 0.95)) * gain;

      const smoothRate = 10.0;
      const a = Math.exp(-dt * smoothRate);
      const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
      this._energy = a * this._energy + (1 - a) * clamp01(rms * 6.0);
      this._bass = a * this._bass + (1 - a) * clamp01(bass * 18.0);
      this._treble = a * this._treble + (1 - a) * clamp01(treble * 30.0);

      // Avoid "time gets huge" precision issues + huge dt jumps after tab stalls.
      this._t = (this._t + dt) % 30.0;
      const t = this._t;

      const speed = 0.35 + 1.2 * this._bass;
      this._phase = Number.isFinite(this._phase) ? this._phase : 0;
      this._phase += dt * speed;
      if (this._phase > 1e6) this._phase -= 1e6;

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
      gl.uniform1f(this._locA.u_dt, dt);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // -------- Pass I: final image --------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);

      gl.useProgram(this._progI);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
      gl.enableVertexAttribArray(this._locI.a_pos);
      gl.vertexAttribPointer(this._locI.a_pos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
      gl.uniform1i(this._locI.u_buf, 0);

      gl.uniform2f(this._locI.u_res, w, h);
      gl.uniform1f(this._locI.u_time, t);
      gl.uniform1f(this._locI.u_phase, this._phase);
      gl.uniform1f(this._locI.u_energy, this._energy);
      gl.uniform1f(this._locI.u_bass, this._bass);
      gl.uniform1f(this._locI.u_treble, this._treble);
      gl.uniform1i(this._locI.u_overlay, overlay ? 1 : 0);
      gl.uniform1f(this._locI.u_overlayBoost, overlay ? 2.5 : 1.0);
      gl.uniform1f(this._locI.u_viewScale, overlay ? 1.18 : 1.0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap
      this._swap();
    } catch (err) {
      this._failed = true;
      console.error("[PlasmaWebGL] render failed:", err);
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
    const decay = Math.exp(-dt / 0.9);
    this._agcSpec = Math.max(inst, this._agcSpec * decay, 1e-3);
    this._invSpec = 1.0 / (this._agcSpec + 1e-6);

    const specLen = spec && spec.length ? spec.length : 0;
    for (let i = 0; i < N; i++) {
      let s = 0;
      if (specLen > 2) {
        const si = 1 + ((i * (specLen - 2) / (N - 1)) | 0);
        const v = (spec[si] || 0) * (gain || 1.0) * this._invSpec;
        s = Math.sqrt(Math.max(0, Math.min(1, v * 4.0)));
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

    // Init both buffers to transparent
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
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS_BUFFER_A = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_prev;
uniform sampler2D u_audio;
uniform vec2 u_res;
uniform float u_time;
uniform float u_dt;
void main(){
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / u_res.xy;
  float topRow = step(fragCoord.y, 1.0);
  float m = texture2D(u_audio, vec2(uv.x, 0.5)).r;
  vec3 prev = texture2D(u_prev, uv).rgb;
  float fade60 = 0.985;
  float fade = pow(fade60, u_dt * 60.0);
  vec3 col = mix(prev * fade, vec3(m), topRow);
  gl_FragColor = vec4(col, 1.0);
}
`;

const FS_IMAGE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_buf;
uniform vec2 u_res;
uniform float u_time;
uniform float u_phase;
uniform float u_energy;
uniform float u_bass;
uniform float u_treble;
uniform int u_overlay;
uniform float u_overlayBoost;
uniform float u_viewScale;

vec3 palette(float t){
  vec3 a = vec3(0.10, 0.10, 0.20);
  vec3 b = vec3(0.55, 0.85, 1.00);
  vec3 c = vec3(0.85, 0.35, 0.95);
  vec3 d = vec3(0.00, 0.33, 0.67);
  return a + b*cos(6.28318*(c*t + d));
}

void main(){
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_res.x / u_res.y;
  uv *= u_viewScale;
  vec2 p = uv;

  float t = u_phase;
  float e = u_energy;

  float r = length(p);
  float a = atan(p.y, p.x);
  a += 0.9*sin(r*3.0 - t*1.2) * (0.3 + 0.9*e);
  r += 0.2*sin(a*6.0 + t*0.8) * (0.2 + 1.2*u_treble);

  vec2 q = vec2(cos(a), sin(a)) * r;
  float v = 0.0;
  v += sin(q.x*6.0 + t);
  v += sin(q.y*6.0 - t*1.2);
  v += sin((q.x+q.y)*4.0 + t*0.7);
  v /= 3.0;

  float glow = smoothstep(0.2, 0.95, abs(v));
  float pulses = 0.5 + 0.5*sin(t*2.0 + v*4.0);
  float k = mix(glow, pulses, 0.35 + 0.35*u_treble);

  vec3 col = palette(v*0.35 + t*0.05);
  col *= 0.65 + 0.85*k;
  col += vec3(0.25, 0.85, 1.0) * (0.15 + 0.85*e) * smoothstep(0.2, 0.7, glow);

  float vig = smoothstep(1.2, 0.2, r);
  col *= vig;

  vec3 fb = texture2D(u_buf, v_uv).rgb;
  col += fb * 0.02;

  float alpha;
  if (u_overlay == 1) {
    col *= u_overlayBoost;
    col = pow(col, vec3(0.85));
    col = min(col, vec3(1.0));
    float lum = max(col.r, max(col.g, col.b));
    alpha = smoothstep(0.03, 0.15, lum);
  } else {
    alpha = clamp(glow * (0.35 + 0.65*e) * vig, 0.0, 1.0);
  }

  gl_FragColor = vec4(col, alpha);
}
`;
