// static/js/visualizers/tunnel_webgl.js
// Tunnel / Warp Speed (WebGL) -- BufferA + Image pipeline with audio row feed.

import { dtFromFrameOrNow, tFromFrameOrSelf } from "./timebase.js";

export class TunnelWarpWebGL {
  static id = "tunnel";
  static name = "Tunnel / Warp Speed (WebGL)";
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
      u_travel: gl.getUniformLocation(this._progI, "u_travel"),
      u_energy: gl.getUniformLocation(this._progI, "u_energy"),
      u_bass: gl.getUniformLocation(this._progI, "u_bass"),
      u_mid: gl.getUniformLocation(this._progI, "u_mid"),
      u_treble: gl.getUniformLocation(this._progI, "u_treble"),
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
    this._lastNowMs = this._t0;
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._travel = 0;
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

  _bandHz(spec, hz0, hz1, sr, nfft) {
    if (!spec || spec.length === 0) return 0;
    const hzPerBin = sr / nfft;
    let b0 = Math.floor(hz0 / hzPerBin);
    let b1 = Math.floor(hz1 / hzPerBin);
    b0 = Math.max(1, Math.min(spec.length - 1, b0));
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
      let dt = dtFromFrameOrNow(frame, now, this);
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

      const sr = frame?.samplerate || 48000;
      const nfft = frame?.fftSize || (spec?.length ? (spec.length - 1) * 2 : 2048);
      const gain = frame?.gain || 1.0;

      const rms = (frame?.rms && frame.rms[0]) ? frame.rms[0] : 0;

      const bassRaw = this._bandHz(spec, 40, 180, sr, nfft) * gain;
      const midRaw  = this._bandHz(spec, 250, 1200, sr, nfft) * gain;
      const trbRaw  = this._bandHz(spec, 2500, 9000, sr, nfft) * gain;

      const smoothRate = 9.0;
      const a = Math.exp(-dt * smoothRate);
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const logNorm = (x, k) => clamp01(Math.log1p(Math.max(0, x) * k) / Math.log1p(k));

      this._energy = a * this._energy + (1 - a) * clamp01(rms * 8.0);
      this._bass   = a * this._bass   + (1 - a) * logNorm(bassRaw, 140);
      this._mid    = a * this._mid    + (1 - a) * logNorm(midRaw,  140);
      this._treble = a * this._treble + (1 - a) * logNorm(trbRaw,  160);

      const speed = 0.55 + 1.4 * this._bass + 0.3 * this._energy;
      this._travel = Number.isFinite(this._travel) ? this._travel : 0;
      this._travel += dt * speed;
      if (this._travel > 1e6) this._travel -= 1e6;

      const tAbs = tFromFrameOrSelf(frame, dt, this);
      const t = tAbs % 600.0;

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

      gl.uniform2f(this._locI.u_res, this.canvas.width, this.canvas.height);
      gl.uniform1f(this._locI.u_time, t);
      gl.uniform1f(this._locI.u_travel, this._travel);
      gl.uniform1f(this._locI.u_energy, this._energy);
      gl.uniform1f(this._locI.u_bass, this._bass);
      gl.uniform1f(this._locI.u_mid, this._mid);
      gl.uniform1f(this._locI.u_treble, this._treble);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap
      this._swap();
    } catch (err) {
      this._failed = true;
      console.error("[TunnelWarpWebGL] render failed:", err);
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
precision mediump float;
varying vec2 v_uv;

uniform sampler2D u_buf;
uniform vec2  u_res;
uniform float u_time;
uniform float u_travel;
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 palette(float t){
  vec3 a = vec3(0.10, 0.10, 0.18);
  vec3 b = vec3(0.55, 0.85, 1.00);
  vec3 c = vec3(0.90, 0.35, 0.95);
  vec3 d = vec3(0.10, 0.55, 0.85);
  return a + b*cos(6.28318*(d*t + c));
}

// Curvy 2D centerline in "world Z" (cheap pseudo-random path)
vec2 position2(float z, float amp){
  vec2 p = vec2(
    sin(z * 0.10) * 1.0 + sin(cos(z * 0.031) * 4.0) * 1.0 + sin(sin(z * 0.0091) * 3.0) * 3.0,
    cos(z * 0.10) * 1.0 + cos(cos(z * 0.031) * 4.0) * 1.0 + cos(sin(z * 0.0091) * 3.0) * 3.0
  );
  return p * amp;
}

// Regular N-gon boundary radius (circumradius R) for a given angle theta.
float ngonRadius(float theta, float R, float N){
  float tau = 6.28318530718;
  float k = tau / max(N, 3.0);
  // fold theta into [-k/2, k/2]
  float t = abs(mod(theta + 0.5*k, k) - 0.5*k);
  float c = cos(3.14159265 / max(N, 3.0));
  return R * c / max(0.25, cos(t)); // clamp denominator to avoid infinities
}

void main(){
  float aspect = u_res.x / max(u_res.y, 1.0);

  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= aspect;
  float px = 2.0 / min(u_res.x, u_res.y); // ~1px in p-space, keeps far rings visible.

  float tau = 6.28318530718;
  float camZ = u_travel * 7.0; // SLOWER motion (visual speed). Raise if you want faster.

  // Bend amplitude from mids, with a little energy so it wakes up on sound
  float bendAmp = (0.06 + 0.10*u_mid + 0.06*u_energy) * 2.4;
  bendAmp *= (1.0 + 0.25*sin(u_time*0.35));
  vec2 cam = position2(camZ, bendAmp);

  // Approx "camera sideways velocity" (used to sell steering)
  vec2 camF = position2(camZ + 1.0, bendAmp);
  vec2 camB = position2(camZ - 1.0, bendAmp);
  vec2 dcamdz = (camF - camB) * 0.5;
  vec2 d2camdz2 = (camF - cam * 2.0 + camB);
  vec2 steer  = dcamdz * (0.55 + 1.10*u_energy); // used for slip/steer feel

  vec3 f = vec3(0.0);
  float aAccum = 0.0;

  // Portal stack count: keep it sane for OBS
  const int STEPS = 64;
  const float ringCap = 60.0;
  // Portal spacing (slices are spaced by this factor)
  float spacing = 2.0;
  float baseZ = floor(camZ / spacing) * spacing;

  float midScale = (2.8 + 2.2*u_mid);
  float slip     = (0.22 + 0.18*u_bass);

  for(int j = 1; j <= STEPS; j++){
    float i = float(j);
    // Spacing math: place portals at multiples of spacing relative to the camera.
    float realZ = baseZ + i * spacing;
    float screenZ = realZ - camZ; // 1..N
    float invZ = 1.0 / screenZ;

    // Weight falls with depth (gentler falloff so far portals stay visible).
    float wZ = 0.075 * invZ / (0.55 + 0.03*screenZ);

    // Depth brightness rebalance: dim near, boost far (keeps perspective, improves readability).
    float nearDim = mix(0.55, 1.0, smoothstep(6.0, 18.0, screenZ));
    float farBoost = mix(1.0, 2.2, smoothstep(18.0, 60.0, screenZ));
    float zGain = nearDim * farBoost;

    // Projected portal radius (bigger when closer)
    float R = (0.82 + 0.10*sin(realZ*0.07 + u_time*0.35)) * (1.0 + 0.10*u_bass);
    float rPortal = R * invZ;

    // Centerline projection: use a 2nd-order Taylor approximation of position2()
    // so portal centers stay aligned with the camera path without per-step trig.
    float dz = (realZ - camZ);
    vec2 rel = dcamdz * dz + 0.5 * d2camdz2 * (dz * dz);
    vec2 c = rel * (midScale * invZ) - steer * slip;

    vec2 q = p - c;
    float dist = length(q);

    // Ring thickness (bass thickens, depth thins)
    float eps = (0.010 + 0.016*u_bass) * (0.60 + 0.65 / (0.35 + screenZ));
    eps = max(eps, px * 0.9); // minimum ring thickness to avoid sub-pixel loss.

    // FAR PORTALS: cheap circle rings (skip atan/polygon/kaleido)
    if(rPortal < 0.03){
      float d = abs(dist - rPortal);
      float ring = 1.0 / (d + eps*1.25);
      ring = min(ring, ringCap);
      // cheap color (3 sins like the shadertoy style, faster than palette())
      vec3 base = 0.5 + 0.5 * sin(vec3(0.07, 0.10, 0.08) * realZ + vec3(0.0, 2.1, 4.2));
      vec3 col = base * ring * wZ * zGain;
      f += col;
      aAccum += (ring * wZ) * 0.9 * zGain;
      continue;
    }

    // NEAR PORTALS: polygon morph + mild kaleido
    float ang  = atan(q.y, q.x);
    // Deterministic sides: 3 -> 4 -> 5 -> 6 -> circle -> 6 -> 5 -> 4 -> 3.
    float t = fract(realZ*0.028 + u_time*0.05);
    float pp = 1.0 - abs(2.0 * t - 1.0); // 0->1->0 ping-pong
    float step = floor(pp * 4.0);
    float sidesInt = 3.0 + min(step, 3.0);
    float circleZone = smoothstep(0.92, 0.98, pp);
    float N = mix(sidesInt, 28.0, circleZone);

    float rb = ngonRadius(ang, rPortal, N);
    float d = abs(dist - rb);
    float ring = 1.0 / (d + eps);
    ring = min(ring, ringCap);

    // Subtle interior kaleido-ish modulation (kept stable, not time-multiplying position)
    float foldN = mix(3.0, 8.0, clamp(u_energy + 0.30*u_treble, 0.0, 1.0)); // cheaper
    float k = tau / foldN;
    float af = abs(mod(ang + 0.5*k, k) - 0.5*k);
    float kale = 1.0 - smoothstep(0.00, 0.12, af / k);
    // Wall-only mask to avoid center spokes/grid lines.
    float wallMask = smoothstep(rPortal*0.55, rPortal*0.85, dist)
      * (1.0 - smoothstep(rPortal*0.90, rPortal*1.02, dist));
    kale *= wallMask;
    kale *= (0.10 + 0.35*u_treble);

    vec3 base = 0.5 + 0.5 * sin(vec3(0.07, 0.10, 0.08) * realZ + vec3(0.0, 2.1, 4.2));
    vec3 col = base * ring * wZ;
    col += base * kale * wZ * 2.2;
    col *= zGain;

    f += col;
    aAccum += (ring * wZ) * 0.9 * zGain;
  }

  // Mild feedback texture seasoning (kept subtle)
  vec3 fb = texture2D(u_buf, v_uv).rgb;
  f += fb * (0.015 + 0.03*u_energy);

  // Tonemap + vignette + overlay-safe alpha
  f = f / (1.0 + f);

  float r = length(p);
  float vig = smoothstep(1.65, 0.10, r);
  f *= vig;

  float alpha = clamp(aAccum * (0.35 + 0.85*u_energy), 0.0, 1.0) * vig;
  gl_FragColor = vec4(f, alpha);
}
`;
