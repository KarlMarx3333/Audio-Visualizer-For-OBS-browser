// static/js/visualizers/feedback_webgl.js
// Feedback Mirror / Infinite TV -- WebGL BufferA + Image pipeline with ping-pong feedback.
// Overlay-friendly alpha preserved in final pass.

import { MultiPassPipeline, TIME_WRAP as PIPE_TIME_WRAP } from "/static/js/webgl/multipass.js";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function normLog(x, k) {
  const v = Math.max(0, x);
  const t = Math.log1p(v * k) / Math.log1p(k);
  return clamp01(t);
}

function bandAvg(spec, sr, nfft, hz0, hz1) {
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
}

export class FeedbackMirrorWebGL {
  static id = "feedback";
  static name = "Feedback Mirror (WebGL)";
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

    // Audio smoothing
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._smooth = 0.86;

    this._preRender = (frame, pipe, dt) => {
      const spec = frame ? frame.spectrum : null;
      const sr = frame?.samplerate || 48000;
      const nfft = frame?.fftSize || (spec && spec.length ? (spec.length - 1) * 2 : 2048);
      const gain = frame?.gain || 1.0;

      const rms0 = Array.isArray(frame?.rms) ? (frame.rms[0] || 0) : (frame?.rms || 0);

      const bassRaw = bandAvg(spec, sr, nfft, 40, 180) * gain;
      const midRaw = bandAvg(spec, sr, nfft, 250, 1200) * gain;
      const trebRaw = bandAvg(spec, sr, nfft, 2500, 9000) * gain;

      const energyT = Math.max(0, Math.min(1, rms0 * 10.0));
      const bassT = normLog(bassRaw, 120);
      const midT = normLog(midRaw, 120);
      const trebleT = normLog(trebRaw, 140);

      const a = Math.pow(this._smooth, dt * 60.0);
      this._energy = a * this._energy + (1 - a) * energyT;
      this._bass = a * this._bass + (1 - a) * bassT;
      this._mid = a * this._mid + (1 - a) * midT;
      this._treble = a * this._treble + (1 - a) * trebleT;

      pipe.stateEnergy = this._energy;
      pipe.stateBass = this._bass;
      pipe.stateMid = this._mid;
      pipe.stateTreble = this._treble;
    };

    const passSpecs = [
      {
        name: "A",
        target: "texture",
        feedback: true,
        fsSrc: FS_BUFFER_A,
        builtins: { res: true, time: "wrap", dt: true },
        bindings: [
          { uniform: "u_prev", kind: "prev", pass: "A", unit: 0 },
          { uniform: "u_audio", kind: "audio", unit: 1 },
        ],
        uniforms: [
          { uniform: "u_energy", kind: "state", key: "stateEnergy" },
          { uniform: "u_bass", kind: "state", key: "stateBass" },
          { uniform: "u_mid", kind: "state", key: "stateMid" },
          { uniform: "u_treble", kind: "state", key: "stateTreble" },
        ],
      },
      {
        name: "Image",
        target: "screen",
        feedback: false,
        fsSrc: FS_IMAGE,
        builtins: { res: true, time: "wrap", dt: true },
        bindings: [
          { uniform: "u_buf", kind: "pass", pass: "A", unit: 0 },
        ],
      },
    ];

    this._pipeline = new MultiPassPipeline(gl, passSpecs, {
      timeWrap: PIPE_TIME_WRAP,
      audioDecay: 0.9,
      audioBoost: 4.0,
      preRender: this._preRender,
    });

    this._failed = false;

    this.onResize(canvas.width, canvas.height, window.devicePixelRatio || 1);
  }

  onResize(w, h, dpr) {
    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;
    this._pipeline.resize(cw, ch);
  }

  onFrame(frame) {
    if (this._failed) return;

    try {
      this._pipeline.render(frame);
    } catch (err) {
      this._failed = true;
      console.error("[FeedbackMirrorWebGL] render failed:", err);
      throw err;
    }
  }

  destroy() {
    if (this._pipeline) this._pipeline.destroy();
  }
}

// ----------------- Shaders -----------------

const FS_IMAGE = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_buf;
void main(){
  gl_FragColor = texture2D(u_buf, v_uv);
}
`;

// BufferA feedback pass with audio row at y <= 1px
const FS_BUFFER_A = `
precision mediump float;

varying vec2 v_uv;
uniform sampler2D u_prev;
uniform sampler2D u_audio;
uniform vec2 u_res;
uniform float u_time;
uniform float u_dt;
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
  // Clamp to avoid negative palette values becoming black in RGBA8.
  return max(vec3(0.0), a + b*cos(6.28318*(d*t + c)));
}

void main(){
  if (gl_FragCoord.y <= 1.0) {
    float m = texture2D(u_audio, vec2(v_uv.x, 0.5)).r;
    gl_FragColor = vec4(m, m, m, 1.0);
    return;
  }

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

  // Center weighting for persistence/injection shaping.
  float center = 1.0 - smoothstep(0.10, 0.60, r);

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

  // chromatic micro-shift adds texture/detail (boost near center for stronger "inner fractal")
  vec2 ca = 0.0022 * vec2(sin(u_time*1.20), cos(u_time*1.05))
          * (0.15 + 0.85*u_treble)
          * (1.0 + 1.4*center);
  vec4 pr = texture2D(u_prev, uv2 + ca);
  vec4 pg = texture2D(u_prev, uv2);
  vec4 pb = texture2D(u_prev, uv2 - ca);
  vec4 prev = vec4(pr.r, pg.g, pb.b, (pr.a + pg.a + pb.a) / 3.0);

  // Center-weighted persistence: keeps more recursion/detail in the middle
  float fade60 = mix(0.992, 0.996, center);
  float fade = pow(fade60, u_dt * 60.0);
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
  // Center-weighted injection: feeds the kaleido attractor where it forms
  inj *= (1.0 + 1.8*center);

  // color is time + angle based
  float colT = 0.15*u_time + a*0.55 + u_treble*0.6;
  vec3 injCol = pal(colT);

  // subtle noise helps prevent banding/static
  float n = (hash(v_uv*u_res + u_time*10.0) - 0.5) * 0.05 * (0.15 + 0.85*u_treble);

  // combine
  float injStrength = 1.5;
  vec3 col = prev.rgb + injCol * (inj * injStrength) + vec3(n);

  // Pre-clamp before tone-map so negatives don't collapse to black.
  col = max(col, vec3(0.0));

  // soft tone-map to avoid "white ball" saturation
  col = col / (1.0 + col);

  // Lift only near-black so it can't go fully black-on-black.
  float luma = max(0.0, dot(col, vec3(0.2126, 0.7152, 0.0722)));
  float lift = (0.020 + 0.060*u_energy) * (1.0 - smoothstep(0.02, 0.08, luma));
  col += vec3(lift);

  // alpha for OBS overlay:
  // - based on signal strength (injection + previous alpha)
  // - vignette makes edges transparent
  float vig = smoothstep(1.70, 0.15, r);
  float alpha = clamp(prev.a + inj*0.65, 0.0, 1.0) * vig;

  gl_FragColor = vec4(col, alpha);
}
`;
