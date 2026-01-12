export class Spectrum2D {
  static id = "spectrum";
  static name = "Spectrum Bars";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;
  }

  onResize(w, h, dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0,0,w,h);

    const spec = frame.spectrum;
    const gain = frame.gain;

    const bars = Math.min(120, Math.max(40, Math.floor(w / 16)));
    const minHz = 40;
    const maxHz = 16000;
    const sr = frame.samplerate || 48000;
    const nfft = frame.fftSize || (spec.length - 1) * 2;

    const hzToBin = (hz)=>{
      const bin = Math.floor((hz / sr) * nfft);
      return Math.max(0, Math.min(spec.length-1, bin));
    };

    const logMin = Math.log(minHz);
    const logMax = Math.log(maxHz);
    const barW = w / bars;

    ctx.fillStyle = "rgba(139,213,255,0.85)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = Math.max(1, Math.floor(1 * this._dpr));

    for(let i=0;i<bars;i++){
      const t0 = i / bars;
      const t1 = (i+1) / bars;
      const hz0 = Math.exp(logMin + (logMax - logMin)*t0);
      const hz1 = Math.exp(logMin + (logMax - logMin)*t1);
      const b0 = hzToBin(hz0);
      const b1 = Math.max(b0+1, hzToBin(hz1));

      let sum = 0;
      const n = b1 - b0;
      for(let k=b0;k<b1;k++) sum += spec[k];
      const mag = (sum / n) * gain;

      const db = 20 * Math.log10(1e-6 + mag);
      const norm = (db + 60) / 60;
      const v = Math.max(0, Math.min(1, norm));

      const x = i * barW;
      const bh = v * (h*0.92);
      ctx.fillRect(x + barW*0.15, h - bh, barW*0.7, bh);
    }

    ctx.beginPath();
    ctx.moveTo(0, h-1);
    ctx.lineTo(w, h-1);
    ctx.stroke();
  }

  destroy(){}
}
