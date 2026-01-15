// static/js/visualizers/milkdrop_webgl2.js
// Milkdrop-ish Warp Reactor -- WebGL2-first, fullscreen feedback shader.
// GPU: ping-pong feedback buffer + mesh warp + polygon shapes + ribbons/pulses/sparkles.
// CPU: only computes audio bands -> uniforms.

import { createProgram, createFullscreenQuad } from "/static/js/webgl/util.js";

export class MilkdropWarpReactorWebGL2 {
  static id = "milkdrop";
  static name = "Milkdrop-ish Warp Reactor (WebGL2)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const opts = {
      alpha: false,                 // opaque
      antialias: false,             // MSAA is wasted on a full-screen shader
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    };

    this.gl =
      canvas.getContext("webgl2", opts) ||
      canvas.getContext("webgl", opts) ||
      canvas.getContext("experimental-webgl", opts);

    if (!this.gl) throw new Error("WebGL not available");

    this.isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      this.gl instanceof WebGL2RenderingContext;

    const gl = this.gl;

    this._destroyed = false;
    this._onContextLost = (e) => {
      if (e) e.preventDefault();
      this._destroyed = true;
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);

    this._t0 = performance.now();
    this._lastNow = this._t0;

    // Smoothed audio
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._energy = 0;
    this._specBuf = null;

    // Kick transient
    this._prevBass = 0;
    this._kick = 0;

    // Spawned shapes (fixed speed per-shape)
    this._shapeCount = 9;
    this._shapePos = new Float32Array(this._shapeCount * 2);
    this._shapeDir = new Float32Array(this._shapeCount * 2);
    this._shapeSpeed = new Float32Array(this._shapeCount);
    this._shapeSize = new Float32Array(this._shapeCount);
    this._shapeSides = new Float32Array(this._shapeCount);
    this._shapeRot = new Float32Array(this._shapeCount);
    this._shapeSpin = new Float32Array(this._shapeCount);
    this._shapeHue = new Float32Array(this._shapeCount);
    this._shapeAge = new Float32Array(this._shapeCount);
    this._shapeLife = new Float32Array(this._shapeCount);
    this._shapeA = new Float32Array(this._shapeCount * 4);
    this._shapeB = new Float32Array(this._shapeCount * 4);
    this._shapeIndex = 0;
    this._spawnAcc = 0;
    this._rng = 0x12345678;
    this._midPhase = 0;

    // Fullscreen quad
    this.vb = createFullscreenQuad(gl);

    // Programs
    this.progFB = createProgram(gl, this._vs(), this._fsFeedback());
    this.progPresent = createProgram(gl, this._vs(), this._fsPresent());

    // Locations (feedback)
    const loc = (p, n) => gl.getUniformLocation(p, n);
    this.aPosFB = gl.getAttribLocation(this.progFB, "a_pos");
    this.uPrev = loc(this.progFB, "u_prev");
    this.uRes = loc(this.progFB, "u_res");
    this.uTime = loc(this.progFB, "u_time");
    this.uDt = loc(this.progFB, "u_dt");
    this.uBass = loc(this.progFB, "u_bass");
    this.uMid = loc(this.progFB, "u_mid");
    this.uTreble = loc(this.progFB, "u_treble");
    this.uEnergy = loc(this.progFB, "u_energy");
    this.uKick = loc(this.progFB, "u_kick");
    this.uSpawn = loc(this.progFB, "u_spawn");
    this.uMidPhase = loc(this.progFB, "u_mid_phase");
    this.uShapeA = loc(this.progFB, "u_shapeA[0]");
    this.uShapeB = loc(this.progFB, "u_shapeB[0]");

    // Locations (present)
    this.aPosPR = gl.getAttribLocation(this.progPresent, "a_pos");
    this.uTex = loc(this.progPresent, "u_tex");

    // Ping-pong targets
    this._w = 0;
    this._h = 0;
    this._texA = this._texB = null;
    this._fbA = this._fbB = null;
    this._readTex = this._writeTex = null;
    this._readFB = this._writeFB = null;

    this.onResize();
  }

  onResize() {
    const gl = this.gl;
    if (this._destroyed || !gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    gl.viewport(0, 0, w, h);

    if (w !== this._w || h !== this._h || !this._readTex) {
      this._w = w;
      this._h = h;
      this._recreateTargets(w, h);
    }
  }

  _recreateTargets(w, h) {
    const gl = this.gl;

    // cleanup old
    if (this._texA) gl.deleteTexture(this._texA);
    if (this._texB) gl.deleteTexture(this._texB);
    if (this._fbA) gl.deleteFramebuffer(this._fbA);
    if (this._fbB) gl.deleteFramebuffer(this._fbB);

    this._texA = this._createTex(w, h);
    this._texB = this._createTex(w, h);
    this._fbA = this._createFB(this._texA);
    this._fbB = this._createFB(this._texB);

    this._readTex = this._texA;
    this._writeTex = this._texB;
    this._readFB = this._fbA;
    this._writeFB = this._fbB;

    // initialize both buffers to black
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbA);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbB);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createTex(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internalFormat = this.isWebGL2 && gl.RGBA8 ? gl.RGBA8 : gl.RGBA;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  _createFB(tex) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Milkdrop: framebuffer incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  _bandHz(spec, samplerate, fftSize, f0, f1) {
    if (!spec || spec.length < 4 || !samplerate || !fftSize) return 0;
    const binHz = samplerate / fftSize;
    let i0 = Math.floor(f0 / binHz);
    let i1 = Math.floor(f1 / binHz);
    i0 = Math.max(0, Math.min(spec.length - 1, i0));
    i1 = Math.max(0, Math.min(spec.length - 1, i1));
    if (i1 < i0) [i0, i1] = [i1, i0];
    const n = Math.max(1, i1 - i0 + 1);
    let s = 0;
    for (let i = i0; i <= i1; i++) s += spec[i];
    return s / n;
  }

  _shape(x) {
    const v = Math.max(0, x);
    const y = 1.0 - Math.exp(-v * 8.0);
    return Math.max(0, Math.min(1, y));
  }

  _clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  _smoothstep(edge0, edge1, x) {
    const t = this._clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  _rand() {
    this._rng = (this._rng * 1664525 + 1013904223) >>> 0;
    return this._rng / 4294967296;
  }

  _spawnShape(vol, b, m, h) {
    const i = this._shapeIndex;
    this._shapeIndex = (this._shapeIndex + 1) % this._shapeCount;

    const ang = this._rand() * Math.PI * 2;
    const dirx = Math.cos(ang);
    const diry = Math.sin(ang);

    const speed = this._lerp(1.1, 2.8, vol) * (0.9 + 0.2 * this._rand());

    const wb = b * 1.2;
    const wm = m * 1.0;
    const wh = h * 0.8;
    const sum = wb + wm + wh;
    let sizeMin = 0.06;
    let sizeMax = 0.14;
    if (sum >= 0.05) {
      const pick = this._rand() * sum;
      if (pick < wb) {
        sizeMin = 0.11;
        sizeMax = 0.22;
      } else if (pick < wb + wm) {
        sizeMin = 0.06;
        sizeMax = 0.14;
      } else {
        sizeMin = 0.02;
        sizeMax = 0.06;
      }
    }
    const size = this._lerp(sizeMin, sizeMax, this._rand());

    const sides = 3 + Math.floor(this._rand() * 4);
    const hue = this._rand();
    const rot = this._rand() * Math.PI * 2;
    const spin = (this._rand() * 2 - 1) * 2.6;
    const life = 1.0;

    this._shapePos[i * 2] = 0;
    this._shapePos[i * 2 + 1] = 0;
    this._shapeDir[i * 2] = dirx;
    this._shapeDir[i * 2 + 1] = diry;
    this._shapeSpeed[i] = speed;
    this._shapeSize[i] = size;
    this._shapeSides[i] = sides;
    this._shapeRot[i] = rot;
    this._shapeSpin[i] = spin;
    this._shapeHue[i] = hue;
    this._shapeAge[i] = 0;
    this._shapeLife[i] = life;
  }

  _updateShapes(dt, vol, b, m, h) {
    const baseRate = this._lerp(0.15, 2.2, vol);
    const spawnRate = baseRate + 2.0 * b + 1.0 * m + 1.6 * this._kick;
    this._spawnAcc += dt * spawnRate;

    let spawned = 0;
    while (this._spawnAcc >= 1.0 && spawned < this._shapeCount) {
      this._spawnAcc -= 1.0;
      this._spawnShape(vol, b, m, h);
      spawned++;
    }

    for (let i = 0; i < this._shapeCount; i++) {
      const ai = i * 4;
      const bi = ai;

      if (this._shapeLife[i] <= 0) {
        this._shapeA[ai] = 0;
        this._shapeA[ai + 1] = 0;
        this._shapeA[ai + 2] = 0;
        this._shapeA[ai + 3] = 0;
        this._shapeB[bi] = 0;
        this._shapeB[bi + 1] = 0;
        this._shapeB[bi + 2] = 0;
        this._shapeB[bi + 3] = 0;
        continue;
      }

      this._shapeAge[i] += dt;

      const dx = this._shapeDir[i * 2] * this._shapeSpeed[i] * dt;
      const dy = this._shapeDir[i * 2 + 1] * this._shapeSpeed[i] * dt;
      const px = this._shapePos[i * 2] + dx;
      const py = this._shapePos[i * 2 + 1] + dy;
      this._shapePos[i * 2] = px;
      this._shapePos[i * 2 + 1] = py;
      this._shapeRot[i] += this._shapeSpin[i] * dt;

      if (px * px + py * py > 2.25) {
        this._shapeLife[i] = 0;
        this._shapeA[ai + 2] = 0;
        this._shapeB[bi + 2] = 0;
        continue;
      }

      const fadeIn = this._smoothstep(0.0, 0.20, this._shapeAge[i]);
      const r = Math.sqrt(px * px + py * py);
      const fadeOut = 1.0 - this._smoothstep(1.05, 1.25, r);
      const life = fadeIn * fadeOut;

      this._shapeA[ai] = px;
      this._shapeA[ai + 1] = py;
      this._shapeA[ai + 2] = this._shapeSize[i];
      this._shapeA[ai + 3] = this._shapeSides[i];

      this._shapeB[bi] = this._shapeRot[i];
      this._shapeB[bi + 1] = this._shapeHue[i];
      this._shapeB[bi + 2] = life;
      this._shapeB[bi + 3] = 1.0;
    }
  }

  onFrame(frame) {
    const gl = this.gl;
    if (this._destroyed || !gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    if (w !== this._w || h !== this._h || !this._readTex) {
      this._w = w;
      this._h = h;
      this._recreateTargets(w, h);
    }

    const now = performance.now();
    let dt = (now - this._lastNow) * 0.001;
    this._lastNow = now;
    dt = Math.min(0.05, Math.max(0.0, dt));

    const srcSpec = frame?.spectrum;
    let spec = srcSpec;
    if(srcSpec){
      if(!this._specBuf || this._specBuf.length !== srcSpec.length){
        this._specBuf = new Float32Array(srcSpec.length);
      }
      this._specBuf.set(srcSpec);
      spec = this._specBuf;
    }
    const gain = Number(frame?.gain ?? 1);
    const sr = Number(frame?.samplerate ?? 48000);
    const fftSize = Number(frame?.fftSize ?? 2048);

    const bassRaw = this._shape(this._bandHz(spec, sr, fftSize, 35, 140) * gain * 2.2);
    const midRaw  = this._shape(this._bandHz(spec, sr, fftSize, 180, 2200) * gain * 1.6);
    const treRaw  = this._shape(this._bandHz(spec, sr, fftSize, 2800, 12000) * gain * 1.3);
    const energyRaw = this._shape(this._bandHz(spec, sr, fftSize, 45, 12000) * gain * 1.9);

    const smoothRate = 10.0;
    const a = Math.exp(-dt * smoothRate);
    this._bass   = a * this._bass   + (1 - a) * bassRaw;
    this._mid    = a * this._mid    + (1 - a) * midRaw;
    this._treble = a * this._treble + (1 - a) * treRaw;
    this._energy = a * this._energy + (1 - a) * energyRaw;

    this._midPhase = Number.isFinite(this._midPhase) ? this._midPhase : 0;
    this._midPhase += dt * this._mid;
    if (this._midPhase > 1e6) this._midPhase -= 1e6;

    const db = Math.max(0, this._bass - this._prevBass);
    this._prevBass = this._bass;
    const kickDecayRate = 8.0;
    this._kick *= Math.exp(-dt * kickDecayRate);
    this._kick = Math.max(this._kick, Math.min(1, db * 7.0));

    const vol = this._clamp01(this._energy);
    const b = this._clamp01(this._bass);
    const m = this._clamp01(this._mid);
    const h = this._clamp01(this._treble);
    this._updateShapes(dt, vol, b, m, h);

    const t = ((now - this._t0) * 0.001) % 600.0;

    // --- PASS 1: feedback warp into writeFB ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._writeFB);
    gl.viewport(0, 0, w, h);

    gl.useProgram(this.progFB);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPosFB);
    gl.vertexAttribPointer(this.aPosFB, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._readTex);
    gl.uniform1i(this.uPrev, 0);

    gl.uniform2f(this.uRes, w, h);
    gl.uniform1f(this.uTime, t);
    gl.uniform1f(this.uDt, dt);
    gl.uniform1f(this.uBass, this._bass);
    gl.uniform1f(this.uMid, this._mid);
    gl.uniform1f(this.uTreble, this._treble);
    gl.uniform1f(this.uEnergy, this._energy);
    gl.uniform1f(this.uKick, this._kick);
    if (this.uMidPhase !== null) gl.uniform1f(this.uMidPhase, this._midPhase);
    if (this.uShapeA !== null) gl.uniform4fv(this.uShapeA, this._shapeA);
    if (this.uShapeB !== null) gl.uniform4fv(this.uShapeB, this._shapeB);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- PASS 2: present to screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);

    gl.useProgram(this.progPresent);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPosPR);
    gl.vertexAttribPointer(this.aPosPR, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
    gl.uniform1i(this.uTex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap
    const tmpT = this._readTex;
    this._readTex = this._writeTex;
    this._writeTex = tmpT;

    const tmpF = this._readFB;
    this._readFB = this._writeFB;
    this._writeFB = tmpF;
  }

  destroy() {
    try {
      this._destroyed = true;
      this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);

      const gl = this.gl;
      gl.deleteProgram(this.progFB);
      gl.deleteProgram(this.progPresent);
      gl.deleteBuffer(this.vb);

      if (this._texA) gl.deleteTexture(this._texA);
      if (this._texB) gl.deleteTexture(this._texB);
      if (this._fbA) gl.deleteFramebuffer(this._fbA);
      if (this._fbB) gl.deleteFramebuffer(this._fbB);
    } catch (e) {}
  }

  _vs() {
    if (this.isWebGL2) {
      return `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`;
    }
    return `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`;
  }

  _fsFeedback() {
    if (this.isWebGL2) {
      return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_prev;
uniform vec2  u_res;
uniform float u_time;
uniform float u_dt;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;
uniform float u_mid_phase;
const int SHAPES = 9;
uniform vec4 u_shapeA[SHAPES];
uniform vec4 u_shapeB[SHAPES];
const int SHAPES = 9;
uniform vec4 u_shapeA[SHAPES];
uniform vec4 u_shapeB[SHAPES];

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

mat2 rot2(float a){
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Signed distance to a regular N-gon centered at origin (approx; fast + looks good).
float sdNgon(vec2 p, float n, float r){
  float a = atan(p.y, p.x);
  float k = 6.28318530718 / n;
  return cos(floor(0.5 + a / k) * k - a) * length(p) - r;
}

float ribbon(vec2 p, float y0, float w){
  float d = abs(p.y - y0);
  return exp(-d * w);
}

void main(){
  vec2 uv = v_uv;
  float aspect = u_res.x / max(1.0, u_res.y);

  // centered coords (aspect-corrected)
  vec2 p = uv - 0.5;
  p.x *= aspect;

  float r = length(p);
  float ang = atan(p.y, p.x);

  // --- feedback warp (Milkdrop-ish) ---
  float swirl = 0.35 + u_mid*0.95 + u_energy*0.35;
  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  float a = ang + swirl*wob + u_time*0.22 + u_mid_phase*0.85;

  // zoom/pump driven by bass + kick
  float zoom = 0.985 - u_bass*0.018 + u_kick*0.028;
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;

  // treble shimmer warp
  float sh = (0.004 + 0.018*u_treble) * (0.65 + 0.55*u_energy);
  q += sh * vec2(
    sin(u_time*1.25 + p.y*6.0),
    cos(u_time*1.05 + p.x*5.0)
  );

  vec2 uv2 = q;
  uv2.x /= aspect;
  uv2 += 0.5;

  // --- per-pixel "mesh warp" (Milkdrop-ish) ---
  // Tiny sine-grid displacement BEFORE sampling feedback. Keeps trails lively with near-zero CPU cost.
  float mf = mix(18.0, 42.0, u_treble); // mesh frequency
  float ma = (0.0012 + 0.0048*u_energy) * (0.55 + 0.85*u_treble); // mesh amplitude
  vec2 mp = (uv2 - 0.5);
  mp.x *= aspect;
  vec2 gw = vec2(
    sin(mp.y*mf + u_time*1.70) + sin(mp.y*(mf*0.53) - u_time*2.10),
    cos(mp.x*mf + u_time*1.30) + cos(mp.x*(mf*0.61) + u_time*2.40)
  );
  uv2 += ma * gw;

  uv2 = clamp(uv2, vec2(0.001), vec2(0.999));

  vec3 prev = texture(u_prev, uv2).rgb;

  // feedback decay (keep trails but prevent runaway)
  float fade60 = 0.965 - 0.020*u_energy + 0.010*u_kick;
  fade60 = clamp(fade60, 0.85, 0.995);
  float fade = pow(fade60, u_dt * 60.0);
  prev *= fade;

  // subtle channel drift (color cycling vibe)
  prev *= vec3(1.005, 0.998, 1.002);
  float pm = max(prev.r, max(prev.g, prev.b));
  prev *= 1.0 / (1.0 + pm * 0.6);

  // --- new content layer ---
  float baseHue = fract(0.58 + 0.12*sin(u_time*0.06) + 0.18*u_mid + 0.10*u_treble);

  // Ribbon waveforms (classic milkdrop-ish feel)
  float amp = (0.10 + 0.18*u_mid + 0.10*u_bass) * (0.85 + 0.60*u_energy);
  float w1 = (55.0 + 90.0*u_treble);
  float w2 = (40.0 + 75.0*u_treble);

  float yA = 0.08*sin(p.x*2.2 + u_time*1.15 + u_mid_phase*1.20) + 0.06*sin(p.x*4.6 - u_time*0.90);
  float yB = 0.09*sin(p.x*1.5 - u_time*0.95 - u_mid_phase*1.10) + 0.05*sin(p.x*5.2 + u_time*1.35);
  float yC = 0.06*sin(p.x*3.1 + u_time*1.40 + u_mid_phase*0.90) + 0.04*sin(p.x*6.1 - u_time*0.70);

  float lineA = ribbon(p, yA*amp, w1);
  float lineB = ribbon(p, yB*amp, w2);
  float lineC = ribbon(p, yC*amp, w2);

  vec3 colA = hsv2rgb(vec3(baseHue + 0.00, 0.90, 1.00));
  vec3 colB = hsv2rgb(vec3(baseHue + 0.33, 0.85, 1.00));
  vec3 colC = hsv2rgb(vec3(baseHue + 0.66, 0.80, 1.00));

  float lineGain = smoothstep(0.06, 0.28, u_energy);

  vec3 add = vec3(0.0);
  add += colA * lineA * (0.55 * lineGain);
  add += colB * lineB * (0.45 * lineGain);
  add += colC * lineC * (0.40 * lineGain);

  // Radial pulse rings (bass/kick)
  float ringR = 0.22 + 0.08*sin(u_time*0.55) + 0.12*u_bass;
  float ring = exp(-abs(r - ringR) * (28.0 + 38.0*u_kick));
  add += hsv2rgb(vec3(baseHue + 0.12, 0.70, 1.00)) * ring * (0.25 + 0.85*u_kick);

  // --- rotating polygon "shapes" (Milkdrop-ish) ---
  // One hex "reactor" + one triangle "blade". Additive glow so it feels like a preset layer.
  float rotA = u_time*0.35 + u_mid_phase*0.95;
  vec2 sp = p;

  vec2 s1p = rot2(rotA) * (sp * (1.10 + 0.25*u_energy));
  float d1 = sdNgon(s1p, 6.0, 0.23 + 0.08*u_bass);
  float s1 = exp(-abs(d1) * (18.0 + 28.0*u_energy));
  float f1 = smoothstep(0.015, 0.0, d1); // a little fill
  add += hsv2rgb(vec3(baseHue + 0.05, 0.80, 1.00)) * (s1*0.20 + f1*0.05) * (0.45 + 0.65*u_energy);

  vec2 offs = vec2(0.12*sin(u_time*0.70), 0.08*cos(u_time*0.50));
  vec2 s2p = rot2(-rotA*1.30 + 0.70) * ((sp + offs) * (1.25 + 0.20*u_energy));
  float d2 = sdNgon(s2p, 3.0, 0.18 + 0.06*u_mid);
  float s2 = exp(-abs(d2) * (22.0 + 30.0*u_energy));
  float f2 = smoothstep(0.018, 0.0, d2);
  add += hsv2rgb(vec3(baseHue + 0.45, 0.85, 1.00)) * (s2*0.18 + f2*0.04) * (0.40 + 0.70*u_energy);

  // --- spawned shapes (fixed speed per-shape, parameters set on spawn) ---
  float throwBoost = 0.90;
  for (int i = 0; i < SHAPES; i++) {
    vec4 sa = u_shapeA[i];
    vec4 sb = u_shapeB[i];
    float life = sb.z;
    if (life <= 0.0) continue;

    vec2 pos = sa.xy;
    float size = sa.z;
    float sides = sa.w;
    float rotS = sb.x;
    float hue = fract(baseHue + sb.y);

    vec2 lp = rot2(rotS) * (p - pos);
    float dS = sdNgon(lp, sides, size);
    float glow = exp(-abs(dS) * (20.0 + 40.0*u_energy));
    float fill = smoothstep(0.020, 0.0, dS);
    vec3 sc  = hsv2rgb(vec3(hue, 0.85, 1.0));
    add += sc * (glow*0.32 + fill*0.10) * throwBoost * life;
  }

  // Sparkles (treble)
  vec2 g = floor((uv * vec2(240.0, 135.0)) + u_time*vec2(12.0, 7.0));
  float h = hash12(g);
  float sparkle = smoothstep(0.996 - 0.004*u_treble, 1.0, h);
  add += vec3(1.0) * sparkle * (0.08 + 0.35*u_treble) * (0.5 + 0.6*u_energy);

  // Combine
  vec3 col = prev + add;

  // Gentle limiter to prevent slow buildup over time.
  float m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.35);

  // Cheap "bloom-ish" curve
  col += col * col * (0.30 + 0.35*u_energy);

  // Vignette
  float vig = smoothstep(1.25, 0.20, r);
  col *= (0.55 + 0.45*vig);

  // Tone map
  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}`;
    }

    // WebGL1 fallback
    return `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_prev;
uniform vec2  u_res;
uniform float u_time;
uniform float u_dt;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;
uniform float u_mid_phase;

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

mat2 rot2(float a){
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float sdNgon(vec2 p, float n, float r){
  float a = atan(p.y, p.x);
  float k = 6.28318530718 / n;
  return cos(floor(0.5 + a / k) * k - a) * length(p) - r;
}

float ribbon(vec2 p, float y0, float w){
  float d = abs(p.y - y0);
  return exp(-d * w);
}

void main(){
  vec2 uv = v_uv;
  float aspect = u_res.x / max(1.0, u_res.y);

  vec2 p = uv - 0.5;
  p.x *= aspect;

  float r = length(p);
  float ang = atan(p.y, p.x);

  float swirl = 0.35 + u_mid*0.95 + u_energy*0.35;
  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  float a = ang + swirl*wob + u_time*0.22 + u_mid_phase*0.85;

  float zoom = 0.985 - u_bass*0.018 + u_kick*0.028;
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;

  float sh = (0.004 + 0.018*u_treble) * (0.65 + 0.55*u_energy);
  q += sh * vec2(
    sin(u_time*1.25 + p.y*6.0),
    cos(u_time*1.05 + p.x*5.0)
  );

  vec2 uv2 = q;
  uv2.x /= aspect;
  uv2 += 0.5;

  // per-pixel mesh warp before sampling feedback
  float mf = mix(18.0, 42.0, u_treble);
  float ma = (0.0012 + 0.0048*u_energy) * (0.55 + 0.85*u_treble);
  vec2 mp = (uv2 - 0.5);
  mp.x *= aspect;
  vec2 gw = vec2(
    sin(mp.y*mf + u_time*1.70) + sin(mp.y*(mf*0.53) - u_time*2.10),
    cos(mp.x*mf + u_time*1.30) + cos(mp.x*(mf*0.61) + u_time*2.40)
  );
  uv2 += ma * gw;

  uv2 = clamp(uv2, vec2(0.001), vec2(0.999));

  vec3 prev = texture2D(u_prev, uv2).rgb;

  float fade60 = 0.965 - 0.020*u_energy + 0.010*u_kick;
  fade60 = clamp(fade60, 0.85, 0.995);
  float fade = pow(fade60, u_dt * 60.0);
  prev *= fade;
  prev *= vec3(1.005, 0.998, 1.002);
  float pm = max(prev.r, max(prev.g, prev.b));
  prev *= 1.0 / (1.0 + pm * 0.6);

  float baseHue = fract(0.58 + 0.12*sin(u_time*0.06) + 0.18*u_mid + 0.10*u_treble);

  float amp = (0.10 + 0.18*u_mid + 0.10*u_bass) * (0.85 + 0.60*u_energy);
  float w1 = (55.0 + 90.0*u_treble);
  float w2 = (40.0 + 75.0*u_treble);

  float yA = 0.08*sin(p.x*2.2 + u_time*1.15 + u_mid_phase*1.20) + 0.06*sin(p.x*4.6 - u_time*0.90);
  float yB = 0.09*sin(p.x*1.5 - u_time*0.95 - u_mid_phase*1.10) + 0.05*sin(p.x*5.2 + u_time*1.35);
  float yC = 0.06*sin(p.x*3.1 + u_time*1.40 + u_mid_phase*0.90) + 0.04*sin(p.x*6.1 - u_time*0.70);

  float lineA = ribbon(p, yA*amp, w1);
  float lineB = ribbon(p, yB*amp, w2);
  float lineC = ribbon(p, yC*amp, w2);

  vec3 colA = hsv2rgb(vec3(baseHue + 0.00, 0.90, 1.00));
  vec3 colB = hsv2rgb(vec3(baseHue + 0.33, 0.85, 1.00));
  vec3 colC = hsv2rgb(vec3(baseHue + 0.66, 0.80, 1.00));

  float lineGain = smoothstep(0.06, 0.28, u_energy);

  vec3 add = vec3(0.0);
  add += colA * lineA * (0.55 * lineGain);
  add += colB * lineB * (0.45 * lineGain);
  add += colC * lineC * (0.40 * lineGain);

  float ringR = 0.22 + 0.08*sin(u_time*0.55) + 0.12*u_bass;
  float ring = exp(-abs(r - ringR) * (28.0 + 38.0*u_kick));
  add += hsv2rgb(vec3(baseHue + 0.12, 0.70, 1.00)) * ring * (0.25 + 0.85*u_kick);

  // rotating polygon shapes
  float rotA = u_time*0.35 + u_mid_phase*0.95;
  vec2 sp = p;

  vec2 s1p = rot2(rotA) * (sp * (1.10 + 0.25*u_energy));
  float d1 = sdNgon(s1p, 6.0, 0.23 + 0.08*u_bass);
  float s1 = exp(-abs(d1) * (18.0 + 28.0*u_energy));
  float f1 = smoothstep(0.015, 0.0, d1);
  add += hsv2rgb(vec3(baseHue + 0.05, 0.80, 1.00)) * (s1*0.20 + f1*0.05) * (0.45 + 0.65*u_energy);

  vec2 offs = vec2(0.12*sin(u_time*0.70), 0.08*cos(u_time*0.50));
  vec2 s2p = rot2(-rotA*1.30 + 0.70) * ((sp + offs) * (1.25 + 0.20*u_energy));
  float d2 = sdNgon(s2p, 3.0, 0.18 + 0.06*u_mid);
  float s2 = exp(-abs(d2) * (22.0 + 30.0*u_energy));
  float f2 = smoothstep(0.018, 0.0, d2);
  add += hsv2rgb(vec3(baseHue + 0.45, 0.85, 1.00)) * (s2*0.18 + f2*0.04) * (0.40 + 0.70*u_energy);

  // spawned shapes (fixed speed per-shape)
  float throwBoost = 0.90;
  for (int i = 0; i < SHAPES; i++) {
    vec4 sa = u_shapeA[i];
    vec4 sb = u_shapeB[i];
    float life = sb.z;
    if (life <= 0.0) continue;

    vec2 pos = sa.xy;
    float size = sa.z;
    float sides = sa.w;
    float rotS = sb.x;
    float hue = fract(baseHue + sb.y);

    vec2 lp = rot2(rotS) * (p - pos);
    float dS = sdNgon(lp, sides, size);
    float glow = exp(-abs(dS) * (20.0 + 40.0*u_energy));
    float fill = smoothstep(0.020, 0.0, dS);
    vec3 sc  = hsv2rgb(vec3(hue, 0.85, 1.0));
    add += sc * (glow*0.32 + fill*0.10) * throwBoost * life;
  }

  vec2 g = floor((uv * vec2(240.0, 135.0)) + u_time*vec2(12.0, 7.0));
  float hh = hash12(g);
  float sparkle = smoothstep(0.996 - 0.004*u_treble, 1.0, hh);
  add += vec3(1.0) * sparkle * (0.08 + 0.35*u_treble) * (0.5 + 0.6*u_energy);

  vec3 col = prev + add;
  float m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.35);
  col += col * col * (0.30 + 0.35*u_energy);

  float vig = smoothstep(1.25, 0.20, r);
  col *= (0.55 + 0.45*vig);

  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));

  gl_FragColor = vec4(col, 1.0);
}`;
  }

  _fsPresent() {
    if (this.isWebGL2) {
      return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;

void main(){
  vec3 col = texture(u_tex, v_uv).rgb;
  // tiny final pop
  col = pow(col, vec3(0.98));
  outColor = vec4(col, 1.0);
}`;
    }

    return `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main(){
  vec3 col = texture2D(u_tex, v_uv).rgb;
  col = pow(col, vec3(0.98));
  gl_FragColor = vec4(col, 1.0);
}`;
  }
}
