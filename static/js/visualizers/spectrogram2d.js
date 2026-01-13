function vivid(t){
  t = Math.max(0, Math.min(1, t));
  const r = Math.max(0, Math.min(1, 1.2*t - 0.1));
  const g = Math.max(0, Math.min(1, 1.2*(1-Math.abs(t-0.5)*2)));
  const b = Math.max(0, Math.min(1, 1.1*(1-t) - 0.05));
  return [Math.floor(r*255), Math.floor(g*255), Math.floor(b*255)];
}

export class Spectrogram2D {
  static id = "spectrogram";
  static name = "Waterfall Spectrogram";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;

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
    const spec = frame.spectrum;
    const gain = frame.gain;

    if(this.off.width !== spec.length){
      this.off.width = spec.length;
      this.off.height = this.specH;
      this._imageRow = this.octx.createImageData(this.off.width, 1);
    }

    this.octx.drawImage(this.off, 0, 1);

    const row = this._imageRow.data;
    for(let x=0;x<spec.length;x++){
      const mag = spec[x] * gain;
      const db = 20 * Math.log10(1e-6 + mag);
      const t = Math.max(0, Math.min(1, (db + 80) / 80));
      const [R,G,B] = vivid(t);
      const i = x*4;
      row[i] = R; row[i+1] = G; row[i+2] = B; row[i+3] = 255;
    }
    this.octx.putImageData(this._imageRow, 0, 0);

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
