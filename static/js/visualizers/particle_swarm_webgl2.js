// static/js/visualizers/particle_swarm_webgl2.js
// Particle Swarm / Explosion — WebGL2 (fallback to WebGL1)
// - N particles orbit center with curl-ish turbulence
// - Kick (bass transient) => radial impulse + trail brightness boost
// - Trails via ping-pong feedback buffer (fade + slight zoom/rotate, then particles)
// Audio mapping:
//   L -> explosion impulse scale, trail length/brightness
//   M -> angular velocity / turbulence
//   H -> sparkle density + hue jitter
//   E -> global intensity / bloom-ish glow (fake bloom via additive soft sprites)
//
// Internal controls (only 3):
//   particleCount: auto-scale to FPS
//   trailFade: fixed default
//   kickSensitivity: fixed default

export class ParticleSwarmWebGL2 {
  static id = "swarm";
  static name = "Particle Swarm / Explosions (WebGL2)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const opts = {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
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
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // ---- “Controls” ----
    this.trailFade = 0.975;       // fixed default | Tested: good: 0.965
    this.kickSensitivity = 0.75;  // fixed default | Tested: good: 0.65
    this.minParticles = 800;
    this.maxParticles = 9000;
    this.particleCount = 2600;    // will auto-scale

    // ---- time / perf ----
    this._t0 = performance.now();
    this._lastT = this._t0;
    this._avgDt = 1 / 60;
    this._lastAutoScaleT = this._t0;
    this._bassPrev = 0;
    this._kickWarmupUntil = this._t0 + 700; // ms: prevents first-hit mega burst
    this._rtScale = 0.75; // 0.6..0.85 is the sweet spot
    this._rtW = 0;
    this._rtH = 0;

    // ---- audio smoothing ----
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._smooth = 0.86;

    // kick detector
    this._bassAvgSlow = 0;
    this._kickFlash = 0;     // decays 0..1 (also trail boost)
    this._kickPending = 0;   // one-shot impulse magnitude
    this._lastKickT = 0;

    // ---- particles (CPU sim) ----
    this._initParticles();

    // ---- fullscreen quad ----
    this._quadVB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVB);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,  1, -1, -1,  1,
        -1,  1,  1, -1,  1,  1,
      ]),
      gl.STATIC_DRAW
    );

    // ---- programs ----
    this._progFeedback = this._createProgram(this._vsQuad(), this._fsFeedback());
    this._progPresent  = this._createProgram(this._vsQuad(), this._fsPresent());
    this._progParticles= this._createProgram(this._vsParticles(), this._fsParticles());

    // ---- locations ----
    const loc = (p, n) => gl.getUniformLocation(p, n);

    this._locFB = {
      a_pos: gl.getAttribLocation(this._progFeedback, "a_pos"),
      u_prev: loc(this._progFeedback, "u_prev"),
      u_res:  loc(this._progFeedback, "u_res"),
      u_time: loc(this._progFeedback, "u_time"),
      u_fade: loc(this._progFeedback, "u_fade"),
      u_zoom: loc(this._progFeedback, "u_zoom"),
      u_rot:  loc(this._progFeedback, "u_rot"),
      u_glow: loc(this._progFeedback, "u_glow"),
    };

    this._locPR = {
      a_pos: gl.getAttribLocation(this._progPresent, "a_pos"),
      u_tex: loc(this._progPresent, "u_tex"),
    };

    this._locP = {
      a_pos:   gl.getAttribLocation(this._progParticles, "a_pos"),
      a_seed:  gl.getAttribLocation(this._progParticles, "a_seed"),
      a_size:  gl.getAttribLocation(this._progParticles, "a_size"),
      u_time:  loc(this._progParticles, "u_time"),
      u_aspect:loc(this._progParticles, "u_aspect"),
      u_energy:loc(this._progParticles, "u_energy"),
      u_bass:  loc(this._progParticles, "u_bass"),
      u_mid:   loc(this._progParticles, "u_mid"),
      u_treble:loc(this._progParticles, "u_treble"),
      u_hue:   loc(this._progParticles, "u_hue"),
      u_sparkle:loc(this._progParticles, "u_sparkle"),
      u_kick:  loc(this._progParticles, "u_kick"),
      u_ptScale:loc(this._progParticles, "u_ptScale"),
    };

    // ---- particle VBO (interleaved: x,y,seed,size) ----
    this._strideFloats = 4;
    this._vData = new Float32Array(this.maxParticles * this._strideFloats);

    this._vboParticles = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboParticles);
    gl.bufferData(gl.ARRAY_BUFFER, this._vData.byteLength, gl.DYNAMIC_DRAW);

    // ---- ping-pong targets ----
    this._w = 0;
    this._h = 0;
    this._texA = this._texB = null;
    this._fbA = this._fbB = null;
    this._readTex = this._writeTex = null;
    this._readFB  = this._writeFB  = null;

    this._ptScale = 1.0;

    this.onResize(canvas.width, canvas.height, window.devicePixelRatio || 1);
  }

  onResize() {
    const gl = this.gl;
    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    const rtW = Math.max(2, (w * this._rtScale) | 0);
    const rtH = Math.max(2, (h * this._rtScale) | 0);

    gl.viewport(0, 0, w, h);

    if (w !== this._w || h !== this._h || rtW !== this._rtW || rtH !== this._rtH || !this._readTex) {
      this._w = w;
      this._h = h;
      this._rtW = rtW;
      this._rtH = rtH;
      this._recreateTargets(rtW, rtH);
    }

    // keep sprite size reasonable across resolutions
    this._ptScale = Math.max(0.75, Math.min(2.25, Math.min(w, h) / 900));
  }

  onFrame(frame) {
    const gl = this.gl;
    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    const rtW = Math.max(2, (w * this._rtScale) | 0);
    const rtH = Math.max(2, (h * this._rtScale) | 0);

    if (w !== this._w || h !== this._h || rtW !== this._rtW || rtH !== this._rtH || !this._readTex) {
      this._w = w;
      this._h = h;
      this._rtW = rtW;
      this._rtH = rtH;
      this._recreateTargets(rtW, rtH);
    }

    const now = performance.now();
    const dt = Math.max(0.001, Math.min(0.05, (now - this._lastT) * 0.001));
    this._lastT = now;
    this._avgDt = this._avgDt * 0.92 + dt * 0.08;

    // ----- audio features -----
    const spec = frame?.spectrum;
    const sr = frame?.samplerate || 48000;
    const nfft =
      frame?.fftSize ||
      (spec && spec.length ? (spec.length - 1) * 2 : 2048);
    const gain = frame?.gain || 1.0;
    const rms0 = Array.isArray(frame?.rms) ? (frame.rms[0] || 0) : (frame?.rms || 0);

    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const normLog = (x, k) => {
      const v = Math.max(0, x);
      return clamp01(Math.log1p(v * k) / Math.log1p(k));
    };

    const bandAvg = (hz0, hz1) => {
      if (!spec || !spec.length) return 0;
      const hzPerBin = sr / nfft;
      let b0 = (hz0 / hzPerBin) | 0;
      let b1 = (hz1 / hzPerBin) | 0;
      if (b1 <= b0 + 1) b1 = b0 + 2;
      if (b0 < 1) b0 = 1;
      if (b1 > spec.length) b1 = spec.length;
      let sum = 0, c = 0;
      for (let i = b0; i < b1; i++) { sum += spec[i]; c++; }
      return c ? (sum / c) : 0;
    };

    const bassRaw = bandAvg(40, 180) * gain;
    const midRaw  = bandAvg(250, 1200) * gain;
    const trbRaw  = bandAvg(2500, 9000) * gain;

    const energyT = clamp01(rms0 * 10.0);
    const bassT   = normLog(bassRaw, 130);
    const midT    = normLog(midRaw,  120);
    const trebleT = normLog(trbRaw,  150);

    const a = this._smooth;
    this._energy = a * this._energy + (1 - a) * energyT;
    this._bass   = a * this._bass   + (1 - a) * bassT;
    this._mid    = a * this._mid    + (1 - a) * midT;
    this._treble = a * this._treble + (1 - a) * trebleT;

    // ----- kick detect (bass transient) -----
    // Make slow average "sticky" downward so it doesn't collapse during silence.
    // (fast attack, slow release)
    if (this._bassAvgSlow === 0) this._bassAvgSlow = this._bass; // first frame init

    if (this._bass > this._bassAvgSlow) {
      this._bassAvgSlow = this._bassAvgSlow * 0.92 + this._bass * 0.08; // rise faster
    } else {
      this._bassAvgSlow = this._bassAvgSlow * 0.985 + this._bass * 0.015; // fall slower
    }

    // tiny noise floor so silence doesn't make baseline ~0
    this._bassAvgSlow = Math.max(this._bassAvgSlow, 0.03);

    const bassRise = this._bass - this._bassPrev;
    this._bassPrev = this._bass;

    const minKickGap = 140; // ms
    const kickRatio = 1.0 + this.kickSensitivity * 0.9;

    // Require warmup + rising edge + absolute bass threshold
    const canKick = now > this._kickWarmupUntil;

    const kickNow =
      canKick &&
      this._bass > 0.14 &&
      this._bassAvgSlow > 0.03 &&
      bassRise > 0.01 &&
      this._bass > this._bassAvgSlow * kickRatio &&
      (now - this._lastKickT) > minKickGap;

    if (kickNow) {
      // REL transient amount, but...
      const delta = this._bass - this._bassAvgSlow;
      const rel = clamp01(delta * 2.4);

      // ...ABS gate prevents huge kicks when baseline is tiny after silence
      const absGate = clamp01((this._bass - 0.14) / 0.35);

      const mag = rel * absGate;

      this._kickPending = Math.max(this._kickPending, mag);
      this._kickFlash = Math.max(this._kickFlash, 0.55 + 0.65 * mag);
      this._lastKickT = now;
    }
    this._kickFlash = Math.max(0, this._kickFlash - dt * 1.9);

    // ----- particleCount auto-scale (~1Hz) -----
    if (now - this._lastAutoScaleT > 900) {
      this._lastAutoScaleT = now;
      const ms = this._avgDt * 1000;
      if (ms > 20.0 && this.particleCount > this.minParticles) {
        this.particleCount = Math.max(this.minParticles, (this.particleCount * 0.88) | 0);
      } else if (ms < 14.5 && this.particleCount < this.maxParticles) {
        this.particleCount = Math.min(this.maxParticles, (this.particleCount * 1.05) | 0);
      }
    }

    const t = (now - this._t0) * 0.001;

    // simulate + upload VBO
    this._stepParticles(dt, t);
    this._writeParticleVBO();

    // ----- render -----
    const aspect = w / Math.max(1, h);

    // Pass 1: feedback => write FB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._writeFB);
    gl.viewport(0, 0, rtW, rtH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._progFeedback);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVB);
    gl.enableVertexAttribArray(this._locFB.a_pos);
    gl.vertexAttribPointer(this._locFB.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._readTex);
    gl.uniform1i(this._locFB.u_prev, 0);
    gl.uniform2f(this._locFB.u_res, rtW, rtH);

    // L -> trail length/brightness (fade closer to 1 => longer)
    const fade = Math.min(0.995, this.trailFade + 0.018 * this._bass + 0.010 * this._kickFlash);
    const zoom = 0.992 + 0.010 * this._bass;
    const rot = 0.02 * (this._mid - 0.5) + 0.04 * Math.sin(t * 0.4) * (0.2 + 0.8 * this._energy);
    const glow = 0.6 + 1.8 * this._energy + 0.7 * this._kickFlash;

    gl.uniform1f(this._locFB.u_time, t);
    gl.uniform1f(this._locFB.u_fade, fade);
    gl.uniform1f(this._locFB.u_zoom, zoom);
    gl.uniform1f(this._locFB.u_rot, rot);
    gl.uniform1f(this._locFB.u_glow, glow);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: particles additively into write FB
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    gl.useProgram(this._progParticles);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboParticles);

    const strideBytes = this._strideFloats * 4;
    gl.enableVertexAttribArray(this._locP.a_pos);
    gl.vertexAttribPointer(this._locP.a_pos, 2, gl.FLOAT, false, strideBytes, 0);

    gl.enableVertexAttribArray(this._locP.a_seed);
    gl.vertexAttribPointer(this._locP.a_seed, 1, gl.FLOAT, false, strideBytes, 8);

    gl.enableVertexAttribArray(this._locP.a_size);
    gl.vertexAttribPointer(this._locP.a_size, 1, gl.FLOAT, false, strideBytes, 12);

    // H -> sparkle density + hue jitter
    const hue = (t * 0.06 + this._treble * 0.22 + 0.12 * Math.sin(t * 0.35)) % 1.0;
    const sparkle = Math.min(1.0, 0.15 + 0.85 * this._treble);

    gl.uniform1f(this._locP.u_time, t);
    gl.uniform1f(this._locP.u_aspect, aspect);
    gl.uniform1f(this._locP.u_energy, this._energy);
    gl.uniform1f(this._locP.u_bass, this._bass);
    gl.uniform1f(this._locP.u_mid, this._mid);
    gl.uniform1f(this._locP.u_treble, this._treble);
    gl.uniform1f(this._locP.u_hue, hue);
    gl.uniform1f(this._locP.u_sparkle, sparkle);
    gl.uniform1f(this._locP.u_kick, this._kickFlash);
    gl.uniform1f(this._locP.u_ptScale, this._ptScale);

    gl.drawArrays(gl.POINTS, 0, this.particleCount);

    // Pass 3: present writeTex to screen
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._progPresent);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVB);
    gl.enableVertexAttribArray(this._locPR.a_pos);
    gl.vertexAttribPointer(this._locPR.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
    gl.uniform1i(this._locPR.u_tex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap ping-pong
    this._swapTargets();
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    try {
      gl.deleteProgram(this._progFeedback);
      gl.deleteProgram(this._progPresent);
      gl.deleteProgram(this._progParticles);
      gl.deleteBuffer(this._quadVB);
      gl.deleteBuffer(this._vboParticles);
      this._deleteTarget(this._texA, this._fbA);
      this._deleteTarget(this._texB, this._fbB);
    } catch (_) {}
  }

  // ------------------ Particles (CPU sim) ------------------

  _initParticles() {
    const N = this.maxParticles;

    this._px = new Float32Array(N);
    this._py = new Float32Array(N);
    this._vx = new Float32Array(N);
    this._vy = new Float32Array(N);
    this._rad = new Float32Array(N);
    this._seed = new Float32Array(N);
    this._size = new Float32Array(N);

    // xorshift-ish deterministic random
    let s = (0x1234567 ^ (Math.random() * 0xffffffff)) | 0;
    const rnd = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) / 4294967296);
    };

    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.55) * 0.65;

      this._px[i] = Math.cos(a) * r;
      this._py[i] = Math.sin(a) * r;

      this._vx[i] = (rnd() - 0.5) * 0.05;
      this._vy[i] = (rnd() - 0.5) * 0.05;

      this._rad[i] = 0.18 + 0.72 * Math.pow(rnd(), 0.75);
      this._seed[i] = rnd();
      this._size[i] = 1.0 + 2.2 * Math.pow(rnd(), 1.2);
    }
  }

  _stepParticles(dt, t) {
    const N = this.particleCount;
    const px = this._px, py = this._py, vx = this._vx, vy = this._vy, rad = this._rad, seed = this._seed;

    // M -> angular velocity / turbulence
    const e = this._energy;
    const bass = this._bass;
    const mid = this._mid;

    const orbit  = 1.55 + 3.5 * mid;
    const spring = 2.9 + 3.8 * (0.2 + mid);
    const turb   = 0.55 + 2.4 * mid + 1.1 * e;

    // stable damping vs dt
    const damp = Math.pow(0.35, dt);

    // one-shot kick impulse
    const kickMag = this._kickPending;
    if (kickMag > 0) this._kickPending = 0;

    for (let i = 0; i < N; i++) {
      let x = px[i], y = py[i];
      let ux = vx[i], uy = vy[i];

      const r = Math.sqrt(x * x + y * y) + 1e-6;

      // orbit tangential force
      const tx = -y / r;
      const ty =  x / r;
      ux += tx * orbit * dt * (0.55 + 0.65 * e);
      uy += ty * orbit * dt * (0.55 + 0.65 * e);

      // radial spring to per-particle radius
      const dr = r - rad[i];
      ux += (-x / r) * dr * spring * dt;
      uy += (-y / r) * dr * spring * dt;

      // curl-ish turbulence (cheap, stable)
      const sd = seed[i] * 6.28318;
      const n1 = Math.sin((y * 3.1 + t * 0.9) + sd);
      const n2 = Math.cos((x * 2.7 - t * 0.7) - sd * 1.3);
      const cx = (n1 + 0.6 * n2);
      const cy = (n2 - 0.6 * n1);
      ux += cx * turb * dt * 0.18;
      uy += cy * turb * dt * 0.18;

      // L -> explosion impulse scale
      if (kickMag > 0) {
        const k = kickMag * (0.9 + 1.6 * bass);
        ux += (x / r) * k * 1.25;
        uy += (y / r) * k * 1.25;
      }

      // integrate
      ux *= damp;
      uy *= damp;
      x += ux * dt;
      y += uy * dt;

      // bounded: respawn softly if too far
      const rr = x * x + y * y;
      if (rr > 1.75) {
        const aa = (seed[i] + t * 0.11) * 6.28318;
        const nr = 0.15 + 0.45 * (seed[i] * 0.91);
        x = Math.cos(aa) * nr;
        y = Math.sin(aa) * nr;
        ux *= 0.2;
        uy *= 0.2;
      }

      px[i] = x; py[i] = y; vx[i] = ux; vy[i] = uy;
    }
  }

  _writeParticleVBO() {
    const N = this.particleCount;
    const out = this._vData;
    const px = this._px, py = this._py, seed = this._seed, size = this._size;

    // E + kick -> size/glow boost
    const sizeBoost = 1.0 + 0.75 * this._energy + 0.95 * this._kickFlash;

    let j = 0;
    for (let i = 0; i < N; i++) {
      out[j++] = px[i];
      out[j++] = py[i];
      out[j++] = seed[i];
      out[j++] = size[i] * sizeBoost;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboParticles);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out.subarray(0, N * this._strideFloats));
  }

  // ------------------ Ping-pong targets ------------------

  _swapTargets() {
    const rt = this._readTex;
    const rf = this._readFB;
    this._readTex = this._writeTex;
    this._readFB  = this._writeFB;
    this._writeTex = rt;
    this._writeFB  = rf;
  }

  _recreateTargets(w, h) {
    const gl = this.gl;

    this._deleteTarget(this._texA, this._fbA);
    this._deleteTarget(this._texB, this._fbB);

    const A = this._createTarget(w, h);
    const B = this._createTarget(w, h);

    this._texA = A.tex; this._fbA = A.fb;
    this._texB = B.tex; this._fbB = B.fb;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbA);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbB);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._readTex = this._texA; this._readFB = this._fbA;
    this._writeTex= this._texB; this._writeFB= this._fbB;
  }

  _createTarget(w, h) {
    const gl = this.gl;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (this.isWebGL2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { tex, fb };
  }

  _deleteTarget(tex, fb) {
    const gl = this.gl;
    if (fb) gl.deleteFramebuffer(fb);
    if (tex) gl.deleteTexture(tex);
  }

  // ------------------ Shaders / compile ------------------

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

  _vsQuad() {
    if (this.isWebGL2) return `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos*0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
    return `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos*0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
  }

  _fsFeedback() {
    // Trails: previous frame sample with fade + slight zoom/rot + tiny drift + mild tonemap
    if (this.isWebGL2) return `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_prev;
uniform vec2 u_res;
uniform float u_time;
uniform float u_fade;
uniform float u_zoom;
uniform float u_rot;
uniform float u_glow;

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123);
}

void main(){
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = v_uv*2.0 - 1.0;
  p.x *= aspect;

  float c = cos(u_rot), s = sin(u_rot);
  mat2 R = mat2(c,-s,s,c);
  vec2 q = R * (p * u_zoom);

  q += 0.010 * vec2(sin(u_time*0.70 + p.y*2.0), cos(u_time*0.62 + p.x*2.0));

  q.x /= aspect;
  vec2 uv2 = q*0.5 + 0.5;

  vec4 prev = texture(u_prev, uv2);
  float lum = max(prev.r, max(prev.g, prev.b));
  float boost = 1.0 + (0.15 + 0.85*lum) * 0.10 * u_glow;

  vec3 col = prev.rgb * u_fade * boost;
  float a = prev.a * u_fade;

  float n = (hash(v_uv*u_res + u_time*11.0) - 0.5) * 0.03;
  col += vec3(n) * (0.35 + 0.65*lum);

  col = col / (1.0 + col);
  outColor = vec4(col, a);
}`;
    return `
precision mediump float;
varying vec2 v_uv;

uniform sampler2D u_prev;
uniform vec2 u_res;
uniform float u_time;
uniform float u_fade;
uniform float u_zoom;
uniform float u_rot;
uniform float u_glow;

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123);
}

void main(){
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = v_uv*2.0 - 1.0;
  p.x *= aspect;

  float c = cos(u_rot), s = sin(u_rot);
  mat2 R = mat2(c,-s,s,c);
  vec2 q = R * (p * u_zoom);

  q += 0.010 * vec2(sin(u_time*0.70 + p.y*2.0), cos(u_time*0.62 + p.x*2.0));

  q.x /= aspect;
  vec2 uv2 = q*0.5 + 0.5;

  vec4 prev = texture2D(u_prev, uv2);
  float lum = max(prev.r, max(prev.g, prev.b));
  float boost = 1.0 + (0.15 + 0.85*lum) * 0.10 * u_glow;

  vec3 col = prev.rgb * u_fade * boost;
  float a = prev.a * u_fade;

  float n = (hash(v_uv*u_res + u_time*11.0) - 0.5) * 0.03;
  col += vec3(n) * (0.35 + 0.65*lum);

  col = col / (1.0 + col);
  gl_FragColor = vec4(col, a);
}`;
  }

  _fsPresent() {
    // final alpha = max(stored alpha, lum->alpha), keeps overlay clean
    if (this.isWebGL2) return `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
void main(){
  vec4 c = texture(u_tex, v_uv);
  vec3 col = c.rgb / (1.0 + c.rgb);
  float lum = max(col.r, max(col.g, col.b));
  float a = max(c.a, smoothstep(0.02, 0.16, lum));
  outColor = vec4(col, clamp(a, 0.0, 1.0));
}`;
    return `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main(){
  vec4 c = texture2D(u_tex, v_uv);
  vec3 col = c.rgb / (1.0 + c.rgb);
  float lum = max(col.r, max(col.g, col.b));
  float a = max(c.a, smoothstep(0.02, 0.16, lum));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;
  }

  _vsParticles() {
    if (this.isWebGL2) return `#version 300 es
precision mediump float;
in vec2 a_pos;
in float a_seed;
in float a_size;
out float v_seed;
out float v_size;
uniform float u_aspect;
uniform float u_ptScale;
void main(){
  vec2 p = a_pos;
  p *= 0.92;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  v_seed = a_seed;
  v_size = a_size;
  gl_PointSize = max(1.0, a_size * 2.6 * u_ptScale);
}`;
    return `
precision mediump float;
attribute vec2 a_pos;
attribute float a_seed;
attribute float a_size;
varying float v_seed;
varying float v_size;
uniform float u_aspect;
uniform float u_ptScale;
void main(){
  vec2 p = a_pos;
  p *= 0.92;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  v_seed = a_seed;
  v_size = a_size;
  gl_PointSize = max(1.0, a_size * 2.6 * u_ptScale);
}`;
  }

  _fsParticles() {
    // E -> intensity, H -> sparkle + hue jitter, kick -> bloom-ish glow
    const body = `
float hash(float x){ return fract(sin(x) * 43758.5453123); }
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);

  float core = exp(-r2 * (2.6 + 0.25*v_size));
  float glow = exp(-r2 * 1.2);

  float h = fract(v_seed + u_hue + 0.08*hash(v_seed*91.7 + u_time*0.7) * u_treble);
  float s = 0.55 + 0.35*u_treble + 0.15*u_kick;
  float v = 0.65 + 0.55*u_energy + 0.25*u_bass;

  vec3 col = hsv2rgb(vec3(h, clamp(s,0.0,1.0), clamp(v,0.0,1.0)));

  float n = hash(v_seed*391.3 + floor(u_time*24.0));
  float spark = step(1.0 - u_sparkle*0.35, n);
  col += spark * (0.25 + 0.75*u_treble) * vec3(1.0, 0.9, 1.0);

  float inten = core * (0.25 + 1.35*u_energy) + glow * (0.06 + 0.55*u_kick);
  inten *= (0.65 + 0.35*u_bass);

  float a = clamp(inten, 0.0, 1.0);
  OUTCOLOR = vec4(col * a, a);
}`;

    if (this.isWebGL2) return `#version 300 es
precision mediump float;
in float v_seed;
in float v_size;
out vec4 outColor;

uniform float u_time;
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_hue;
uniform float u_sparkle;
uniform float u_kick;

#define OUTCOLOR outColor
${body}
`;
    return `
precision mediump float;
varying float v_seed;
varying float v_size;

uniform float u_time;
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_hue;
uniform float u_sparkle;
uniform float u_kick;

#define OUTCOLOR gl_FragColor
${body}
`;
  }
}
