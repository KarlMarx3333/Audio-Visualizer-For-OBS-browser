// static/js/visualizers/fractal_torus_webgl.js
// Fractal Torus Tunnel (WebGL) -- adapted to ObsVizHost contract.
// Credits:
// - Original/adapted from: "Fractal Toras Tunnel" by netgrind (2017-05-16)
//   https://www.shadertoy.com/view/ld2yDD
// - Inspired by: "Disco tunnel" by WAHa_06x36 (2018-05-08)
//   https://www.shadertoy.com/view/XstfzB
// Two-pass: BufferA (feedback + audio row) -> Image (raymarch).
// Overlay-friendly: no opaque page background; final alpha derived from luminance.

import { MultiPassPipeline, TIME_WRAP as PIPE_TIME_WRAP } from "/static/js/webgl/multipass.js";

const TIME_WRAP = PIPE_TIME_WRAP;
const TRAVEL_WRAP = 1024.0; // multiple of 2 to match fract repeat period

export class FractalTorusWebGL {
  static id = "fractal_torus";
  static name = "Fractal Torus Tunnel (WebGL)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const glOpts = {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    };

    this.gl =
      canvas.getContext("webgl", glOpts) ||
      canvas.getContext("experimental-webgl", glOpts);

    if (!this.gl) throw new Error("WebGL not available");

    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const qs = new URLSearchParams(location.search);
    const pass = (qs.get("pass") || "").toLowerCase();
    this._showBufferA = pass === "a" || pass === "buffera";

    this._uTravel = { uniform: "u_travel", kind: "value", value: 0 };

    const passSpecs = [
      {
        name: "A",
        target: "texture",
        feedback: true,
        fsSrc: FS_BUFFER_A,
        builtins: { res: true, time: "wrap", dt: true },
        bindings: [
          { uniform: "u_prev", kind: "prev", pass: "A", unit: 0 },
          { uniform: "u_audio", kind: "audio", unit: 1 },
        ],
      },
      {
        name: "Image",
        target: "screen",
        feedback: false,
        fsSrc: this._showBufferA ? FS_BLIT : FS_IMAGE,
        builtins: { res: true, time: "wrap", dt: true },
        bindings: [
          { uniform: "u_buf", kind: "pass", pass: "A", unit: 0 },
        ],
        uniforms: this._showBufferA ? null : [this._uTravel],
      },
    ];

    this._pipeline = new MultiPassPipeline(gl, passSpecs, { timeWrap: TIME_WRAP });
    this._lastNowMs = performance.now();
    this._tFallback = 0;
    this._failed = false;

    this.onResize(canvas.width, canvas.height, window.devicePixelRatio || 1);
  }

  onResize(w, h, dpr) {
    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;
    this._pipeline.resize(cw, ch);
  }

  onFrame(frame) {
    if (this._failed) return;

    try {
      let dt = Number(frame && frame.dt);
      if (!Number.isFinite(dt) || dt <= 0) {
        const now = performance.now();
        const last = this._lastNowMs || now;
        dt = (now - last) * 0.001;
        this._lastNowMs = now;
        if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
        if (dt > 0.1) dt = 0.1;
      }

      let t = Number(frame && frame.t);
      if (!Number.isFinite(t) || t < 0) {
        let acc = this._tFallback;
        if (!Number.isFinite(acc)) acc = 0;
        acc += dt;
        this._tFallback = acc;
        t = acc;
      }

      this._uTravel.value = (t * 0.5) % TRAVEL_WRAP;
      this._pipeline.render(frame);
    } catch (err) {
      this._failed = true;
      console.error("[FractalTorusWebGL] render failed:", err);
      throw err;
    }
  }

  destroy() {
    if (this._pipeline) this._pipeline.destroy();
  }
}

// ---------------- Shaders ----------------

const FS_BLIT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_buf;
void main() {
  gl_FragColor = texture2D(u_buf, v_uv);
}
`;

// Shadertoy Buffer A adapted
const FS_BUFFER_A = `
precision mediump float;
varying vec2 v_uv;

uniform sampler2D u_prev;   // previous BufferA
uniform sampler2D u_audio;  // spectrum strip (R)
uniform vec2 u_res;
uniform float u_time;

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / u_res.xy;
  vec2 o = vec2(0.0, 1.1 / u_res.y);

  // For y <= 1px, write the audio row from u_audio. Else, feedback from previous frame.
  float topRow = max(ceil(1.0 - fragCoord.y), 0.0); // 1 on first row, 0 otherwise
  float m = mix(
    texture2D(u_prev, uv - o).r,
    texture2D(u_audio, vec2(uv.x, 0.33)).r,
    topRow
  );

  m *= (1.0 - pow(1.0 - uv.x, 5.0)) * 0.3 + 0.75;
  gl_FragColor = vec4(m, m, m, 1.0);
}
`;

// Shadertoy Image adapted from netgrind (ld2yDD); alpha derived from luminance.
const FS_IMAGE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;

uniform sampler2D u_buf; // current BufferA
uniform vec2 u_res;
uniform float u_time;
uniform float u_travel;

#define I_MAX 100
#define E 0.0005

float g;
float t;
float a;
vec3 ss;
vec4 vv;

void rotate(inout vec2 v, float angle) {
  v = vec2(cos(angle)*v.x + sin(angle)*v.y, -sin(angle)*v.x + cos(angle)*v.y);
}

float sdTorus(vec3 p, vec2 tt) {
  vec2 q = vec2(length(p.zy) - tt.x, p.x);
  return length(q) - tt.y;
}

vec3 blackbody(float Temp) {
  vec3 col = vec3(255.0);
  col.x = 56100000.0 * pow(Temp, (-3.0/2.0)) + 148.0;
  col.y = 100.04 * log(Temp) - 623.6;
  if (Temp > 6500.0) col.y = 35200000.0 * pow(Temp, (-3.0/2.0)) + 184.0;
  col.z = 194.18 * log(Temp) - 1448.6;
  col = clamp(col, 0.0, 255.0) / 255.0;
  if (Temp < 1000.0) col *= Temp / 1000.0;
  return col;
}

float scene(vec3 p) {
  float scale = 1.0;
  float r2, k;
  a = cos(0.5 * (p.z) + t);
  rotate(p.yx, a);
  p.xy += vec2(cos(t), sin(t)) * 0.25 + 1.0;
  p.z -= u_travel;

  ss = p;
  for (int i = 0; i < 4; i++) {
    p.xyz = 1.0 - 2.0 * fract(0.5 * p.xyz + 0.5);
    r2 = sdTorus(p, vec2(0.21, 0.4 * vv[i] + 0.21));
    k = 1.0 / (r2);
    p *= k;
    scale *= k;
  }
  ss = p * (fract(ss) + 0.5);
  return (0.25 * (abs(p.x) + length(fract(ss.xz) - 0.5) * 0.1) / scale);
}

vec2 march(vec3 pos, vec3 dir) {
  vec2 dist = vec2(0.0);
  vec3 p = vec3(0.0);
  vec2 s = vec2(0.0);

  vec3 dirr;
  for (int i = 0; i < I_MAX; ++i) {
    dirr = dir;
    p = pos + dirr * dist.y;
    dist.x = scene(p);
    dist.y += dist.x;

    if (dist.x < E || dist.y > 6.0) {
      p = ss;
      g = p.y;
      g += (step(sin(5.0*p.x), 0.5) + step(sin(20.0*p.x), 0.5));
      break;
    }
    s.x += 1.0;
  }
  s.y = dist.y;
  return s;
}

vec3 camera(vec2 uv) {
  float fov = 1.0;
  vec3 forw  = vec3(0.0, 0.0, -1.0);
  vec3 right = vec3(1.0, 0.0, 0.0);
  vec3 up    = vec3(0.0, 1.0, 0.0);
  return normalize(uv.x * right + uv.y * up + fov * forw);
}

void main() {
  t = u_time * 0.5;

  // Read 4 control values from BufferA's top row (audio row written by BufferA)
  for (int i = 0; i < 4; i++) {
    vv[i] = texture2D(u_buf, vec2(float(i) / 6.0, 0.01)).r;
  }

  vec2 R = u_res.xy;
  vec2 f = gl_FragCoord.xy;
  vec2 uv = (f - R * 0.5) / R.y;

  vec3 dir = camera(uv);
  vec3 pos = vec3(0.0);

  vec2 inter = march(pos, dir);

  vec3 col = vec3(inter.y * 0.051 - (inter.x) * 0.001);
  col += blackbody((15.0 - (2.0 * inter.y - 0.1 * inter.x)) * 50.0);
  col = sin(col * 6.0 - 0.4) * 0.5 + 0.5;

  // Full-screen effect: opaque output.
  // Keep vignette on color only (optional aesthetic), but alpha stays 1.
  float v = smoothstep(1.25, 0.15, length(uv));
  col *= v;

  gl_FragColor = vec4(col, 1.0);
}
`;
