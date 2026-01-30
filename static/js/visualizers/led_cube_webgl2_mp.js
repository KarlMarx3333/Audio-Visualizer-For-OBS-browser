import { MultiPassWebGL2 } from "/static/js/webgl/multipass_webgl2.js";

/*
Light-Panel Cube (WebGL2 Multipass)

- Renders only the OUTSIDE surface of a rotating cube (analytic ray-box intersection).
- Each face is subdivided into an NxN grid of LED-like tiles with clear gaps.
- Each tile is assigned a stable band from log-spaced FFT bands (with slight deterministic jitter).
- CPU-side audio: log bands -> per-band normalization -> slow AGC -> per-band energies (0..1).
- Shader: tile brightness uses logistic-style compression + local glow; transients add subtle wobble and a scan wave.

Overlay-safe: background alpha = 0; cube remains readable even in silence.
*/

const BAND_COUNT = 64;
const DEFAULT_TILES_N = 14; // tiles per face edge (NxN). 12-18 are reasonable.
const TIME_WRAP_S = 10000;
const TAU = Math.PI * 2;

const LED_CUBE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_aspect;
uniform float u_time;
uniform float u_dt;

// Scalar audio features (from frame.* via MultiPassWebGL2)
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_energy;
uniform float u_gain;

// 1D spectrum texture (R32F, 1 x N)
uniform sampler2D u_specTex;
uniform int u_specLen;

// Custom uniforms (set by this visualizer)
uniform float u_transient; // 0..1
uniform float u_wavePos;    // 0..1
uniform float u_waveOn;     // 0..1
uniform float u_tiles;      // tiles per face edge
uniform float u_rotX;       // radians
uniform float u_rotY;       // radians

// --- helpers ---

float saturate(float x){ return clamp(x, 0.0, 1.0); }

float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Sample 1D audio texture at integer index.
float specAt(int idx){
  int L = max(u_specLen, 1);
  idx = clamp(idx, 0, L - 1);
  float u = (float(idx) + 0.5) / float(L);
  return texture(u_specTex, vec2(u, 0.5)).r;
}

// Logistic-style compression normalized so 0->0 and 1->1.
float logistic01(float x, float a, float c){
  x = saturate(x);
  float lo = 1.0 / (exp(-a * (0.0 - c)) + 1.0);
  float hi = 1.0 / (exp(-a * (1.0 - c)) + 1.0);
  float y  = 1.0 / (exp(-a * (x   - c)) + 1.0);
  return (y - lo) / max(hi - lo, 1e-6);
}

mat3 rotX(float a){
  float s = sin(a), c = cos(a);
  return mat3(1,0,0, 0,c,-s, 0,s,c);
}
mat3 rotY(float a){
  float s = sin(a), c = cos(a);
  return mat3(c,0,s, 0,1,0, -s,0,c);
}

// Ray-box intersection against axis-aligned box centered at origin with half-size b.
// Returns tNear (entry) in t.x and tFar (exit) in t.y.
vec2 rayBox(vec3 ro, vec3 rd, vec3 b){
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-b - ro) * inv;
  vec3 t1 = ( b - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(tn, tf);
}

// Determine face normal for point on box surface.
vec3 boxNormal(vec3 p, vec3 b){
  vec3 a = abs(p);
  vec3 n = vec3(0.0);
  if (a.x > a.y && a.x > a.z) n = vec3(sign(p.x), 0.0, 0.0);
  else if (a.y > a.z)        n = vec3(0.0, sign(p.y), 0.0);
  else                       n = vec3(0.0, 0.0, sign(p.z));
  return n;
}

// Map point on face to local face UV (0..1) and face id 0..5.
// Face order: +X,-X,+Y,-Y,+Z,-Z
void faceUV(vec3 p, vec3 n, vec3 b, out vec2 uv, out int faceId){
  vec3 q = p / b; // -1..1 on surface
  if (n.x > 0.5)      { faceId = 0; uv = vec2( q.z,  q.y); }
  else if (n.x < -0.5){ faceId = 1; uv = vec2(-q.z,  q.y); }
  else if (n.y > 0.5){ faceId = 2; uv = vec2( q.x, -q.z); }
  else if (n.y < -0.5){faceId = 3; uv = vec2( q.x,  q.z); }
  else if (n.z > 0.5){ faceId = 4; uv = vec2( q.x,  q.y); }
  else               { faceId = 5; uv = vec2(-q.x,  q.y); }
  uv = uv * 0.5 + 0.5;
}

// Palette: warm (bass) -> cool (highs), not rainbow.
vec3 bandColor(float t){
  vec3 warm = vec3(1.00, 0.38, 0.10);
  vec3 mid  = vec3(0.15, 0.95, 1.00);
  vec3 cool = vec3(0.90, 0.18, 1.00);
  float a = smoothstep(0.0, 0.55, t);
  float b = smoothstep(0.45, 1.0, t);
  vec3 c0 = mix(warm, mid, a);
  return mix(c0, cool, b);
}

// Signed distance to a rectangle centered at 0.5 in cell-space (0..1).
float sdTile(vec2 f, float halfSize){
  vec2 q = abs(f - 0.5) - vec2(halfSize);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

void main(){
  // Screen -> camera ray
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_aspect;

  vec3 ro = vec3(0.0, 0.0, -2.35);
  vec3 rd = normalize(vec3(uv, 1.55));

  // Rotation: steady spin with time-varying rates (not audio-driven)
  float kick = saturate(u_transient);
  float ax = u_rotX;
  float ay = u_rotY;
  mat3 R = rotY(ay) * rotX(ax);

  // Transform ray into cube local space
  vec3 rro = transpose(R) * ro;
  vec3 rrd = transpose(R) * rd;

  vec3 b = vec3(0.55);
  vec2 hit = rayBox(rro, rrd, b);
  float tn = hit.x;
  float tf = hit.y;

  if (tf <= max(tn, 0.0)) {
    fragColor = vec4(0.0);
    return;
  }

  float t = tn > 0.0 ? tn : tf;
  vec3 p = rro + rrd * t;
  vec3 n = boxNormal(p, b);

  // Face UV + tile coords
  vec2 fuv;
  int faceId;
  faceUV(p, n, b, fuv, faceId);

  float tilesF = max(2.0, floor(u_tiles + 0.5));
  vec2 g = fuv * tilesF;
  vec2 cell = floor(g);
  vec2 f = fract(g);

  // Gap/border (AA in cell-space)
  vec2 fw = fwidth(g);
  float aa = max(fw.x, fw.y);

  float gap = 0.09;              // physical gap between panels
  float halfSize = 0.5 - gap;    // tile interior half-size in cell-space
  float dTile = sdTile(f, halfSize);

  // Tile mask: 1 inside panel, 0 in gaps.
  float tile = 1.0 - smoothstep(0.0, aa * 1.25, dTile);
  float gapMask = 1.0 - tile;

  // Stable tile id -> band index (monotonic distribution + jitter)
  float Nf = tilesF;
  int N = int(Nf);
  int xi = int(cell.x);
  int yi = int(cell.y);
  xi = clamp(xi, 0, N - 1);
  yi = clamp(yi, 0, N - 1);

  int tileId = faceId * N * N + yi * N + xi;
  int tileCount = 6 * N * N;

  float u01 = (float(tileId) + 0.5) / float(max(tileCount, 1));
  float h = hash11(float(tileId) + 17.0 * float(faceId));
  float jitter = (h - 0.5) * 6.0; // +/- ~3 bands

  float bandF = u01 * float(${BAND_COUNT - 1}) + jitter;
  int band = int(clamp(floor(bandF + 0.5), 0.0, float(${BAND_COUNT - 1})));

  float e = specAt(band);

  // Band-dependent "feel": bass slower/larger glow, highs quicker/sharper.
  float bt = float(band) / float(${BAND_COUNT - 1});
  float bassness = 1.0 - smoothstep(0.00, 0.30, bt);
  float highness = smoothstep(0.60, 1.00, bt);

  // Logistic compression: lifts quiet detail, avoids constant full-white
  float a = mix(16.0, 22.0, highness);
  float c = mix(0.42, 0.55, highness);
  float ec = logistic01(e, a, c);

  // Tile emissive strength
  float tileLum = ec;
  tileLum *= 0.55 + 0.45 * tile;

  // Local glow based on distance to tile edge (bigger for bass)
  float edgeK = mix(8.0, 14.0, highness);
  float haloK = mix(5.0, 9.0, bassness);
  float edge = exp(-abs(dTile) * edgeK);
  float halo = exp(-max(dTile, 0.0) * haloK);

  // Traveling scan wave (per-face UV space)
  float wave = 0.0;
  if (u_waveOn > 0.5) {
    float w = exp(-pow((fuv.y - u_wavePos) * 10.0, 2.0));
    wave = w;
  }

  // Color: band palette + transient white pop
  vec3 led = bandColor(bt);
  led = mix(led, vec3(1.0), 0.10 + 0.25 * kick);

  float pulse = 1.0 + 0.25 * bassness * sin(u_time * 3.2 + 6.2831 * u01);
  float shimmer = 1.0 + 0.18 * highness * sin(u_time * 18.0 + 40.0 * h);

  float emissiveStrength = tileLum * (0.80 + 0.55 * edge) * pulse * shimmer;
  emissiveStrength += 0.55 * wave * (0.35 + 0.65 * tile);

  // Base material (keeps cube readable even in silence)
  vec3 lightDir = normalize(vec3(-0.35, 0.75, -0.20));
  float ndl = saturate(dot(n, lightDir));
  vec3 baseCol = vec3(0.03, 0.035, 0.045);
  baseCol += 0.02 * vec3(float(faceId) * 0.07, 0.0, float(faceId) * 0.03);

  // Slightly brighter in gaps so segmentation reads
  float baseMix = mix(0.35, 0.85, gapMask);
  vec3 base = baseCol * (0.20 + 0.85 * ndl) * baseMix;

  // Spec highlight (subtle)
  vec3 vdir = normalize(-rrd);
  vec3 hdir = normalize(lightDir + vdir);
  float spec = pow(saturate(dot(n, hdir)), 64.0);
  base += vec3(0.12) * spec * (0.20 + 0.40 * kick);

  // Final composite on surface
  vec3 emissive = led * emissiveStrength * tile;
  emissive += led * (0.35 * halo) * tileLum;

  // Control brightness so it doesn't live at full-white
  float global = 0.85 + 0.35 * saturate(u_energy);
  vec3 col = base + emissive * global;

  // Alpha: cube mask + a touch of emissive halo
  float lum = max(col.r, max(col.g, col.b));
  float alpha = 0.55;
  alpha += 0.25 * saturate(lum);
  alpha += 0.10 * halo * saturate(tileLum);
  alpha = saturate(alpha);

  fragColor = vec4(col, alpha);
}
`;

const PASS_SPECS = [
  { name: "Image", fs: LED_CUBE_FS },
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

// Build a log-spaced band map (audio spectrum -> BAND_COUNT bands).
function computeLogBandsMap({ bandCount, specLen, samplerate, fftSize, fMin = 20, fMax = 18000 }) {
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

export class LedCubeWebGL2MP {
  static id = "led_cube";
  static name = "Light-Panel Cube (Audio Tiles) (WebGL2 Multipass)";
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
    this.BAND_COUNT = BAND_COUNT;
    this._bandStart = new Uint16Array(this.BAND_COUNT);
    this._bandEnd = new Uint16Array(this.BAND_COUNT);

    this._Ei = new Float32Array(this.BAND_COUNT);     // fast envelope
    this._floor = new Float32Array(this.BAND_COUNT);  // noise floor
    this._ref = new Float32Array(this.BAND_COUNT);    // peak/scale ref
    this._bands = new Float32Array(this.BAND_COUNT);  // final bi (0..1)

    this._mapKey = "";
    this._L = 0.0; // loudness
    this._g = 1.0; // AGC gain

    this._bass = 0.0;
    this._mid = 0.0;
    this._high = 0.0;
    this._energy = 0.0;

    this._loudSlow = 0.0;
    this._transient = 0.0;

    // Scan wave state
    this._waveOn = 0.0;
    this._wavePos = 0.0;
    this._waveT = 999.0;
    this._waveCooldown = 0.0;

    // Rotation phases (dt-driven, wrapped)
    this._rotX = 0.0;
    this._rotY = 0.0;
    this._rotModX = 0.0;
    this._rotModD = 1.7;

    // Tunables (safe ranges)
    this._params = {
      tilesN: DEFAULT_TILES_N,

      // band envelopes
      bandAttack: 0.020,
      bandReleaseLow: 0.260,  // bass release (slower)
      bandReleaseHigh: 0.090, // high release (faster)

      // floor/ref tracking
      floorDown: 0.70,
      floorUp: 8.00,
      refDecay: 1.60,

      // AGC
      loudAttack: 0.55,
      loudRelease: 0.90,
      gainAttack: 0.80,
      gainRelease: 1.10,
      target: 0.30,
      gainMin: 0.55,
      gainMax: 3.00,

      // transient shaping
      transientBoost: 2.6,
      transientAttack: 0.012,
      transientRelease: 0.11,
      loudSlowTau: 0.55,

      // scan wave
      waveDuration: 0.55,
      waveWidth: 0.10,
      waveCooldown: 0.18,
      waveThreshold: 0.55,
    };

    // Frame proxy (no allocations)
    this._frameProxy = {
      frameId: 0,
      ts: 0,
      tsMs: 0,
      channels: 1,
      rms: null,
      peak: null,
      corr: null,
      bass: 0,
      mid: 0,
      high: 0,
      energy: 0,
      gain: 1,
      overlay: true,
      waveLR: null,
      spectrum: this._bands,
      wave: null,
      samplerate: 48000,
      fftSize: 2048,
      dt: 1 / 60,
      t: 0,
      time: { t: 0, dt: 1 / 60 },
      width: 0,
      height: 0,
      dpr: 1,
      viewport: { w: 0, h: 0, dpr: 1 },
    };

    // Custom uniforms
    this._locImage = null;

    const self = this;
    const passes = PASS_SPECS.map((p) => {
      const spec = { ...p };
      spec.uniforms = function (gl2, program) {
        if (!self._locImage) self._locImage = self._resolveLocs(gl2, program);
        self._applyUniforms(gl2, self._locImage);
      };
      return spec;
    });

    this.mp.setPasses(passes);

    this._lastT = NaN;
    this._frame = 0;
  }

  _resolveLocs(gl2, program) {
    return {
      u_transient: gl2.getUniformLocation(program, "u_transient"),
      u_wavePos: gl2.getUniformLocation(program, "u_wavePos"),
      u_waveOn: gl2.getUniformLocation(program, "u_waveOn"),
      u_tiles: gl2.getUniformLocation(program, "u_tiles"),
      u_rotX: gl2.getUniformLocation(program, "u_rotX"),
      u_rotY: gl2.getUniformLocation(program, "u_rotY"),
    };
  }

  _applyUniforms(gl2, loc) {
    if (!loc) return;
    const P = this._params;
    if (loc.u_transient) gl2.uniform1f(loc.u_transient, this._transient);
    if (loc.u_wavePos) gl2.uniform1f(loc.u_wavePos, this._wavePos);
    if (loc.u_waveOn) gl2.uniform1f(loc.u_waveOn, this._waveOn);
    if (loc.u_tiles) gl2.uniform1f(loc.u_tiles, P.tilesN);
    if (loc.u_rotX) gl2.uniform1f(loc.u_rotX, this._rotX);
    if (loc.u_rotY) gl2.uniform1f(loc.u_rotY, this._rotY);
  }

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
      fMax: 18000,
    });

    this._bandStart.set(map.startBins);
    this._bandEnd.set(map.endBins);

    // Reset gently when mapping changes
    this._L = 0.0;
    this._g = 1.0;
    this._bass = this._mid = this._high = this._energy = 0.0;
    this._loudSlow = 0.0;
    this._transient = 0.0;

    for (let i = 0; i < this.BAND_COUNT; i++) {
      this._Ei[i] = 0;
      this._floor[i] = 0;
      this._ref[i] = 1e-3;
      this._bands[i] = 0;
    }
  }

  _updateBands(frame, dt) {
    const spec = frame && frame.spectrum;
    const specLen = spec && spec.length ? (spec.length | 0) : 0;

    const P = this._params;
    const eps = 1e-6;

    // Use UI gain as an input scale; keep it sane.
    let userGain = (frame && isFiniteNumber(frame.gain)) ? frame.gain : 1.0;
    if (!(userGain > 0)) userGain = 1.0;
    if (userGain > 6.0) userGain = 6.0;

    if (!spec || specLen <= 0) {
      const k = expSmoothingK(dt, 0.25);
      for (let i = 0; i < this.BAND_COUNT; i++) {
        this._Ei[i] *= (1 - k);
        this._bands[i] *= (1 - k);
      }
      this._L *= (1 - k);
      this._g = 1.0 + (this._g - 1.0) * (1 - k);
      this._bass *= (1 - k);
      this._mid *= (1 - k);
      this._high *= (1 - k);
      this._energy *= (1 - k);
      return;
    }

    const kAtk = expSmoothingK(dt, P.bandAttack);

    const kFloorDown = expSmoothingK(dt, P.floorDown);
    const kFloorUp = expSmoothingK(dt, P.floorUp);
    const decayRef = Math.exp(-dt / Math.max(1e-6, P.refDecay));

    let sumN = 0;

    for (let i = 0; i < this.BAND_COUNT; i++) {
      const s = this._bandStart[i] | 0;
      const e = this._bandEnd[i] | 0;

      const band01 = i / (this.BAND_COUNT - 1);
      const relTau = P.bandReleaseLow + (P.bandReleaseHigh - P.bandReleaseLow) * Math.pow(band01, 0.85);
      const kRel = expSmoothingK(dt, relTau);

      const raw = avgRange(spec, s, e) * userGain;

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

      const ni = clamp01(adj / (Ri + eps));
      sumN += ni;
      this._bands[i] = ni;
    }

    const meanN = sumN / this.BAND_COUNT;

    // Slow loudness + AGC
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

    // Apply AGC and compute macro bands
    const per = this.BAND_COUNT;
    const iBassEnd = Math.floor(per * 0.18);
    const iMidEnd = Math.floor(per * 0.62);

    let bass = 0, mid = 0, high = 0;
    let bN = 0, mN = 0, hN = 0;
    let energy = 0;

    for (let i = 0; i < this.BAND_COUNT; i++) {
      const bi = clamp01(this._bands[i] * this._g);
      this._bands[i] = bi;
      energy += bi;

      if (i < iBassEnd) { bass += bi; bN++; }
      else if (i < iMidEnd) { mid += bi; mN++; }
      else { high += bi; hN++; }
    }

    const bassT = bN > 0 ? bass / bN : 0;
    const midT = mN > 0 ? mid / mN : 0;
    const highT = hN > 0 ? high / hN : 0;
    const energyT = energy / this.BAND_COUNT;

    const kM = expSmoothingK(dt, 0.20);
    this._bass += (bassT - this._bass) * kM;
    this._mid  += (midT - this._mid) * kM;
    this._high += (highT - this._high) * kM;
    this._energy += (energyT - this._energy) * kM;

    // Transient hint: loudness (low-mid) minus slower loudness
    const loudFast = clamp01(bassT * 0.65 + midT * 0.35);
    const kLS = expSmoothingK(dt, P.loudSlowTau);
    this._loudSlow += (loudFast - this._loudSlow) * kLS;

    const tr = Math.max(0, loudFast - this._loudSlow) * P.transientBoost;

    // Shape transient with fast attack / slower release
    const kTA = expSmoothingK(dt, P.transientAttack);
    const kTR = expSmoothingK(dt, P.transientRelease);
    const kT = tr > this._transient ? kTA : kTR;
    this._transient += (tr - this._transient) * kT;
    this._transient = clamp01(this._transient);

    // Scan wave trigger
    if (this._waveCooldown > 0) this._waveCooldown = Math.max(0, this._waveCooldown - dt);

    if (this._waveOn > 0.5) {
      this._waveT += dt;
      const dur = Math.max(0.1, P.waveDuration);
      this._wavePos = this._waveT / dur;
      if (this._wavePos > 1.2) {
        this._waveOn = 0.0;
        this._wavePos = 0.0;
        this._waveT = 999.0;
      }
    } else {
      if (this._waveCooldown <= 0 && this._transient >= P.waveThreshold) {
        this._waveOn = 1.0;
        this._waveT = 0.0;
        this._wavePos = 0.0;
        this._waveCooldown = P.waveCooldown;
      }
    }
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

    // Time-varying rotation rates (0.2..0.6), dt-driven, never equal.
    this._rotModX = (this._rotModX + dt * 0.07) % TAU;
    this._rotModD = (this._rotModD + dt * 0.11) % TAU;
    const sx = 0.2 + 0.34 * (0.5 + 0.5 * Math.sin(this._rotModX)); // 0.2..0.54
    const delta = 0.02 + 0.04 * (0.5 + 0.5 * Math.sin(this._rotModD)); // 0.02..0.06
    const sy = sx + delta; // 0.22..0.60 (always != sx)
    this._rotX = (this._rotX + dt * sx) % TAU;
    this._rotY = (this._rotY + dt * sy) % TAU;

    let frameIndex = 0;
    if (frame && isFiniteNumber(frame.frameIndex)) frameIndex = frame.frameIndex | 0;
    else if (frame && isFiniteNumber(frame.frame)) frameIndex = frame.frame | 0;
    else frameIndex = (this._frame = (this._frame + 1) | 0);

    const tWrapped = TIME_WRAP_S > 0 ? (t % TIME_WRAP_S) : t;

    this._ensureBandMap(frame);
    this._updateBands(frame, dt);

    // Build proxy frame (no allocations)
    const fp = this._frameProxy;
    fp.frameId = frame && isFiniteNumber(frame.frameId) ? frame.frameId | 0 : frameIndex;
    fp.ts = frame && isFiniteNumber(frame.ts) ? frame.ts : 0;
    fp.tsMs = frame && isFiniteNumber(frame.tsMs) ? frame.tsMs : 0;

    fp.channels = frame && isFiniteNumber(frame.channels) ? frame.channels | 0 : 1;
    fp.rms = frame ? frame.rms : null;
    fp.peak = frame ? frame.peak : null;
    fp.corr = frame ? frame.corr : null;

    fp.bass = this._bass;
    fp.mid = this._mid;
    fp.high = this._high;
    fp.energy = this._energy;

    // We applied UI gain into band extraction; keep shader gain neutral.
    fp.gain = 1.0;

    fp.overlay = !!(frame && frame.overlay);
    fp.waveLR = null;

    fp.spectrum = this._bands;
    fp.wave = null;

    fp.samplerate = frame && isFiniteNumber(frame.samplerate) ? frame.samplerate : 48000;
    fp.fftSize = frame && isFiniteNumber(frame.fftSize) ? (frame.fftSize | 0) : 2048;

    fp.dt = dt;
    fp.t = tWrapped;
    fp.time.t = tWrapped;
    fp.time.dt = dt;

    fp.width = frame && isFiniteNumber(frame.width) ? frame.width : 0;
    fp.height = frame && isFiniteNumber(frame.height) ? frame.height : 0;
    fp.dpr = frame && isFiniteNumber(frame.dpr) ? frame.dpr : 1;

    fp.viewport.w = frame && frame.viewport && isFiniteNumber(frame.viewport.w) ? frame.viewport.w : fp.width;
    fp.viewport.h = frame && frame.viewport && isFiniteNumber(frame.viewport.h) ? frame.viewport.h : fp.height;
    fp.viewport.dpr = frame && frame.viewport && isFiniteNumber(frame.viewport.dpr) ? frame.viewport.dpr : fp.dpr;

    this.mp.render(fp, tWrapped, dt, frameIndex);
  }

  destroy() {
    if (this.mp) this.mp.destroy();
    this.mp = null;
    this.gl = null;
    this.canvas = null;
  }
}
