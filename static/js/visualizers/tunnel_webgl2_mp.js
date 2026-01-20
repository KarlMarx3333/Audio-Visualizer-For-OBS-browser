import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Tunnel (v2 multipass, single-pass Image)
- Visually faithful to the legacy tunnel vibe: bright portal rings on a curving centerline
- No feedback, no trails, no post blur
- Real “steering/bending” via camera following the same path as the portals (dcam/dz compensation)
- Audio drives: bass->speed/thickness/brightness, mid->bend amount, high->color shimmer
*/

const TUNNEL_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_aspect;
uniform float u_time;
uniform float u_dt;

uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_energy;
uniform float u_gain;

uniform sampler2D u_specTex;
uniform int u_specLen;

// custom (set from JS)
uniform float u_camZ;

#define TAU 6.28318530718

float specAt(float x){
  return texture(u_specTex, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

// Matches the provided shadertoy-style path (sum of harmonics)
vec2 position2(float z){
  return vec2(
    sin(z * 0.10) * 1.0 + sin(cos(z * 0.031) * 4.0) * 1.0 + sin(sin(z * 0.0091) * 3.0) * 3.0,
    cos(z * 0.10) * 1.0 + cos(cos(z * 0.031) * 4.0) * 1.0 + cos(sin(z * 0.0091) * 3.0) * 3.0
  );
}

float ngonRadius(float theta, float R, float N){
  float k = TAU / max(N, 3.0);
  float t = abs(mod(theta + 0.5*k, k) - 0.5*k);
  float c = cos(3.14159265 / max(N, 3.0));
  // clamp denom to avoid infinities (keeps things stable)
  return R * c / max(0.25, cos(t));
}

void main(){
  // Aspect-correct “p” like shadertoy's min(res) normalization.
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= u_aspect;

  // Audio shaping (quiet still moves)
  float bass = sqrt(clamp(u_bass, 0.0, 1.0));
  float mid  = sqrt(clamp(u_mid,  0.0, 1.0));
  float high = sqrt(clamp(u_high, 0.0, 1.0));
  float en   = sqrt(clamp(u_energy, 0.0, 1.0));
  float g    = clamp(u_gain, 0.2, 4.0);

  // Spectrum taps (helps even when scalar bands are weak)
  float sLo = specAt(0.035);
  float sMd = specAt(0.18);
  float sHi = specAt(0.80);

  // Camera + bend (mid-driven)
  float bend = (0.14 + 0.42*mid + 0.22*en + 0.18*sMd);   // visible bend
  bend = clamp(bend, 0.12, 0.70);

  float camZ = u_camZ;
  vec2 cam = position2(camZ) * bend;

  // camera "steer" (derivative along z) — sells turning without warping rings
  float dz = 0.85;
  vec2 camF = position2(camZ + dz) * bend;
  vec2 camB = position2(camZ - dz) * bend;
  vec2 dcamdz = (camF - camB) / (2.0 * dz);

  // projection tuning (legacy-ish)
  float proj = 9.5 + 4.5*mid;         // bigger = stronger bend feel
  float slip = 0.32 + 0.35*bass + 0.16*en;      // how much "steer compensation" we apply

  // Ring stack tuning
  const int STEPS = 120;
  float spacing = 1.55;               // ring spacing in world-z
  float baseZ = floor(camZ / spacing) * spacing;

  // Thickness in p-space (minimum tied to pixel size)
  float px = 2.0 / max(1.0, min(u_resolution.x, u_resolution.y));
  float epsBase = max(px * 0.9, (0.007 + 0.020*bass + 0.010*sLo));

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  // brightness scaling (no trails; audio should still pop)
  float bright = (0.75 + 1.10*bass + 0.25*en) * (1.15 + 0.35*g);

  for (int j = 1; j <= STEPS; j++){
    float i = float(j);
    float realZ = baseZ + i * spacing;
    float screenZ = realZ - camZ;     // >0
    float invZ = 1.0 / screenZ;

    // depth attenuation tuned to match the legacy “many portals visible”
    float wZ = 0.085 * invZ / (0.45 + 0.020*screenZ);
    float nearDim = mix(0.45, 1.00, smoothstep(4.0, 22.0, screenZ));
    wZ *= nearDim;

    // portal radius (classic 1/screenZ)
    float r = (0.98 + 0.08*sin(realZ*0.07)) * invZ;

    // center offset for this slice (relative to camera)
    vec2 portal = position2(realZ) * bend;
    vec2 rel = (portal - cam);
    vec2 c = rel * (proj * invZ) - dcamdz * slip;

    vec2 q = p - c;
    float dist = length(q);

    // Far rings: circles (cheaper, closer to original vibe)
    // Near rings: occasional polygon slices (legacy file did this too)
    float ringVal = 0.0;
    float eps = epsBase * (0.65 + 0.55 / (0.35 + screenZ)); // depth-thins

    if (r < 0.03) {
      float d = abs(dist - r);
      ringVal = 1.0 / (d + eps*1.25);
    } else {
      float ang = atan(q.y, q.x);
      float sliceIndex = floor(realZ / spacing);
      float group = floor(sliceIndex / 10.0);
      float idx = mod(group, 9.0);
      float N = idx <= 4.0 ? (4.0 + idx) : (12.0 - idx);

      float rp = ngonRadius(ang, r, N);
      float d = abs(dist - rp);
      ringVal = 1.0 / (d + eps);
    }

    // cap prevents blowouts (keeps stable on OBS)
    ringVal = min(ringVal, 55.0);

    // cheap legacy-like coloring
    vec3 base = 0.5 + 0.5 * sin(vec3(0.07, 0.10, 0.08) * realZ + vec3(0.0, 2.1, 4.2)
                               + (0.35 + 0.75*high) * sHi);

    vec3 col = base * ringVal * wZ * bright;

    acc += col;
    aAcc += ringVal * wZ;
  }

  // tonemap (no bloom/feedback)
  acc = acc / (1.0 + acc);

  // mild vignette
  float r2 = length(p);
  float vig = smoothstep(1.65, 0.12, r2);
  acc *= vig;

  // overlay-safe alpha: derived from ring energy (not opaque background)
  float alpha = clamp(aAcc * (0.22 + 0.70*en + 0.35*bass), 0.0, 1.0) * vig;

  fragColor = vec4(acc, alpha);
}
`;

const PASS_SPECS = [{ name: "Image", fs: TUNNEL_FS }];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function bandAvg(spec, a0, a1) {
  if (!spec || !spec.length) return NaN;
  const n = spec.length;
  let i0 = (a0 * n) | 0, i1 = (a1 * n) | 0;
  if (i0 < 0) i0 = 0;
  if (i1 > n) i1 = n;
  if (i1 <= i0) return NaN;
  let s = 0;
  for (let i = i0; i < i1; i++) s += spec[i];
  return s / (i1 - i0);
}

export class TunnelWebGL2MP {
  static id = "tunnel";
  static name = "Tunnel / Warp Speed (WebGL2 Multipass)";
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

    this._lastT = NaN;
    this._frame = 0;

    // world-z camera accumulator (dt-stable, no time*audio multiply)
    this._camZ = 0;

    // cache custom uniform location once
    this._uCamZLoc = null;

    const self = this;
    const passes = [
      {
        name: PASS_SPECS[0].name,
        fs: PASS_SPECS[0].fs,
        uniforms(gl2, program) {
          if (!self._uCamZLoc) self._uCamZLoc = gl2.getUniformLocation(program, "u_camZ");
          if (self._uCamZLoc) gl2.uniform1f(self._uCamZLoc, self._camZ);
        },
      },
    ];

    this.mp.setPasses(passes);
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
      if (frame.time && isFiniteNumber(frame.time.t)) t = frame.time.t;
      else if (isFiniteNumber(frame.t)) t = frame.t;
      else if (isFiniteNumber(frame.ts)) t = frame.ts < 1e12 ? frame.ts : frame.ts * 0.001;
    }

    let dt = NaN;
    if (frame) {
      if (isFiniteNumber(frame.dt)) dt = frame.dt;
      else if (frame.time && isFiniteNumber(frame.time.dt)) dt = frame.time.dt;
    }
    if (!isFiniteNumber(dt)) dt = isFiniteNumber(this._lastT) ? (t - this._lastT) : 1 / 60;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._lastT = t;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) frameIndex = frame.frameIndex | 0;
    else if (frame && isFiniteNumber(frame.frame)) frameIndex = frame.frame | 0;
    else frameIndex = (this._frame = (this._frame + 1) | 0);

    // Ensure audio scalars exist (some builds may not populate bands strongly)
    const spec = frame && (frame.spectrum || frame.spec);
    let bass = frame && isFiniteNumber(frame.bass) ? frame.bass : NaN;
    let mid = frame && isFiniteNumber(frame.mid) ? frame.mid : NaN;
    let high = frame && isFiniteNumber(frame.high) ? frame.high : NaN;
    let energy = frame && isFiniteNumber(frame.energy) ? frame.energy : NaN;

    if (spec && spec.length) {
      if (!isFiniteNumber(bass)) bass = bandAvg(spec, 0.00, 0.06);
      if (!isFiniteNumber(mid)) mid = bandAvg(spec, 0.10, 0.30);
      if (!isFiniteNumber(high)) high = bandAvg(spec, 0.40, 0.95);
      if (!isFiniteNumber(energy)) energy = bandAvg(spec, 0.00, 1.00);
    }

    bass = clamp01(isFiniteNumber(bass) ? bass : 0);
    mid = clamp01(isFiniteNumber(mid) ? mid : 0);
    high = clamp01(isFiniteNumber(high) ? high : 0);
    energy = clamp01(isFiniteNumber(energy) ? energy : (bass + mid + high) / 3);

    if (frame) {
      frame.bass = bass;
      frame.mid = mid;
      frame.high = high;
      frame.energy = energy;
    }

    // Legacy-ish speed in world units (camZ in shader is world-z directly)
    // Make audio *obviously* affect forward velocity without breaking dt-invariance.
    const b = Math.sqrt(bass);
    const e = Math.sqrt(energy);
    const base = 12.6;                  // "Disco tunnel" feel
    const speed = Math.min(36, base + 19.8 * b + 7.2 * e);

    this._camZ += dt * speed;
    if (this._camZ > 1e6) this._camZ -= 1e6;

    this.mp.render(frame, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
    this._uCamZLoc = null;
  }
}
