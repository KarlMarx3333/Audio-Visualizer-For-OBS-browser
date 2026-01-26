import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Feedback Mirror (v2 multipass)
Goal: match legacy "kaleidoscopic infinite TV" look, but stay compact + v2-safe.
Key fix vs current: compute legacy-like audio controls in-shader using u_rms + log-compressed spectrum taps.
*/

const FEEDBACK_BUFFER_A_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_prev;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_dt;
uniform float u_aspect;

uniform float u_rms;
uniform float u_gain;

// Optional (if host provides meaningful values, we’ll take the max)
uniform float u_energy;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;

uniform sampler2D u_specTex;
uniform int u_specLen;

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float normLog(float x, float k){
  x = max(0.0, x);
  return clamp(log(1.0 + x*k) / log(1.0 + k), 0.0, 1.0);
}

float specAt(float x01){
  int n = max(u_specLen, 1);
  float xf = clamp(x01, 0.0, 1.0) * float(n - 1);
  float u = (xf + 0.5) / float(n);
  return texture(u_specTex, vec2(u, 0.5)).r;
}

vec3 pal(float t){
  // legacy palette (neon-ish, dark base)
  vec3 a = vec3(0.12, 0.10, 0.18);
  vec3 b = vec3(0.55, 0.85, 1.00);
  vec3 c = vec3(1.00, 0.35, 0.85);
  vec3 d = vec3(0.20, 0.65, 0.90);
  return max(vec3(0.0), a + b*cos(6.2831853*(d*t + c)));
}

vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

mat2 rot2(float a){
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

vec2 kaleidoFold(vec2 p, float slices){
  float r = length(p);
  float a = atan(p.y, p.x);
  float tau = 6.2831853;
  a = mod(a + tau, tau);
  float seg = tau / max(slices, 1.0);
  a = mod(a, seg);
  a = abs(a - seg*0.5);
  return vec2(cos(a), sin(a)) * r;
}

void main(){
  float aspect = u_aspect;

  // centered coords (aspect-correct)
  vec2 p = v_uv*2.0 - 1.0;
  p.x *= aspect;

  float r = length(p);

  // Center weighting for persistence/injection shaping.
  float center = 1.0 - smoothstep(0.10, 0.60, r);

  // ---- Audio controls (legacy-like normalization)
  float g = clamp(u_gain, 0.2, 4.0);

  // RMS -> energy (this is the big difference vs v0.2 “avg spectrum”)
  float energyR = clamp(u_rms * 10.0 * g, 0.0, 1.0);

  // Log-compressed spectrum taps (acts like legacy normLog on band avgs)
  float bassS  = normLog(specAt(0.045) * g, 120.0);
  float midS   = normLog(specAt(0.180) * g, 120.0);
  float trebS  = normLog(specAt(0.720) * g, 140.0);

  // If host-provided bands exist, keep them; otherwise these dominate.
  float energyT = max(clamp(u_energy, 0.0, 1.0), energyR);
  float bassT   = max(clamp(u_bass,   0.0, 1.0), bassS);
  float midT    = max(clamp(u_mid,    0.0, 1.0), midS);
  float trebleT = max(clamp(u_high,   0.0, 1.0), trebS);

  // Shape like legacy (smoother low end)
  float energy = clamp(energyT, 0.0, 1.0);
  float bass   = clamp(bassT,   0.0, 1.0);
  float mid    = clamp(midT,    0.0, 1.0);
  float treble = clamp(trebleT, 0.0, 1.0);

  // Kaleido fold (legacy: fixed 6 slices)
  p = kaleidoFold(p, 6.0);
  float a = atan(p.y, p.x);

  // Feedback transform: zoom/rotate + drift (legacy-ish)
  float zoom = 0.986 - 0.040*bass;  // bass "breathes" the recursion
  zoom = clamp(zoom, 0.803, 0.992); //(zoom, 0.986, 0.992)
  float rot  = 0.04*sin(u_time*0.55) + 0.22*(treble - 0.5) + 0.10*mid;

  vec2 pf = rot2(rot) * (p * zoom);

  // drift breaks symmetry (prevents "static ball")
  vec2 drift_raw = 0.028 * vec2(
    sin(u_time*0.70 + bass*3.1),
    cos(u_time*0.86 + treble*3.1)
  ) * (0.10 + 0.90*energy);

  vec2 drift = drift_raw * (1.0 - zoom);   // key: prevents dot-collapse when zoom≈1

  pf += drift;

  // map back to UV
  vec2 q = pf;
  q.x /= aspect;
  vec2 uv2 = q*0.5 + 0.5;
  // Mirror-wrap to avoid sampling the transparent border in feedback.
  uv2 = 1.0 - abs(fract(uv2 * 0.5) * 2.0 - 1.0);

  // chromatic micro-shift (stronger near center like legacy)
  vec2 ca = 0.0022 * vec2(sin(u_time*1.20), cos(u_time*1.05))
          * (0.15 + 0.85*treble)
          * (1.0 + 1.4*center);

  vec4 pr = texture(u_prev, uv2 + ca);
  vec4 pg = texture(u_prev, uv2);
  vec4 pb = texture(u_prev, uv2 - ca);
  vec4 prev = vec4(pr.r, pg.g, pb.b, (pr.a + pg.a + pb.a) * (1.0/3.0));

  // Center-weighted persistence (dt-invariant)
  float fade60 = mix(0.992, 0.996, center);
  float fade = pow(fade60, u_dt * 60.0);
  prev.rgb *= fade;
  prev.a   *= fade;

  // --- Asymmetric injection (legacy-ish)
  vec2 cpos = vec2(
    0.40*sin(u_time*0.62 + mid*2.5),
    0.26*cos(u_time*0.54 + treble*2.5)
  );
  vec2 d = (p - cpos);
  float blob = exp(-dot(d,d) * (24.0 + 44.0*treble)) * (0.06 + 0.94*energy);

  float la = u_time*0.75 + bass*2.2;
  vec2 dir = vec2(cos(la), sin(la));
  float distLine = abs(dot(p, vec2(-dir.y, dir.x)));
  float along = dot(p, dir);
  float line = exp(-distLine*distLine*85.0) * exp(-along*along*0.35);
  line *= (0.05 + 0.95*energy) * (0.35 + 0.65*treble);

  float wv = 0.5 + 0.5*sin(12.0*r - u_time*5.2 - bass*7.0);
  wv = pow(wv, 7.0) * exp(-r*2.2) * (0.15 + 0.85*bass);

  float inj = blob*0.65 + line*0.55 + wv*0.35;
  inj *= (1.0 + 1.8*center);

  // Spatial hue variation keeps feedback from collapsing into a single tone.
  float cell = hash(floor((p * vec2(6.0, 6.0)) + 0.5));
  float hue = fract(
      0.10 * u_time
    + 0.10 * r
    + 0.18 * sin(2.0 * a)
    + 0.12 * cos(3.0 * a)
    + 0.20 * cell
    + 0.10 * bass + 0.06 * mid + 0.08 * treble
  );

  float sat = 0.70 + 0.25 * treble;
  float val = 0.55 + 0.45 * (0.35 + 0.65 * energy);
  vec3 injCol = hsv2rgb(vec3(hue, sat, val));

  float n = (hash(v_uv*u_resolution + u_time*10.0) - 0.5)
          * 0.05 * (0.15 + 0.85*treble);

  vec3 col = prev.rgb + injCol * (inj * 1.5) + vec3(n);
  col = max(col, vec3(0.0));
  col = col / (1.0 + col);

  float luma = max(0.0, dot(col, vec3(0.2126, 0.7152, 0.0722)));
  float lift = (0.020 + 0.060*energy) * (1.0 - smoothstep(0.02, 0.08, luma));
  col += vec3(lift);

  float vig = smoothstep(1.70, 0.15, r); // (1.70, 0.15, r)
  float alpha = clamp(prev.a + inj*0.65, 0.0, 1.0) * vig;

  fragColor = vec4(col, alpha);
}
`;

const FEEDBACK_IMAGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D iChannel0;
void main(){ fragColor = texture(iChannel0, v_uv); }
`;

const PASS_SPECS = [
  { name: "BufferA", fs: FEEDBACK_BUFFER_A_FS, feedback: true },
  { name: "Image", fs: FEEDBACK_IMAGE_FS, inputs: { 0: "BufferA" } },
];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export class FeedbackWebGL2MP {
  static id = "feedback";
  static name = "Feedback Mirror (WebGL2 Multipass)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 not available");

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    this.gl = gl;
    this.mp = new MultiPassWebGL2(gl);
    this.mp.setPasses(PASS_SPECS);

    this._lastT = NaN;
    this._frame = 0;
  }

  onResize(w, h, dpr) {
    if (!this.mp) return;
    this.mp.setSize(w, h, dpr);
  }

  onFrame(frame) {
    if (!this.mp) return;

    let t = performance.now() * 0.001;
    if (frame) {
      if (frame.time && isFiniteNumber(frame.time.t)) t = frame.time.t;
      else if (isFiniteNumber(frame.t)) t = frame.t;
      else if (isFiniteNumber(frame.ts)) t = frame.ts < 1e12 ? frame.ts : frame.ts * 0.001;
    }

    const TIME_WRAP = 10000.0;
    if (t > TIME_WRAP) t = t % TIME_WRAP;

    let dt = 1 / 60;
    if (frame) {
      if (isFiniteNumber(frame.dt)) dt = frame.dt;
      else if (frame.time && isFiniteNumber(frame.time.dt)) dt = frame.time.dt;
      else if (isFiniteNumber(this._lastT)) dt = t - this._lastT;
    }

    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._lastT = t;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) frameIndex = frame.frameIndex | 0;
    else if (frame && isFiniteNumber(frame.frame)) frameIndex = frame.frame | 0;
    else { this._frame = (this._frame + 1) | 0; frameIndex = this._frame; }

    this.mp.render(frame, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
  }
}
