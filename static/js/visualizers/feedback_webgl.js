// static/js/visualizers/feedback_webgl.js
// Feedback Mirror / Infinite TV — WebGL ping-pong framebuffer feedback
// Self-contained (no repo util imports). Transparent-overlay friendly.

export class FeedbackMirrorWebGL {
  static id = "feedback";
  static name = "Feedback Mirror (WebGL)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    // --- WebGL context (alpha overlay friendly)
    this.gl =
      canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) ||
      canvas.getContext("experimental-webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });

    if (!this.gl) throw new Error("WebGL not available");

    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // --- Fullscreen quad
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

    // --- Programs
    this._progFeedback = this._createProgram(VS, FS_FEEDBACK);
    this._progPresent = this._createProgram(VS, FS_PRESENT);

    // --- Locations (feedback)
    this._locFB = {
      a_pos: gl.getAttribLocation(this._progFeedback, "a_pos"),
      u_prev: gl.getUniformLocation(this._progFeedback, "u_prev"),
      u_res: gl.getUniformLocation(this._progFeedback, "u_res"),
      u_time: gl.getUniformLocation(this._progFeedback, "u_time"),
      u_energy: gl.getUniformLocation(this._progFeedback, "u_energy"),
      u_bass: gl.getUniformLocation(this._progFeedback, "u_bass"),
      u_mid: gl.getUniformLocation(this._progFeedback, "u_mid"),
      u_treble: gl.getUniformLocation(this._progFeedback, "u_treble"),
    };

    // --- Locations (present)
    this._locPR = {
      a_pos: gl.getAttribLocation(this._progPresent, "a_pos"),
      u_tex: gl.getUniformLocation(this._progPresent, "u_tex"),
    };

    // --- Ping-pong buffers
    this._w = 0;
    this._h = 0;
    this._dpr = 1;

    this._texA = null;
    this._texB = null;
    this._fbA = null;
    this._fbB = null;

    // read -> write each frame
    this._readTex = null;
    this._writeTex = null;
    this._readFB = null;
    this._writeFB = null;

    // --- Audio smoothing
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._smooth = 0.86;

    this._t0 = performance.now();
  }

  onResize(w, h, dpr) {
    this._dpr = dpr || 1;

    // canvas width/height are authoritative (already scaled by dpr outside)
    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;

    if (cw === this._w && ch === this._h) return;
    this._w = cw;
    this._h = ch;

    this._recreateTargets(cw, ch);
  }

  onFrame(frame) {
    const gl = this.gl;
    const w = this.canvas.width | 0;
    const h = this.canvas.height | 0;
    if (w <= 2 || h <= 2) return;

    if (w !== this._w || h !== this._h || !this._readTex) {
      this._w = w;
      this._h = h;
      this._recreateTargets(w, h);
    }

    // --- Audio features (robust + reactive, no allocations)
    const spec = frame?.spectrum;
    const sr = frame?.samplerate || 48000;
    const nfft =
      frame?.fftSize ||
      (spec && spec.length ? (spec.length - 1) * 2 : 2048);
    const gain = frame?.gain || 1.0;

    const rms0 = Array.isArray(frame?.rms) ? (frame.rms[0] || 0) : (frame?.rms || 0);

    // Normalize helpers (log compression so it reacts across levels)
    const normLog = (x, k) => {
      const v = Math.max(0, x);
      const t = Math.log1p(v * k) / Math.log1p(k);
      return Math.max(0, Math.min(1, t));
    };

    const bandAvg = (hz0, hz1) => {
      if (!spec || spec.length === 0) return 0;
      const hzPerBin = sr / nfft;
      let b0 = (hz0 / hzPerBin) | 0;
      let b1 = (hz1 / hzPerBin) | 0;
      if (b1 <= b0 + 1) b1 = b0 + 2;
      if (b0 < 1) b0 = 1;
      if (b1 > spec.length) b1 = spec.length;
      let sum = 0;
      let c = 0;
      for (let i = b0; i < b1; i++) {
        sum += spec[i];
        c++;
      }
      return c > 0 ? (sum / c) : 0;
    };

    const bassRaw = bandAvg(40, 180) * gain;
    const midRaw = bandAvg(250, 1200) * gain;
    const trebRaw = bandAvg(2500, 9000) * gain;

    const energyT = Math.max(0, Math.min(1, rms0 * 10.0));
    const bassT = normLog(bassRaw, 120);
    const midT = normLog(midRaw, 120);
    const trebleT = normLog(trebRaw, 140);

    const a = this._smooth;
    this._energy = a * this._energy + (1 - a) * energyT;
    this._bass = a * this._bass + (1 - a) * bassT;
    this._mid = a * this._mid + (1 - a) * midT;
    this._treble = a * this._treble + (1 - a) * trebleT;

    const t = (performance.now() - this._t0) * 0.001;

    // --- Pass 1: feedback into write FB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._writeFB);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._progFeedback);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
    gl.enableVertexAttribArray(this._locFB.a_pos);
    gl.vertexAttribPointer(this._locFB.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._readTex);
    gl.uniform1i(this._locFB.u_prev, 0);

    gl.uniform2f(this._locFB.u_res, w, h);
    gl.uniform1f(this._locFB.u_time, t);
    gl.uniform1f(this._locFB.u_energy, this._energy);
    gl.uniform1f(this._locFB.u_bass, this._bass);
    gl.uniform1f(this._locFB.u_mid, this._mid);
    gl.uniform1f(this._locFB.u_treble, this._treble);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 2: present writeTex to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._progPresent);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
    gl.enableVertexAttribArray(this._locPR.a_pos);
    gl.vertexAttribPointer(this._locPR.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
    gl.uniform1i(this._locPR.u_tex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Swap
    this._swap();
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    try {
      gl.deleteProgram(this._progFeedback);
      gl.deleteProgram(this._progPresent);
      gl.deleteBuffer(this._vb);

      this._deleteTarget(this._texA, this._fbA);
      this._deleteTarget(this._texB, this._fbB);
    } catch (_) {}
  }

  // ----------------- internals -----------------

  _swap() {
    const rt = this._readTex;
    const wf = this._writeFB;
    const rf = this._readFB;

    this._readTex = this._writeTex;
    this._writeTex = rt;

    this._readFB = this._writeFB;
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

    // Init both buffers to transparent so feedback starts clean
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
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0
    );

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

// ----------------- Shaders -----------------

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS_PRESENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main(){
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

// This is the actual feedback effect.
// Key properties:
// - Samples previous frame with zoom/rotate/drift (feedback)
// - Adds asymmetric, audio-driven injection (so it doesn't become a "white ball")
// - Uses vignette + luminance-based alpha so edges stay transparent for OBS overlays
const FS_FEEDBACK = `
precision mediump float;

varying vec2 v_uv;
uniform sampler2D u_prev;
uniform vec2 u_res;
uniform float u_time;
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec3 pal(float t){
  // smooth neon-ish palette without hard banding
  vec3 a = vec3(0.12, 0.10, 0.18);
  vec3 b = vec3(0.55, 0.85, 1.00);
  vec3 c = vec3(1.00, 0.35, 0.85);
  vec3 d = vec3(0.20, 0.65, 0.90);
  return a + b*cos(6.28318*(d*t + c));
}

void main(){
  float aspect = u_res.x / max(u_res.y, 1.0);

  // centered coords (aspect-correct)
  vec2 p = v_uv*2.0 - 1.0;
  p.x *= aspect;

  // Kaleido fold (turns drift into mirrored "infinite TV" vibes)
  float r = length(p);
  float a = atan(p.y, p.x);
  float tau = 6.28318530718;
  a = mod(a + tau, tau);
  float N = 6.0;
  float seg = tau / N;
  a = mod(a, seg);
  a = abs(a - seg*0.5);
  p = vec2(cos(a), sin(a)) * r;

  // Feedback transform: zoom/rotate + drift
  float zoom = 0.985 - 0.055*u_bass;     // bass "breathes" the tunnel
  float rot  = 0.04*sin(u_time*0.55) + 0.22*(u_treble - 0.5) + 0.10*u_mid;

  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  vec2 pf = R * (p * zoom);

  // drift breaks symmetry (prevents "static ball")
  vec2 drift = 0.028 * vec2(
    sin(u_time*0.70 + u_bass*3.1),
    cos(u_time*0.86 + u_treble*3.1)
  ) * (0.10 + 0.90*u_energy);

  pf += drift;

  // map back to UV
  vec2 q = pf;
  q.x /= aspect;
  vec2 uv2 = q*0.5 + 0.5;

  // chromatic micro-shift adds texture/detail
  vec2 ca = 0.0022 * vec2(sin(u_time*1.20), cos(u_time*1.05)) * (0.15 + 0.85*u_treble);
  vec4 pr = texture2D(u_prev, uv2 + ca);
  vec4 pg = texture2D(u_prev, uv2);
  vec4 pb = texture2D(u_prev, uv2 - ca);
  vec4 prev = vec4(pr.r, pg.g, pb.b, (pr.a + pg.a + pb.a) / 3.0);

  // feedback fade (slightly more fade when quiet so it doesn't linger)
  float fade = 0.992;
  prev.rgb *= fade;
  prev.a   *= fade;

  // --- Asymmetric injection (audio-driven)
  // orbiting point seed (creates trails + motion)
  vec2 cpos = vec2(
    0.40*sin(u_time*0.62 + u_mid*2.5),
    0.26*cos(u_time*0.54 + u_treble*2.5)
  );
  vec2 d = (p - cpos);
  float blob = exp(-dot(d,d) * (24.0 + 44.0*u_treble)) * (0.06 + 0.94*u_energy);

  // a rotating "scratch" line seed (makes it look like infinite TV smear)
  float la = u_time*0.75 + u_bass*2.2;
  vec2 dir = vec2(cos(la), sin(la));
  float distLine = abs(dot(p, vec2(-dir.y, dir.x)));
  float along = dot(p, dir);
  float line = exp(-distLine*distLine*85.0) * exp(-along*along*0.35);
  line *= (0.05 + 0.95*u_energy) * (0.35 + 0.65*u_treble);

  // radial shock ripple (bass makes rings pulse)
  float wave = 0.5 + 0.5*sin(12.0*r - u_time*5.2 - u_bass*7.0);
  wave = pow(wave, 7.0) * exp(-r*2.2) * (0.15 + 0.85*u_bass);

  float inj = blob*0.65 + line*0.55 + wave*0.35;

  // color is time + angle based
  float colT = 0.15*u_time + a*0.55 + u_treble*0.6;
  vec3 injCol = pal(colT);

  // subtle noise helps prevent banding/static
  float n = (hash(v_uv*u_res + u_time*10.0) - 0.5) * 0.05 * (0.15 + 0.85*u_treble);

  // combine
  float injStrength = 1.2;
  vec3 col = prev.rgb + injCol * (inj * injStrength) + vec3(n);

  // soft tone-map to avoid "white ball" saturation
  col = col / (1.0 + col);

  // alpha for OBS overlay:
  // - based on signal strength (injection + previous alpha)
  // - vignette makes edges transparent
  float vig = smoothstep(1.70, 0.15, r);
  float alpha = clamp(prev.a + inj*0.65, 0.0, 1.0) * vig;

  gl_FragColor = vec4(col, alpha);
}
`;
