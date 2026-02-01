import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Apollonian Fractures (WebGL2 Multipass) — audio reactive port
Original: "Apollonian Fractures" by otaviogood (2014-09-08)
https://www.shadertoy.com/view/XdjSzD

Audio mapping (stable + obvious):
- bass -> zoom pulse + warp strength + ring breathe
- mid  -> fold/contrast (fracture intensity)
- high -> outer ring shimmer speed/intensity
- energy -> global brightness lift (no “fade to nothing”)
Overlay-safe alpha derived from luminance + object mask.
*/

const APOLLONIAN_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_aspect;
uniform float u_time;
uniform float u_dt;

uniform float u_timeDrive;
uniform float u_timeRing;

uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_energy;
uniform float u_gain;

uniform sampler2D u_noiseTex;

const float TAU = 6.28318530718;

float sat(float x){ return clamp(x, 0.0, 1.0); }

vec2 safeNormalize(vec2 v){
  float l = length(v);
  return (l > 1e-6) ? (v / l) : vec2(0.0);
}

// --- noise (ported from the original; noiseTex tiles via fract()) ---
float Hash2d(vec2 uv){
  float f = uv.x + uv.y * 37.0;
  return fract(sin(f) * 104003.9);
}
float mixP(float f0, float f1, float a){
  return mix(f0, f1, a*a*(3.0 - 2.0*a));
}
const vec2 zeroOne = vec2(0.0, 1.0);

vec2 noise2dTex2(vec2 uv){
  const float N = 256.0; // engine NOISE_SIZE
  vec2 p = uv;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f*f*(3.0-2.0*f); // smooth

  vec2 t00 = (i + vec2(0.5, 0.5)) / N;
  vec2 t10 = (i + vec2(1.5, 0.5)) / N;
  vec2 t01 = (i + vec2(0.5, 1.5)) / N;
  vec2 t11 = (i + vec2(1.5, 1.5)) / N;

  // wrap manually (engine uses CLAMP)
  t00 = fract(t00); t10 = fract(t10);
  t01 = fract(t01); t11 = fract(t11);

  vec2 a = texture(u_noiseTex, t00).rg;
  vec2 b = texture(u_noiseTex, t10).rg;
  vec2 c = texture(u_noiseTex, t01).rg;
  vec2 d = texture(u_noiseTex, t11).rg;

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noise2d(vec2 uv){
  vec2 fr = fract(uv.xy);
  vec2 fl = floor(uv.xy);
  float h00 = Hash2d(fl);
  float h10 = Hash2d(fl + zeroOne.yx);
  float h01 = Hash2d(fl + zeroOne);
  float h11 = Hash2d(fl + zeroOne.yy);
  return mixP(mixP(h00, h10, fr.x), mixP(h01, h11, fr.x), fr.y);
}

// Core fractal with audio-driven knobs (bounded for stability).
float Fractal(vec2 p, float drive, float speed, float foldAdd){
  vec2 pr = p;
  float scale = 1.0;
  float iter = 1.0;

  for (int i = 0; i < 12; i++){
    // Original: p*0.15*iter + time*1.925
    vec2 n2 = noise2dTex2(p * (0.15 * iter) + u_timeDrive + float(i) * 0.17);

    float nx = n2.x - 0.5;
    float ny = n2.y;

    // Original warp strength: 0.0002 * iter^3
    float it3 = iter * iter * iter;
    float w = 0.0002 * it3 * drive;
    pr += vec2(nx, ny) * w;

    pr = fract(pr * 0.5 + 0.5) * 2.0 - 1.0;

    // Original exponent: 1.0 + nx*0.5 (we add a small audio term)
    float len2 = max(dot(pr, pr), 1e-6);
    float expo = clamp(1.0 + nx * 0.5 + foldAdd, 0.55, 2.10);

    float lenv = pow(len2, expo);
    float inv = 1.1 / max(lenv, 1e-6);

    pr *= inv;
    scale *= inv;
    iter += 1.0;
  }

  float b = abs(pr.x) * abs(pr.y) / max(scale, 1e-6);
  return pow(b, 0.125) * 0.95;
}

void main(){
  // Shadertoy-style centered UV with aspect correction
  vec2 uv = v_uv - 0.5;
  uv.x *= u_aspect;

  // Audio shaping (lift lows so it *moves* even on quieter tracks)
  float bass = pow(sat(u_bass),   0.40);
  float mid  = pow(sat(u_mid),    0.40);
  float high = pow(sat(u_high),   0.40);
  float en   = pow(sat(u_energy), 0.35);
  float g    = clamp(u_gain, 0.2, 4.0);

  // Drivers (BOUNDED — avoids “teleport / explode”)
  float drive   = clamp(0.95 + 0.45*bass + 0.25*mid,  0.95, 1.35);
  float speed   = clamp(0.95 + 0.55*bass + 0.15*high, 0.95, 1.60);
  float foldAdd = clamp(0.02 + 0.25*mid  + 0.08*high, 0.02, 0.35);

  // Bass zoom pulse (obvious, stable)
  float zoom = 0.94 * (1.0 - 0.050*bass);
  uv *= zoom;

  // Original warp direction term
  vec2 warp = safeNormalize(uv) * (1.0 - pow(length(uv), 0.45));
  warp *= (1.0 + 0.65*mid + 0.25*bass);

  // Fractal channels (keep original offsets)
  vec3 finalColor = vec3(
    Fractal(uv*2.0 +  1.0, drive,        speed,        foldAdd),
    Fractal(uv*2.0 + 37.0, drive * 0.93, speed * 1.03, foldAdd * 0.95),
    Fractal((warp+0.5)*2.0 + 15.0, drive * 0.88, speed * 1.10, foldAdd * 0.90)
  );
  finalColor = 1.0 - finalColor;

  // Circle mask + outer ring (bass “breathes” radius slightly)
  float circle = 1.0 - length(uv * (2.2 - 0.16*bass));

  float at = atan(uv.x, uv.y);
  float aNoise = noise2d(vec2(at * 30.0, u_timeRing));
  aNoise = aNoise * 0.5 + 0.5;

  // Original shaping
  finalColor *= pow(max(0.0, circle), 0.1) * 2.0;                 // mask
  finalColor *= 1.0 + pow(1.0 - abs(circle), 30.0);               // colorful outer glow

  // Outer ring (high-driven shimmer pop)
  finalColor += vec3(1.0, 0.3, 0.03) * (2.6 + 4.8*high)
              * pow(1.0 - abs(circle), 100.0) * aNoise;

  float outer = (1.0 - pow(max(0.0, circle), 0.1) * 2.0);
  finalColor += vec3(1.0, 0.2, 0.03) * (0.28 + 0.50*en)
              * max(0.0, outer * (1.0 - length(uv)));

  // Global brightness lift (energy + gain)
  finalColor *= (0.85 + 1.15*en + 0.35*bass) * (1.0 + 0.22*(g - 1.0));

  // --- overlay-safe alpha (shape-based; stable) ---
  float mask = smoothstep(-0.10, 0.55, circle);
  float edge = pow(clamp(circle, 0.0, 1.0), 0.12);
  float a = clamp(mask * (0.25 + 0.75*edge), 0.0, 1.0);
  a *= (0.85 + 0.35*en);
  fragColor = vec4(finalColor, a);
}
`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D iChannel0;
void main(){ fragColor = texture(iChannel0, v_uv); }
`;

const PASS_SPECS_BASE = [
  { name: "BufferA", fs: APOLLONIAN_FS, scale: 1.0, inputs: { 0: "noise" } },
  { name: "Image",   fs: BLIT_FS,        inputs: { 0: "BufferA" } },
];

const TIME_WRAP_S = 0;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clampInt(x, lo, hi) {
  const v = x | 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Average spectrum magnitude between two Hz bounds (clamped to Nyquist).
function bandAvgHz(spec, samplerate, f0, f1) {
  if (!spec || !spec.length) return NaN;
  const n = spec.length | 0;
  if (n <= 2) return NaN;

  const sr = isFiniteNumber(samplerate) ? samplerate : 48000;
  const nyq = 0.5 * sr;

  const a = Math.max(0, Math.min(nyq, f0));
  const b = Math.max(0, Math.min(nyq, f1));
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  if (hi <= lo + 1e-6) return NaN;

  // rfft bins map: [0..nyq] -> [0..n-1]
  let i0 = Math.floor((lo / nyq) * (n - 1));
  let i1 = Math.ceil((hi / nyq) * (n - 1));
  i0 = clampInt(i0, 0, n - 1);
  i1 = clampInt(i1, 0, n - 1);
  if (i1 <= i0) return NaN;

  let s = 0;
  for (let i = i0; i <= i1; i++) s += spec[i];
  return s / (i1 - i0 + 1);
}

const COMP_K = 18.0;
const COMP_D = Math.log1p(COMP_K);
function comp01(x) {
  const v = Math.max(0, x);
  return clamp01(Math.log1p(v * COMP_K) / COMP_D);
}

export class ApollonianFracturesWebGL2MP {
  static id = "apollonian_fractures";
  static name = "Apollonian Fractures (WebGL2 Multipass)";
  static renderer = "webgl";

  constructor(canvas, opts = {}) {
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

    this._loc = null;

    this._lastT = NaN;
    this._frame = 0;

    // Audio state (smoothed, dt-corrected)
    this._agc = 1.0;
    this._bass = 0.0;
    this._mid = 0.0;
    this._high = 0.0;
    this._energy = 0.0;
    this._floorE = 0.0;
    this._L = 0.0;
    this._timeDrive = 0.0;
    this._timeRing = 0.0;

    this._params = { renderScale: 1.0 };
    if (opts && typeof opts === "object") {
      if (isFiniteNumber(opts.renderScale)) {
        this._params.renderScale = Math.min(1.0, Math.max(0.75, opts.renderScale));
      }
    }

    // Apply renderScale to BufferA and build passes
    const self = this;
    const passes = PASS_SPECS_BASE.map((p) => {
      const pass = { ...p };
      if (pass.name === "BufferA") pass.scale = self._params.renderScale;
      pass.uniforms = function (gl2, program) {
        if (!self._loc) self._loc = new Map();
        let loc = self._loc.get(program);
        if (!loc) {
          loc = self._resolveLocs(gl2, program);
          self._loc.set(program, loc);
        }
        self._applyUniforms(gl2, loc);
      };
      return pass;
    });

    this.mp.setPasses(passes);
  }

  _resolveLocs(gl2, program) {
    return {
      u_timeDrive: gl2.getUniformLocation(program, "u_timeDrive"),
      u_timeRing: gl2.getUniformLocation(program, "u_timeRing"),
    };
  }

  _applyUniforms(gl2, loc) {
    if (!loc) return;
    if (loc.u_timeDrive) gl2.uniform1f(loc.u_timeDrive, this._timeDrive);
    if (loc.u_timeRing) gl2.uniform1f(loc.u_timeRing, this._timeRing);
  }

  onResize(w, h, dpr) {
    if (!this.mp) return;
    this.mp.setSize(w, h, dpr);
  }

  onFrame(frame) {
    if (!this.mp) return;

    const now = performance.now() * 0.001;
    let t = now;
    if (frame) {
      if (frame.time && isFiniteNumber(frame.time.t)) t = frame.time.t;
      else if (isFiniteNumber(frame.t)) t = frame.t;
      else if (isFiniteNumber(frame.ts)) t = frame.ts < 1e12 ? frame.ts : frame.ts * 0.001;
    }

    let dtReal = NaN;
    if (frame) {
      if (isFiniteNumber(frame.dt)) dtReal = frame.dt;
      else if (frame.time && isFiniteNumber(frame.time.dt)) dtReal = frame.time.dt;
    }
    if (!isFiniteNumber(dtReal)) dtReal = isFiniteNumber(this._lastT) ? (t - this._lastT) : (1 / 60);
    if (dtReal < 0) dtReal = 0;

    // Keep dt systems separate (rate vs render/motion)
    const dtRate = dtReal;
    const dt = Math.min(dtReal, 0.10);

    this._lastT = t;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) frameIndex = frame.frameIndex | 0;
    else if (frame && isFiniteNumber(frame.frame)) frameIndex = frame.frame | 0;
    else frameIndex = (this._frame = (this._frame + 1) | 0);

    // --- Audio: derive from spectrum with mini-AGC + compression (stable 0..1) ---
    const spec = frame && (frame.spectrum || frame.spec);
    const specLen = (spec && spec.length) ? (spec.length | 0) : 0;

    let bassT = 0, midT = 0, highT = 0, energyT = 0;

    if (specLen > 0) {
      const samplerate = frame && isFiniteNumber(frame.samplerate) ? frame.samplerate : 48000;
      bassT = bandAvgHz(spec, samplerate, 35.0, 180.0);      if (!isFiniteNumber(bassT)) bassT = 0;
      midT  = bandAvgHz(spec, samplerate, 200.0, 2000.0);    if (!isFiniteNumber(midT))  midT  = 0;
      highT = bandAvgHz(spec, samplerate, 2500.0, 12000.0);  if (!isFiniteNumber(highT)) highT = 0;
      energyT = bandAvgHz(spec, samplerate, 20.0, 18000.0);  if (!isFiniteNumber(energyT)) energyT = 0;
    }

    const energyRaw = energyT;
    const kFloorDown = 1 - Math.exp(-dtRate / 0.6);
    const kFloorUp = 1 - Math.exp(-dtRate / 6.0);
    const kFloor = energyRaw < this._floorE ? kFloorDown : kFloorUp;
    this._floorE += (energyRaw - this._floorE) * kFloor;

    const energyAdj = Math.max(0, energyRaw - this._floorE);
    const gate = energyRaw > 1e-6 ? clamp01(energyAdj / energyRaw) : 0;
    bassT *= gate;
    midT  *= gate;
    highT *= gate;
    energyT = energyAdj;

    let userGain = (frame && isFiniteNumber(frame.gain)) ? frame.gain : 1.0;
    if (!(userGain > 0)) userGain = 1.0;

    const nearSilence = (energyT < 5e-4) || !(specLen > 0);

    const kLA = 1 - Math.exp(-dtRate * 0.65);
    const kLR = 1 - Math.exp(-dtRate * 1.60);
    const kL = energyT > this._L ? kLA : kLR;
    this._L = this._L + (energyT - this._L) * kL;

    const targetLevel = 0.38;
    let desired = targetLevel / (this._L + 1e-6);
    if (desired < 0.35) desired = 0.35;
    else if (desired > 6.0) desired = 6.0;

    if (nearSilence) {
      const kSilence = 1 - Math.exp(-dtRate * 0.5);
      this._agc += (1.0 - this._agc) * kSilence;
    }

    const atkAgc = 1 - Math.exp(-dtRate * 0.75);
    const relAgc = 1 - Math.exp(-dtRate * 1.05);
    const kAgc = desired > this._agc ? atkAgc : relAgc;
    if (!nearSilence) this._agc += (desired - this._agc) * kAgc;

    const effGain = userGain * this._agc;



    bassT   = comp01(bassT   * effGain);
    midT    = comp01(midT    * effGain);
    highT   = comp01(highT   * effGain);
    energyT = comp01(energyT * effGain);

    // Smooth so missing frames don't snap the look
    const k = 1 - Math.exp(-dtRate * 4.0);
    this._bass   += (bassT   - this._bass)   * k;
    this._mid    += (midT    - this._mid)    * k;
    this._high   += (highT   - this._high)   * k;
    this._energy += (energyT - this._energy) * k;

    if (frame) {
      frame.bass = this._bass;
      frame.mid = this._mid;
      frame.high = this._high;
      frame.energy = this._energy;
      // keep frame.gain as user-controlled (we used it internally for AGC)
    }


    const bassSh = Math.pow(clamp01(this._bass), 0.40);
    const highSh = Math.pow(clamp01(this._high), 0.40);
    const speedT = 0.95 + 0.55 * bassSh + 0.15 * highSh;
    const ringT = 0.60 + 1.40 * highSh;
    const dtMove = dt;
    this._timeDrive = (this._timeDrive + dtMove * (1.925 * speedT)) % 256.0;
    this._timeRing += dtMove * ringT;

    const tWrapped = TIME_WRAP_S > 0 ? (t % TIME_WRAP_S) : t;
    this.mp.render(frame, tWrapped, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
  }
}
