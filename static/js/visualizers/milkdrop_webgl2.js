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

    // Kick transient
    this._prevBass = 0;
    this._kick = 0;

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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  _createFB(tex) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
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

    const spec = frame?.spectrum;
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

    const db = Math.max(0, this._bass - this._prevBass);
    this._prevBass = this._bass;
    const kickDecayRate = 8.0;
    this._kick *= Math.exp(-dt * kickDecayRate);
    this._kick = Math.max(this._kick, Math.min(1, db * 7.0));

    const t = (now - this._t0) * 0.001;

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
  float spin  = 0.22 + u_mid*0.85;

  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  float a = ang + swirl*wob + u_time*spin;

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

  // --- new content layer ---
  float baseHue = fract(0.58 + 0.12*sin(u_time*0.06) + 0.18*u_mid + 0.10*u_treble);

  // Ribbon waveforms (classic milkdrop-ish feel)
  float amp = (0.10 + 0.18*u_mid + 0.10*u_bass) * (0.85 + 0.60*u_energy);
  float w1 = (55.0 + 90.0*u_treble);
  float w2 = (40.0 + 75.0*u_treble);

  float yA = 0.08*sin(p.x*2.2 + u_time*(1.15 + 1.20*u_mid)) + 0.06*sin(p.x*4.6 - u_time*0.90);
  float yB = 0.09*sin(p.x*1.5 - u_time*(0.95 + 1.10*u_mid)) + 0.05*sin(p.x*5.2 + u_time*1.35);
  float yC = 0.06*sin(p.x*3.1 + u_time*(1.40 + 0.90*u_mid)) + 0.04*sin(p.x*6.1 - u_time*0.70);

  float lineA = ribbon(p, yA*amp, w1);
  float lineB = ribbon(p, yB*amp, w2);
  float lineC = ribbon(p, yC*amp, w2);

  vec3 colA = hsv2rgb(vec3(baseHue + 0.00, 0.90, 1.00));
  vec3 colB = hsv2rgb(vec3(baseHue + 0.33, 0.85, 1.00));
  vec3 colC = hsv2rgb(vec3(baseHue + 0.66, 0.80, 1.00));

  vec3 add = vec3(0.0);
  add += colA * lineA * (0.55 + 0.75*u_energy);
  add += colB * lineB * (0.45 + 0.70*u_energy);
  add += colC * lineC * (0.40 + 0.65*u_energy);

  // Radial pulse rings (bass/kick)
  float ringR = 0.22 + 0.08*sin(u_time*0.55) + 0.12*u_bass;
  float ring = exp(-abs(r - ringR) * (28.0 + 38.0*u_kick));
  add += hsv2rgb(vec3(baseHue + 0.12, 0.70, 1.00)) * ring * (0.25 + 0.85*u_kick);

  // --- rotating polygon "shapes" (Milkdrop-ish) ---
  // One hex "reactor" + one triangle "blade". Additive glow so it feels like a preset layer.
  float rotA = u_time * (0.35 + 0.95*u_mid);
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

  // --- "thrown" shapes from center (varied speed/size/sides/color) ---
  // Pure GPU procedural emitters; trails come for free from feedback.
  // Keep count modest for perf; increase to 12 if you want more density.
  const int SHAPES = 9;
  float throwBoost = (0.25 + 0.75*u_energy) * (0.55 + 0.45*u_bass) + (0.25*u_kick);
  throwBoost *= 1.30;
  // IMPORTANT: keep spawnRate constant (no audio dependency) so travel doesn't jitter.
  float spawnRate = 0.75; // spawns/sec per slot (0.6..1.2 is a good range)
  for (int i = 0; i < SHAPES; i++) {
    float fi = float(i);

    // Each slot has a stable phase offset so spawns are staggered.
    float slotOff = hash12(vec2(fi + 91.7, 17.3)) * 8.0; // cycles offset
    float phase   = u_time * spawnRate + slotOff;
    float cyc     = floor(phase);   // "spawn id" (integer-ish)
    float lf      = fract(phase);   // 0..1 within this spawn
    float age     = lf / spawnRate; // seconds since spawn (fixed-speed travel)

    // Stable per-spawn randomness (seeded by spawn id)
    float hA = hash12(vec2(fi + 1.3,  cyc +  7.1));
    float hB = hash12(vec2(fi + 4.7,  cyc + 19.9));
    float hC = hash12(vec2(fi + 9.2,  cyc +  3.3));
    float hD = hash12(vec2(fi + 2.6,  cyc + 11.8));

    // Direction + speed are FIXED for the whole life of this spawned shape
    float ang2  = 6.2831853 * hA;
    vec2  dir   = vec2(cos(ang2), sin(ang2));
    float speed = mix(0.55, 1.35, hB);   // units/sec in our centered space
    float rad   = age * speed;

    // Fade-in/out over the spawn window to hide the reset (no snapping)
    float life = smoothstep(0.00, 0.10, lf) * (1.0 - smoothstep(0.80, 1.00, lf));

    // Optional slight curvature (seeded) so paths aren't perfectly straight
    float curve = (hC - 0.5) * 0.25;
    vec2 pos = (rot2(curve * age) * (dir * rad));

    // Vary size and shape (reuse sdNgon)
    float size = (0.05 + 0.14*hD) * (0.70 + 0.65*u_bass);
    float sides = 3.0 + floor(hC * 4.0);       // 3..6
    float spin  = mix(-2.6, 2.6, hA);          // rad/sec (seeded)
    float rotS  = hB*6.2831853 + age * spin;   // rotation seeded at spawn

    // Distance field + glow/fill
    vec2 lp = rot2(rotS) * (p - pos);
    float dS = sdNgon(lp, sides, size);
    float glow = exp(-abs(dS) * (20.0 + 40.0*u_energy));
    float fill = smoothstep(0.020, 0.0, dS);

    // Color: per-shape hue offset + energy-driven value
    float hue = fract(baseHue + 0.18 + 0.85*hB + 0.08*sin(0.08*cyc + fi));
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
  float spin  = 0.22 + u_mid*0.85;

  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  float a = ang + swirl*wob + u_time*spin;

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

  float baseHue = fract(0.58 + 0.12*sin(u_time*0.06) + 0.18*u_mid + 0.10*u_treble);

  float amp = (0.10 + 0.18*u_mid + 0.10*u_bass) * (0.85 + 0.60*u_energy);
  float w1 = (55.0 + 90.0*u_treble);
  float w2 = (40.0 + 75.0*u_treble);

  float yA = 0.08*sin(p.x*2.2 + u_time*(1.15 + 1.20*u_mid)) + 0.06*sin(p.x*4.6 - u_time*0.90);
  float yB = 0.09*sin(p.x*1.5 - u_time*(0.95 + 1.10*u_mid)) + 0.05*sin(p.x*5.2 + u_time*1.35);
  float yC = 0.06*sin(p.x*3.1 + u_time*(1.40 + 0.90*u_mid)) + 0.04*sin(p.x*6.1 - u_time*0.70);

  float lineA = ribbon(p, yA*amp, w1);
  float lineB = ribbon(p, yB*amp, w2);
  float lineC = ribbon(p, yC*amp, w2);

  vec3 colA = hsv2rgb(vec3(baseHue + 0.00, 0.90, 1.00));
  vec3 colB = hsv2rgb(vec3(baseHue + 0.33, 0.85, 1.00));
  vec3 colC = hsv2rgb(vec3(baseHue + 0.66, 0.80, 1.00));

  vec3 add = vec3(0.0);
  add += colA * lineA * (0.55 + 0.75*u_energy);
  add += colB * lineB * (0.45 + 0.70*u_energy);
  add += colC * lineC * (0.40 + 0.65*u_energy);

  float ringR = 0.22 + 0.08*sin(u_time*0.55) + 0.12*u_bass;
  float ring = exp(-abs(r - ringR) * (28.0 + 38.0*u_kick));
  add += hsv2rgb(vec3(baseHue + 0.12, 0.70, 1.00)) * ring * (0.25 + 0.85*u_kick);

  // rotating polygon shapes
  float rotA = u_time * (0.35 + 0.95*u_mid);
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

  // thrown shapes from center (WebGL1 path)
  const int SHAPES = 9;
  float throwBoost = (0.25 + 0.75*u_energy) * (0.55 + 0.45*u_bass) + (0.25*u_kick);
  throwBoost *= 1.30;
  float spawnRate = 0.75;
  for (int i = 0; i < SHAPES; i++) {
    float fi = float(i);

    float slotOff = hash12(vec2(fi + 91.7, 17.3)) * 8.0;
    float phase   = u_time * spawnRate + slotOff;
    float cyc     = floor(phase);
    float lf      = fract(phase);
    float age     = lf / spawnRate;

    float hA = hash12(vec2(fi + 1.3,  cyc +  7.1));
    float hB = hash12(vec2(fi + 4.7,  cyc + 19.9));
    float hC = hash12(vec2(fi + 9.2,  cyc +  3.3));
    float hD = hash12(vec2(fi + 2.6,  cyc + 11.8));

    float ang2  = 6.2831853 * hA;
    vec2  dir   = vec2(cos(ang2), sin(ang2));
    float speed = mix(0.55, 1.35, hB);
    float rad   = age * speed;

    float life = smoothstep(0.00, 0.10, lf) * (1.0 - smoothstep(0.80, 1.00, lf));

    float curve = (hC - 0.5) * 0.25;
    vec2 pos = (rot2(curve * age) * (dir * rad));

    float size = (0.05 + 0.14*hD) * (0.70 + 0.65*u_bass);
    float sides = 3.0 + floor(hC * 4.0);
    float spin  = mix(-2.6, 2.6, hA);
    float rotS  = hB*6.2831853 + age * spin;

    vec2 lp = rot2(rotS) * (p - pos);
    float dS = sdNgon(lp, sides, size);
    float glow = exp(-abs(dS) * (20.0 + 40.0*u_energy));
    float fill = smoothstep(0.020, 0.0, dS);

    float hue = fract(baseHue + 0.18 + 0.85*hB + 0.08*sin(0.08*cyc + fi));
    vec3 sc  = hsv2rgb(vec3(hue, 0.85, 1.0));
    add += sc * (glow*0.32 + fill*0.10) * throwBoost * life;
  }

  vec2 g = floor((uv * vec2(240.0, 135.0)) + u_time*vec2(12.0, 7.0));
  float hh = hash12(g);
  float sparkle = smoothstep(0.996 - 0.004*u_treble, 1.0, hh);
  add += vec3(1.0) * sparkle * (0.08 + 0.35*u_treble) * (0.5 + 0.6*u_energy);

  vec3 col = prev + add;
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
