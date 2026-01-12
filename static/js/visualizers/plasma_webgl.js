import { createGL, createProgram, createFullscreenQuad } from "/static/js/webgl/util.js";

export class PlasmaWebGL {
  static id = "plasma";
  static name = "Neon Plasma (WebGL)";
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
      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_energy;
      uniform float u_bass;
      uniform float u_treble;
      uniform int u_overlay;
      uniform float u_overlayBoost;

      vec3 palette(float t){
        vec3 a = vec3(0.10, 0.10, 0.20);
        vec3 b = vec3(0.55, 0.85, 1.00);
        vec3 c = vec3(0.85, 0.35, 0.95);
        vec3 d = vec3(0.00, 0.33, 0.67);
        return a + b*cos(6.28318*(c*t + d));
      }

      void main(){
        vec2 uv = v_uv;
        vec2 p = (uv * 2.0 - 1.0);
        p.x *= u_res.x / u_res.y;

        float t = u_time * (0.35 + 1.2*u_bass);
        float e = u_energy;

        float r = length(p);
        float a = atan(p.y, p.x);
        a += 0.9*sin(r*3.0 - t*1.2) * (0.3 + 0.9*e);
        r += 0.2*sin(a*6.0 + t*0.8) * (0.2 + 1.2*u_treble);

        vec2 q = vec2(cos(a), sin(a)) * r;
        float v = 0.0;
        v += sin(q.x*6.0 + t);
        v += sin(q.y*6.0 - t*1.2);
        v += sin((q.x+q.y)*4.0 + t*0.7);
        v /= 3.0;

        float glow = smoothstep(0.2, 0.95, abs(v));
        float pulses = 0.5 + 0.5*sin(t*2.0 + v*4.0);
        float k = mix(glow, pulses, 0.35 + 0.35*u_treble);

        vec3 col = palette(v*0.35 + t*0.05);
        col *= 0.65 + 0.85*k;
        col += vec3(0.25, 0.85, 1.0) * (0.15 + 0.85*e) * smoothstep(0.2, 0.7, glow);

        float vig = smoothstep(1.2, 0.2, r);
        col *= vig;

        if(u_overlay == 1){
          col *= u_overlayBoost;
          col = pow(col, vec3(0.85));
          col = min(col, vec3(1.0));
          float lum = max(col.r, max(col.g, col.b));
          float a = smoothstep(0.03, 0.15, lum);
          gl_FragColor = vec4(col, a);
        }else{
          float alpha = clamp(glow * (0.35 + 0.65*e) * vig, 0.0, 1.0);
          gl_FragColor = vec4(col, alpha);
        }
      }
    `;

    this.program = createProgram(this.gl, vs, fs);
    this.vb = createFullscreenQuad(this.gl);

    this.aPos = this.gl.getAttribLocation(this.program, "a_pos");
    this.uRes = this.gl.getUniformLocation(this.program, "u_res");
    this.uTime = this.gl.getUniformLocation(this.program, "u_time");
    this.uEnergy = this.gl.getUniformLocation(this.program, "u_energy");
    this.uBass = this.gl.getUniformLocation(this.program, "u_bass");
    this.uTreble = this.gl.getUniformLocation(this.program, "u_treble");
    this.uOverlay = this.gl.getUniformLocation(this.program, "u_overlay");
    this.uOverlayBoost = this.gl.getUniformLocation(this.program, "u_overlayBoost");

    this._t0 = performance.now();
    this._energy = 0;
    this._bass = 0;
    this._treble = 0;
  }

  onResize(w,h,dpr){
    this.gl.viewport(0,0,this.canvas.width,this.canvas.height);
  }

  _band(spec, b0, b1){
    b0 = Math.max(0, Math.min(spec.length-1, b0));
    b1 = Math.max(b0+1, Math.min(spec.length, b1));
    let sum = 0;
    for(let i=b0;i<b1;i++) sum += spec[i];
    return sum / (b1-b0);
  }

  onFrame(frame){
    const gl = this.gl;
    const spec = frame.spectrum;
    const rms = (frame.rms && frame.rms[0]) ? frame.rms[0] : 0;
    const overlay = !!frame.overlay;

    const bass = this._band(spec, 2, 50) * frame.gain;
    const treble = this._band(spec, Math.floor(spec.length*0.55), Math.floor(spec.length*0.95)) * frame.gain;

    const a = 0.85;
    this._energy = a*this._energy + (1-a)*Math.min(1.0, rms*6.0);
    this._bass = a*this._bass + (1-a)*Math.min(1.0, bass*18.0);
    this._treble = a*this._treble + (1-a)*Math.min(1.0, treble*30.0);

    const t = (performance.now() - this._t0) / 1000.0;

    if(overlay){
      gl.clearColor(0, 0, 0, 0);
    }else{
      gl.clearColor(0, 0, 0, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, t);
    gl.uniform1f(this.uEnergy, this._energy);
    gl.uniform1f(this.uBass, this._bass);
    gl.uniform1f(this.uTreble, this._treble);
    gl.uniform1i(this.uOverlay, overlay ? 1 : 0);
    gl.uniform1f(this.uOverlayBoost, overlay ? 2.5 : 1.0);

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
