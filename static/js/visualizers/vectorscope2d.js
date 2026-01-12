export class Vectorscope2D {
  static id = "vectorscope";
  static name = "Stereo Vectorscope / Goniometer";
  static renderer = "2d";

  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this._dpr = 1;
    this._fade = 0.10;
    this._pseudoDelay = 12;
    const qs = new URLSearchParams(location.search);
    this._pseudo = qs.get("pseudo") === "1";
  }

  onResize(w,h,dpr){
    this._dpr = dpr || 1;
  }

  onFrame(frame){
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${this._fade})`;
    ctx.fillRect(0,0,w,h);
    ctx.restore();

    const ch = frame.channels || 1;
    const inter = frame.waveLR;
    const mono = frame.wave;
    const corr = frame.corr;
    let n = 0;

    const userGain = frame.gain || 1.0;
    let peak = 1e-6;
    const useStereo = (ch === 2 && inter);
    const usePseudo = (!useStereo && this._pseudo && mono);
    if(useStereo){
      n = Math.floor(inter.length / 2);
      const step = Math.max(1, Math.floor(n / 512));
      for(let i=0;i<n;i+=step){
        const L = inter[2*i];
        const R = inter[2*i + 1];
        peak = Math.max(peak, Math.abs(L), Math.abs(R));
      }
    }else if(mono){
      n = mono.length;
      const step = Math.max(1, Math.floor(n / 512));
      for(let i=0;i<n;i+=step){
        peak = Math.max(peak, Math.abs(mono[i]));
      }
    }
    const auto = Math.min(3.0, Math.max(0.9, 0.75 / peak));
    const g = userGain * auto;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const scale = Math.min(w, h) * 0.46;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = Math.max(1, Math.floor(1*this._dpr));
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.restore();

    if(n <= 0){
      return;
    }

    const pts = 1024;
    const step = Math.max(1, Math.floor(n / pts));
    const pseudoDelay = Math.min(this._pseudoDelay, Math.max(1, n - 1));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = Math.max(2.5, 3.5*this._dpr);
    ctx.strokeStyle = "rgba(139,213,255,0.12)";
    ctx.beginPath();
    let first = true;
    for(let i=0;i<n;i+=step){
      let L, R;
      if(useStereo){
        const base = 2*i;
        L = inter[base] * g;
        R = inter[base+1] * g;
      }else if(usePseudo){
        const j = i + pseudoDelay;
        const idx = j < n ? j : j - n;
        L = mono[i] * g;
        R = mono[idx] * g;
      }else{
        const v = (mono ? mono[i] : 0) * g;
        L = v; R = v;
      }
      const x = cx + L * scale;
      const y = cy - R * scale;
      if(first){ ctx.moveTo(x,y); first = false; }
      else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = Math.max(1.2, 1.8*this._dpr);
    ctx.strokeStyle = "rgba(139,213,255,0.85)";
    ctx.beginPath();
    first = true;
    for(let i=0;i<n;i+=step){
      let L, R;
      if(useStereo){
        const base = 2*i;
        L = inter[base] * g;
        R = inter[base+1] * g;
      }else if(usePseudo){
        const j = i + pseudoDelay;
        const idx = j < n ? j : j - n;
        L = mono[i] * g;
        R = mono[idx] * g;
      }else{
        const v = (mono ? mono[i] : 0) * g;
        L = v; R = v;
      }
      const x = cx + L * scale;
      const y = cy - R * scale;
      if(first){ ctx.moveTo(x,y); first = false; }
      else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.restore();

    const showHint = ((ch < 2 || !inter) && !usePseudo) || (corr != null && corr > 0.98);
    if(showHint){
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = `${Math.max(10, Math.floor(11*this._dpr))}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText("MONO / CORR>=0.98 - use stereo input for blob", 8, 8);
      ctx.restore();
    }
  }

  destroy(){}
}
