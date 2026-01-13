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
    this._counts = new Float32Array(12);
    this._smooth = 0.5;
    this._minHz = 80;
    this._maxHz = 6000;
  }

  onResize(w,h,dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0,0,w,h);

    const spec = frame.spectrum;
    if(!spec || spec.length === 0){
      return;
    }

    const gain = frame.gain || 1.0;
    const sr = frame.samplerate || 48000;
    const nfft = frame.fftSize || (spec.length - 1) * 2;
    const hzPerBin = sr / nfft;
    const k0 = Math.max(1, Math.floor(this._minHz / hzPerBin));
    const k1 = Math.min(spec.length - 1, Math.floor(this._maxHz / hzPerBin));

    this._chroma.fill(0);
    this._counts.fill(0);

    for(let k=k0;k<=k1;k++){
      const f = k * hzPerBin;
      const mag = spec[k] * gain;
      const db = 20 * Math.log10(1e-6 + mag);
      if(db < -70){
        continue;
      }
      let t = (db + 70) / 45;
      t = Math.max(0, Math.min(1, t));
      t = Math.pow(t, 0.75);

      const midi = 69 + 12 * Math.log2(f / 440);
      const n0 = Math.floor(midi);
      const frac = midi - n0;
      const pc0 = ((n0 % 12) + 12) % 12;
      const pc1 = (pc0 + 1) % 12;
      const contrib = t;
      this._chroma[pc0] += contrib * (1 - frac);
      this._chroma[pc1] += contrib * frac;
      this._counts[pc0] += (1 - frac);
      this._counts[pc1] += frac;
    }

    for(let i=0;i<12;i++){
      if(this._counts[i] > 0){
        this._chroma[i] = this._chroma[i] / this._counts[i];
      }else{
        this._chroma[i] = 0;
      }
    }

    let maxv = 0;
    for(let i=0;i<12;i++){
      if(this._chroma[i] > maxv){
        maxv = this._chroma[i];
      }
    }

    const a = this._smooth;
    for(let i=0;i<12;i++){
      let v = maxv > 0 ? (this._chroma[i] / maxv) : 0;
      v = Math.pow(v, 0.7);
      this._chromaSm[i] = a*this._chromaSm[i] + (1-a)*v;
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const outerR = Math.min(w, h) * 0.46;
    const innerR = outerR * 0.18;
    const step = (Math.PI * 2) / 12;
    const gap = step * 0.12;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = Math.max(1, Math.floor(1*this._dpr));
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
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
    ctx.fillStyle = "rgba(139,213,255,0.12)";
    for(let i=0;i<12;i++){
      const v = this._chromaSm[i];
      if(v <= 0){
        continue;
      }
      const r1 = innerR + v * (outerR - innerR);
      const start = i * step + gap * 0.5 - Math.PI / 2;
      const end = (i + 1) * step - gap * 0.5 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.arc(cx, cy, innerR, end, start, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(139,213,255,0.85)";
    for(let i=0;i<12;i++){
      const v = this._chromaSm[i];
      if(v <= 0){
        continue;
      }
      const r1 = innerR + v * (outerR - innerR);
      const start = i * step + gap * 0.5 - Math.PI / 2;
      const end = (i + 1) * step - gap * 0.5 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, start, end, false);
      ctx.arc(cx, cy, innerR, end, start, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  destroy(){}
}
