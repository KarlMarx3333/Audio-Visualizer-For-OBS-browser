import { dtFromFrameOrNow } from "./timebase.js";

const TAU = Math.PI * 2;

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
  const wf = 1 / Math.sqrt(Math.max(20, hz));
  chroma[pc] += w * wp * wf;
}

function wrapAngle(a) {
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export class ChromaRing2D {
  static id = "chroma";
  static name = "Chromagram / Pitch-Class Ring";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;
    this._chroma = new Float32Array(12);
    this._chromaSm = new Float32Array(12);
    this._minHz = 80;
    this._maxHz = 6000;
    this._maxPeaks = 24;
    this._peakHz = new Float32Array(this._maxPeaks);
    this._peakW = new Float32Array(this._maxPeaks);
    this._peakCount = 0;
    this._detuneBins = 60;
    this._detuneHist = new Float32Array(this._detuneBins);
    this._detuneCents = 0;
    this._detuneTauSec = 2.0;
    this._chromaSmooth60 = 0.55; // legacy; replaced by attack/release below
    this._a4 = 440;
    this._sigma = 0.23;
    this._centsSm = 0;
    this._needleAng = 0;
    this._needleAlpha = 0;
    this._colors = new Array(12);
    this._glowColors = new Array(12);
    for (let i = 0; i < 12; i++) {
      const h = (i / 12) * 360;
      this._colors[i] = `hsl(${h}, 85%, 60%)`;
      this._glowColors[i] = `hsl(${h}, 90%, 62%)`;
    }
    this._lastNowMs = performance.now();

    // ---- Anti-flicker + stability controls ----
    // Peak filtering (kills 1-frame noise peaks)
    this._peakPromDb = 2.5;    // required dB prominence over neighbors
    this._peakPlateauDb = 1.0; // treat near-equal adjacent bins as one peak (pure sine can split across bins)
    this._peakWMin   = 0.06;   // ignore ultra-weak peaks

    // Activity gate (prevents silence normalization from exploding)
    this._activitySm = 0;
    this._gateOpen = false;
    this._gateOpenTh  = 0.10;  // open when smoothed activity exceeds this
    this._gateCloseTh = 0.06;  // close when smoothed activity falls below this
    this._activityTauSec = 0.12;

    // Smoothed normalization (reduces jitter on music)
    this._normMax = 1e-6;
    this._normRiseTauSec = 0.10;  // faster rise
    this._normFallTauSec = 0.50;  // slower fall

    // Wedge smoothing (attack fast, release slow)
    this._chromaAttack60  = 0.65; // @60fps: lower = faster attack
    this._chromaRelease60 = 0.95; // @60fps: higher = slower release
  }

  onResize(w,h,dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    const now = performance.now();
    let dt = dtFromFrameOrNow(frame, now, this);
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    // Short trails, overlay-safe.
    const fade60 = 0.85;
    const fadeAlpha = 1 - Math.pow(fade60, dt * 60.0);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = fadeAlpha;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const spec = frame.spectrum;
    const specLen = spec ? spec.length : 0;

    const gain = frame.gain || 1.0;
    const sr = frame.samplerate || 48000;
    const nfft = frame.fftSize || (specLen > 1 ? (specLen - 1) * 2 : 2048);
    const hzPerBin = sr / nfft;
    const k0 = Math.max(1, Math.floor(this._minHz / hzPerBin));
    const k1 = Math.min(specLen > 0 ? specLen - 1 : 0, Math.floor(this._maxHz / hzPerBin));

    this._chroma.fill(0);
    this._peakCount = 0;

    if (specLen > 3 && k1 > k0 + 2) {
      const threshDb = -75;
      const eps = 1e-12;
      for (let k = k0 + 1; k <= k1 - 1; k++) {
        const m0 = spec[k - 1] * gain;
        const m1 = spec[k] * gain;
        const m2 = spec[k + 1] * gain;
        if (m1 <= 0) continue;
        const y0 = 20 * Math.log10(m0 + eps);
        const y1 = 20 * Math.log10(m1 + eps);
        const y2 = 20 * Math.log10(m2 + eps);
        if (y1 <= y0 || y1 < y2 || y1 < threshDb) continue;

        // Prominence with plateau support: a pure tone can split across two adjacent bins,
        // making y1~y2 and naive prominence ~0. Treat that as a single peak and compare
        // against the outer neighbors instead.
        let prom;
        if (Math.abs(y1 - y2) <= this._peakPlateauDb && y2 >= threshDb) {
          // Compare against left neighbor and the next bin (if available).
          let y3 = threshDb - 200;
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
        if (prom < this._peakPromDb) continue;
        const delta = parabolicDelta(y0, y1, y2);
        const fPeak = (k + delta) * hzPerBin;
        const w = Math.pow(clamp01((y1 - threshDb) / 40), 0.9);
        if (w > this._peakWMin) {
          this._peakCount = insertPeakTopN(this._maxPeaks, this._peakHz, this._peakW, this._peakCount, fPeak, w);
        }
      }
    }

    let totalW = 0;
    if (this._peakCount > 0) {
      this._detuneHist.fill(0);
      for (let i = 0; i < this._peakCount; i++) {
        const f = this._peakHz[i];
        const w = this._peakW[i];
        const midi = midiFromHz(f, this._a4);
        const cents = centsToNearestSemitone(midi);
        const t = (cents + 50) / 100;
        let b = Math.floor(t * this._detuneBins);
        if (b < 0) b = 0;
        if (b >= this._detuneBins) b = this._detuneBins - 1;
        this._detuneHist[b] += w;
        totalW += w;
      }
    }

    // Activity metric + hysteresis gate:
    // Map totalW into ~[0..1] so thresholds are stable across content.
    // (totalW is sum of peak weights, each ~0..1, but peakCount is capped)
    const activity = clamp01(totalW / 6.0);
    const actAlpha = 1 - Math.exp(-dt / this._activityTauSec);
    this._activitySm += (activity - this._activitySm) * actAlpha;
    if (!this._gateOpen) {
      if (this._activitySm >= this._gateOpenTh) this._gateOpen = true;
    } else {
      if (this._activitySm <= this._gateCloseTh) this._gateOpen = false;
    }

    let detuneTarget = 0;
    // Only chase detune when the gate is open (avoids silence jitter).
    if (this._gateOpen && totalW > 1e-5) {
      let bestB = 0;
      let bestV = this._detuneHist[0];
      for (let b = 1; b < this._detuneBins; b++) {
        const v = this._detuneHist[b];
        if (v > bestV) {
          bestV = v;
          bestB = b;
        }
      }
      detuneTarget = ((bestB + 0.5) / this._detuneBins) * 100 - 50;
    }
    const detuneAlpha = 1 - Math.exp(-dt / this._detuneTauSec);
    this._detuneCents = this._detuneCents + (detuneTarget - this._detuneCents) * detuneAlpha;
    if (!Number.isFinite(this._detuneCents)) this._detuneCents = 0;
    if (this._detuneCents > 50) this._detuneCents = 50;
    if (this._detuneCents < -50) this._detuneCents = -50;

    for (let i = 0; i < this._peakCount; i++) {
      let hz = this._peakHz[i];
      let w = this._peakW[i];
      for (let d = 0; d < 3; d++) {
        if (hz < this._minHz) break;
        accumChromaFromHz(this._chroma, hz, w, this._a4, this._detuneCents, this._sigma);
        hz *= 0.5;
        w *= 0.5;
      }
    }

    let maxv = 0;
    let sumv = 0;
    for (let i = 0; i < 12; i++) {
      if (this._chroma[i] > maxv) maxv = this._chroma[i];
      sumv += this._chroma[i];
    }

    // If gate closed, force targets to 0 so tiny noise can’t normalize to 1.0.
    if (!this._gateOpen) {
      maxv = 0;
      sumv = 0;
    }

    // Smoothed normalization: reduces “max bin bouncing” jitter on music.
    // Track a smoothed max (fast rise, slow fall).
    const riseA = 1 - Math.exp(-dt / this._normRiseTauSec);
    const fallA = 1 - Math.exp(-dt / this._normFallTauSec);
    if (maxv > this._normMax) this._normMax += (maxv - this._normMax) * riseA;
    else this._normMax += (maxv - this._normMax) * fallA;
    if (!Number.isFinite(this._normMax) || this._normMax < 1e-6) this._normMax = 1e-6;

    // Wedge smoothing (attack/release)
    const aAtk = Math.pow(this._chromaAttack60, dt * 60.0);
    const aRel = Math.pow(this._chromaRelease60, dt * 60.0);
    const denom = this._normMax;
    for (let i = 0; i < 12; i++) {
      let v = denom > 0 ? (this._chroma[i] / denom) : 0;
      v = clamp01(v);
      v = Math.pow(v, 0.75);
      const cur = this._chromaSm[i];
      const a = (v > cur) ? aAtk : aRel;
      this._chromaSm[i] = a * cur + (1 - a) * v;
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const outerR = Math.min(w, h) * 0.46;
    const innerR = outerR * 0.18;
    const step = TAU / 12;
    const gap = step * 0.12;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(210,230,255,0.08)";
    ctx.lineWidth = Math.max(1, Math.floor(1.2 * this._dpr));
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, TAU);
    ctx.arc(cx, cy, innerR, 0, TAU);
    ctx.stroke();

    for(let i=0;i<12;i++){
      const ang = i * step - Math.PI / 2;
      const x0 = cx + Math.cos(ang) * innerR;
      const y0 = cy + Math.sin(ang) * innerR;
      const x1 = cx + Math.cos(ang) * outerR;
      const y1 = cy + Math.sin(ang) * outerR;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for(let i=0;i<12;i++){
      const v = this._chromaSm[i];
      if(v <= 0.001) continue;
      const r1 = innerR + v * (outerR - innerR) + outerR * 0.015;
      const start = i * step + gap * 0.5 - Math.PI / 2;
      const end = (i + 1) * step - gap * 0.5 - Math.PI / 2;
      ctx.fillStyle = this._glowColors[i];
      ctx.globalAlpha = 0.18 + 0.38 * v;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.arc(cx, cy, innerR, end, start, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    for(let i=0;i<12;i++){
      const v = this._chromaSm[i];
      if(v <= 0.001) continue;
      const r1 = innerR + v * (outerR - innerR);
      const start = i * step + gap * 0.5 - Math.PI / 2;
      const end = (i + 1) * step - gap * 0.5 - Math.PI / 2;
      ctx.fillStyle = this._colors[i];
      ctx.globalAlpha = 0.45 + 0.50 * v;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.arc(cx, cy, innerR, end, start, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    let dom = 0;
    let domV = this._chromaSm[0];
    for (let i = 1; i < 12; i++) {
      const v = this._chromaSm[i];
      if (v > domV) {
        domV = v;
        dom = i;
      }
    }

    const targetAng = dom * step - Math.PI / 2;
    const angDelta = wrapAngle(targetAng - this._needleAng);
    const angAlpha = 1 - Math.exp(-dt * 8.0);
    this._needleAng += angDelta * angAlpha;
    const needleTargetAlpha = clamp01(domV * 1.2);
    const needleAlpha = 1 - Math.exp(-dt * 6.0);
    this._needleAlpha += (needleTargetAlpha - this._needleAlpha) * needleAlpha;

    let centsTarget = 0;
    // Only show cents marker when gate open (prevents silence flicker).
    if (this._gateOpen && this._peakCount > 0) {
      const midi = midiFromHz(this._peakHz[0], this._a4) - this._detuneCents * 0.01;
      centsTarget = centsToNearestSemitone(midi);
    }
    const centsAlpha = 1 - Math.exp(-dt * 6.0);
    this._centsSm += (centsTarget - this._centsSm) * centsAlpha;
    if (!Number.isFinite(this._centsSm)) this._centsSm = 0;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, Math.floor(1.5 * this._dpr));
    ctx.globalAlpha = 0.25 + 0.65 * this._needleAlpha;
    const nx0 = cx + Math.cos(this._needleAng) * (innerR * 0.9);
    const ny0 = cy + Math.sin(this._needleAng) * (innerR * 0.9);
    const nx1 = cx + Math.cos(this._needleAng) * (outerR * 1.02);
    const ny1 = cy + Math.sin(this._needleAng) * (outerR * 1.02);
    ctx.beginPath();
    ctx.moveTo(nx0, ny0);
    ctx.lineTo(nx1, ny1);
    ctx.stroke();
    ctx.restore();

    if (this._needleAlpha > 0.1) {
      const centsClamp = Math.max(-45, Math.min(45, this._centsSm));
      const wedge = step - gap;
      const offset = (centsClamp / 100) * wedge * 0.7;
      const markerAng = targetAng + offset;
      const mr = innerR + (outerR - innerR) * 0.65;
      const mx = cx + Math.cos(markerAng) * mr;
      const my = cy + Math.sin(markerAng) * mr;
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.globalAlpha = 0.25 + 0.5 * this._needleAlpha;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(1.5, 2.2 * this._dpr), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  destroy(){}
}
