export class SafeCanvas2D {
  static id = "safe_canvas2d";
  static name = "Safe Mode (Canvas2D)";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext("2d", { alpha: true }) : null;
    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._bg = "rgba(8, 12, 18, 0.9)";
    this._bgOverlay = "rgba(0, 0, 0, 0)";
    this._waveColor = "rgba(120, 220, 255, 0.95)";
    this._barColor = "rgba(140, 255, 210, 0.65)";
    this._label = "SAFE MODE";
    this._labelFont = "12px sans-serif";
  }

  onResize(w, h, dpr) {
    if (!this.canvas || !this.ctx) return;
    const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const cssW = Math.max(2, Math.floor(w || 0));
    const cssH = Math.max(2, Math.floor(h || 0));
    const bw = Math.max(2, Math.floor(cssW * scale));
    const bh = Math.max(2, Math.floor(cssH * scale));
    this._dpr = scale;
    this._cssW = cssW;
    this._cssH = cssH;
    this.canvas.width = bw;
    this.canvas.height = bh;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
  }

  onFrame(frame) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const dpr = this._dpr || 1;
    const w = this._cssW || Math.max(2, Math.floor(canvas.width / dpr));
    const h = this._cssH || Math.max(2, Math.floor(canvas.height / dpr));
    if (!(w > 0 && h > 0)) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = (frame && frame.overlay) ? this._bgOverlay : this._bg;
    ctx.fillRect(0, 0, w, h);

    const spectrum = frame && frame.spectrum;
    if (spectrum && spectrum.length) {
      const n = spectrum.length | 0;
      const maxBars = 48;
      const bars = n < maxBars ? n : maxBars;
      const barW = w / Math.max(1, bars);
      const baseY = h * 0.92;
      const maxH = h * 0.35;
      ctx.fillStyle = this._barColor;
      for (let i = 0; i < bars; i++) {
        const idx = (i * n / bars) | 0;
        const v = spectrum[idx];
        const mag = Number.isFinite(v) ? v : 0;
        const clamped = mag < 0 ? 0 : (mag > 1 ? 1 : mag);
        const bh = clamped * maxH;
        const x = i * barW;
        ctx.fillRect(x, baseY - bh, barW * 0.85, bh);
      }
    }

    const wave = frame && frame.wave;
    if (wave && wave.length > 1) {
      const n = wave.length | 0;
      const maxPoints = 1024;
      const step = Math.max(1, Math.floor(n / maxPoints));
      const count = Math.max(2, Math.ceil(n / step));
      const dx = w / (count - 1);
      const mid = h * 0.36;
      const amp = h * 0.25;
      ctx.strokeStyle = this._waveColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let x = 0;
      let j = 0;
      for (let i = 0; i < n; i += step) {
        const v = wave[i];
        const y = mid - (Number.isFinite(v) ? v : 0) * amp;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        j++;
        x = j * dx;
        if (j >= count) break;
      }
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
    ctx.font = this._labelFont;
    ctx.textBaseline = "top";
    ctx.fillText(this._label, 8, 8);
  }

  destroy() {
    // Safe mode is side-effect free.
  }
}
