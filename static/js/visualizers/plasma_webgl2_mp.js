import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

const PLASMA_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
// Audio-reactive inputs (fed from frame.* by MultiPassWebGL2).
uniform float u_energy;
uniform float u_bass;
uniform float u_high;
uniform float u_gain;
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
  uv *= 1.11;  // slight zoom out to reduce edge outside canvas

  float t = u_time;
  // Audio remap: lift low values so quiet audio still drives motion/brightness.
  float energy = sqrt(clamp(u_energy, 0.0, 1.0));
  float bass = sqrt(clamp(u_bass, 0.0, 1.0));
  float high = sqrt(clamp(u_high, 0.0, 1.0));
  float g = clamp(u_gain, 0.2, 4.0);

  float r = length(uv);
  float a = atan(uv.y, uv.x);
  // energy: increases angular wobble amplitude (more rotation-like warp).
  a += 0.9 * sin(r * 3.0 - t * 1.2) * (0.25 + 0.85 * energy + 0.6 * bass);
  // high: sharpens radial warp and adds higher-frequency motion.
  r += 0.2 * sin(a * 6.0 + t * 0.8) * (0.2 + 1.2 * high);

  vec2 q = vec2(cos(a), sin(a)) * r;
  float v = 0.0;
  v += sin(q.x * 6.0 + t);
  v += sin(q.y * 6.0 - t * 1.2);
  v += sin((q.x + q.y) * 4.0 + t * 0.7);
  v /= 3.0;

  float glow = smoothstep(0.2, 0.95, abs(v));
  float pulses = 0.5 + 0.5 * sin(t * 2.0 + v * 4.0);
  // high: leans toward pulsing detail vs. smooth glow.
  float k = mix(glow, pulses, 0.35 + 0.35 * high);

  vec3 col = palette(v * 0.35 + t * 0.05);
  col *= 0.65 + 0.85 * k;
  col += vec3(0.25, 0.85, 1.0) * (0.15 + 0.85 * energy) * smoothstep(0.2, 0.7, glow);

  float vig = smoothstep(1.2, 0.2, r);
  col *= vig;
  // bass: overall brightness lift.
  col *= 0.85 + 0.6 * bass;
  // gain: overall intensity boost (useful for quiet sources).
  col *= (1.81125 + 0.646875 * g);

  float lum = max(col.r, max(col.g, col.b));
  // energy: raises visibility floor; gain: extra transparency boost.
  float alpha = smoothstep(0.015, 0.2, lum) * clamp(0.45 + 0.6 * energy, 0.0, 1.0);
  alpha *= (1.4705625 + 0.3061875 * g);
  alpha = clamp(alpha, 0.0, 1.0);
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

    // frame.{energy,bass,high,gain} drive the shader via MultiPassWebGL2 uniforms.
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
