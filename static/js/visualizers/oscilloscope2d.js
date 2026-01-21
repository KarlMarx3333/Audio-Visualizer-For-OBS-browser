const BG_COLOR = "rgb(8, 12, 18)";
const BAR_COLOR = "rgb(140, 255, 210)";
const WAVE_GLOW = "rgb(90, 210, 255)";
const WAVE_EDGE_R = "rgb(255, 90, 110)";
const WAVE_EDGE_B = "rgb(80, 130, 255)";
const LABEL_COLOR = "rgba(255, 255, 255, 0.85)";

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function scalar0(v) {
  if (Number.isFinite(v)) return v;
  if (v && typeof v.length === "number") {
    const x = v[0];
    return Number.isFinite(x) ? x : NaN;
  }
  return NaN;
}

export class Oscilloscope2D {
  static id = "safe_canvas2d";
  static name = "Safe Mode Oscilloscope (Canvas2D)";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext("2d", { alpha: true }) : null;
    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._lastNowMs = 0;
    this._agc = 1.0;
    this._energy = 0.0;
    this._prevEnergy = 0.0;
    this._kick = 0.0;
    this._grad = null;
    this._gradW = 0;
    this._gradOverlay = false;
    this._barIdx = null;
    this._barCount = 0;
    this._barSpecLen = 0;
    this._label = "SAFE MODE";
    this._label2 = "OSCILLOSCOPE2D";
    this._labelFont = "12px sans-serif";
    this._labelFontSmall = "10px sans-serif";
    this._debug = false;
    if (typeof window !== "undefined") {
      const qs = new URLSearchParams(window.location.search || "");
      this._debug = qs.get("debug") === "1";
    }
    if (this.ctx) {
      this.ctx.lineJoin = "round";
      this.ctx.lineCap = "round";
    }
  }

  onResize(w, h, dpr) {
    if (Number.isFinite(dpr) && dpr > 0) this._dpr = dpr;
    if (Number.isFinite(w) && w > 0) this._cssW = w;
    if (Number.isFinite(h) && h > 0) this._cssH = h;
    this._grad = null;
    this._gradW = 0;
    this._barIdx = null;
    this._barCount = 0;
    this._barSpecLen = 0;
  }

  _buildGradient(ctx, w, overlay) {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    if (overlay) {
      g.addColorStop(0.0, "rgba(90, 220, 255, 0.75)");
      g.addColorStop(0.5, "rgba(130, 255, 220, 0.95)");
      g.addColorStop(1.0, "rgba(90, 160, 255, 0.85)");
    } else {
      g.addColorStop(0.0, "rgba(70, 190, 255, 0.75)");
      g.addColorStop(0.5, "rgba(120, 240, 210, 0.95)");
      g.addColorStop(1.0, "rgba(80, 140, 255, 0.85)");
    }
    this._grad = g;
    this._gradW = w;
    this._gradOverlay = overlay;
  }

  _ensureBarIdx(count, specLen) {
    if (!(count > 0 && specLen > 0)) {
      this._barIdx = null;
      this._barCount = 0;
      this._barSpecLen = 0;
      return;
    }
    if (this._barIdx && this._barCount === count && this._barSpecLen === specLen) return;
    this._barIdx = new Uint16Array(count);
    this._barCount = count;
    this._barSpecLen = specLen;
    for (let i = 0; i < count; i++) {
      this._barIdx[i] = (i * specLen / count) | 0;
    }
  }

  _strokeWave(ctx, wave, step, count, dx, mid, amp, offsetX) {
    const n = wave.length | 0;
    let x = offsetX;
    let j = 0;
    ctx.beginPath();
    for (let i = 0; i < n; i += step) {
      const v = wave[i];
      const y = mid - (Number.isFinite(v) ? v : 0) * amp;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      j++;
      if (j >= count) break;
      x = j * dx + offsetX;
    }
    ctx.stroke();
  }

  onFrame(frame) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const f = frame || null;

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
    this._cssW = cssW;
    this._cssH = cssH;

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

    // Overlay-safe trails using dt-scaled destination-out fade.
    const baseFade60 = overlay ? 0.09 : 0.12;
    let fadeAlpha = baseFade60 * (dt * 60);
    if (fadeAlpha < 0.03) fadeAlpha = 0.03;
    else if (fadeAlpha > 0.25) fadeAlpha = 0.25;

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = fadeAlpha;
    ctx.fillStyle = "rgb(0, 0, 0)";
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

    const wave = f && f.wave ? f.wave : null;
    const spectrum = f && f.spectrum ? f.spectrum : null;

    const peak0 = scalar0(f && f.peak);
    const rms0 = scalar0(f && f.rms);

    let scanPeak = 0;
    let sumSq = 0;
    let count = 0;
    if (wave && wave.length > 0) {
      const n = wave.length | 0;
      const step = Math.max(1, Math.floor(n / 512));
      for (let i = 0; i < n; i += step) {
        const v = wave[i];
        const fv = Number.isFinite(v) ? v : 0;
        const av = fv < 0 ? -fv : fv;
        if (av > scanPeak) scanPeak = av;
        sumSq += fv * fv;
        count++;
      }
    }

    let ampLevel = Number.isFinite(peak0) ? peak0 : (Number.isFinite(rms0) ? (rms0 * 2) : scanPeak);
    if (!(ampLevel > 0)) ampLevel = 1e-4;

    let userGain = (f && Number.isFinite(f.gain)) ? f.gain : 1;
    if (!(userGain > 0)) userGain = 1;

    // Slow AGC keeps visuals in-range without exploding in silence.
    const target = 0.8;
    let desired = target / (ampLevel * userGain);
    if (desired < 0.35) desired = 0.35;
    else if (desired > 3.0) desired = 3.0;

    const atk = 1 - Math.exp(-dt * 18);
    const rel = 1 - Math.exp(-dt * 6);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;
    if (this._agc < 0.35) this._agc = 0.35;
    else if (this._agc > 3.0) this._agc = 3.0;

    let rmsScan = count > 0 ? Math.sqrt(sumSq / count) : 0;
    let energyRaw = rmsScan * 2.0;
    if (f && Number.isFinite(f.energy)) energyRaw = 0.5 * energyRaw + 0.5 * f.energy;
    energyRaw = clamp01(energyRaw);

    const eSmooth = 1 - Math.exp(-dt * 8);
    this._energy += (energyRaw - this._energy) * eSmooth;

    let db = this._energy - this._prevEnergy;
    if (db < 0) db = 0;
    this._prevEnergy = this._energy;
    this._kick *= Math.exp(-dt * 6);
    let kick = db * 6;
    if (kick > this._kick) this._kick = kick;
    if (this._kick > 1) this._kick = 1;

    const energy = this._energy;
    const kickLevel = this._kick;
    const g = userGain * this._agc;

    if (this._debug && spectrum && spectrum.length > 0) {
      const specLen = spectrum.length | 0;
      let bars = Math.floor(cssW / 14);
      if (bars < 24) bars = 24;
      else if (bars > 96) bars = 96;
      if (bars > specLen) bars = specLen;

      if (bars > 0) {
        this._ensureBarIdx(bars, specLen);
        const barIdx = this._barIdx;
        const barW = cssW / bars;
        const baseY = cssH * 0.92;
        let maxH = cssH * 0.28;
        maxH *= (0.75 + 0.6 * energy);
        const alpha = 0.45 * (0.6 + 0.8 * kickLevel);
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = alpha;
        ctx.fillStyle = BAR_COLOR;
        for (let i = 0; i < bars; i++) {
          const idx = barIdx ? barIdx[i] : ((i * specLen / bars) | 0);
          const v = spectrum[idx];
          let mag = Number.isFinite(v) ? v : 0;
          if (mag < 0) mag = 0;
          else if (mag > 1) mag = 1;
          mag = Math.sqrt(mag);
          const bh = mag * maxH;
          const x = i * barW;
          ctx.fillRect(x, baseY - bh, barW * 0.82, bh);
        }
        ctx.restore();
      }
    }

    if (wave && wave.length > 1) {
      const n = wave.length | 0;
      let ptsTarget = Math.floor(cssW / 1.1);
      if (ptsTarget < 500) ptsTarget = 500;
      else if (ptsTarget > 1400) ptsTarget = 1400;
      let step = Math.floor(n / ptsTarget);
      if (step < 1) step = 1;
      let count = Math.ceil(n / step);
      if (count < 2) count = 2;
      const dx = cssW / (count - 1);
      let amp = cssH * (0.22 + 0.18 * energy);
      amp *= g;
      const maxAmp = cssH * 0.45;
      if (amp > maxAmp) amp = maxAmp;
      const minAmp = cssH * 0.08;
      if (amp < minAmp) amp = minAmp;
      const mid = cssH * 0.44;

      const gradW = Math.max(2, Math.floor(cssW));
      if (this._gradW !== gradW || this._gradOverlay !== overlay || !this._grad) {
        this._buildGradient(ctx, gradW, overlay);
      }

      const glowAlpha = 0.18 + 0.18 * energy;
      const coreAlpha = 0.62 + 0.25 * energy;
      const edgeAlpha = 0.12 + 0.18 * energy;
      let thCore = 1.4 + 6.0 * kickLevel + 2.2 * energy;
      if (thCore < 1.0) thCore = 1.0;
      else if (thCore > 12.0) thCore = 12.0;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = glowAlpha;
      ctx.lineWidth = thCore * 1.6;
      ctx.strokeStyle = WAVE_GLOW;
      this._strokeWave(ctx, wave, step, count, dx, mid, amp, 0);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = edgeAlpha;
      ctx.lineWidth = thCore * 0.6;
      ctx.strokeStyle = WAVE_EDGE_R;
      this._strokeWave(ctx, wave, step, count, dx, mid, amp, 1);
      ctx.strokeStyle = WAVE_EDGE_B;
      this._strokeWave(ctx, wave, step, count, dx, mid, amp, -1);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = coreAlpha;
      ctx.lineWidth = thCore;
      ctx.strokeStyle = this._grad || "rgb(120, 220, 255)";
      this._strokeWave(ctx, wave, step, count, dx, mid, amp, 0);
      ctx.restore();
    }

    if (this._debug) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = this._labelFont;
      ctx.textBaseline = "top";
      ctx.fillText(this._label, 8, 8);
      ctx.font = this._labelFontSmall;
      ctx.globalAlpha = 0.6;
      ctx.fillText(this._label2, 8, 22);
      ctx.restore();
    }
  }

  destroy() {
    // Safe mode is side-effect free.
  }
}
