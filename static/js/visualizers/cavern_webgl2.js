// static/js/visualizers/cavern_webgl2.js
// Neon Crystal Cavern — fullscreen, opaque, WebGL2-first raymarched eye-candy.
// Mostly-GPU: CPU only computes a few audio bands -> uniforms.
//
// Visual model
// - Raymarched "cavern" boundary with domain-warped cylinder
// - Voronoi ridge mask to suggest faceted crystal planes
// - Neon emissive edges + fog + specular + subtle volumetric dust
//
// Audio mapping (from spectrum):
//   L (bass)   -> travel speed + warp + shock intensity
//   M (mid)    -> facet planes + hue drift
//   H (treble) -> edge sharpness + shimmer
//   E (energy) -> bloom-ish exposure + emissive gain
//
// Notes
// - Opaque output (alpha=1) and requests GL context with alpha:false.

import { createProgram, createFullscreenQuad } from "/static/js/webgl/util.js";

export class NeonCrystalCavernWebGL2 {
  static id = "cavern";
  static name = "Neon Crystal Cavern (WebGL2)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    // WebGL2-first, opaque.
    const opts = {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    };

    this.gl =
      canvas.getContext("webgl2", opts) ||
      canvas.getContext("webgl", opts) ||
      canvas.getContext("experimental-webgl", opts);

    if (!this.gl) throw new Error("WebGL not available");

    this.isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      this.gl instanceof WebGL2RenderingContext;

    const gl = this.gl;

    // Hardening: avoid "silent internal errors" on context loss.
    this._destroyed = false;
    this._onContextLost = (e) => {
      if (e) e.preventDefault();
      this._destroyed = true;
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);

    const vs = this._vsSource();
    const fs = this._fsSource();

    this.program = createProgram(gl, vs, fs);
    this.vb = createFullscreenQuad(gl);

    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.uRes = gl.getUniformLocation(this.program, "u_res");
    this.uTime = gl.getUniformLocation(this.program, "u_time");
    this.uBass = gl.getUniformLocation(this.program, "u_bass");
    this.uMid = gl.getUniformLocation(this.program, "u_mid");
    this.uTreble = gl.getUniformLocation(this.program, "u_treble");
    this.uEnergy = gl.getUniformLocation(this.program, "u_energy");
    this.uKick = gl.getUniformLocation(this.program, "u_kick");

    this._t0 = performance.now();

    // Smoothed audio
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._energy = 0;

    // Kick transient
    this._prevBass = 0;
    this._kick = 0;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
  }

  onResize() {
    if (this._destroyed) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  _bandHz(spec, samplerate, fftSize, f0, f1) {
    if (!spec || spec.length < 4 || !samplerate || !fftSize) return 0;
    const binHz = samplerate / fftSize;
    let i0 = Math.floor(f0 / binHz);
    let i1 = Math.floor(f1 / binHz);
    i0 = Math.max(0, Math.min(spec.length - 1, i0));
    i1 = Math.max(0, Math.min(spec.length - 1, i1));
    if (i1 < i0) [i0, i1] = [i1, i0];
    const n = Math.max(1, i1 - i0 + 1);
    let s = 0;
    for (let i = i0; i <= i1; i++) s += spec[i];
    return s / n;
  }

  _shape(x) {
    // Normalize spectrum magnitudes into a friendly 0..1 range.
    // (FFT magnitudes are typically small; shape boosts low values without hard clipping.)
    const v = Math.max(0, x);
    const y = 1.0 - Math.exp(-v * 8.0);
    return Math.max(0, Math.min(1, y));
  }

  onFrame(frame) {
    if (this._destroyed) return;
    const gl = this.gl;

    const spec = frame?.spectrum;
    const gain = Number(frame?.gain ?? 1);
    const sr = Number(frame?.samplerate ?? 48000);
    const fftSize = Number(frame?.fftSize ?? 2048);

    // Bands
    const bassRaw = this._shape(this._bandHz(spec, sr, fftSize, 35, 140) * gain * 2.2);
    const midRaw = this._shape(this._bandHz(spec, sr, fftSize, 180, 2200) * gain * 1.6);
    const treRaw = this._shape(this._bandHz(spec, sr, fftSize, 2800, 12000) * gain * 1.3);

    // Energy (wide)
    const e0 = this._bandHz(spec, sr, fftSize, 45, 12000) * gain;
    const energyRaw = this._shape(e0 * 1.9);

    // Smooth (EMA)
    const a = 0.90;
    this._bass = a * this._bass + (1 - a) * bassRaw;
    this._mid = a * this._mid + (1 - a) * midRaw;
    this._treble = a * this._treble + (1 - a) * treRaw;
    this._energy = a * this._energy + (1 - a) * energyRaw;

    // Kick transient: fast attack, slow decay
    const db = Math.max(0, this._bass - this._prevBass);
    this._prevBass = this._bass;
    this._kick = Math.max(this._kick * 0.92, Math.min(1, db * 7.5));

    const t = (performance.now() - this._t0) * 0.001;

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, t);
    gl.uniform1f(this.uBass, this._bass);
    gl.uniform1f(this.uMid, this._mid);
    gl.uniform1f(this.uTreble, this._treble);
    gl.uniform1f(this.uEnergy, this._energy);
    gl.uniform1f(this.uKick, this._kick);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy() {
    try {
      this._destroyed = true;
      this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);
      const gl = this.gl;
      gl.deleteProgram(this.program);
      gl.deleteBuffer(this.vb);
    } catch (e) {}
  }

  _vsSource() {
    if (this.isWebGL2) {
      return `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`;
    }
    return `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`;
  }

  _fsSource() {
    // WebGL2 path
    if (this.isWebGL2) {
      return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;

#define PI 3.141592653589793
#define TAU 6.283185307179586

float hash1(vec3 p){
  // cheap, stable hash
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

vec3 hash3(vec3 p){
  // iq-ish hash33
  vec3 p3 = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float noise3(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  // smootherstep
  f = f*f*(3.0 - 2.0*f);

  float n000 = hash1(i + vec3(0,0,0));
  float n100 = hash1(i + vec3(1,0,0));
  float n010 = hash1(i + vec3(0,1,0));
  float n110 = hash1(i + vec3(1,1,0));
  float n001 = hash1(i + vec3(0,0,1));
  float n101 = hash1(i + vec3(1,0,1));
  float n011 = hash1(i + vec3(0,1,1));
  float n111 = hash1(i + vec3(1,1,1));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);

  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);

  return mix(nxy0, nxy1, f.z);
}

float fbm(vec3 p){
  float a = 0.5;
  float s = 0.0;
  for(int i=0;i<4;i++){
    s += a * noise3(p);
    p = p*2.02 + 17.17;
    a *= 0.5;
  }
  return s;
}

vec3 warp3(vec3 p, float t){
  // 3 independent fbm channels
  float x = fbm(p + vec3( 0.0,  0.0, t));
  float y = fbm(p + vec3(11.7,  5.3, t));
  float z = fbm(p + vec3(23.1, 17.9, t));
  return vec3(x,y,z);
}

vec2 voronoi2(vec3 p){
  vec3 g = floor(p);
  vec3 f = fract(p);
  float md1 = 1e9;
  float md2 = 1e9;
  for(int z=-1; z<=1; z++){
    for(int y=-1; y<=1; y++){
      for(int x=-1; x<=1; x++){
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 r = o + hash3(g + o) - f;
        float d = dot(r, r);
        if(d < md1){
          md2 = md1;
          md1 = d;
        }else if(d < md2){
          md2 = d;
        }
      }
    }
  }
  return vec2(sqrt(md1), sqrt(md2));
}

mat2 rot(float a){
  float s = sin(a), c = cos(a);
  return mat2(c,-s,s,c);
}

float cavernRadius(float z, float bass){
  float r = 1.55;
  r += 0.22 * sin(z * 0.12);
  r += 0.14 * (noise3(vec3(z*0.08, 0.0, 0.0)) - 0.5);
  r += 0.20 * bass;
  return r;
}

float mapScene(vec3 p){
  // Time-driven forward drift inside the cave
  float speed = mix(0.55, 1.55, clamp(u_bass*1.15 + u_energy*0.35 + u_kick*0.4, 0.0, 1.0));
  p.z += u_time * speed * 2.05;

  // slight corkscrew camera vibe through the world itself (cheap)
  float tw = 0.08 + 0.10*u_mid;
  p.xy *= rot(p.z * tw);

  // domain warp (cave "breath")
  float warpAmt = 0.18 + 0.62*u_bass + 0.18*u_kick;
  vec3 w = warp3(p*0.35, u_time*0.15) * 2.0 - 1.0;
  vec3 q = p + w * warpAmt;

  float r = cavernRadius(q.z, u_bass);
  float dCave = abs(length(q.xy) - r);

  // crystal facets: voronoi ridges + subtle plane ripples
  vec2 v = voronoi2(q * 1.35);
  float ridge = max(0.001, v.y - v.x); // near 0 => boundary/ridge
  float ridgeMask = exp(-ridge * (14.0 + 28.0*u_treble));

  float plane = abs(sin(dot(q, normalize(vec3(0.86,0.21,0.45))) * 3.1));
  float planeMask = pow(clamp(1.0 - plane, 0.0, 1.0), 6.0);

  float protrude = (0.30 + 0.70*u_bass) * ridgeMask + (0.06 + 0.22*u_mid) * planeMask;
  protrude *= (0.8 + 0.7*u_energy);

  // "shards" push inward, reducing distance to wall
  float d = dCave - protrude * 0.38;

  return d;
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.0015, 0.0);
  float d1 = mapScene(p + vec3(e.x, e.y, e.y));
  float d2 = mapScene(p - vec3(e.x, e.y, e.y));
  float d3 = mapScene(p + vec3(e.y, e.x, e.y));
  float d4 = mapScene(p - vec3(e.y, e.x, e.y));
  float d5 = mapScene(p + vec3(e.y, e.y, e.x));
  float d6 = mapScene(p - vec3(e.y, e.y, e.x));
  return normalize(vec3(d1-d2, d3-d4, d5-d6));
}

vec3 palette(float t){
  // cosine palette (smooth neon gradients)
  vec3 a = vec3(0.45, 0.35, 0.55);
  vec3 b = vec3(0.55, 0.55, 0.45);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.05, 0.33, 0.67);
  return a + b * cos(TAU * (c * t + d));
}

vec3 tonemap(vec3 c){
  // simple filmic-ish
  c = max(c, vec3(0.0));
  float expo = 1.1 + 1.9*u_energy + 0.8*u_kick;
  c = vec3(1.0) - exp(-c * expo);
  // gamma
  c = pow(c, vec3(1.0/2.2));
  return c;
}

void main(){
  vec2 uv = (v_uv * 2.0 - 1.0);
  uv.x *= u_res.x / max(1.0, u_res.y);

  // camera setup
  float t = u_time;
  float camBob = 0.10 * sin(t*0.8) * (0.25 + 0.75*u_energy);
  vec3 ro = vec3(0.0, camBob, 0.0);

  // view ray
  float fov = mix(1.15, 1.35, clamp(u_kick*0.75 + u_bass*0.35, 0.0, 1.0));
  vec3 rd = normalize(vec3(uv, fov));

  // subtle camera roll
  float roll = 0.06 * sin(t*0.45) + 0.10*u_mid;
  rd.xy = rot(roll) * rd.xy;

  // raymarch
  float dist = 0.0;
  float hit = 0.0;
  vec3  p = ro;

  // volumetric dust accumulation (cheap)
  float dust = 0.0;

  for(int i=0;i<86;i++){
    p = ro + rd * dist;
    float d = mapScene(p);
    if(d < 0.0018){
      hit = 1.0;
      break;
    }
    // soft volumetric feel: denser near walls
    dust += exp(-d * 12.0) * 0.012;
    dist += max(d * 0.62, 0.012);
    if(dist > 28.0) break;
  }

  vec3 bg = vec3(0.01, 0.012, 0.02);
  // faint background glow
  bg += 0.03 * palette(0.12 + 0.03*t);

  vec3 col = bg;

  if(hit > 0.5){
    vec3 n = calcNormal(p);

    // lighting
    vec3 ldir = normalize(vec3(0.45, 0.65, 0.25));
    float diff = clamp(dot(n, ldir), 0.0, 1.0);

    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    float spec = pow(max(dot(reflect(-ldir, n), -rd), 0.0), 24.0 + 42.0*u_treble);

    // edge mask for neon glow (recompute cheaply)
    vec2 v = voronoi2((p) * 1.35);
    float ridge = max(0.001, v.y - v.x);
    float ridgeMask = exp(-ridge * (14.0 + 28.0*u_treble));
    float plane = abs(sin(dot(p, normalize(vec3(0.86,0.21,0.45))) * 3.1));
    float planeMask = pow(clamp(1.0 - plane, 0.0, 1.0), 6.0);
    float edge = ridgeMask * 1.35 + planeMask * 0.55;

    float hue = 0.56
      + 0.10*sin(p.z*0.09)
      + 0.10*u_mid
      + 0.06*u_time*0.03
      + 0.08*(n.x+n.y);

    vec3 base = palette(hue);

    // "prismatic" tint shift with treble
    base = mix(base, base*vec3(1.15, 0.95, 1.25), u_treble*0.65);

    vec3 lit = base * (0.18 + 0.95*diff) + vec3(0.55)*spec;
    lit += base * fres * (0.55 + 0.85*u_energy);

    vec3 emissive = base * edge * (0.9 + 2.8*u_energy + 2.3*u_bass + 1.5*u_kick);
    emissive += palette(hue + 0.25) * (0.15 + 0.9*u_treble) * edge;

    // fog / depth
    float fog = exp(-dist * (0.09 + 0.05*u_energy));
    col = mix(bg, lit + emissive, fog);

    // add dust glow
    col += dust * (0.6 + 1.6*u_energy) * base;
  }else{
    // subtle star grain
    float g = noise3(vec3(v_uv*u_res.xy*0.002, u_time*0.02));
    col += 0.02 * g;
  }

  // finishing
  col = tonemap(col);

  outColor = vec4(col, 1.0);
}`;
    }

    // WebGL1 fallback
    return `
precision highp float;

varying vec2 v_uv;

uniform vec2  u_res;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;

#define PI 3.141592653589793
#define TAU 6.283185307179586

float hash1(vec3 p){
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

vec3 hash3(vec3 p){
  vec3 p3 = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float noise3(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f*f*(3.0 - 2.0*f);

  float n000 = hash1(i + vec3(0,0,0));
  float n100 = hash1(i + vec3(1,0,0));
  float n010 = hash1(i + vec3(0,1,0));
  float n110 = hash1(i + vec3(1,1,0));
  float n001 = hash1(i + vec3(0,0,1));
  float n101 = hash1(i + vec3(1,0,1));
  float n011 = hash1(i + vec3(0,1,1));
  float n111 = hash1(i + vec3(1,1,1));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);

  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);

  return mix(nxy0, nxy1, f.z);
}

float fbm(vec3 p){
  float a = 0.5;
  float s = 0.0;
  for(int i=0;i<4;i++){
    s += a * noise3(p);
    p = p*2.02 + 17.17;
    a *= 0.5;
  }
  return s;
}

vec3 warp3(vec3 p, float t){
  float x = fbm(p + vec3( 0.0,  0.0, t));
  float y = fbm(p + vec3(11.7,  5.3, t));
  float z = fbm(p + vec3(23.1, 17.9, t));
  return vec3(x,y,z);
}

vec2 voronoi2(vec3 p){
  vec3 g = floor(p);
  vec3 f = fract(p);
  float md1 = 1e9;
  float md2 = 1e9;
  for(int z=-1; z<=1; z++){
    for(int y=-1; y<=1; y++){
      for(int x=-1; x<=1; x++){
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 r = o + hash3(g + o) - f;
        float d = dot(r, r);
        if(d < md1){
          md2 = md1;
          md1 = d;
        }else if(d < md2){
          md2 = d;
        }
      }
    }
  }
  return vec2(sqrt(md1), sqrt(md2));
}

mat2 rot(float a){
  float s = sin(a), c = cos(a);
  return mat2(c,-s,s,c);
}

float cavernRadius(float z, float bass){
  float r = 1.55;
  r += 0.22 * sin(z * 0.12);
  r += 0.14 * (noise3(vec3(z*0.08, 0.0, 0.0)) - 0.5);
  r += 0.20 * bass;
  return r;
}

float mapScene(vec3 p){
  float speed = mix(0.55, 1.55, clamp(u_bass*1.15 + u_energy*0.35 + u_kick*0.4, 0.0, 1.0));
  p.z += u_time * speed * 2.05;

  float tw = 0.08 + 0.10*u_mid;
  p.xy *= rot(p.z * tw);

  float warpAmt = 0.18 + 0.62*u_bass + 0.18*u_kick;
  vec3 w = warp3(p*0.35, u_time*0.15) * 2.0 - 1.0;
  vec3 q = p + w * warpAmt;

  float r = cavernRadius(q.z, u_bass);
  float dCave = abs(length(q.xy) - r);

  vec2 v = voronoi2(q * 1.35);
  float ridge = max(0.001, v.y - v.x);
  float ridgeMask = exp(-ridge * (14.0 + 28.0*u_treble));

  float plane = abs(sin(dot(q, normalize(vec3(0.86,0.21,0.45))) * 3.1));
  float planeMask = pow(clamp(1.0 - plane, 0.0, 1.0), 6.0);

  float protrude = (0.30 + 0.70*u_bass) * ridgeMask + (0.06 + 0.22*u_mid) * planeMask;
  protrude *= (0.8 + 0.7*u_energy);

  return dCave - protrude * 0.38;
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.0015, 0.0);
  float d1 = mapScene(p + vec3(e.x, e.y, e.y));
  float d2 = mapScene(p - vec3(e.x, e.y, e.y));
  float d3 = mapScene(p + vec3(e.y, e.x, e.y));
  float d4 = mapScene(p - vec3(e.y, e.x, e.y));
  float d5 = mapScene(p + vec3(e.y, e.y, e.x));
  float d6 = mapScene(p - vec3(e.y, e.y, e.x));
  return normalize(vec3(d1-d2, d3-d4, d5-d6));
}

vec3 palette(float t){
  vec3 a = vec3(0.45, 0.35, 0.55);
  vec3 b = vec3(0.55, 0.55, 0.45);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.05, 0.33, 0.67);
  return a + b * cos(TAU * (c * t + d));
}

vec3 tonemap(vec3 c){
  c = max(c, vec3(0.0));
  float expo = 1.1 + 1.9*u_energy + 0.8*u_kick;
  c = vec3(1.0) - exp(-c * expo);
  c = pow(c, vec3(1.0/2.2));
  return c;
}

void main(){
  vec2 uv = (v_uv * 2.0 - 1.0);
  uv.x *= u_res.x / max(1.0, u_res.y);

  float t = u_time;
  float camBob = 0.10 * sin(t*0.8) * (0.25 + 0.75*u_energy);
  vec3 ro = vec3(0.0, camBob, 0.0);

  float fov = mix(1.15, 1.35, clamp(u_kick*0.75 + u_bass*0.35, 0.0, 1.0));
  vec3 rd = normalize(vec3(uv, fov));

  float roll = 0.06 * sin(t*0.45) + 0.10*u_mid;
  rd.xy = rot(roll) * rd.xy;

  float dist = 0.0;
  float hit = 0.0;
  vec3  p = ro;
  float dust = 0.0;

  for(int i=0;i<86;i++){
    p = ro + rd * dist;
    float d = mapScene(p);
    if(d < 0.0018){
      hit = 1.0;
      break;
    }
    dust += exp(-d * 12.0) * 0.012;
    dist += max(d * 0.62, 0.012);
    if(dist > 28.0) break;
  }

  vec3 bg = vec3(0.01, 0.012, 0.02);
  bg += 0.03 * palette(0.12 + 0.03*t);

  vec3 col = bg;

  if(hit > 0.5){
    vec3 n = calcNormal(p);
    vec3 ldir = normalize(vec3(0.45, 0.65, 0.25));
    float diff = clamp(dot(n, ldir), 0.0, 1.0);

    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    float spec = pow(max(dot(reflect(-ldir, n), -rd), 0.0), 24.0 + 42.0*u_treble);

    vec2 v = voronoi2((p) * 1.35);
    float ridge = max(0.001, v.y - v.x);
    float ridgeMask = exp(-ridge * (14.0 + 28.0*u_treble));
    float plane = abs(sin(dot(p, normalize(vec3(0.86,0.21,0.45))) * 3.1));
    float planeMask = pow(clamp(1.0 - plane, 0.0, 1.0), 6.0);
    float edge = ridgeMask * 1.35 + planeMask * 0.55;

    float hue = 0.56
      + 0.10*sin(p.z*0.09)
      + 0.10*u_mid
      + 0.06*u_time*0.03
      + 0.08*(n.x+n.y);

    vec3 base = palette(hue);
    base = mix(base, base*vec3(1.15, 0.95, 1.25), u_treble*0.65);

    vec3 lit = base * (0.18 + 0.95*diff) + vec3(0.55)*spec;
    lit += base * fres * (0.55 + 0.85*u_energy);

    vec3 emissive = base * edge * (0.9 + 2.8*u_energy + 2.3*u_bass + 1.5*u_kick);
    emissive += palette(hue + 0.25) * (0.15 + 0.9*u_treble) * edge;

    float fog = exp(-dist * (0.09 + 0.05*u_energy));
    col = mix(bg, lit + emissive, fog);
    col += dust * (0.6 + 1.6*u_energy) * base;
  }else{
    float g = noise3(vec3(v_uv*u_res.xy*0.002, u_time*0.02));
    col += 0.02 * g;
  }

  col = tonemap(col);
  gl_FragColor = vec4(col, 1.0);
}`;
  }
}
