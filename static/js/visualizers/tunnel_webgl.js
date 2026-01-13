import { createGL, createProgram, createFullscreenQuad } from "/static/js/webgl/util.js";

export class TunnelWarpWebGL {
  static id = "tunnel";
  static name = "Tunnel / Warp Speed (WebGL)";
  static renderer = "webgl";

  constructor(canvas){
    this.canvas = canvas;
    this.gl = createGL(canvas);

    const vs = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fs = `
      precision mediump float;
      varying vec2 v_uv;

      uniform vec2  u_res;
      uniform float u_time;
      uniform float u_energy;
      uniform float u_bass;
      uniform float u_mid;
      uniform float u_treble;

      float hash(vec2 p){
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      vec3 palette(float t){
        vec3 a = vec3(0.10, 0.10, 0.18);
        vec3 b = vec3(0.55, 0.85, 1.00);
        vec3 c = vec3(0.90, 0.35, 0.95);
        vec3 d = vec3(0.10, 0.55, 0.85);
        return a + b*cos(6.28318*(d*t + c));
      }

      float band(float x, float w){
        float d = abs(fract(x) - 0.5) * 2.0;
        return 1.0 - smoothstep(w, 1.0, d);
      }

      void main(){
        float aspect = u_res.x / max(u_res.y, 1.0);

        vec2 p = v_uv * 2.0 - 1.0;
        p.x *= aspect;

        float r = length(p);
        float a = atan(p.y, p.x);
        float tau = 6.28318530718;

        float speed = 0.55 + 2.6*u_bass + 0.6*u_energy;
        float z = u_time * speed;

        float inv = 1.0 / (r + 0.28);
        float depth = clamp(inv * 0.55, 0.0, 6.0);

        float twist = 0.35*sin(u_time*0.35) + 0.65*u_treble + 0.25*u_mid;
        a += twist * depth * 0.12;

        float u = fract(a / tau);
        float v = z*0.18 + depth*1.25;

        u += 0.035*sin(v*0.7 + u_time*0.7) + 0.025*sin(u_time*0.6 + u_mid*3.0);
        v += 0.12*sin(u*12.0 + u_time*0.3) * (0.15 + 0.85*u_bass);

        float rings  = band(v*1.25, 0.18);
        float spokes = band(u*24.0 + v*0.08, 0.24);
        float streak = pow(band(u*70.0 + v*0.12, 0.10), 2.0);

        vec2 sp = vec2(u*85.0, v*22.0);
        vec2 id = floor(sp);
        vec2 gv = fract(sp) - 0.5;
        float rnd = hash(id);
        float star = smoothstep(0.06, 0.0, length(gv));
        star *= smoothstep(0.92, 0.995, rnd);
        star *= (0.25 + 0.75*u_treble);

        float tunnelMask = smoothstep(1.35, 0.05, r);

        float inten =
          (rings*0.85 + spokes*0.75 + streak*1.25 + star*1.10)
          * (0.35 + 1.80*u_energy)
          * (0.55 + 0.28*depth);

        float centerGlow = exp(-r*r*3.0) * (0.10 + 0.70*u_energy);

        vec3 base = palette(v*0.08 + u_time*0.06 + u*0.9);
        vec3 col = base * inten;

        col += vec3(0.25, 0.85, 1.0) * streak * (0.10 + 0.60*u_treble);
        col += vec3(1.0, 0.25, 0.85) * rings * (0.06 + 0.28*u_bass);
        col += base * centerGlow;

        float n = (hash(v_uv*u_res + u_time*10.0) - 0.5) * 0.04 * (0.20 + 0.80*u_treble);
        col += vec3(n);

        col = col / (1.0 + col);

        float vig = smoothstep(1.60, 0.08, r);
        float alpha = clamp((inten*0.85 + centerGlow*0.55) * tunnelMask, 0.0, 1.0);
        alpha *= vig;

        gl_FragColor = vec4(col, alpha);
      }
    `;

    this.program = createProgram(this.gl, vs, fs);
    this.vb = createFullscreenQuad(this.gl);

    const gl = this.gl;
    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.uRes = gl.getUniformLocation(this.program, "u_res");
    this.uTime = gl.getUniformLocation(this.program, "u_time");
    this.uEnergy = gl.getUniformLocation(this.program, "u_energy");
    this.uBass = gl.getUniformLocation(this.program, "u_bass");
    this.uMid = gl.getUniformLocation(this.program, "u_mid");
    this.uTreble = gl.getUniformLocation(this.program, "u_treble");

    this._t0 = performance.now();
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
  }

  onResize(){
    this.gl.viewport(0,0,this.canvas.width,this.canvas.height);
  }

  _bandHz(spec, hz0, hz1, sr, nfft){
    if(!spec || spec.length === 0) return 0;
    const hzPerBin = sr / nfft;
    let b0 = Math.floor(hz0 / hzPerBin);
    let b1 = Math.floor(hz1 / hzPerBin);
    b0 = Math.max(1, Math.min(spec.length - 1, b0));
    b1 = Math.max(b0 + 1, Math.min(spec.length, b1));
    let sum = 0;
    for(let i=b0;i<b1;i++) sum += spec[i];
    return sum / (b1 - b0);
  }

  onFrame(frame){
    const gl = this.gl;
    const spec = frame.spectrum;

    const sr = frame.samplerate || 48000;
    const nfft = frame.fftSize || ((spec?.length ? (spec.length - 1) * 2 : 2048));
    const gain = frame.gain || 1.0;

    const rms = (frame.rms && frame.rms[0]) ? frame.rms[0] : 0;

    const bassRaw = this._bandHz(spec, 40, 180, sr, nfft) * gain;
    const midRaw  = this._bandHz(spec, 250, 1200, sr, nfft) * gain;
    const trbRaw  = this._bandHz(spec, 2500, 9000, sr, nfft) * gain;

    const a = 0.86;
    const clamp01 = (x)=>Math.max(0, Math.min(1, x));
    const logNorm = (x, k)=> clamp01(Math.log1p(Math.max(0,x)*k) / Math.log1p(k));

    this._energy = a*this._energy + (1-a)*clamp01(rms*8.0);
    this._bass   = a*this._bass   + (1-a)*logNorm(bassRaw, 140);
    this._mid    = a*this._mid    + (1-a)*logNorm(midRaw,  140);
    this._treble = a*this._treble + (1-a)*logNorm(trbRaw,  160);

    const t = (performance.now() - this._t0) / 1000.0;

    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, t);
    gl.uniform1f(this.uEnergy, this._energy);
    gl.uniform1f(this.uBass, this._bass);
    gl.uniform1f(this.uMid, this._mid);
    gl.uniform1f(this.uTreble, this._treble);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(){
    try{
      const gl = this.gl;
      gl.deleteProgram(this.program);
      gl.deleteBuffer(this.vb);
    }catch(e){}
  }
}
