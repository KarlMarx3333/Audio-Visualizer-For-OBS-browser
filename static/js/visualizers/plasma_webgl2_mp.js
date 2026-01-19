import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

const PLASMA_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_energy;
uniform float u_bass;
uniform float u_high;
uniform float u_aspect;

vec3 palette(float t){
  vec3 a = vec3(0.10, 0.10, 0.20);
  vec3 b = vec3(0.55, 0.85, 1.00);
  vec3 c = vec3(0.85, 0.35, 0.95);
  vec3 d = vec3(0.00, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * t + d));
}

void main(){
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;

  float t = u_time;
  float energy = u_energy;
  float bass = u_bass;
  float high = u_high;

  float r = length(uv);
  float a = atan(uv.y, uv.x);
  a += 0.9 * sin(r * 3.0 - t * 1.2) * (0.25 + 0.85 * energy);
  r += 0.2 * sin(a * 6.0 + t * 0.8) * (0.2 + 1.2 * high);

  vec2 q = vec2(cos(a), sin(a)) * r;
  float v = 0.0;
  v += sin(q.x * 6.0 + t);
  v += sin(q.y * 6.0 - t * 1.2);
  v += sin((q.x + q.y) * 4.0 + t * 0.7);
  v /= 3.0;

  float glow = smoothstep(0.2, 0.95, abs(v));
  float pulses = 0.5 + 0.5 * sin(t * 2.0 + v * 4.0);
  float k = mix(glow, pulses, 0.35 + 0.35 * high);

  vec3 col = palette(v * 0.35 + t * 0.05);
  col *= 0.65 + 0.85 * k;
  col += vec3(0.25, 0.85, 1.0) * (0.15 + 0.85 * energy) * smoothstep(0.2, 0.7, glow);

  float vig = smoothstep(1.2, 0.2, r);
  col *= vig;
  col *= 0.85 + 0.6 * bass;

  float lum = max(col.r, max(col.g, col.b));
  float alpha = smoothstep(0.02, 0.18, lum) * clamp(0.4 + 0.6 * energy, 0.0, 1.0);
  fragColor = vec4(col, alpha);
}
`;

const PASS_SPECS = [
  {
    name: "Image",
    fs: PLASMA_FS,
  },
];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export class PlasmaWebGL2MP {
  static id = "plasma";
  static name = "Plasma (WebGL2 Multipass)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 not available");

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    this.gl = gl;
    this.mp = new MultiPassWebGL2(gl);
    this.mp.setPasses(PASS_SPECS);

    this._lastT = NaN;
    this._frame = 0;
  }

  onResize(w, h, dpr) {
    if (!this.mp) return;
    this.mp.setSize(w, h, dpr);
  }

  onFrame(frame) {
    if (!this.mp) return;

    const now = performance.now() * 0.001;
    let t = now;
    if (frame) {
      if (frame.time && isFiniteNumber(frame.time.t)) {
        t = frame.time.t;
      } else if (isFiniteNumber(frame.t)) {
        t = frame.t;
      } else if (isFiniteNumber(frame.ts)) {
        t = frame.ts < 1e12 ? frame.ts : frame.ts * 0.001;
      }
    }

    let dt = NaN;
    if (frame) {
      if (isFiniteNumber(frame.dt)) {
        dt = frame.dt;
      } else if (frame.time && isFiniteNumber(frame.time.dt)) {
        dt = frame.time.dt;
      }
    }

    if (!isFiniteNumber(dt)) {
      if (isFiniteNumber(this._lastT)) {
        dt = t - this._lastT;
      } else {
        dt = 1 / 60;
      }
    }

    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._lastT = t;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) {
      frameIndex = frame.frameIndex | 0;
    } else if (frame && isFiniteNumber(frame.frame)) {
      frameIndex = frame.frame | 0;
    } else {
      this._frame = (this._frame + 1) | 0;
      frameIndex = this._frame;
    }

    this.mp.render(frame, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) {
      this.mp.destroy();
    }
    this.mp = null;
    this.gl = null;
    this.canvas = null;
  }
}
