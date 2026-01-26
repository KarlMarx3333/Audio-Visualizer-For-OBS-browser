import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Galaxy (v0.2) — “actual galaxy”: volumetric nebula + crisp stars
- Nebula is a thin volumetric disc (raymarched slab) with spiral dust lanes + fBm clouds.
- Stars are procedural point-stars anchored to the disc (stable, deterministic) + faint background stars.
- Audio drives STAR BRIGHTNESS ONLY (per-band normalized + AGC on CPU). No “fade to nothing”.
*/

// Main tuning knobs live in `this._params` inside GalaxyWebGL2MP.

// Shader pass: BufferA (nebula volumetric slab).
const GALAXY_NEBULA_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_dt;
uniform float u_aspect;

uniform sampler2D iChannel0; // noise

// Look controls (tweak in JS params, not here).
uniform float u_mids;   // 0..1 (bias only; nebula still visible without audio)
uniform float u_scale;  // disc scale (larger = fills more of frame)
uniform float u_twist;  // spiral twist amount
uniform float u_core;   // core glow strength

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;
const int   ARM_COUNT = 4;

float sat(float x){ return clamp(x, 0.0, 1.0); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c,-s,s,c); }

// --- camera (tweak yaw/pitch/dist/target/fov for framing) ---
void cameraRay(vec2 uv, out vec3 ro, out vec3 rd){
  float yaw   = u_time * 0.045;
  float pitch = -0.35;     // tilt down toward the disc (ensure intersection)
  float dist  = 1.35;

  ro = vec3(sin(yaw) * dist, 0.85, cos(yaw) * dist);
  vec3 target = vec3(0.0, 0.10, 0.0);

  vec3 ww = normalize(target - ro);
  vec3 up0 = vec3(0.0, 1.0, 0.0);
  vec3 uu = normalize(cross(ww, up0));
  vec3 vv = normalize(cross(uu, ww));

  // pitch: rotate ww/vv around uu
  float cp = cos(pitch), sp = sin(pitch);
  vec3 ww2 = normalize(ww * cp + vv * sp);
  vec3 vv2 = normalize(cross(uu, ww2));

  float fov = 1.45;
  rd = normalize(uv.x * uu + uv.y * vv2 + fov * ww2);
}

// --- noise (procedural clouds / dust lanes) ---
float n2(vec2 p){
  vec2 uv = fract(p);
  vec2 w = texture(iChannel0, uv * 0.85 + 0.17).rg - 0.5;
  vec2 warp = w * 0.55;
  return texture(iChannel0, fract(uv + warp)).r;
}
float noise3(vec3 p){
  float a = n2(p.xy);
  float b = n2(p.yz);
  float c = n2(p.zx);
  return (a + b + c) * 0.3333333;
}
float fbm3(vec3 p){
  float f = 0.0;
  float a = 0.55;
  for(int i=0;i<2;i++){
    f += a * noise3(p);
    p = p * 2.02 + vec3(17.0, 9.0, 13.0);
    a *= 0.50;
  }
  return f;
}

// --- galaxy fields (disc lies on XZ, Y is thickness) ---
float armCoord(vec2 p){
  float r = length(p);
  float th = atan(p.y, p.x);
  th = (th < 0.0) ? (th + TAU) : th;
  return th + u_twist * log(r + 0.055);
}

float arms(vec2 p){
  float a = armCoord(p);
  float u = fract(a / TAU);                 // 0..1
  float seg = u * float(ARM_COUNT);
  float d = abs(fract(seg) - 0.5) * 2.0;    // 0 at arm center
  // keep arms strong but not “pie chart”
  return smoothstep(1.0, 0.0, pow(d, 1.35));
}

float discFalloff(float r){
  float d = exp(-r*r*1.10);
  float c = exp(-r*r*16.0) * u_core;
  float coreCap = smoothstep(0.02, 0.25, r);
  c *= mix(0.35, 1.0, coreCap);
  return d + c;
}

vec3 nebulaColor(float r, float aMask, float n){
  // r: 0..~1, aMask: arms emphasis
  vec3 coreWarm = vec3(1.00, 0.88, 0.72);
  vec3 armCool  = vec3(0.45, 0.70, 1.10);
  vec3 magenta  = vec3(0.95, 0.55, 0.85);

  vec3 col = mix(coreWarm, armCool, sat(r));
  col = mix(col, magenta, 0.25 * aMask);
  col *= 0.80 + 0.40 * n;
  return col;
}

void main(){
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;
  float timeWrap = mod(u_time, 1000.0);

  vec3 ro, rd;
  cameraRay(uv, ro, rd);

  // Thin volumetric slab around y=0 (increase H for thicker nebula).
  float H = 0.75;          // half-thickness (world)
  float denom = rd.y;
  if (abs(denom) < 1e-4){
    fragColor = vec4(0.0);
    return;
  }
  float t0 = (-H - ro.y) / denom;
  float t1 = ( H - ro.y) / denom;
  float tEnter = min(t0, t1);
  float tExit  = max(t0, t1);
  if (tExit <= 0.0){
    fragColor = vec4(0.0);
    return;
  }
  tEnter = max(tEnter, 0.0);

  // Raymarch inside slab; STEPS trades quality vs cost.
  const int STEPS = 12;
  float t = tEnter;
  float dt = (tExit - tEnter) / float(STEPS);

  vec3 col = vec3(0.0);
  float a = 0.0;

  // Rotate disc slowly (not audio-driven).
  float spin = u_time * 0.018;

  for(int i=0;i<STEPS;i++){
    vec3 pos = ro + rd * (t + dt * (float(i) + 0.5));

    // Disc coordinates (world -> galaxy plane).
    vec2 p = rot(spin) * (pos.xz * u_scale);
    float r = length(p);

    // Keep work bounded (galaxy radius cutoff).
    if (r < 1.60){
      float disc = discFalloff(r);
      float armM = arms(p);
      float vy = exp(-abs(pos.y) * 10.0); // vertical density

      // Cloud noise in disc volume (adds nebula structure).
      vec3 np = vec3(p * 0.95, pos.y * 3.0);
      np += vec3(0.16 * timeWrap, -0.10 * timeWrap, 0.0);

      float n = fbm3(np);
      float lanes = n;

      // Dust lanes carve out darker streaks along arms.
      float laneCut = 1.0 - 0.25 * pow(sat(lanes), 6.5);

      float density = disc * mix(0.9, 3.0, armM) * vy;
      float nLump = smoothstep(0.12, 0.75, n);
      density *= (0.45 + 2.4 * nLump);
      density *= laneCut;

      // Subtle mids bias (nebula still visible with zero audio).
      density *= (0.90 + 0.50 * u_mids);

      // Core glow volume (non-audio).
      float coreGlow = u_core * exp(-r*r*18.0) * vy;
      coreGlow *= smoothstep(0.05, 0.22, r);
      density += 0.18 * coreGlow;

      // Anti-core: thicken dust near the center to avoid a white hotspot.
      float coreDark = 1.0 + (1.0 - smoothstep(0.0, 0.25, r)) * 0.9;
      density *= coreDark;

      density = max(density, 0.0);

      // Front-to-back compositing.
      float alpha = density * 1.15 * dt;   // overall opacity (tweak for brightness)
      alpha = clamp(alpha, 0.0, 0.38);

      vec3 c = nebulaColor(sat(r / 1.15), armM, n);
      c *= exp(-density * 1.5);

      col += (1.0 - a) * c * alpha;
      a   += (1.0 - a) * alpha;

      if (a > 0.98) break;
    }

    t += dt;
  }

  fragColor = vec4(col, sat(a));
}
`;


// Shader pass: BufferB (stars + background stars).
const GALAXY_STARS_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_dt;
uniform float u_aspect;

const int BAND_COUNT = 64;
uniform float u_bands[BAND_COUNT]; // 0..1 (AGC + per-band normalized CPU)

// Look controls (tweak in JS params).
uniform float u_highs;    // 0..1 highs for twinkle
uniform float u_scale;    // disc scale
uniform float u_twist;    // spiral twist
uniform float u_core;     // core glow bias
uniform float u_starBase; // overall star alpha scale

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;
const int   ARM_COUNT = 4;

float sat(float x){ return clamp(x, 0.0, 1.0); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c,-s,s,c); }

// --- deterministic hash ---
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  float n = hash12(p);
  return vec2(n, hash12(p + n + 19.19));
}

// --- camera (match nebula) ---
void cameraRay(vec2 uv, out vec3 ro, out vec3 rd){
  float yaw   = u_time * 0.045;
  float pitch = -0.35;
  float dist  = 1.25;

  ro = vec3(sin(yaw) * dist, 0.85, cos(yaw) * dist);
  vec3 target = vec3(0.0, 0.10, 0.0);

  vec3 ww = normalize(target - ro);
  vec3 up0 = vec3(0.0, 1.0, 0.0);
  vec3 uu = normalize(cross(ww, up0));
  vec3 vv = normalize(cross(uu, ww));

  float cp = cos(pitch), sp = sin(pitch);
  vec3 ww2 = normalize(ww * cp + vv * sp);
  vec3 vv2 = normalize(cross(uu, ww2));

  float fov = 1.45;
  rd = normalize(uv.x * uu + uv.y * vv2 + fov * ww2);
}

bool intersectPlaneY0(vec3 ro, vec3 rd, out vec3 hit){
  float denom = rd.y;
  if (abs(denom) < 1e-4) return false;
  float t = -ro.y / denom;
  if (t <= 0.0) return false;
  hit = ro + t * rd;
  return true;
}

// --- galaxy mapping for band ownership (spiral arms + radial bias) ---
float armCoord(vec2 p){
  float r = length(p);
  float th = atan(p.y, p.x);
  th = (th < 0.0) ? (th + TAU) : th;
  return th + u_twist * log(r + 0.055);
}
int bandAt(vec2 p){
  float r = length(p);
  float u = fract(armCoord(p) / TAU);
  int arm = int(floor(u * float(ARM_COUNT)));
  arm = clamp(arm, 0, ARM_COUNT - 1);

  const int PER_ARM = BAND_COUNT / ARM_COUNT;
  float rr = sat(pow(r / 1.12, 0.88));
  int ridx = int(floor(rr * float(PER_ARM)));
  ridx = clamp(ridx, 0, PER_ARM - 1);

  return clamp(arm * PER_ARM + ridx, 0, BAND_COUNT - 1);
}
int armIndex(vec2 p){
  float u = fract(armCoord(p) / TAU);
  int arm = int(floor(u * float(ARM_COUNT)));
  return clamp(arm, 0, ARM_COUNT - 1);
}

vec3 armPalette(int arm, float t){
  if(arm == 0) return mix(vec3(0.70, 0.85, 1.00), vec3(0.40, 0.60, 1.10), t);
  if(arm == 1) return mix(vec3(1.00, 0.82, 0.62), vec3(0.95, 0.45, 0.85), t);
  if(arm == 2) return mix(vec3(0.78, 1.00, 0.88), vec3(0.35, 1.00, 0.95), t);
  return mix(vec3(1.00, 0.96, 0.75), vec3(0.78, 0.86, 1.00), t);
}

float discFalloff(float r){
  float d = exp(-r*r*1.15);
  float c = exp(-r*r*18.0) * u_core;
  return d + c;
}

// --- star shape: crisp core + subtle halo ---
float starShape(vec2 dp, float rad){
  float d = length(dp);
  float w = fwidth(d) + 1e-5;

  float core = exp(-pow(d / max(rad, 1e-4), 2.0) * 3.2);
  float halo = 0.35 * exp(-pow(d / max(rad * 2.6, 1e-4), 2.0) * 2.0);

  float cut = smoothstep(rad * 4.0 + w, rad * 3.0 - w, d);
  float s = (core + halo) * cut;

  // tiny diffraction spikes for bigger stars only
  if (rad > 0.010){
    float lx = abs(dp.x) / rad;
    float ly = abs(dp.y) / rad;
    float sp = 0.08 * (exp(-lx*lx*2.0) + exp(-ly*ly*2.0));
    s += sp * cut;
  }
  return s;
}

// Anchored stars on the galaxy plane (stable, deterministic).
vec4 starsLayer(vec2 p, float cellSize, float density, float seed, float rMin, float rMax, float thr){
  float ang = seed * 0.41;
  vec2 pp = rot(ang) * p;

  vec2 gv = pp / cellSize;
  vec2 cell = floor(gv);
  vec2 f = fract(gv);

  vec3 col = vec3(0.0);
  float aSum = 0.0;

  for(int oy=-1; oy<=1; oy++){
    for(int ox=-1; ox<=1; ox++){
      vec2 cc = cell + vec2(float(ox), float(oy));
      vec2 rnd = hash22(cc + seed);
      if(rnd.x > density) continue;

      vec2 rel = vec2(float(ox), float(oy)) + rnd - f;
      vec2 dp = rel * cellSize;

      vec2 starPos = rot(-ang) * ((cc + rnd) * cellSize);
      float r = length(starPos);
      if (r > 1.55) continue;

      float disc = discFalloff(r);
      float region = disc * (0.55 + 0.45 * exp(-r*r*2.0));

      int bi = bandAt(starPos);
      float b = u_bands[bi];

      // ALWAYS visible baseline; audio only boosts brightness.
      float base = 0.36; // visible even when silent
      float boost = smoothstep(thr, 1.0, b);
      float bright = base + 1.35 * boost;

      // Size distribution (many small, few big).
      float sz = mix(rMin, rMax, pow(rnd.y, 4.3));

      float s = starShape(dp, sz);

      // Per-star weight.
      float w = mix(0.60, 1.0, pow(rnd.y, 1.3));
      float alpha = u_starBase * region * w * bright * s;

      // Gentle twinkle from highs only.
      if (u_highs > 0.02 && sz < 0.010){
        float ph = 4.5 * u_time + seed * 13.0 + rnd.y * 9.7;
        float tw = 1.0 + 0.25 * u_highs * sin(ph);
        alpha *= clamp(tw, 0.90, 1.15);
      }

      int arm = armIndex(starPos);
      float t = sat(r / 1.12);
      vec3 c = armPalette(arm, t);

      // slight temperature variation
      c *= mix(0.85, 1.15, rnd.x);

      col += c * alpha;
      aSum += alpha;
    }
  }

  return vec4(col, aSum);
}

// Faint background stars anchored to the galaxy plane (moves with the disc).
vec4 planeFieldStars(vec2 p, float cellSize, float density, float seed, float size){
  vec2 g = p / cellSize;
  vec2 cell = floor(g);
  vec2 f = fract(g);

  vec3 col = vec3(0.0);
  float a = 0.0;

  for(int oy=-1; oy<=1; oy++){
    for(int ox=-1; ox<=1; ox++){
      vec2 cc = cell + vec2(float(ox), float(oy));
      vec2 rnd = hash22(cc + seed);
      if (rnd.x > density) continue;

      vec2 rel = vec2(float(ox), float(oy)) + rnd - f;
      vec2 dp = rel * cellSize;
      float s = starShape(dp, size);

      vec2 starPos = (cc + rnd) * cellSize;
      float r = length(starPos);
      if (r > 1.90) continue;

      float disc = discFalloff(r);
      float alpha = 0.16 * disc * s;

      vec3 c = mix(vec3(0.70, 0.82, 1.00), vec3(1.00, 0.90, 0.75), rnd.y);
      col += c * alpha;
      a += alpha;
    }
  }

  return vec4(col, sat(a));
}

void main(){
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;

  vec3 col = vec3(0.0);
  float a = 0.0;

  // Galaxy plane anchored stars (with perspective).
  vec3 ro, rd;
  cameraRay(uv, ro, rd);
  vec3 hit;
  if(intersectPlaneY0(ro, rd, hit)){
    vec2 p = hit.xz * u_scale;
    p = rot(u_time * 0.018) * p;

    float r = length(p);
    if (r < 1.90){
      // Background field stars anchored to the plane (no screen-space artifacts).
      vec4 bg0 = planeFieldStars(p, 0.075, 0.985, 13.0, 0.010);
      vec4 bg1 = planeFieldStars(p, 0.130, 0.970, 77.0, 0.014);
      col += bg0.rgb + bg1.rgb;
      a += 0.10 * (bg0.a + bg1.a);

      vec4 s0 = starsLayer(p, 0.018, 0.72, 17.0, 0.0009, 0.0048, 0.22);
      vec4 s1 = starsLayer(p, 0.040, 0.55, 91.0, 0.0016, 0.0105, 0.26);
      vec4 s2 = starsLayer(p, 0.085, 0.33, 203.0, 0.0032, 0.0200, 0.30);

      col += s0.rgb + s1.rgb + s2.rgb;
      a += (s0.a + s1.a + s2.a);

      // Stable core sparkle (not audio-driven).
      float core = u_core * exp(-r*r*25.0);
      col += core * vec3(1.00, 0.95, 0.80) * 0.25;
      a += core * 0.06;
    }
  }

  // Soft vignette (overlay readability).
  float v = 1.0 - 0.18 * pow(length(uv), 1.7);
  col *= v;
  a *= v;

  fragColor = vec4(min(col, vec3(4.0)), sat(a));
}
`;

// BufferC: dust scattering (white clouds that pick up star color)
const GALAXY_DUST_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;

uniform sampler2D iChannel0; // BufferA (nebula)  rgb=emissive, a=density
uniform sampler2D iChannel1; // BufferB (stars)   rgb=star light, a=star alpha
uniform sampler2D iChannel2; // noise (same "noise" you already use)

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sat(float x){ return clamp(x, 0.0, 1.0); }

// Small isotropic blur so scattering is local (not center-biased).
vec3 scatterBlur(vec2 uv, float r){
  vec2 off = vec2(r, 0.0);
  vec2 offD = vec2(r * 0.70710678, r * 0.70710678);

  const float w0 = 0.28;
  const float w1 = 0.12;
  const float w2 = 0.06;

  vec3 acc = texture(iChannel1, uv).rgb * w0;
  acc += texture(iChannel1, uv + vec2( off.x, 0.0)).rgb * w1;
  acc += texture(iChannel1, uv + vec2(-off.x, 0.0)).rgb * w1;
  acc += texture(iChannel1, uv + vec2(0.0,  off.x)).rgb * w1;
  acc += texture(iChannel1, uv + vec2(0.0, -off.x)).rgb * w1;

  acc += texture(iChannel1, uv + vec2( offD.x,  offD.y)).rgb * w2;
  acc += texture(iChannel1, uv + vec2(-offD.x,  offD.y)).rgb * w2;
  acc += texture(iChannel1, uv + vec2( offD.x, -offD.y)).rgb * w2;
  acc += texture(iChannel1, uv + vec2(-offD.x, -offD.y)).rgb * w2;

  return acc;
}

void main(){
  float timeWrap = mod(u_time, 1000.0);
  vec4 neb = texture(iChannel0, v_uv);
  vec4 star = texture(iChannel1, v_uv);

  // Treat nebula + bright stars as dust density (participating media).
  float density = max(neb.a, pow(star.a, 0.65) * 0.35);
  density = pow(sat(density), 0.55);


  // Add soft cloud breakup so it reads as "thick white dust", not a flat mask.
  float n = texture(iChannel2, v_uv * 1.35 + vec2(timeWrap * 0.01, -timeWrap * 0.008)).r;
  float breakup = smoothstep(0.18, 0.92, n);
  density *= breakup;

  // Optical depth -> transmittance
  const float DUST_K = 2.8;             // absorption/scatter scale (match in composite)
  float tau = density * DUST_K;
  float T = exp(-tau);

  // Incident light from stars (blurred) so clouds carry star color.
  float blurR = mix(0.0015, 0.012, density);
  vec3 illum = scatterBlur(v_uv, blurR);

  float I = luma(illum);

  // White clouds that absorb/take on star color:
  // start near white (luma), then tint toward star color.
  const float TINT = 0.05;               // 0=white only, 1=fully colored by stars
  vec3 white = vec3(I);
  vec3 tinted = mix(white, illum, TINT);

  // Scattering intensity: more when medium is thick AND stars are bright.
  float scatter = (1.0 - T) * sat(I * 3.0);

  // Tiny base term so clouds exist even with dim stars (optional; set to 0.0 if you hate it)
  scatter += 0.03 * density;

  vec3 col = tinted * (0.95 * scatter);

  // Keep overlay-safe (don’t hard-opaque the screen)
  float a = sat(scatter) * 0.65;

  fragColor = vec4(col, a);
}
`;


// Shader pass: Image (composite + tone curve).
const GALAXY_COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D iChannel0; // BufferA nebula (a=density)
uniform sampler2D iChannel1; // BufferB stars
uniform sampler2D iChannel2; // BufferC dust scattering

float sat(float x){ return clamp(x, 0.0, 1.0); }

void main(){
  vec4 neb = texture(iChannel0, v_uv);
  vec4 stars = texture(iChannel1, v_uv);
  vec4 dust = texture(iChannel2, v_uv);

  vec3 nebCol = neb.rgb + dust.rgb;
  float nebA = sat(max(neb.a, dust.a));

  vec3 finalRGB = mix(stars.rgb, nebCol, nebA);
  finalRGB += stars.rgb * nebA * 0.5;

  float outA = max(nebA * 1.5, stars.a);
  fragColor = vec4(pow(finalRGB, vec3(0.85)), sat(outA));
}
`;


// Multipass layout: nebula -> stars -> composite.
const PASS_SPECS = [
  { name: "BufferA", fs: GALAXY_NEBULA_FS, inputs: { 0: "noise" } },
  { name: "BufferB", fs: GALAXY_STARS_FS },
  { name: "BufferC", fs: GALAXY_DUST_FS, inputs: { 0: "BufferA", 1: "BufferB", 2: "noise" } },
  { name: "Image",   fs: GALAXY_COMPOSITE_FS, inputs: { 0: "BufferA", 1: "BufferB", 2: "BufferC" } },
];


function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
function expSmoothingK(dt, tau) {
  if (!(dt > 0) || !(tau > 1e-6)) return 1;
  const k = 1 - Math.exp(-dt / tau);
  return k > 1 ? 1 : (k < 0 ? 0 : k);
}

// Build a log-spaced band map (audio spectrum -> 64 bands).
function computeLogBandsMap({ bandCount, specLen, samplerate, fftSize, fMin = 20, fMax = 20000 }) {
  const nyq = samplerate > 0 ? samplerate * 0.5 : 24000;
  const hi = Math.min(fMax, nyq * 0.98);
  const lo = Math.max(1, Math.min(fMin, hi * 0.5));
  const ratio = hi / lo;

  const startBins = new Uint16Array(bandCount);
  const endBins = new Uint16Array(bandCount);

  for (let i = 0; i < bandCount; i++) {
    const a = i / bandCount;
    const b = (i + 1) / bandCount;
    const f0 = lo * Math.pow(ratio, a);
    const f1 = lo * Math.pow(ratio, b);
    let s = Math.floor((f0 * fftSize) / samplerate);
    let e = Math.floor((f1 * fftSize) / samplerate);
    if (s < 1) s = 1; // skip DC
    if (e < s) e = s;
    if (e > specLen - 1) e = specLen - 1;
    startBins[i] = s;
    endBins[i] = e;
  }
  return { startBins, endBins };
}

// Average a spectrum range (safe for non-finite values).
function avgRange(arr, s, e) {
  let sum = 0;
  let n = 0;
  for (let i = s; i <= e; i++) {
    const v = arr[i];
    sum += isFiniteNumber(v) ? v : 0;
    n++;
  }
  return n > 0 ? (sum / n) : 0;
}

export class GalaxyWebGL2MP {
  static id = "galaxy";
  static name = "Galaxy (Nebula + Stars by Band) (WebGL2 Multipass)";
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

    // Band pipeline state (no per-frame allocations).
    this.BAND_COUNT = 64;
    this._bandStart = new Uint16Array(this.BAND_COUNT);
    this._bandEnd = new Uint16Array(this.BAND_COUNT);

    this._Ei = new Float32Array(this.BAND_COUNT);     // fast envelope
    this._floor = new Float32Array(this.BAND_COUNT);  // noise floor
    this._ref = new Float32Array(this.BAND_COUNT);    // peak/scale ref
    this._bands = new Float32Array(this.BAND_COUNT);  // final bi (0..1)

    this._mapKey = "";
    this._L = 0.0;      // loudness (slow)
    this._g = 1.0;      // AGC gain (slow)
    this._mids = 0.0;
    this._highs = 0.0;

    this._locA = null;
    this._locB = null;

    // Tunables: primary look/feel knobs (safe to tweak live).
    this._params = {
      // log-band envelopes (seconds; lower = snappier)
      bandAttack: 0.030,
      bandRelease: 0.220,

      // floor/ref tracking (seconds; higher = slower)
      floorDown: 0.60,
      floorUp: 8.00,
      refDecay: 1.75,

      // AGC (slow normalization across tracks)
      loudAttack: 0.55,
      loudRelease: 0.90,
      gainAttack: 0.75,
      gainRelease: 1.00,
      target: 0.25,
      gainMin: 0.55,
      gainMax: 3.50,

      // shader look (geometry + brightness)
      scale: 0.95,
      twist: 7.2,
      core: 1.25,
      starBase: 1.55,
    };

    const self = this;
    const passes = PASS_SPECS.map((p) => {
      const spec = { ...p };
      spec.uniforms = function (gl2, program) {
        // Both BufferA and BufferB consume the same uniform set.
        if (spec.name === "BufferA") {
          if (!self._locA) self._locA = self._resolveLocs(gl2, program);
          self._applyUniforms(gl2, self._locA);
        } else if (spec.name === "BufferB") {
          if (!self._locB) self._locB = self._resolveLocs(gl2, program);
          self._applyUniforms(gl2, self._locB);
        }
      };
      return spec;
    });

    this.mp.setPasses(passes);

    this._lastT = NaN;
    this._frame = 0;
  }

  // Cache custom uniform locations per program.
  _resolveLocs(gl2, program) {
    return {
      u_bands: gl2.getUniformLocation(program, "u_bands"),
      u_highs: gl2.getUniformLocation(program, "u_highs"),
      u_mids: gl2.getUniformLocation(program, "u_mids"),
      u_scale: gl2.getUniformLocation(program, "u_scale"),
      u_twist: gl2.getUniformLocation(program, "u_twist"),
      u_core: gl2.getUniformLocation(program, "u_core"),
      u_starBase: gl2.getUniformLocation(program, "u_starBase"),
    };
  }

  // Push CPU-side band data + look params into shaders.
  _applyUniforms(gl2, loc) {
    if (!loc) return;

    if (loc.u_bands) gl2.uniform1fv(loc.u_bands, this._bands);
    if (loc.u_highs) gl2.uniform1f(loc.u_highs, this._highs);
    if (loc.u_mids) gl2.uniform1f(loc.u_mids, this._mids);

    const P = this._params;
    if (loc.u_scale) gl2.uniform1f(loc.u_scale, P.scale);
    if (loc.u_twist) gl2.uniform1f(loc.u_twist, P.twist);
    if (loc.u_core) gl2.uniform1f(loc.u_core, P.core);
    if (loc.u_starBase) gl2.uniform1f(loc.u_starBase, P.starBase);
  }

  // Rebuild log-band map when FFT settings change.
  _ensureBandMap(frame) {
    const spec = frame && frame.spectrum;
    const specLen = spec && spec.length ? (spec.length | 0) : 0;
    const samplerate = frame && isFiniteNumber(frame.samplerate) ? frame.samplerate : 48000;
    const fftSize = frame && isFiniteNumber(frame.fftSize) ? frame.fftSize : 2048;

    const key = `${specLen}:${samplerate}:${fftSize}`;
    if (key === this._mapKey) return;

    this._mapKey = key;

    if (specLen <= 4 || !(samplerate > 0) || !(fftSize > 0)) {
      for (let i = 0; i < this.BAND_COUNT; i++) {
        this._bandStart[i] = 1;
        this._bandEnd[i] = 1;
      }
      return;
    }

    const map = computeLogBandsMap({
      bandCount: this.BAND_COUNT,
      specLen,
      samplerate,
      fftSize,
      fMin: 20,
      fMax: 20000,
    });

    this._bandStart.set(map.startBins);
    this._bandEnd.set(map.endBins);

    // Reset gently when mapping changes
    this._L = 0.0;
    this._g = 1.0;
    this._mids = 0.0;
    this._highs = 0.0;
    for (let i = 0; i < this.BAND_COUNT; i++) {
      this._Ei[i] = 0;
      this._floor[i] = 0;
      this._ref[i] = 1e-3;
      this._bands[i] = 0;
    }
  }

  // Update per-band envelopes + AGC (dt-stable).
  _updateBands(frame, dt) {
    const spec = frame && frame.spectrum;
    if (!spec || !spec.length) {
      // ease toward zero energy; visuals remain (baseline in shader)
      const k = expSmoothingK(dt, 0.25);
      for (let i = 0; i < this.BAND_COUNT; i++) {
        this._Ei[i] *= (1 - k);
        this._bands[i] *= (1 - k);
      }
      this._L *= (1 - k);
      this._g = 1.0 + (this._g - 1.0) * (1 - k);
      this._mids *= (1 - k);
      this._highs *= (1 - k);
      return;
    }

    const P = this._params;

    const kAtk = expSmoothingK(dt, P.bandAttack);
    const kRel = expSmoothingK(dt, P.bandRelease);

    const kFloorDown = expSmoothingK(dt, P.floorDown);
    const kFloorUp = expSmoothingK(dt, P.floorUp);
    const decayRef = Math.exp(-dt / Math.max(1e-6, P.refDecay));

    let sumN = 0;
    const eps = 1e-6;

    for (let i = 0; i < this.BAND_COUNT; i++) {
      const s = this._bandStart[i] | 0;
      const e = this._bandEnd[i] | 0;
      const raw = avgRange(spec, s, e);

      // Fast envelope (attack/release)
      const prevE = this._Ei[i];
      const k = raw > prevE ? kAtk : kRel;
      const Ei = prevE + (raw - prevE) * k;
      this._Ei[i] = Ei;

      // Floor estimate (tracks down faster than up)
      const prevF = this._floor[i];
      const kf = Ei < prevF ? kFloorDown : kFloorUp;
      const Fi = prevF + (Ei - prevF) * kf;
      this._floor[i] = Fi;

      const adj = Ei > Fi ? (Ei - Fi) : 0;

      // Reference peak with decay
      const prevR = this._ref[i];
      const Ri = adj > prevR ? adj : (prevR * decayRef);
      this._ref[i] = Ri > eps ? Ri : eps;

      // Per-band normalized (0..1)
      const ni = clamp01(adj / (Ri + eps));
      sumN += ni;

      this._bands[i] = ni;
    }

    const meanN = sumN / this.BAND_COUNT;

    // Slow loudness + AGC (global gain).
    const kLA = expSmoothingK(dt, P.loudAttack);
    const kLR = expSmoothingK(dt, P.loudRelease);
    const kL = meanN > this._L ? kLA : kLR;
    this._L = this._L + (meanN - this._L) * kL;

    let gT = P.target / (this._L + eps);
    if (gT < P.gainMin) gT = P.gainMin;
    if (gT > P.gainMax) gT = P.gainMax;

    const kGA = expSmoothingK(dt, P.gainAttack);
    const kGR = expSmoothingK(dt, P.gainRelease);
    const kG = gT > this._g ? kGA : kGR;
    this._g = this._g + (gT - this._g) * kG;

    // Apply AGC to bands and compute mids/highs.
    const per = this.BAND_COUNT;
    const i0 = Math.floor(per * 0.12);
    const i1 = Math.floor(per * 0.55);
    let mids = 0, highs = 0, mN = 0, hN = 0;

    for (let i = 0; i < this.BAND_COUNT; i++) {
      const bi = clamp01(this._bands[i] * this._g);
      this._bands[i] = bi;

      if (i >= i0 && i < i1) { mids += bi; mN++; }
      else if (i >= i1) { highs += bi; hN++; }
    }

    const midsT = mN > 0 ? (mids / mN) : 0;
    const highsT = hN > 0 ? (highs / hN) : 0;

    const kMH = expSmoothingK(dt, 0.25);
    this._mids = this._mids + (midsT - this._mids) * kMH;
    this._highs = this._highs + (highsT - this._highs) * kMH;
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

    this._ensureBandMap(frame);
    this._updateBands(frame, dt);

    // Render multipass (uniforms bound in pass callbacks).
    this.mp.render(frame, t, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
  }
}
