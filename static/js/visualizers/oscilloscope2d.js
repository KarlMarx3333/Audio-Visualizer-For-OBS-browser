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

    // Cached gradient (recreated only when size changes)
    this._gradW = 0;
    this._grad = null;
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

    // Peak estimate (downsampled) for AGC.
    let peak = 1e-6;
    const n = wave.length;
    const scanStep = Math.max(1, Math.floor(n / 512));
    for (let i = 0; i < n; i += scanStep) {
      const a = Math.abs(wave[i]);
      if (a > peak) peak = a;
    }

    // Target amplitude so the wave fills the viewport but doesn't clip.
    const target = 0.80;
    const desired = Math.max(0.8, Math.min(3.0, target / peak));

    // AGC smoothing: fast attack, slower release.
    const atk = 1.0 - Math.exp(-dt * 18.0);
    const rel = 1.0 - Math.exp(-dt * 6.0);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;

    const g = userGain * this._agc;

    const mid = h * 0.5;
    const scale = h * 0.40;

    // Subtle center line (keeps orientation while still feeling "shader-y").
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = overlay ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(1, Math.floor(1 * this._dpr));
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.restore();

    // Downsample the polyline so it stays smooth and cheap at high sample counts.
    const pts = Math.min(1400, Math.max(500, Math.floor(w / 1.2)));
    const step = Math.max(1, Math.floor(n / pts));

    this._ensureGradient(w, overlay);

    // Use round joins/caps to remove "spiky" corners on fast signals.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Glow pass (additive)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.18 : 0.14;
    ctx.lineWidth = Math.max(3.0, 5.0 * this._dpr);
    ctx.beginPath();
    {
      let first = true;
      for (let i = 0; i < n; i += step) {
        const t = i / (n - 1);
        const x = t * w;
        const y = mid - wave[i] * g * scale;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();
    ctx.restore();

    // Core line
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = this._grad;
    ctx.globalAlpha = overlay ? 0.95 : 0.92;
    ctx.lineWidth = Math.max(1.4, 2.2 * this._dpr);
    ctx.beginPath();
    {
      let first = true;
      for (let i = 0; i < n; i += step) {
        const t = i / (n - 1);
        const x = t * w;
        const y = mid - wave[i] * g * scale;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  destroy() {}
}
