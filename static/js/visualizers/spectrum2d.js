export class Spectrum2D {
  static id = "spectrum";
  static name = "Spectrum Bars";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;
    this._lastNow = performance.now();
    this._gain = 1.0;

    this._bars = 0;
    this._targets = null;
    this._val = null;
    this._peak = null;
    this._hold = null;
    this._effBars = 0;
    this._effTargets = null;
    this._debugNext = 0;

    this._gradW = 0;
    this._grad = null;

    this._state = { w: 0, h: 0, dt: 1 / 60, bars: 0 };
  }

  onResize(w, h, dpr) {
    this._dpr = dpr || 1;
    this._gradW = 0;
    this._grad = null;
  }

  _ensureGradient(w) {
    if (this._grad && this._gradW === w) return;
    const g = this.ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0.0, "rgba(120,235,255,0.95)");
    g.addColorStop(0.5, "rgba(190,150,255,0.95)");
    g.addColorStop(1.0, "rgba(255,130,210,0.95)");
    this._grad = g;
    this._gradW = w;
  }

  _ensureBars(bars) {
    if (bars === this._bars) return;
    this._bars = bars;
    this._targets = new Float32Array(bars);
    this._val = new Float32Array(bars);
    this._peak = new Float32Array(bars);
    this._hold = new Float32Array(bars);
  }

  _ensureEffTargets(bars) {
    if (bars === this._effBars) return;
    this._effBars = bars;
    this._effTargets = new Float32Array(bars);
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  computeTargets(spec, sr, fftSize) {
    const bars = this._bars;
    const targets = this._targets;
    if (!targets) return null;
    if (!spec || !spec.length || bars === 0) {
      targets.fill(0);
      return targets;
    }

    const minHz = 40;
    const maxHz = 16000;
    const gain = this._gain;
    const nfft = fftSize || (spec.length - 1) * 2;

    const hzToBin = (hz) => {
      const bin = Math.floor((hz / sr) * nfft);
      return Math.max(0, Math.min(spec.length - 1, bin));
    };

    const binMin = hzToBin(minHz);
    const binMax = Math.max(binMin + 1, hzToBin(maxHz));
    const available = Math.max(1, binMax - binMin);
    const effBars = Math.min(bars, available);
    this._ensureEffTargets(effBars);

    const eff = this._effTargets;
    const logA = Math.log(binMin + 1);
    const logB = Math.log(binMax + 1);

    const dbFloor = -66.0;
    const dbRange = 66.0;
    const gamma = 0.6;
    let prevB1 = binMin;
    const pairs = [];

    for (let i = 0; i < effBars; i++) {
      const t0 = i / effBars;
      const t1 = (i + 1) / effBars;
      let b0 = Math.floor(Math.exp(logA + (logB - logA) * t0)) - 1;
      let b1 = Math.floor(Math.exp(logA + (logB - logA) * t1)) - 1;
      if (b0 < binMin) b0 = binMin;
      if (b0 > binMax - 1) b0 = binMax - 1;
      if (b1 < b0 + 1) b1 = b0 + 1;
      if (b1 > binMax) b1 = binMax;
      if (b0 < prevB1) b0 = prevB1;
      if (b1 <= b0) b1 = Math.min(binMax, b0 + 1);
      prevB1 = b1;

      let sumSq = 0;
      let max = 0;
      const n = b1 - b0;
      for (let k = b0; k < b1; k++) {
        const v = spec[k];
        sumSq += v * v;
        if (v > max) max = v;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, n));
      const tc = effBars > 1 ? i / (effBars - 1) : 0;
      let mag = (0.75 * rms + 0.25 * max) * gain;
      mag *= 0.85 + 0.35 * tc;

      const db = 20 * Math.log10(mag + 1e-9);
      let v = (db - dbFloor) / dbRange;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      v = Math.pow(v, gamma);
      eff[i] = v;
      if (pairs.length < 10) pairs.push([b0, b1]);
    }

    if (effBars === bars) {
      targets.set(eff);
    } else {
      const denom = Math.max(1, bars - 1);
      const effDenom = Math.max(1, effBars - 1);
      for (let i = 0; i < bars; i++) {
        const t = i / denom;
        const idx = t * effDenom;
        const i0 = idx | 0;
        const i1 = Math.min(effBars - 1, i0 + 1);
        const f = idx - i0;
        targets[i] = eff[i0] + (eff[i1] - eff[i0]) * f;
      }
    }

    if (typeof window !== "undefined" && window.DEBUG_SPECTRUM_BINS) {
      const now = performance.now();
      if (now >= this._debugNext) {
        this._debugNext = now + 5000;
        console.log("[spectrum2d] bins", {
          fftSize: nfft,
          specLen: spec.length,
          binMin,
          binMax,
          bars,
          effBars,
          pairs,
        });
      }
    }

    return targets;
  }

  updateState(targets, dt) {
    if (!targets) return;
    const val = this._val;
    const peak = this._peak;
    const hold = this._hold;
    const atkRate = 22.0;
    const relRate = 8.0;
    const peakHold = 0.14;
    const peakDecay = 0.9;
    const atk = 1 - Math.exp(-dt * atkRate);
    const rel = 1 - Math.exp(-dt * relRate);

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let v = val[i];
      if (t > v) {
        v += (t - v) * atk;
      } else {
        v += (t - v) * rel;
      }
      val[i] = v;

      let p = peak[i];
      let h = hold[i];
      if (v > p) {
        p = v;
        h = peakHold;
      } else if (h > 0) {
        h -= dt;
        if (h < 0) h = 0;
      } else {
        p = Math.max(v, p - peakDecay * dt);
      }
      peak[i] = p;
      hold[i] = h;
    }
  }

  draw(state, overlay) {
    const ctx = this.ctx;
    const w = state.w;
    const h = state.h;
    const dt = state.dt;
    const bars = state.bars;
    if (!bars) return;

    const baseFade = overlay ? 0.08 : 0.14;
    const fade = Math.max(0.03, Math.min(0.30, baseFade * (dt / (1 / 60))));
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    this._ensureGradient(w);

    // Minimal baseline.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = overlay ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = Math.max(1, Math.floor(1 * this._dpr));
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    ctx.restore();

    const val = this._val;
    const peak = this._peak;
    const barW = w / bars;
    const innerW = barW * 0.68;
    const pad = (barW - innerW) * 0.5;
    const maxH = h * 0.92;
    const radius = Math.max(1, Math.min(innerW * 0.4, h * 0.02));
    const glowPad = Math.max(1.0, 2.5 * this._dpr);

    // Glow pass.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.16 : 0.12;
    for (let i = 0; i < bars; i++) {
      const v = val[i];
      if (v <= 0.001) continue;
      const bh = v * maxH;
      const x = i * barW + pad;
      const y = h - bh;
      const gx = x - glowPad * 0.35;
      const gw = innerW + glowPad * 0.7;
      const gy = y - glowPad * 0.2;
      const gh = bh + glowPad * 0.2;
      this._roundRect(ctx, gx, gy, gw, gh, radius + glowPad * 0.5);
      ctx.fill();

      const capH = Math.max(2.0, 3.2 * this._dpr);
      const capW = innerW * 0.9;
      const capX = x + (innerW - capW) * 0.5;
      const capY = Math.max(0, h - peak[i] * maxH - capH * 0.5);
      this._roundRect(ctx, capX, capY, capW, capH, capH * 0.5);
      ctx.fill();
    }
    ctx.restore();

    // Core bars.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.90 : 0.86;
    for (let i = 0; i < bars; i++) {
      const v = val[i];
      if (v <= 0.001) continue;
      const bh = v * maxH;
      const x = i * barW + pad;
      const y = h - bh;
      this._roundRect(ctx, x, y, innerW, bh, radius);
      ctx.fill();
    }
    ctx.restore();

    // Highlight strip.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.globalAlpha = overlay ? 0.55 : 0.42;
    for (let i = 0; i < bars; i++) {
      const v = val[i];
      if (v <= 0.02) continue;
      const bh = v * maxH;
      const x = i * barW + pad;
      const y = h - bh;
      const hh = Math.max(1.0, Math.min(4.0 * this._dpr, bh * 0.18));
      const hx = x + innerW * 0.12;
      const hw = innerW * 0.76;
      this._roundRect(ctx, hx, y + hh * 0.15, hw, hh, hh * 0.6);
      ctx.fill();
    }
    ctx.restore();

    // Peak caps.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.95 : 0.92;
    for (let i = 0; i < bars; i++) {
      const p = peak[i];
      if (p <= 0.01) continue;
      const x = i * barW + pad;
      const capH = Math.max(2.0, 3.0 * this._dpr);
      const capW = innerW * 0.9;
      const capX = x + (innerW - capW) * 0.5;
      const capY = Math.max(0, h - p * maxH - capH * 0.5);
      this._roundRect(ctx, capX, capY, capW, capH, capH * 0.5);
      ctx.fill();
    }
    ctx.restore();

    // Chromatic edge offsets.
    const edgeOff = Math.max(1, Math.round(1 * this._dpr));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = overlay ? 0.22 : 0.16;
    ctx.lineWidth = Math.max(1.0, 1.2 * this._dpr);
    for (let i = 0; i < bars; i++) {
      const v = val[i];
      if (v <= 0.01) continue;
      const bh = v * maxH;
      const x = i * barW + pad;
      const y = h - bh;
      ctx.strokeStyle = "rgba(255,90,90,0.7)";
      this._roundRect(ctx, x + edgeOff, y, innerW, bh, radius);
      ctx.stroke();
      ctx.strokeStyle = "rgba(90,210,255,0.7)";
      this._roundRect(ctx, x - edgeOff, y, innerW, bh, radius);
      ctx.stroke();
    }
    ctx.restore();
  }

  onFrame(frame) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const overlay = !!frame.overlay;

    const now = performance.now();
    let dt = (now - this._lastNow) * 0.001;
    this._lastNow = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    const bars = Math.min(180, Math.max(96, Math.floor(w / 10)));
    this._ensureBars(bars);

    const spec = frame.spectrum;
    const sr = frame.samplerate || 48000;
    const specLen = spec && spec.length ? spec.length : 0;
    const nfft = frame.fftSize || (specLen > 1 ? (specLen - 1) * 2 : 2048);
    this._gain = frame.gain || 1.0;

    const targets = this.computeTargets(spec, sr, nfft);
    this.updateState(targets, dt);

    this._state.w = w;
    this._state.h = h;
    this._state.dt = dt;
    this._state.bars = bars;
    this.draw(this._state, overlay);
  }

  destroy() {}
}
