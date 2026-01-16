export class Oscilloscope2D {
  static id = "oscilloscope";
  static name = "Oscilloscope";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;

    // Auto-gain to keep the waveform readable across loud/quiet sources.
    this._agc = 1.0;
    this._lastNow = performance.now();
    this._energy = 0;
    this._prevEnergy = 0;
    this._kick = 0;

    // Cached gradient (recreated only when size changes)
    this._gradW = 0;
    this._grad = null;
    this._gradOverlay = false;

    // Preallocated buffers for points/normals/rails.
    this._ptsCap = 0;
    this._px = null;
    this._py = null;
    this._amp = null;
    this._nx = null;
    this._ny = null;
    this._lx = null;
    this._ly = null;
    this._rx = null;
    this._ry = null;
  }

  onResize(w, h, dpr) {
    this._dpr = dpr || 1;
    // Force gradient rebuild on next frame.
    this._gradW = 0;
    this._grad = null;
  }

  _ensureGradient(w, overlay) {
    if (this._grad && this._gradW === w && this._gradOverlay === overlay) return;
    const g = this.ctx.createLinearGradient(0, 0, w, 0);
    // Slight multi-hue "neon" without being rainbow-confetti.
    if (overlay) {
      g.addColorStop(0.0, "rgba(139,213,255,0.95)");
      g.addColorStop(0.5, "rgba(200,160,255,0.95)");
      g.addColorStop(1.0, "rgba(255,170,210,0.95)");
    } else {
      g.addColorStop(0.0, "rgba(139,213,255,0.92)");
      g.addColorStop(0.5, "rgba(200,160,255,0.92)");
      g.addColorStop(1.0, "rgba(255,170,210,0.92)");
    }
    this._grad = g;
    this._gradW = w;
    this._gradOverlay = overlay;
  }

  _ensureBuffers(count) {
    if (count <= this._ptsCap) return;
    this._ptsCap = count;
    this._px = new Float32Array(count);
    this._py = new Float32Array(count);
    this._amp = new Float32Array(count);
    this._nx = new Float32Array(count);
    this._ny = new Float32Array(count);
    this._lx = new Float32Array(count);
    this._ly = new Float32Array(count);
    this._rx = new Float32Array(count);
    this._ry = new Float32Array(count);
  }

  _buildTubePath(count, offX, offY) {
    const ctx = this.ctx;
    const lx = this._lx;
    const ly = this._ly;
    const rx = this._rx;
    const ry = this._ry;
    ctx.beginPath();
    ctx.moveTo(lx[0] + offX, ly[0] + offY);
    for (let i = 1; i < count; i++) {
      ctx.lineTo(lx[i] + offX, ly[i] + offY);
    }
    for (let i = count - 1; i >= 0; i--) {
      ctx.lineTo(rx[i] + offX, ry[i] + offY);
    }
    ctx.closePath();
  }

  onFrame(frame) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const overlay = !!frame.overlay;

    // dt for FPS-independent fade + AGC.
    const now = performance.now();
    let dt = (now - this._lastNow) * 0.001;
    this._lastNow = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    // Gentle persistence trails (transparent-overlay friendly).
    // Scale fade by dt so OBS (30fps) and browsers (60/144) look similar.
    const baseFade = overlay ? 0.09 : 0.12;
    const fade = Math.max(0.03, Math.min(0.25, baseFade * (dt / (1 / 60))));
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const wave = frame.wave;
    if (!wave || wave.length < 2) return;

    const userGain = frame.gain || 1.0;

    // Peak/RMS estimate (downsampled) for AGC + energy/kick.
    let ampLevel = Number(frame.peak);
    if (!Number.isFinite(ampLevel)) {
      const rmsIn = Number(frame.rms);
      if (Number.isFinite(rmsIn)) ampLevel = rmsIn * 2.0;
    }
    let scanPeak = 1e-6;
    let sumSq = 0;
    let count = 0;
    const n = wave.length;
    const scanStep = Math.max(1, Math.floor(n / 512));
    for (let i = 0; i < n; i += scanStep) {
      const v = wave[i];
      const a = Math.abs(v);
      if (a > scanPeak) scanPeak = a;
      sumSq += v * v;
      count++;
    }
    if (!Number.isFinite(ampLevel)) ampLevel = scanPeak;
    ampLevel = Math.max(ampLevel, 1e-4);

    // Target amplitude so the wave fills the viewport but doesn't clip.
    const target = 0.80;
    const minGain = 0.35;
    const maxGain = 3.0;
    const desired = Math.max(minGain, Math.min(maxGain, target / (ampLevel * userGain)));

    // AGC smoothing: fast attack, slower release.
    const atk = 1.0 - Math.exp(-dt * 18.0);
    const rel = 1.0 - Math.exp(-dt * 6.0);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;

    const rms = Math.sqrt(sumSq / Math.max(1, count));
    const energyRaw = Math.min(1, rms * 2.0);
    const eSmooth = 1.0 - Math.exp(-dt * 8.0);
    this._energy += (energyRaw - this._energy) * eSmooth;

    const db = Math.max(0, this._energy - this._prevEnergy);
    this._prevEnergy = this._energy;
    const kickDecay = 6.0;
    this._kick *= Math.exp(-dt * kickDecay);
    this._kick = Math.max(this._kick, Math.min(1, db * 6.0));

    const g = userGain * this._agc;

    const mid = h * 0.5;
    const scale = h * 0.40;

    // Downsample points so it stays smooth and cheap at high sample counts.
    const ptsTarget = Math.min(1400, Math.max(500, Math.floor(w / 1.1)));
    const step = Math.max(1, Math.floor(n / ptsTarget));
    const countEst = Math.floor((n - 1) / step) + 2;
    this._ensureBuffers(countEst);

    const px = this._px;
    const py = this._py;
    const ampArr = this._amp;
    let pts = 0;
    const invN = 1 / (n - 1);
    for (let i = 0; i < n; i += step) {
      const t = i * invN;
      const x = t * w;
      const y = mid - wave[i] * g * scale;
      px[pts] = x;
      py[pts] = y;
      ampArr[pts] = Math.abs(wave[i]);
      pts++;
    }
    if ((n - 1) % step !== 0) {
      const i = n - 1;
      const x = w;
      const y = mid - wave[i] * g * scale;
      px[pts] = x;
      py[pts] = y;
      ampArr[pts] = Math.abs(wave[i]);
      pts++;
    }
    if (pts < 2) return;

    const nx = this._nx;
    const ny = this._ny;
    const lx = this._lx;
    const ly = this._ly;
    const rx = this._rx;
    const ry = this._ry;

    const thBase = 1.4 * this._dpr;
    const thKick = 6.0 * this._dpr;
    const thEnergy = 2.2 * this._dpr;
    const thMin = 1.0 * this._dpr;
    const thMax = 12.0 * this._dpr;
    const thCore = thBase + this._kick * thKick + this._energy * thEnergy;
    const thClamp = Math.max(thMin, Math.min(thMax, thCore));

    for (let i = 0; i < pts; i++) {
      const i0 = i === 0 ? 0 : i - 1;
      const i1 = i === pts - 1 ? pts - 1 : i + 1;
      const dx = px[i1] - px[i0];
      const dy = py[i1] - py[i0];
      const inv = 1 / Math.max(1e-6, Math.hypot(dx, dy));
      const nnx = -dy * inv;
      const nny = dx * inv;
      nx[i] = nnx;
      ny[i] = nny;
      const mod = 0.85 + 0.35 * ampArr[i];
      const th = thClamp * mod;
      lx[i] = px[i] + nnx * th;
      ly[i] = py[i] + nny * th;
      rx[i] = px[i] - nnx * th;
      ry[i] = py[i] - nny * th;
    }

    this._ensureGradient(w, overlay);

    // Tube fill
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.90 : 0.85;
    this._buildTubePath(pts, 0, 0);
    ctx.fill();
    ctx.restore();

    // Outer glow
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.12 : 0.10;
    ctx.lineWidth = Math.max(2.0, thClamp * 0.8);
    this._buildTubePath(pts, 0, 0);
    ctx.stroke();
    ctx.restore();

    // Chromatic edges
    const edgeOff = Math.max(1, Math.round(1 * this._dpr));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = overlay ? 0.24 : 0.18;
    ctx.lineWidth = Math.max(1.0, 1.2 * this._dpr);
    ctx.strokeStyle = "rgba(255,90,90,0.7)";
    this._buildTubePath(pts, edgeOff, 0);
    ctx.stroke();
    ctx.strokeStyle = "rgba(90,210,255,0.7)";
    this._buildTubePath(pts, -edgeOff, 0);
    ctx.stroke();
    ctx.restore();
  }

  destroy() {}
}
