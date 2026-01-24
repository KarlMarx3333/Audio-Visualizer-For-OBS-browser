import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";
/*
3D Spectrum Dots (WebGL2 Multipass)

Inspired by Shadertoy: "Video Heightfield" (audio heightfield variant) by huttarl (2013-03-20)
https://www.shadertoy.com/view/XXXXXXXX   // TODO: replace with the exact Shadertoy URL

Notes: Original shader references "video heightfield" by @simesgreen:
https://www.shadertoy.com/view/Xss3zr

Changes vs original:
- Render bands as dotted ridges (dot grid in band/depth UV) instead of a continuous shaded heightfield surface
- Removed the oscilloscope / waveform line overlay
- Solid green dots with red peak highlights; constant brightness and alpha
- Added spectrum rebin/smoothing + log-compression to reduce bass dominance and improve high-frequency visibility
- Per-band normalization (band-average with headroom) to keep activity across the full field
- Slow AGC (anti-track-loudness drift)
*/

const BANDS = 30; // keep in sync with shader BANDS
const BAND_LOG_POWER = 2.15;
const FREQ_MIN_HZ = 20.0;
const FREQ_MAX_HZ = 15000.0;
const BAND_AVG_RISE_TAU = 0.6;
const BAND_AVG_FALL_TAU = 3.0;
const BAND_AVG_SILENCE_TAU = 6.0;
const NORM_CLAMP = 2.5;
const NORM_EPS = 1e-4;
const BAND_REF_HEADROOM = 1.6;
const BAND_FLOOR_MIN = 0.0006;
const BAND_FLOOR_MAX = 0.0025;

const SPECTRUM_3D_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_dt;

uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_energy;
uniform float u_gain;
uniform float u_aspect;

uniform sampler2D u_specTex;
uniform int u_specLen;

const int   STEPS = 64;
const float BANDS = 30.0;
const float DOTS_Z = 90.0;  // dot columns along depth
const float DOT_BRIGHTNESS = 4.0;

const vec3 LIGHT_DIR = vec3(0.5535, 0.7547, 0.3522);
const float PI = 3.141592653589793;

vec3 rotateX(vec3 p, float a){
  float s = sin(a), c = cos(a);
  return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z);
}
vec3 rotateY(vec3 p, float a){
  float s = sin(a), c = cos(a);
  return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
}

bool intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float tnear, out float tfar){
  vec3 invR = 1.0 / rd;
  vec3 t0 = (bmin - ro) * invR;
  vec3 t1 = (bmax - ro) * invR;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  tnear = max(max(tmin.x, tmin.y), tmin.z);
  tfar  = min(min(tmax.x, tmax.y), tmax.z);
  return tnear <= tfar;
}

vec2 worldToTex(vec3 p){
  // map xz from [-1,1] to [0,1]
  vec2 uv = p.xz * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  return uv;
}

float normalCurve(float x){
  // Cauchy-like bell curve (stable, cheap)
  return 1.0 / (PI * (1.0 + x*x));
}

float specSample01(float x01){
  int n = u_specLen;
  if(n <= 1) return 0.0;

  float fx = clamp(x01, 0.0, 1.0) * float(n - 1);
  int i0 = int(floor(fx));

  // 5-tap smoothing kernel around nearest bin (rebins + smooths enough to avoid raw-bin jitter)
  int i_2 = clamp(i0 - 2, 0, n - 1);
  int i_1 = clamp(i0 - 1, 0, n - 1);
  int i00 = clamp(i0 + 0, 0, n - 1);
  int i1  = clamp(i0 + 1, 0, n - 1);
  int i2  = clamp(i0 + 2, 0, n - 1);

  float u_2 = (float(i_2) + 0.5) / float(n);
  float u_1 = (float(i_1) + 0.5) / float(n);
  float u00 = (float(i00) + 0.5) / float(n);
  float u1  = (float(i1)  + 0.5) / float(n);
  float u2  = (float(i2)  + 0.5) / float(n);

  float v_2 = max(0.0, texture(u_specTex, vec2(u_2, 0.5)).r);
  float v_1 = max(0.0, texture(u_specTex, vec2(u_1, 0.5)).r);
  float v00 = max(0.0, texture(u_specTex, vec2(u00, 0.5)).r);
  float v1  = max(0.0, texture(u_specTex, vec2(u1,  0.5)).r);
  float v2  = max(0.0, texture(u_specTex, vec2(u2,  0.5)).r);

  // weights: [0.25, 0.6, 1.0, 0.6, 0.25]
  float s = v_2*0.25 + v_1*0.60 + v00 + v1*0.60 + v2*0.25;
  return s / (0.25 + 0.60 + 1.00 + 0.60 + 0.25);
}

float bandAmp(float band01){
  float v = specSample01(clamp(band01, 0.0, 1.0));
  float c = log(1.0 + 28.0*v) / log(29.0);
  return clamp(c, 0.0, 1.0);
}

float heightField(vec3 p){
  vec2 uv = worldToTex(p);

  float bi = floor(uv.x * BANDS);
  float bx = (bi + 0.5) / BANDS;

  float amp = bandAmp(bx);

  // depth (uv.y) bell curve so each band forms a "ridge" of dots
  float zc = normalCurve((uv.y - 0.5) * 5.0) * 2.0;

  return amp * zc * 0.95; // keep within box Y range
}

bool traceHeightField(vec3 ro, vec3 stepV, out vec3 hitPos){
  vec3 p = ro;
  vec3 pPrev = p;
  float hPrev = heightField(pPrev);
  for(int i = 0; i < STEPS; i++){
    float h = heightField(p);
    if(p.y < h){
      float y0 = pPrev.y - hPrev;
      float y1 = p.y     - h;
      float k = clamp(y0 / (y0 - y1), 0.0, 1.0);
      hitPos = mix(pPrev, p, k);
      return true;
    }
    pPrev = p;
    hPrev = h;
    p += stepV;
  }
  return false;
}

float dotMask(vec2 uv){
  // dots anchored per-band and along depth
  vec2 cell = vec2(fract(uv.x * BANDS), fract(uv.y * DOTS_Z)) - 0.5;
  // Keep dots round in world units (band spacing != depth spacing).
  cell.x *= (DOTS_Z / BANDS);
  float d = length(cell);

  // derivative-aware AA
  float aa = max(0.003, fwidth(d));
  float r = 0.18;

  float core = 1.0 - smoothstep(r - aa, r + aa, d);
  float glow = 1.0 - smoothstep(r, r + 0.45, d);
  return clamp(core + 0.35 * glow, 0.0, 1.0);
}

void main(){
  float t = mod(u_time, 1000.0);

  // NDC-ish pixel for camera ray
  vec2 px = v_uv * 2.0 - 1.0;
  px.x *= u_aspect;

  // camera
  vec3 camO = vec3(0.0, 0.06, 2.60);
  vec3 camD = normalize(vec3(px.x, px.y, -2.2));

  // gentle auto-rotation (audio nudges only)
  float bass = pow(clamp(u_bass, 0.0, 1.0), 0.5);
  float mid  = pow(clamp(u_mid,  0.0, 1.0), 0.5);

  float pitch = -0.55 + 0.08*sin(t*0.17) - 0.18*bass;
  float yaw   =  0.35*sin(t*0.21) + 0.22*mid;

  camO = rotateX(camO, pitch);
  camD = rotateX(camD, pitch);
  camO = rotateY(camO, yaw);
  camD = rotateY(camD, yaw);

  // box bounds in world space
  const vec3 BMIN = vec3(-1.0, -0.01, -1.0);
  const vec3 BMAX = vec3( 1.0,  0.60,  1.0);

  float tnear, tfar;
  if(!intersectBox(camO, camD, BMIN, BMAX, tnear, tfar)){
    fragColor = vec4(0.0);
    return;
  }

  tnear = max(tnear, 0.0);
  vec3 pnear = camO + camD * (tnear - 1e-4);
  vec3 pfar  = camO + camD * tfar;
  float stepSize = length(pfar - pnear) / float(STEPS);

  vec3 hitPos;
  if(!traceHeightField(pnear, camD * stepSize, hitPos)){
    fragColor = vec4(0.0);
    return;
  }

  vec2 uv = worldToTex(hitPos);

  // per-band amp
  float bi = floor(uv.x * BANDS);
  float bx = (bi + 0.5) / BANDS;
  float amp = bandAmp(bx);

  // dot-only rendering
  float dots = dotMask(uv);

  float peakAmp = smoothstep(0.60, 0.85, amp);
  peakAmp = pow(peakAmp, 1.4);
  float row = floor(clamp(uv.y, 0.0, 0.999999) * DOTS_Z);
  float rowCenter = (DOTS_Z - 1.0) * 0.5;
  float rowDist = abs(row - rowCenter);
  float peakCenter = 1.0 - smoothstep(0.5, 13.5, rowDist);
  float peak = peakAmp * peakCenter;
  vec3 col = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), peak);
  col = normalize(max(col, vec3(1e-4)));
  col *= DOT_BRIGHTNESS;
  // Keep alpha constant for visible dots (no energy/amp/distance fade).
  float vis = dots;
  float alpha = vis * 1.0;
  alpha = clamp(alpha, 0.0, 1.0);

  // extra clamp for overlay safety
  col = clamp(col, 0.0, 25.0);
  fragColor = vec4(col, alpha);
}
`;

const PASS_SPECS = [
  { name: "Image", fs: SPECTRUM_3D_FS },
];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function sampleSpec01(spec, len, x01) {
  if (!spec || len <= 1) return 0;
  const fx = clamp(x01, 0, 1) * (len - 1);
  const i0 = Math.floor(fx);

  const i_2 = Math.max(0, i0 - 2);
  const i_1 = Math.max(0, i0 - 1);
  const i00 = i0;
  const i1 = Math.min(len - 1, i0 + 1);
  const i2 = Math.min(len - 1, i0 + 2);

  const v_2 = Math.max(0, isFiniteNumber(spec[i_2]) ? spec[i_2] : 0);
  const v_1 = Math.max(0, isFiniteNumber(spec[i_1]) ? spec[i_1] : 0);
  const v00 = Math.max(0, isFiniteNumber(spec[i00]) ? spec[i00] : 0);
  const v1 = Math.max(0, isFiniteNumber(spec[i1]) ? spec[i1] : 0);
  const v2 = Math.max(0, isFiniteNumber(spec[i2]) ? spec[i2] : 0);

  const s = v_2 * 0.25 + v_1 * 0.60 + v00 + v1 * 0.60 + v2 * 0.25;
  return s / 2.7;
}

export class Spectrum3DWebGL2MP {
  static id = "spectrum3d";
  static name = "3D Spectrum Dots (WebGL2 Multipass)";
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
    this._agc = 1.0;

    this._bands = new Float32Array(BANDS);
    this._bandAvg = new Float32Array(BANDS);
    this._bandFloor = new Float32Array(BANDS);
    this._bandPos = new Float32Array(BANDS);
    this._mapSpecLen = 0;
    this._mapSampleRate = 0;
    this._mapFftSize = 0;
    this._mapFMax = 0;
    for (let i = 0; i < BANDS; i++) {
      const t = (i + 0.5) / BANDS;
      this._bandPos[i] = Math.pow(t, BAND_LOG_POWER);
      const floor = BAND_FLOOR_MIN + (BAND_FLOOR_MAX - BAND_FLOOR_MIN) * (t * t);
      this._bandFloor[i] = floor;
      this._bandAvg[i] = floor;
      this._bands[i] = 0;
    }

    this._frameProxy = {
      frameId: 0,
      ts: 0,
      tsMs: 0,
      channels: 1,
      rms: null,
      peak: null,
      corr: null,
      bass: 0,
      mid: 0,
      high: 0,
      energy: 0,
      overlay: false,
      waveLR: null,
      spectrum: this._bands,
      wave: null,
      gain: 1.0,
      samplerate: 48000,
      fftSize: 2048,
      dt: 1 / 60,
      t: 0,
      time: { t: 0, dt: 1 / 60 },
      viewport: { w: 0, h: 0, dpr: 1 },
      width: 0,
      height: 0,
      dpr: 1,
    };
  }

  _updateBandMap(specLen, samplerate, fftSize) {
    const nyquist = samplerate > 0 ? samplerate * 0.5 : 0;
    const fMax = Math.min(FREQ_MAX_HZ, nyquist);
    const useLog = specLen > 1 && samplerate > 0 && fftSize > 0 && fMax > FREQ_MIN_HZ;

    for (let i = 0; i < BANDS; i++) {
      const t = (i + 0.5) / BANDS;
      if (useLog) {
        const tt = Math.pow(t, BAND_LOG_POWER);
        const freq = FREQ_MIN_HZ * Math.pow(fMax / FREQ_MIN_HZ, tt);
        const bin = (freq * fftSize) / samplerate;
        const pos = specLen > 1 ? (bin / (specLen - 1)) : 0;
        this._bandPos[i] = clamp(pos, 0, 1);
      } else {
        this._bandPos[i] = Math.pow(t, BAND_LOG_POWER);
      }
    }

    this._mapSpecLen = specLen;
    this._mapSampleRate = samplerate;
    this._mapFftSize = fftSize;
    this._mapFMax = fMax;
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

    let dt = NaN;
    if (frame) {
      if (isFiniteNumber(frame.dt)) dt = frame.dt;
      else if (frame.time && isFiniteNumber(frame.time.dt)) dt = frame.time.dt;
    }
    if (!isFiniteNumber(dt)) {
      dt = isFiniteNumber(this._lastT) ? (t - this._lastT) : (1 / 60);
    }
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._lastT = t;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) frameIndex = frame.frameIndex | 0;
    else if (frame && isFiniteNumber(frame.frame)) frameIndex = frame.frame | 0;
    else {
      this._frame = (this._frame + 1) | 0;
      frameIndex = this._frame;
    }

    const specIn = frame && frame.spectrum ? frame.spectrum : null;
    const specLen = specIn && specIn.length ? (specIn.length | 0) : 0;
    const samplerate = frame && isFiniteNumber(frame.samplerate) ? frame.samplerate : 48000;
    const fftSize = frame && isFiniteNumber(frame.fftSize) ? frame.fftSize | 0 : 2048;
    const nyquist = samplerate > 0 ? samplerate * 0.5 : 0;
    const fMax = Math.min(FREQ_MAX_HZ, nyquist);
    if (
      specLen !== this._mapSpecLen ||
      samplerate !== this._mapSampleRate ||
      fftSize !== this._mapFftSize ||
      fMax !== this._mapFMax
    ) {
      this._updateBandMap(specLen, samplerate, fftSize);
    }

    let userGain = (frame && isFiniteNumber(frame.gain)) ? frame.gain : 1.0;
    if (!(userGain > 0)) userGain = 1.0;

    let peak0 = 0;
    let rms0 = 0;
    if (frame && frame.peak && frame.peak.length) peak0 = frame.peak[0] || 0;
    if (frame && frame.rms && frame.rms.length) rms0 = frame.rms[0] || 0;

    let scanPeak = 0;
    if (specIn && specLen > 0) {
      const step = Math.max(1, (specLen / 96) | 0);
      for (let i = 0; i < specLen; i += step) {
        const v = specIn[i];
        const fv = Number.isFinite(v) ? v : 0;
        if (fv > scanPeak) scanPeak = fv;
      }
    }

    let ampLevel = Number.isFinite(peak0) ? peak0 : (Number.isFinite(rms0) ? (rms0 * 2.0) : scanPeak);
    if (!(ampLevel > 0)) ampLevel = 1e-4;

    const energyIn = (frame && isFiniteNumber(frame.energy)) ? frame.energy : 0;
    const nearSilence = (energyIn < 0.02) && (ampLevel * userGain < 0.02);

    const target = 0.65;
    let desired = this._agc;
    if (!nearSilence) {
      desired = target / (ampLevel * userGain);
      if (desired < 0.35) desired = 0.35;
      else if (desired > 3.0) desired = 3.0;
    }

    const atk = 1 - Math.exp(-dt * 1.2);
    const rel = 1 - Math.exp(-dt * 0.35);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;
    if (this._agc < 0.35) this._agc = 0.35;
    else if (this._agc > 3.0) this._agc = 3.0;

    const effGain = userGain * this._agc;
    const g = clamp(effGain, 0.2, 4.0);
    const gainScale = 1.2 + 2.4 * g;

    const kRise = 1 - Math.exp(-dt / BAND_AVG_RISE_TAU);
    const kFall = 1 - Math.exp(-dt / BAND_AVG_FALL_TAU);
    const kSilence = 1 - Math.exp(-dt / BAND_AVG_SILENCE_TAU);

    for (let i = 0; i < BANDS; i++) {
      let cur = 0;
      if (specIn && specLen > 0) {
        const v = sampleSpec01(specIn, specLen, this._bandPos[i]);
        cur = (Number.isFinite(v) ? v : 0) * gainScale;
      }

      let avg = this._bandAvg[i];
      if (nearSilence) {
        avg += (this._bandFloor[i] - avg) * kSilence;
      } else {
        const kAvg = cur > avg ? kRise : kFall;
        avg += (cur - avg) * kAvg;
      }
      this._bandAvg[i] = avg;

      const ref = Math.max(avg * BAND_REF_HEADROOM, this._bandFloor[i], NORM_EPS);
      let norm = cur / ref;
      if (norm > NORM_CLAMP) norm = NORM_CLAMP;
      if (norm < 0) norm = 0;
      this._bands[i] = norm;
    }

    const fp = this._frameProxy;
    fp.frameId = frame && isFiniteNumber(frame.frameId) ? frame.frameId | 0 : frameIndex;
    fp.ts = frame && isFiniteNumber(frame.ts) ? frame.ts : 0;
    fp.tsMs = frame && isFiniteNumber(frame.tsMs) ? frame.tsMs : 0;

    fp.channels = frame && isFiniteNumber(frame.channels) ? frame.channels | 0 : 1;
    fp.rms = frame ? frame.rms : null;
    fp.peak = frame ? frame.peak : null;
    fp.corr = frame ? frame.corr : null;

    fp.bass = frame && isFiniteNumber(frame.bass) ? frame.bass : 0;
    fp.mid = frame && isFiniteNumber(frame.mid) ? frame.mid : 0;
    fp.high = frame && isFiniteNumber(frame.high) ? frame.high : 0;
    fp.energy = energyIn;

    fp.overlay = !!(frame && frame.overlay);
    fp.waveLR = frame ? frame.waveLR : null;
    fp.wave = frame ? frame.wave : null;
    fp.spectrum = this._bands;
    fp.gain = 1.0;

    fp.samplerate = samplerate;
    fp.fftSize = fftSize;

    fp.dt = dt;
    fp.t = t;
    fp.time.t = t;
    fp.time.dt = dt;

    fp.width = frame && isFiniteNumber(frame.width) ? frame.width : 0;
    fp.height = frame && isFiniteNumber(frame.height) ? frame.height : 0;
    fp.dpr = frame && isFiniteNumber(frame.dpr) ? frame.dpr : 1;

    fp.viewport.w = frame && frame.viewport && isFiniteNumber(frame.viewport.w) ? frame.viewport.w : fp.width;
    fp.viewport.h = frame && frame.viewport && isFiniteNumber(frame.viewport.h) ? frame.viewport.h : fp.height;
    fp.viewport.dpr = frame && frame.viewport && isFiniteNumber(frame.viewport.dpr) ? frame.viewport.dpr : fp.dpr;

    // Use normalized per-band spectrum via u_specTex/u_specLen.
    this.mp.render(fp, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
    this._bands = null;
    this._bandAvg = null;
    this._bandFloor = null;
    this._bandPos = null;
    this._agc = null;
    this._mapSpecLen = null;
    this._mapSampleRate = null;
    this._mapFftSize = null;
    this._mapFMax = null;
  }
}
