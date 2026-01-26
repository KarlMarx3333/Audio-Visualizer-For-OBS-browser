import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Top/Bottom Mirrored Radial Spectrum (WebGL2 Multipass)

Inspired by Shadertoy: "Radial Audio Visualizer" by Rafbeam (2018-04-21)
https://www.shadertoy.com/view/ldtBRN

Changes vs original:
- Internal base circle (constant alpha, not energy-driven)
- Two-tone colored palette (NOT rainbow)
- Peak hats with smooth fall
- Bars+hats alpha driven by energy, clamped <= 0.50
- Slow AGC (anti-track-loudness drift)
- No warp/distort, no twist motion, no grid
- Audible-only mapping (20-18000 Hz, log-spaced, Nyquist-clamped)
*/

const BARS_N = 128;
const FREQ_MIN_HZ = 20.0;
const FREQ_MAX_HZ = 16000.0;
const BAND_AVG_RISE_TAU = 0.6;
const BAND_AVG_FALL_TAU = 3.0;
const BAND_AVG_SILENCE_TAU = 6.0;
const NORM_CLAMP = 2.5;
const NORM_EPS = 1e-4;
const BAND_REF_HEADROOM = 1.6;
const BAND_FLOOR_MIN = 0.0006;
const BAND_FLOOR_MAX = 0.0025;

const RADIAL_SPECTRUM_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_aspect;
uniform float u_time;
uniform float u_dt;

uniform float u_energy;

// Audio textures (R32F, 1xN)
uniform sampler2D u_specTex;
uniform int u_specLen;

uniform sampler2D u_waveTex;   // repurposed for peaks (R32F, 1xN)
uniform int u_waveLen;

const float PI = 3.14159265359;

float safeLen(int n){ return float(max(n, 1)); }

// 1D sample with linear interpolation (u in [0..1])
float tex1D(sampler2D tex, int len, float u){
  float L = safeLen(len);
  float x = clamp(u, 0.0, 1.0) * (L - 1.0);
  float i = floor(x);
  float f = x - i;
  float u0 = (i + 0.5) / L;
  float u1 = (min(i + 1.0, L - 1.0) + 0.5) / L;
  float a = texture(tex, vec2(u0, 0.5)).r;
  float b = texture(tex, vec2(u1, 0.5)).r;
  return mix(a, b, f);
}

float logNorm(float x){
  // Log compression for nicer spectrum dynamics.
  float k = 18.0;
  x = max(x, 0.0);
  return clamp(log(1.0 + x*k) / log(1.0 + k), 0.0, 1.0);
}

// NOT rainbow: cyan -> magenta (static by bin)
vec3 palette(float t){
  vec3 c0 = vec3(0.00, 0.90, 1.00);
  vec3 c1 = vec3(1.00, 0.18, 0.88);
  return mix(c0, c1, smoothstep(0.0, 1.0, t));
}

void main(){
  vec2 uv = v_uv;

  // Centered, aspect-correct space
  vec2 p = uv - 0.5;
  p.x *= u_aspect;
  p = vec2(-p.y, p.x);

  p.y = abs(p.y);

  float r = length(p);
  float ang = atan(p.y, p.x);             // 0..PI
  float a01 = ang / PI;                   // 0..1 (mirrored)

  // Bar count: keep crisp but not too heavy
  float barsN = ${BARS_N}.0;

  float idxF = floor(a01 * barsN);
  float tIdx = (idxF + 0.5) / barsN;

  // Sector mask (crisp bars with AA)
  float cell = fract(a01 * barsN);
  float d = abs(cell - 0.5);
  float aaA = fwidth(a01 * barsN);
  float halfW = 0.33; // bar half-width in cell space (0..0.5)
  float inSector = smoothstep(halfW, halfW - aaA, d);

  // Spectrum sample + tiny spatial smoothing (no temporal sluggishness)
  float s0 = tex1D(u_specTex, u_specLen, tIdx);
  float sL = tex1D(u_specTex, u_specLen, clamp(tIdx - 1.0/barsN, 0.0, 1.0));
  float sR = tex1D(u_specTex, u_specLen, clamp(tIdx + 1.0/barsN, 0.0, 1.0));
  float s = (sL + 2.0*s0 + sR) * 0.25;

  float lvl = logNorm(s);

  // Geometry
  float innerR = 0.15;  // base circle radius
  float maxLen = 0.25;  // max bar length
  float barLen = maxLen * pow(lvl, 0.65);
  float outerR = innerR + barLen;

  float aaR = fwidth(r) * 1.6;

  // Bar body mask
  float inRad = smoothstep(innerR - aaR, innerR + aaR, r) *
                (1.0 - smoothstep(outerR - aaR, outerR + aaR, r));
  float body = inSector * inRad;

  // Peak hats (u_waveTex is peaks)
  float pk = tex1D(u_waveTex, u_waveLen, tIdx);
  float pkLvl = logNorm(pk);
  float pkR = innerR + maxLen * pow(pkLvl, 0.85);

  float hatTh = 0.006;
  float hat = inSector * (1.0 - smoothstep(hatTh - aaR, hatTh + aaR, abs(r - pkR)));

  // Internal base circle (constant alpha; not energy-driven)
  float ringTh = 0.0065;
  float ring = 1.0 - smoothstep(ringTh - aaR, ringTh + aaR, abs(r - innerR));

  // Alpha rules
  float barsAlpha = 0.50 + 0.25 * smoothstep(0.02, 0.25, u_energy);
  float circleAlpha = 0.30;

  float mBars = max(body, hat);
  float aBars = barsAlpha * mBars;
  float aCircle = circleAlpha * ring;

  float outA = max(aCircle, aBars);

  // Colors
  vec3 colBar = palette(tIdx);
  colBar *= (0.35 + 1.8 * lvl);
  vec3 colHat = mix(colBar, vec3(1.0), 0.25);

  vec3 colCircle = mix(vec3(0.00, 0.90, 1.00), vec3(1.00, 0.18, 0.88), 0.5);

  vec3 outC = colCircle;
  if (aBars >= aCircle) {
    float hatMix = hat / max(mBars, 1e-6);
    outC = mix(colBar, colHat, hatMix);
  }

  fragColor = vec4(outC, outA);
}
`;

const PASS_SPECS = [
  { name: "Image", fs: RADIAL_SPECTRUM_FS },
];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
function logNorm(x) {
  const k = 18.0;
  const v = x > 0 ? x : 0;
  return Math.min(1.0, Math.log1p(v * k) / Math.log1p(k));
}
function sampleSpecLinear(spec, len, idx) {
  if (!spec || len <= 0) return 0;
  let x = idx;
  const maxIdx = len - 1;
  if (x < 0) x = 0;
  if (x > maxIdx) x = maxIdx;
  const i = Math.floor(x);
  const f = x - i;
  const a = spec[i];
  const b = spec[i < maxIdx ? i + 1 : i];
  const av = Number.isFinite(a) ? a : 0;
  const bv = Number.isFinite(b) ? b : 0;
  return av + (bv - av) * f;
}

export class RadialSpectrumWebGL2MP {
  static id = "radial_spectrum";
  static name = "Top/Bottom Mirrored Radial Spectrum (WebGL2 Multipass)";
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

    // AGC + smoothing state
    this._agc = 1.0;
    this._bars = null;   // Float32Array (scaled, smoothed bars)
    this._peaks = null;  // Float32Array (scaled peak-hats)
    this._specLen = 0;
    this._barBins = new Float32Array(BARS_N);
    this._bandAvg = new Float32Array(BARS_N);
    this._bandFloor = new Float32Array(BARS_N);
    this._mapSpecLen = 0;
    this._mapSampleRate = 0;
    this._mapFftSize = 0;
    this._mapFMax = 0;
    this._mapUseLog = false;

    // Reused proxy frame so we can feed modified spec/peaks without per-frame allocations.
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
      spectrum: null,
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

  onResize(w, h, dpr) {
    if (!this.mp) return;
    this.mp.setSize(w, h, dpr);
  }

  _ensureBuffers() {
    const n = BARS_N;
    if (this._specLen === n && this._bars && this._peaks) return;
    this._specLen = n;
    this._bars = new Float32Array(n);
    this._peaks = new Float32Array(n);
  }

  _updateBarMap(specLen, samplerate, fftSize) {
    const nyquist = samplerate > 0 ? samplerate * 0.5 : 0;
    const fMax = Math.min(FREQ_MAX_HZ, nyquist);
    const fMin = FREQ_MIN_HZ;
    const useLog = specLen > 0 && samplerate > 0 && fftSize > 0 && fMax > fMin;
    const denom = BARS_N > 1 ? (BARS_N - 1) : 1;

    if (useLog) {
      const logSpan = Math.log(fMax / fMin);
      for (let i = 0; i < BARS_N; i++) {
        const t = i / denom;
        const freq = fMin * Math.exp(logSpan * t);
        const bin = freq * fftSize / samplerate;
        const clamped = Math.max(0, Math.min(specLen - 1, bin));
        this._barBins[i] = clamped;
      }
    } else {
      const maxIdx = Math.max(0, specLen - 1);
      for (let i = 0; i < BARS_N; i++) {
        this._barBins[i] = (i / denom) * maxIdx;
      }
    }

    for (let i = 0; i < BARS_N; i++) {
      const t = i / denom;
      const floor = BAND_FLOOR_MIN + (BAND_FLOOR_MAX - BAND_FLOOR_MIN) * (t * t);
      this._bandFloor[i] = floor;
      this._bandAvg[i] = floor;
      if (this._bars) this._bars[i] = 0;
      if (this._peaks) this._peaks[i] = 0;
    }

    this._mapSpecLen = specLen;
    this._mapSampleRate = samplerate;
    this._mapFftSize = fftSize;
    this._mapFMax = fMax;
    this._mapUseLog = useLog;
  }

  onFrame(frame) {
    if (!this.mp) return;

    // Time
    const now = performance.now() * 0.001;
    let t = now;
    if (frame && isFiniteNumber(frame.t)) t = frame.t;
    else if (frame && frame.time && isFiniteNumber(frame.time.t)) t = frame.time.t;

    let dt = 1 / 60;
    if (frame && isFiniteNumber(frame.dt)) dt = frame.dt;
    else if (frame && frame.time && isFiniteNumber(frame.time.dt)) dt = frame.time.dt;
    if (!isFiniteNumber(dt)) {
      if (isFiniteNumber(this._lastT)) dt = t - this._lastT;
      else dt = 1 / 60;
    }
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._lastT = t;

    // Frame index
    this._frame = (this._frame + 1) | 0;
    const frameIndex = this._frame;

    // Inputs
    const specIn = frame && frame.spectrum ? frame.spectrum : null;
    const specLen = specIn && specIn.length ? (specIn.length | 0) : 0;
    this._ensureBuffers();

    let userGain = (frame && isFiniteNumber(frame.gain)) ? frame.gain : 1.0;
    if (!(userGain > 0)) userGain = 1.0;

    // Slow AGC (anti-track-loudness drift). Uses frame peak/rms if present; clamps; avoids exploding in silence.
    let peak0 = 0, rms0 = 0;
    if (frame && frame.peak && frame.peak.length) peak0 = frame.peak[0] || 0;
    if (frame && frame.rms && frame.rms.length) rms0 = frame.rms[0] || 0;

    // Fallback scan (cheap): use max spectrum bin if arrays exist.
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

    // Freeze/clamp AGC in near-silence
    const nearSilence = (energyIn < 0.02) && (ampLevel * userGain < 0.02);

    const target = 0.65; // target visual amplitude (tuned for overlay-safe alpha)
    let desired = this._agc;
    if (!nearSilence) {
      desired = target / (ampLevel * userGain);
      if (desired < 0.35) desired = 0.35;
      else if (desired > 3.0) desired = 3.0;
    }

    // Multi-second-ish AGC response (doesn't affect bar snappiness much; only overall scaling)
    const atk = 1 - Math.exp(-dt * 1.2);
    const rel = 1 - Math.exp(-dt * 0.35);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;

    if (this._agc < 0.35) this._agc = 0.35;
    else if (this._agc > 3.0) this._agc = 3.0;

    const effGain = userGain * this._agc;

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
      this._updateBarMap(specLen, samplerate, fftSize);
    }

    // Fast, non-sluggish smoothing for bars + smooth peak hats
    let maxBar = 0;
    if (this._bars && this._peaks) {
      const atkB = 1 - Math.exp(-dt * 28.0);
      const relB = 1 - Math.exp(-dt * 18.0);
      const kRise = 1 - Math.exp(-dt / BAND_AVG_RISE_TAU);
      const kFall = 1 - Math.exp(-dt / BAND_AVG_FALL_TAU);
      const kSilence = 1 - Math.exp(-dt / BAND_AVG_SILENCE_TAU);

      // Peak hat release: smooth fall (~seconds)
      const release60 = 0.985;
      const pkRel = Math.pow(release60, dt * 60.0);

      const hasSpec = specIn && specLen > 0;

      for (let i = 0; i < BARS_N; i++) {
        let cur = 0;
        if (hasSpec) {
          const bin = this._barBins[i];
          const v = sampleSpecLinear(specIn, specLen, bin);
          cur = (Number.isFinite(v) ? v : 0) * effGain;
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

        // Bars: fast attack, slightly slower release (but still quick)
        const prev = this._bars[i];
        const k = norm > prev ? atkB : relB;
        const next = prev + (norm - prev) * k;
        this._bars[i] = next > 0 ? next : 0;
        if (next > maxBar) maxBar = next;

        // Peaks: hold max, smooth fall
        let pk = this._peaks[i] * pkRel;
        if (next > pk) pk = next;
        this._peaks[i] = pk;
      }
    }

    // Build proxy frame (no allocations)
    const fp = this._frameProxy;
    fp.frameId = frame && isFiniteNumber(frame.frameId) ? frame.frameId | 0 : frameIndex;
    fp.ts = frame && isFiniteNumber(frame.ts) ? frame.ts : 0;
    fp.tsMs = frame && isFiniteNumber(frame.tsMs) ? frame.tsMs : 0;

    fp.channels = frame && isFiniteNumber(frame.channels) ? frame.channels | 0 : 1;
    fp.rms = frame ? frame.rms : null;
    fp.peak = frame ? frame.peak : null;
    fp.corr = frame ? frame.corr : null;

    fp.bass = frame && isFiniteNumber(frame.bass) ? frame.bass : 0;
    fp.mid  = frame && isFiniteNumber(frame.mid) ? frame.mid : 0;
    fp.high = frame && isFiniteNumber(frame.high) ? frame.high : 0;

    // Energy drives ONLY bars/hats alpha in shader; keep it stable and bounded.
    const energyBars = logNorm(maxBar);
    fp.energy = clamp01(Math.max(energyIn, energyBars));

    fp.overlay = !!(frame && frame.overlay);
    fp.waveLR = null;

    fp.spectrum = this._bars || null; // bars
    fp.wave = this._peaks || null;    // peaks (repurpose u_waveTex)
    fp.gain = 1.0;                    // we already applied effGain into bars/peaks

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

    this.mp.render(fp, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
    this._bars = null;
    this._peaks = null;
  }
}
