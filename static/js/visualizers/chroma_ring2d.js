// Chroma Ring (Canvas2D) — v0.2
//
// Key tweak constants (sane defaults):
//   MIN_HZ / MAX_HZ           : pitch tracking band
//   FADE60_OVERLAY / FADE60_BG: trail persistence (dt-correct). Higher = longer trails.
//   ACT_OPEN / ACT_CLOSE      : activity gate hysteresis (silence -> fully transparent)
//   NORM_RISE_TAU / NORM_FALL_TAU: smoothed normalization stability
//   ATTACK60_* / RELEASE60_*  : wedge smoothing (dt-correct, adaptive)
//   ENERGY_ON / ENERGY_OFF    : brightness gate hysteresis
//   OUTER_R_FRAC / INNER_R_FRAC: ring geometry

const TAU = Math.PI * 2;

const MIN_HZ = 80;
const MAX_HZ = 6000;

const MAX_PEAKS = 24;
const DETUNE_BINS = 60;
const A4_HZ = 440;
const SIGMA = 0.23;

const PEAK_PROM_DB = 2.5;
const PEAK_PLATEAU_DB = 1.0;
const PEAK_W_MIN = 0.06;
const THRESH_DB = -75;

const ACT_OPEN = 0.03;
const ACT_CLOSE = 0.015;
const ACT_TAU = 0.12;

const DETUNE_TAU_SEC = 2.0;

const NORM_RISE_TAU = 0.10;
const NORM_FALL_TAU = 0.50;

const ATTACK60_FAST = 0.82;
const RELEASE60_FAST = 0.93;
const ATTACK60_SLOW = 0.97;
const RELEASE60_SLOW = 0.985;

const FADE60_OVERLAY = 0.885;
const FADE60_BG = 0.915;

const ENERGY_ON = 0.045;
const ENERGY_OFF = 0.012;

const OUTER_R_FRAC = 0.46;
const INNER_R_FRAC = 0.18;
const GAP_FRAC = 0.12;

const GRID_ALPHA_MAX = 0.26;
const WEDGE_IDLE = 0.045;
const WEDGE_ALPHA_IDLE = 0.9;

const BG_COLOR = "rgb(8, 10, 18)";
const BLACK = "rgb(0, 0, 0)";

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function maxAbsArray(arr) {
  if (!arr || !arr.length) return 0;
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Math.abs(arr[i]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function parabolicDelta(y1, y2, y3) {
  const denom = (y1 - 2 * y2 + y3);
  if (Math.abs(denom) < 1e-12) return 0;
  return 0.5 * (y1 - y3) / denom;
}

function midiFromHz(f, a4) {
  return 69 + 12 * Math.log2(f / a4);
}

function centsToNearestSemitone(midi) {
  return 100 * (midi - Math.round(midi));
}

function wrapAngle(a) {
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

function insertPeakTopN(maxPeaks, peakHz, peakW, count, hz, w) {
  let i = count;
  if (i < maxPeaks) {
    peakHz[i] = hz;
    peakW[i] = w;
    count++;
  } else if (w <= peakW[maxPeaks - 1]) {
    return count;
  } else {
    peakHz[maxPeaks - 1] = hz;
    peakW[maxPeaks - 1] = w;
    i = maxPeaks - 1;
  }
  while (i > 0 && peakW[i] > peakW[i - 1]) {
    const tw = peakW[i]; peakW[i] = peakW[i - 1]; peakW[i - 1] = tw;
    const th = peakHz[i]; peakHz[i] = peakHz[i - 1]; peakHz[i - 1] = th;
    i--;
  }
  return count;
}

function accumChromaFromHz(chroma, hz, w, a4, detuneCents, sigma) {
  const midi = midiFromHz(hz, a4) - detuneCents * 0.01;
  const mRound = Math.round(midi);
  const x = midi - mRound;
  const inv = 1 / (sigma + 1e-9);
  const wp = Math.exp(-0.5 * (x * inv) * (x * inv));
  const pc = ((mRound % 12) + 12) % 12;
  // Mild HF de-emphasis so highs don't dominate chroma visually.
  const wf = 1 / Math.sqrt(Math.max(20, hz));
  chroma[pc] += w * wp * wf;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rgbStr(r, g, b) {
  return `rgb(${r|0}, ${g|0}, ${b|0})`;
}

function lerpRGB(c0, c1, t, out) {
  out[0] = lerp(c0[0], c1[0], t);
  out[1] = lerp(c0[1], c1[1], t);
  out[2] = lerp(c0[2], c1[2], t);
}

export class ChromaRing2D {
  static id = "chroma_ring";
  static name = "Chroma Ring / Pitch Classes (Canvas2D)";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext("2d", { alpha: true }) : null;

    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._lastNowMs = 0;

    // Pitch/chroma state
    this._chroma = new Float32Array(12);
    this._chromaSm = new Float32Array(12);
    this._peakHz = new Float32Array(MAX_PEAKS);
    this._peakW = new Float32Array(MAX_PEAKS);
    this._peakCount = 0;

    this._detuneHist = new Float32Array(DETUNE_BINS);
    this._detuneCents = 0;
    this._normMax = 1e-6;

    // Activity gate (silence stability)
    this._activitySm = 0;
    this._gateOpen = false;

    // Draw mode hysteresis (low energy = strokes, high energy = filled wedges)
    this._fillMode = false;

    // Smoothed controls
    this._bass = 0;
    this._mid = 0;
    this._high = 0;
    this._energy = 0;
    this._energyGate = 0;

    // Needle
    this._needleAng = 0;
    this._needleAlpha = 0;
    this._centsSm = 0;

    // Precompute wedge angles + tick vectors
    this._step = TAU / 12;
    this._gap = this._step * GAP_FRAC;
    this._wStart = new Float32Array(12);
    this._wEnd = new Float32Array(12);
    this._tickCos = new Float32Array(12);
    this._tickSin = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      const start = i * this._step + this._gap * 0.5 - Math.PI / 2;
      const end = (i + 1) * this._step - this._gap * 0.5 - Math.PI / 2;
      const mid = i * this._step - Math.PI / 2;
      this._wStart[i] = start;
      this._wEnd[i] = end;
      this._tickCos[i] = Math.cos(mid);
      this._tickSin[i] = Math.sin(mid);
    }

    // palette (controlled)
    this._colors = new Array(12);
    this._glowColors = new Array(12);
    this._strokeColors = new Array(12);
    this._buildPalette();

    // Cached reticle/grid
    this._grid = null;
    this._gridCtx = null;
    if (typeof document !== "undefined") {
      this._grid = document.createElement("canvas");
      this._gridCtx = this._grid.getContext("2d", { alpha: true });
    }

    if (this.ctx) {
      this.ctx.lineJoin = "round";
      this.ctx.lineCap = "round";
    }
  }

  _buildPalette() {
    const A = [80, 255, 0];  // laser green
    const B = [0, 120, 255]; // neon blue
    const C = [255, 0, 40];  // neon red
    const tmp = [0, 0, 0];

    for (let i = 0; i < 12; i++) {
      // t in [0..1)
      const t = i / 12;
      // piecewise: 0..1/3 A->B, 1/3..2/3 B->C, 2/3..1 C->A
      let r, g, b;
      if (t < 1 / 3) {
        const u = t * 3;
        lerpRGB(A, B, u, tmp);
      } else if (t < 2 / 3) {
        const u = (t - 1 / 3) * 3;
        lerpRGB(B, C, u, tmp);
      } else {
        const u = (t - 2 / 3) * 3;
        lerpRGB(C, A, u, tmp);
      }
      r = tmp[0]; g = tmp[1]; b = tmp[2];

      // Core fill is slightly brighter, glow is slightly softer.
      const core = [clamp(r * 1.00, 0, 255), clamp(g * 1.00, 0, 255), clamp(b * 1.00, 0, 255)];
      const glow = [clamp(r * 0.92, 0, 255), clamp(g * 0.92, 0, 255), clamp(b * 0.92, 0, 255)];
      const stroke = [clamp(r * 0.85 + 20, 0, 255), clamp(g * 0.85 + 20, 0, 255), clamp(b * 0.85 + 20, 0, 255)];

      this._colors[i] = rgbStr(core[0], core[1], core[2]);
      this._glowColors[i] = rgbStr(glow[0], glow[1], glow[2]);
      this._strokeColors[i] = rgbStr(stroke[0], stroke[1], stroke[2]);
    }
  }

  onResize(w, h, dpr) {
    if (Number.isFinite(dpr) && dpr > 0) this._dpr = dpr;
    if (Number.isFinite(w) && w > 0) this._cssW = w;
    if (Number.isFinite(h) && h > 0) this._cssH = h;
    this._rebuildGrid();
  }

  _rebuildGrid() {
    if (!this._grid || !this._gridCtx) return;

    const w = this._cssW | 0;
    const h = this._cssH | 0;
    if (!(w > 1 && h > 1)) return;

    this._grid.width = w;
    this._grid.height = h;

    const gctx = this._gridCtx;
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const outerR = Math.min(w, h) * OUTER_R_FRAC;
    const innerR = outerR * INNER_R_FRAC;

    // Reticle: subtle circles + diamond + tick marks.
    const lineW = Math.max(1, Math.floor(1.2 * this._dpr));
    gctx.lineJoin = "round";
    gctx.lineCap = "round";

    gctx.save();
    gctx.globalCompositeOperation = "source-over";

    // Outer/inner circles
    gctx.strokeStyle = "rgba(210, 230, 255, 0.10)";
    gctx.lineWidth = lineW;
    gctx.beginPath();
    gctx.arc(cx, cy, outerR, 0, TAU);
    gctx.arc(cx, cy, innerR, 0, TAU);
    gctx.stroke();

    // Mid circle
    gctx.strokeStyle = "rgba(190, 200, 255, 0.08)";
    gctx.lineWidth = Math.max(1, Math.floor(1.0 * this._dpr));
    gctx.beginPath();
    gctx.arc(cx, cy, innerR + (outerR - innerR) * 0.62, 0, TAU);
    gctx.stroke();

    // Axes cross
    gctx.strokeStyle = "rgba(230, 240, 255, 0.08)";
    gctx.lineWidth = Math.max(1, Math.floor(1.0 * this._dpr));
    gctx.beginPath();
    gctx.moveTo(cx - outerR, cy);
    gctx.lineTo(cx + outerR, cy);
    gctx.moveTo(cx, cy - outerR);
    gctx.lineTo(cx, cy + outerR);
    gctx.stroke();

    // Diamond (45° square)
    const dr = outerR * 0.78;
    gctx.strokeStyle = "rgba(220, 210, 255, 0.07)";
    gctx.lineWidth = Math.max(1, Math.floor(1.0 * this._dpr));
    gctx.beginPath();
    gctx.moveTo(cx, cy - dr);
    gctx.lineTo(cx + dr, cy);
    gctx.lineTo(cx, cy + dr);
    gctx.lineTo(cx - dr, cy);
    gctx.closePath();
    gctx.stroke();

    // 12 tick lines
    gctx.strokeStyle = "rgba(210, 230, 255, 0.08)";
    gctx.lineWidth = Math.max(1, Math.floor(1.0 * this._dpr));
    for (let i = 0; i < 12; i++) {
      const c = this._tickCos[i];
      const s = this._tickSin[i];
      const x0 = cx + c * innerR;
      const y0 = cy + s * innerR;
      const x1 = cx + c * outerR;
      const y1 = cy + s * outerR;
      gctx.beginPath();
      gctx.moveTo(x0, y0);
      gctx.lineTo(x1, y1);
      gctx.stroke();
    }

    // Center dot
    gctx.fillStyle = "rgba(255, 255, 255, 0.10)";
    gctx.beginPath();
    gctx.arc(cx, cy, Math.max(1.2, 1.8 * this._dpr), 0, TAU);
    gctx.fill();

    gctx.restore();
  }

  onFrame(frame) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const f = frame || null;

    // Resolve DPR + CSS sizing like other v0.2 Canvas2D visualizers.
    let dpr = (f && Number.isFinite(f.dpr) && f.dpr > 0) ? f.dpr : this._dpr;
    if (!(dpr > 0)) {
      const deviceDpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      dpr = deviceDpr > 0 ? deviceDpr : 1;
    }
    this._dpr = dpr;

    const backingW = canvas.width | 0;
    const backingH = canvas.height | 0;
    const cssW = backingW / dpr;
    const cssH = backingH / dpr;
    if (!(cssW > 1 && cssH > 1)) return;

    if (cssW !== this._cssW || cssH !== this._cssH) {
      this._cssW = cssW;
      this._cssH = cssH;
      this._rebuildGrid();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let dt = (f && Number.isFinite(f.dt)) ? f.dt : 0;
    if (!(dt > 0)) {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const last = this._lastNowMs;
      this._lastNowMs = now;
      dt = Number.isFinite(last) && last > 0 ? (now - last) * 0.001 : (1 / 60);
    }
    dt = clamp(dt, 0, 0.1);

    const overlay = !!(f && f.overlay);

    // Smoothed audio controls (dt-correct)
    const sFast = 1 - Math.exp(-dt * 10);
    const sMed = 1 - Math.exp(-dt * 6);
    const bass = clamp01(f && Number.isFinite(f.bass) ? f.bass : 0);
    const mid = clamp01(f && Number.isFinite(f.mid) ? f.mid : 0);
    const high = clamp01(f && Number.isFinite(f.high) ? f.high : 0);
    const energyRaw0 = clamp01(f && Number.isFinite(f.energy) ? f.energy : 0);
    const energySpec = energyRaw0;
    const gain = (f && Number.isFinite(f.gain) && f.gain > 0) ? f.gain : 1.0;
    const rms = maxAbsArray(f && f.rms);
    const peakAmp = maxAbsArray(f && f.peak);
    const energyFallback = clamp01(Math.pow(Math.max(rms * 6.0, peakAmp * 1.4) * gain, 1.2));
    const energyRaw = clamp01(Math.max(energySpec, energyFallback));

    this._bass += (bass - this._bass) * sMed;
    this._mid += (mid - this._mid) * sMed;
    this._high += (high - this._high) * sMed;
    this._energy += (energyRaw - this._energy) * sFast;

    // Energy gate hysteresis (prevents "ghost UI" on silence)
    const gateTarget = smoothstep01((this._energy - ENERGY_OFF) / (ENERGY_ON - ENERGY_OFF));
    const gateCurved = gateTarget * (0.4 + 0.6 * gateTarget);
    this._energyGate += (gateCurved - this._energyGate) * (1 - Math.exp(-dt * 7));
    this._energyGate = clamp01(this._energyGate);

    // Overlay-safe trails: dt-scaled destination-out fade.
    let fade60 = overlay ? FADE60_OVERLAY : FADE60_BG;
    // Bass slightly increases persistence.
    fade60 = clamp(fade60 + 0.06 * this._bass, 0.84, 0.96);
    let fadeAlpha = 1 - Math.pow(fade60, dt * 60.0);
    fadeAlpha = clamp(fadeAlpha, 0.02, 0.30);

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = fadeAlpha;
    ctx.fillStyle = BLACK;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();

    if (!overlay) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
    }

    // --- Compute chroma from spectral peaks (stable + low CPU) ---
    const spec = (f && f.spectrum && f.spectrum.length) ? f.spectrum : null;
    const specLen = spec ? (spec.length | 0) : 0;

    this._chroma.fill(0);
    this._peakCount = 0;

    const sr = (f && Number.isFinite(f.samplerate) && f.samplerate > 0) ? f.samplerate : 48000;
    const nfft = (f && Number.isFinite(f.fftSize) && f.fftSize > 0)
      ? f.fftSize
      : (specLen > 1 ? (specLen - 1) * 2 : 2048);

    const hzPerBin = sr / nfft;
    const k0 = Math.max(1, Math.floor(MIN_HZ / hzPerBin));
    const k1 = Math.min(specLen > 0 ? specLen - 2 : 0, Math.floor(MAX_HZ / hzPerBin));

    if (specLen > 3 && k1 > k0 + 2) {
      const eps = 1e-12;
      for (let k = k0 + 1; k <= k1 - 1; k++) {
        const m0 = spec[k - 1] * gain;
        const m1 = spec[k] * gain;
        const m2 = spec[k + 1] * gain;
        if (!(m1 > 0)) continue;

        const y0 = 20 * Math.log10(m0 + eps);
        const y1 = 20 * Math.log10(m1 + eps);
        const y2 = 20 * Math.log10(m2 + eps);

        if (y1 <= y0 || y1 < y2 || y1 < THRESH_DB) continue;

        // Prominence with plateau support (pure sine can split across bins).
        let prom;
        if (Math.abs(y1 - y2) <= PEAK_PLATEAU_DB && y2 >= THRESH_DB) {
          let y3 = THRESH_DB - 200;
          if (k + 2 <= k1) {
            const m3 = spec[k + 2] * gain;
            y3 = 20 * Math.log10(m3 + eps);
          }
          const ref = (y0 > y3 ? y0 : y3);
          const ypk = (y1 > y2 ? y1 : y2);
          prom = ypk - ref;
        } else {
          prom = y1 - (y0 > y2 ? y0 : y2);
        }
        if (prom < PEAK_PROM_DB) continue;

        const delta = parabolicDelta(y0, y1, y2);
        const fPeak = (k + delta) * hzPerBin;

        // Weight (compressed): keep stable, ignore ultra-weak peaks.
        const w = Math.pow(clamp01((y1 - THRESH_DB) / 40), 0.90);
        if (w > PEAK_W_MIN) {
          this._peakCount = insertPeakTopN(MAX_PEAKS, this._peakHz, this._peakW, this._peakCount, fPeak, w);
        }
      }
    }

    // Activity metric + hysteresis gate.
    let totalW = 0;
    if (this._peakCount > 0) {
      this._detuneHist.fill(0);
      for (let i = 0; i < this._peakCount; i++) {
        const hz = this._peakHz[i];
        const w = this._peakW[i];
        const midi = midiFromHz(hz, A4_HZ);
        const cents = centsToNearestSemitone(midi);
        const t = (cents + 50) / 100;
        let b = Math.floor(t * DETUNE_BINS);
        if (b < 0) b = 0;
        else if (b >= DETUNE_BINS) b = DETUNE_BINS - 1;
        this._detuneHist[b] += w;
        totalW += w;
      }
    }

    const activity = clamp01(Math.max(totalW / 6.0, energyRaw * 1.6));
    const actA = 1 - Math.exp(-dt / ACT_TAU);
    this._activitySm += (activity - this._activitySm) * actA;

    if (!this._gateOpen) {
      if (this._activitySm >= ACT_OPEN) this._gateOpen = true;
    } else {
      if (this._activitySm <= ACT_CLOSE) this._gateOpen = false;
    }

    // Detune tracking (only when gate open)
    let detuneTarget = 0;
    if (this._gateOpen && totalW > 1e-5) {
      let bestB = 0;
      let bestV = this._detuneHist[0];
      for (let b = 1; b < DETUNE_BINS; b++) {
        const v = this._detuneHist[b];
        if (v > bestV) {
          bestV = v;
          bestB = b;
        }
      }
      detuneTarget = ((bestB + 0.5) / DETUNE_BINS) * 100 - 50;
    }
    const detA = 1 - Math.exp(-dt / DETUNE_TAU_SEC);
    this._detuneCents += (detuneTarget - this._detuneCents) * detA;
    if (!Number.isFinite(this._detuneCents)) this._detuneCents = 0;
    this._detuneCents = clamp(this._detuneCents, -50, 50);

    // Accumulate chroma from peaks (and a few lower octaves).
    if (this._gateOpen && this._peakCount > 0) {
      for (let i = 0; i < this._peakCount; i++) {
        let hz = this._peakHz[i];
        let w = this._peakW[i];
        for (let d = 0; d < 3; d++) {
          if (hz < MIN_HZ) break;
          accumChromaFromHz(this._chroma, hz, w, A4_HZ, this._detuneCents, SIGMA);
          hz *= 0.5;
          w *= 0.5;
        }
      }
    }
    if (this._gateOpen && this._peakCount === 0 && spec && specLen > 8 && energyRaw > 0.01) {
      const stride = Math.max(1, Math.floor((k1 - k0) / 140));
      const energyRef = Math.max(0.015, energySpec);
      const quiet = clamp01((energySpec - 0.008) / 0.08);
      const wScale = 0.12 + 0.88 * quiet;
      for (let k = k0; k <= k1; k += stride) {
        const m = spec[k] * gain;
        if (!(m > 0)) continue;
        const w = Math.pow(clamp01(m / (energyRef * 16.0)), 0.9) * wScale;
        if (w <= 0.001) continue;
        accumChromaFromHz(this._chroma, k * hzPerBin, w, A4_HZ, this._detuneCents, SIGMA);
      }
    }

    let maxv = 0;
    for (let i = 0; i < 12; i++) {
      const v = this._chroma[i];
      if (v > maxv) maxv = v;
    }

    // Smoothed normalization: fast rise, slow fall.
    if (!this._gateOpen) maxv = 0;
    const riseA = 1 - Math.exp(-dt / NORM_RISE_TAU);
    const fallA = 1 - Math.exp(-dt / NORM_FALL_TAU);
    if (maxv > this._normMax) this._normMax += (maxv - this._normMax) * riseA;
    else this._normMax += (maxv - this._normMax) * fallA;
    if (!Number.isFinite(this._normMax) || this._normMax < 1e-6) this._normMax = 1e-6;

    // Wedge smoothing (attack/release) with adaptive speed.
    const denom = this._normMax;
    for (let i = 0; i < 12; i++) {
      let v = denom > 0 ? (this._chroma[i] / denom) : 0;
      v = clamp01(v);
      // Gentle shaping: keeps a readable base without crushing mids.
      v = Math.pow(v, 0.78);
      const cur = this._chromaSm[i];
      const delta = Math.abs(v - cur);
      const speed = clamp01(delta * 2.2);
      const atk60 = lerp(ATTACK60_SLOW, ATTACK60_FAST, speed);
      const rel60 = lerp(RELEASE60_SLOW, RELEASE60_FAST, speed);
      const a = (v > cur) ? Math.pow(atk60, dt * 60.0) : Math.pow(rel60, dt * 60.0);
      this._chromaSm[i] = a * cur + (1 - a) * v;
    }

    // Decide draw mode (fill vs stroke) using energy gate.
    if (!this._fillMode) {
      if (this._energyGate > 0.55) this._fillMode = true;
    } else {
      if (this._energyGate < 0.35) this._fillMode = false;
    }

    // --- Draw ---
    const cx = cssW * 0.5;
    const cy = cssH * 0.5;
    const outerR = Math.min(cssW, cssH) * OUTER_R_FRAC;
    const innerR = outerR * INNER_R_FRAC;

    // Grid (cached) — visible only when there's energy.
    if (this._grid && this._energyGate > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = clamp01(this._energyGate) * GRID_ALPHA_MAX;
      ctx.drawImage(this._grid, 0, 0, cssW, cssH);
      ctx.restore();
    }

    const shimmer = clamp01(this._high * 1.25);
    const thick = 1.0 + 2.6 * this._mid;
    const lineWCore = Math.max(1, Math.floor(thick * this._dpr));
    const lineWGlow = Math.max(1, Math.floor((thick * 2.2) * this._dpr));
    const energyAlpha = Math.max(this._energyGate, WEDGE_ALPHA_IDLE);
    const idleV = (this._energyGate < 0.02 && !this._gateOpen) ? WEDGE_IDLE : 0;

    // Glow pass (controlled additive)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const glowBase = 0.10 + 0.12 * shimmer;
    for (let i = 0; i < 12; i++) {
      const v = Math.max(this._chromaSm[i], idleV);
      if (v <= 0.002) continue;
      const r1 = innerR + v * (outerR - innerR) + outerR * 0.014;
      const start = this._wStart[i];
      const end = this._wEnd[i];

      ctx.fillStyle = this._glowColors[i];
      ctx.globalAlpha = (glowBase + 0.32 * v) * energyAlpha;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.arc(cx, cy, innerR, end, start, true);
      ctx.closePath();
      ctx.fill();

      // Crisp outer stroke for readability.
      ctx.strokeStyle = this._strokeColors[i];
      ctx.globalAlpha = (0.10 + 0.22 * v) * energyAlpha;
      ctx.lineWidth = lineWGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.stroke();
    }
    ctx.restore();

    if (this._fillMode) {
      // Core filled wedges
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < 12; i++) {
        const v = Math.max(this._chromaSm[i], idleV);
        if (v <= 0.002) continue;
        const r1 = innerR + v * (outerR - innerR);
        const start = this._wStart[i];
        const end = this._wEnd[i];

        ctx.fillStyle = this._colors[i];
        ctx.globalAlpha = (0.18 + 0.70 * v) * energyAlpha;
        ctx.beginPath();
        ctx.arc(cx, cy, r1, start, end, false);
        ctx.arc(cx, cy, innerR, end, start, true);
        ctx.closePath();
        ctx.fill();

        // Thin inner edge adds definition.
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.globalAlpha = (0.20 + 0.35 * v) * energyAlpha;
        ctx.lineWidth = lineWCore;
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, start, end, false);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // Low-energy mode: stroke-only arcs (cleaner, less blocky)
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < 12; i++) {
        const v = Math.max(this._chromaSm[i], idleV);
        if (v <= 0.002) continue;
        const r = innerR + v * (outerR - innerR);
        const start = this._wStart[i];
        const end = this._wEnd[i];

        ctx.strokeStyle = this._colors[i];
        ctx.globalAlpha = (0.18 + 0.62 * v) * energyAlpha;
        ctx.lineWidth = lineWCore;
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, end, false);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Dominant pitch class needle + cents marker (minimal HUD) ---
    let dom = 0;
    let domV = this._chromaSm[0];
    for (let i = 1; i < 12; i++) {
      const v = this._chromaSm[i];
      if (v > domV) {
        domV = v;
        dom = i;
      }
    }

    const targetAng = dom * this._step - Math.PI / 2;
    const angDelta = wrapAngle(targetAng - this._needleAng);
    const angA = 1 - Math.exp(-dt * 8.0);
    this._needleAng += angDelta * angA;

    const needleTargetAlpha = clamp01(domV * 1.25) * this._energyGate;
    const needleA = 1 - Math.exp(-dt * 6.0);
    this._needleAlpha += (needleTargetAlpha - this._needleAlpha) * needleA;

    let centsTarget = 0;
    if (this._gateOpen && this._peakCount > 0) {
      const midi = midiFromHz(this._peakHz[0], A4_HZ) - this._detuneCents * 0.01;
      centsTarget = centsToNearestSemitone(midi);
    }
    const centsA = 1 - Math.exp(-dt * 6.0);
    this._centsSm += (centsTarget - this._centsSm) * centsA;
    if (!Number.isFinite(this._centsSm)) this._centsSm = 0;

    if (this._needleAlpha > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = Math.max(1, Math.floor(1.5 * this._dpr));
      ctx.globalAlpha = 0.10 + 0.85 * this._needleAlpha;
      const nx0 = cx + Math.cos(this._needleAng) * (innerR * 0.92);
      const ny0 = cy + Math.sin(this._needleAng) * (innerR * 0.92);
      const nx1 = cx + Math.cos(this._needleAng) * (outerR * 1.03);
      const ny1 = cy + Math.sin(this._needleAng) * (outerR * 1.03);
      ctx.beginPath();
      ctx.moveTo(nx0, ny0);
      ctx.lineTo(nx1, ny1);
      ctx.stroke();
      ctx.restore();

      // Cents marker dot (only when needle visible)
      if (this._needleAlpha > 0.12) {
        const centsClamp = clamp(this._centsSm, -45, 45);
        const wedge = this._step - this._gap;
        const offset = (centsClamp / 100) * wedge * 0.7;
        const markerAng = targetAng + offset;
        const mr = innerR + (outerR - innerR) * 0.68;
        const mx = cx + Math.cos(markerAng) * mr;
        const my = cy + Math.sin(markerAng) * mr;
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.globalAlpha = 0.10 + 0.65 * this._needleAlpha;
        ctx.beginPath();
        ctx.arc(mx, my, Math.max(1.4, 2.1 * this._dpr), 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  destroy() {}
}
