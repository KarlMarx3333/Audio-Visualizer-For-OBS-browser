function buildVividLUT() {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const r = Math.max(0, Math.min(1, 1.2 * t - 0.1));
    const g = Math.max(0, Math.min(1, 1.2 * (1 - Math.abs(t - 0.5) * 2)));
    const b = Math.max(0, Math.min(1, 1.1 * (1 - t) - 0.05));
    const o = i * 3;
    lut[o] = (r * 255) | 0;
    lut[o + 1] = (g * 255) | 0;
    lut[o + 2] = (b * 255) | 0;
  }
  return lut;
}

export class Spectrogram2D {
  static id = "spectrogram";
  static name = "Waterfall Spectrogram";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;

    this._lastNow = performance.now();
    this._scrollAcc = 0;
    this._rowsPerSec = 60;
    this._lut = buildVividLUT();

    this.specH = 512;
    this.off = document.createElement("canvas");
    this.off.width = 1024;
    this.off.height = this.specH;
    this.octx = this.off.getContext("2d", { willReadFrequently: true });

    this._imageRow = this.octx.createImageData(this.off.width, 1);
  }

  onResize(w,h,dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const w = this.canvas.width;
    const h = this.canvas.height;
    const spec = frame?.spectrum;
    const gain = frame?.gain || 1.0;

    const now = performance.now();
    let dt = (now - this._lastNow) * 0.001;
    this._lastNow = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    const hasSpec = !!(spec && spec.length);
    if (hasSpec) {
      if(this.off.width !== spec.length){
        this.off.width = spec.length;
        this.off.height = this.specH;
        this._imageRow = this.octx.createImageData(this.off.width, 1);
      }

      this._scrollAcc += dt * this._rowsPerSec;
      let rows = this._scrollAcc | 0;
      const maxRows = Math.max(0, this.off.height - 1);
      if (rows > maxRows) rows = maxRows;
      if (rows > 0) {
        this._scrollAcc -= rows;
        const offW = this.off.width;
        const offH = this.off.height;
        this.octx.drawImage(this.off, 0, 0, offW, offH - rows, 0, rows, offW, offH - rows);

        const row = this._imageRow.data;
        const lut = this._lut;
        for(let x=0;x<spec.length;x++){
          const mag = spec[x] * gain;
          const db = 20 * Math.log10(1e-6 + mag);
          const t = Math.max(0, Math.min(1, (db + 80) / 80));
          const idx = (t * 255) | 0;
          const li = idx * 3;
          const i = x * 4;
          row[i] = lut[li];
          row[i + 1] = lut[li + 1];
          row[i + 2] = lut[li + 2];
          row[i + 3] = 255;
        }
        for (let y = 0; y < rows; y++) {
          this.octx.putImageData(this._imageRow, 0, y);
        }
      }
    }

    const ctx = this.ctx;
    ctx.clearRect(0,0,w,h);

    ctx.save();
    ctx.translate(0, h);
    ctx.scale(1, -1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, 0, 0, w, h);
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = Math.max(1, Math.floor(1*this._dpr));
    ctx.beginPath();
    ctx.moveTo(0, h*0.25); ctx.lineTo(w, h*0.25);
    ctx.moveTo(0, h*0.50); ctx.lineTo(w, h*0.50);
    ctx.moveTo(0, h*0.75); ctx.lineTo(w, h*0.75);
    ctx.stroke();
  }

  destroy(){}
}
