export class Oscilloscope2D {
  static id = "oscilloscope";
  static name = "Oscilloscope";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;
  }

  onResize(w,h,dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0,0,w,h);

    const wave = frame.wave;
    const gain = frame.gain;

    const mid = h/2;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(1, Math.floor(1*this._dpr));
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    const n = wave.length;

    ctx.lineWidth = Math.max(1.2, 1.8 * this._dpr);
    ctx.strokeStyle = "rgba(139,213,255,0.18)";
    ctx.beginPath();
    for(let i=0;i<n;i++){
      const t = i/(n-1);
      const x = t * w;
      const y = mid - (wave[i] * gain) * (h*0.38);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(139,213,255,0.92)";
    ctx.beginPath();
    for(let i=0;i<n;i++){
      const t = i/(n-1);
      const x = t * w;
      const y = mid - (wave[i] * gain) * (h*0.38);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  destroy(){}
}
