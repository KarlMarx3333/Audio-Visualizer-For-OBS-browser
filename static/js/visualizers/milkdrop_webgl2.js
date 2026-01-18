// static/js/visualizers/milkdrop_webgl2.js
// Milkdrop-ish Warp Reactor -- WebGL2-first, fullscreen feedback shader.
// GPU: ping-pong feedback buffer + mesh warp + polygon shapes + ribbons/pulses/sparkles.
// CPU: only computes audio bands -> uniforms.

import { createProgram, createFullscreenQuad } from "/static/js/webgl/util.js";
import { dtFromFrameOrNow } from "./timebase.js";

const TWO_PI = Math.PI * 2;
const TIME_WRAP = 9e5; // seconds (~10.4 days)

export class MilkdropWarpReactorWebGL2 {
  static id = "milkdrop";
  static name = "Milkdrop-ish Warp Reactor (WebGL2)";
  static renderer = "webgl";

  constructor(canvas) {
    this.canvas = canvas;

    const opts = {
      alpha: false,                 // opaque
      antialias: false,             // MSAA is wasted on a full-screen shader
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    };

    const gl = canvas.getContext("webgl2", opts);
    if (!gl) throw new Error("MilkDrop requires WebGL2");
    this.gl = gl;

    this._destroyed = false;
    this._onContextLost = (e) => {
      if (e) e.preventDefault();
      this._destroyed = true;
    };
    canvas.addEventListener("webglcontextlost", this._onContextLost, false);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);

    this._t0 = performance.now();
    this._lastNowMs = this._t0;
    this._t = 0; // monotonic time accumulator (avoid upstream time resets)
    this._frameCount = 0;

    this._dbgEnabled = false;
    this._dbgFlags = Object.create(null);
    this._dbgLastEmitMs = Object.create(null);
    this._dbgLastSummaryMs = Object.create(null);
    this._dbgThrottleMs = 250;
    this._dbgSummaryMs = 2000;
    this._dbgLastT = null;
    this._dbgWrapWindowStartMs = 0;
    this._dbgWrapCountMid = 0;
    this._dbgWrapCountRay = 0;
    this._dbgNextGpuReadMs = 0;
    this._dbgBrightThreshold = 240;
    this._snapEnabled = false;
    this._snapLastEmitMs = null;
    this._snapThrottleMs = 250;
    this._snapLastUTime = null;
    this._snapLastDtReal = null;
    this._snapLastFrameT = null;
    this._snapLastMidPhase = null;
    this._snapLastRayPhase = null;
    this._snapPhasePrev = null;
    this._snapPhaseCurr = null;
    this._snapPhaseNames = null;
    this._snapPhasePrevValid = false;
    this._snapPix = null;
    this._snapPrevPix = null;
    this._snapPrevPixValid = false;
    this._snapPixThreshold = 80;
    this._snapReadStride = 4;
    this._snapForceRead = false;
    this._snapSnapshotFrame = -1;
    this._snapObjIds = null;
    this._snapObjIdNext = 1;

    // Smoothed audio
    this._bass = 0;
    this._mid = 0;
    this._treble = 0;
    this._energy = 0;
    this._specBuf = null;

    // Kick transient
    this._prevBass = 0;
    this._kick = 0;

    // Spawned shapes (fixed speed per-shape)
    this._shapeCount = 32;
    this._shapePos = new Float32Array(this._shapeCount * 2);
    this._shapeDir = new Float32Array(this._shapeCount * 2);
    this._shapeSpeed = new Float32Array(this._shapeCount);
    this._shapeSize = new Float32Array(this._shapeCount);
    this._shapeSides = new Float32Array(this._shapeCount);
    this._shapeRot = new Float32Array(this._shapeCount);
    this._shapeSpin = new Float32Array(this._shapeCount);
    this._shapeHue = new Float32Array(this._shapeCount);
    this._shapeAge = new Float32Array(this._shapeCount);
    this._shapeLife = new Float32Array(this._shapeCount);
    this._shapeKill = new Float32Array(this._shapeCount);
    this._shapeA = new Float32Array(this._shapeCount * 4);
    this._shapeB = new Float32Array(this._shapeCount * 4);
    this._shapeIndex = 0;
    this._spawnAcc = 0;
    this._rng = 0x12345678;
    this._midPhase = 0;
    this._midPhaseWarp = 0;
    this._midPhaseShape = 0;
    this._rayPhase = 0;

    // Debug layer masking (used by /v/milkdrop?debug=1&md_mask=warp|shapes|rays)
    // 0 = normal, 1 = warp (inject debug bars), 2 = shapes, 3 = rays
    this._mask = 0;
    try {
      const sp = new URLSearchParams(globalThis.location ? globalThis.location.search : "");
      const debug = sp.get("debug") === "1";
      const vizDebug = sp.get("viz_debug") === "1";
      this._snapEnabled = debug;
      this._dbgEnabled = debug || vizDebug;
      const m = (sp.get("md_mask") || "").toLowerCase();
      if (m === "warp" || m === "1") this._mask = 1;
      else if (m === "shapes" || m === "2") this._mask = 2;
      else if (m === "rays" || m === "3") this._mask = 3;
    } catch (e) {}
    if (this._snapEnabled) {
      this._snapLastEmitMs = Object.create(null);
      this._snapPhasePrev = new Float32Array(16);
      this._snapPhaseCurr = new Float32Array(16);
      this._snapPhaseNames = [
        "phase0.x", "phase0.y", "phase0.z", "phase0.w",
        "phase1.x", "phase1.y", "phase1.z", "phase1.w",
        "phase2.x", "phase2.y", "phase2.z", "phase2.w",
        "phase3.x", "phase3.y", "phase3.z", "phase3.w",
      ];
      this._snapPix = new Uint8Array(4);
      this._snapPrevPix = new Uint8Array(4);
      this._snapObjIds = new WeakMap();
    }

    // Fullscreen quad
    this.vb = createFullscreenQuad(gl);

    // Programs
    this.progFB = createProgram(gl, this._vs(), this._fsFeedback());
    this.progPresent = createProgram(gl, this._vs(), this._fsPresent());
    this._dbgProg = null;
    this._dbgFB = null;
    this._dbgTex = null;
    this._dbgBuf = null;
    this._dbgPos = -1;
    this._dbgPrev = null;
    this._dbgRes = null;
    this._dbgTime = null;
    this._dbgDt = null;
    this._dbgBass = null;
    this._dbgMid = null;
    this._dbgTreble = null;
    this._dbgEnergy = null;
    this._dbgKick = null;
    this._dbgMidPhase = null;
    this._dbgMidPhaseWarp = null;
    this._dbgRayPhase = null;

    if (this._dbgEnabled) {
      this._initDebugWatch();
      this._dbgLog("init", `md_mask=${this._mask}`, null, this._t0);
    }

    // Locations (feedback)
    const loc = (p, n) => gl.getUniformLocation(p, n);
    this.aPosFB = gl.getAttribLocation(this.progFB, "a_pos");
    this.uPrev = loc(this.progFB, "u_prev");
    this.uRes = loc(this.progFB, "u_res");
    this.uTime = loc(this.progFB, "u_time");
    this.uDt = loc(this.progFB, "u_dt");
    this.uBass = loc(this.progFB, "u_bass");
    this.uMid = loc(this.progFB, "u_mid");
    this.uTreble = loc(this.progFB, "u_treble");
    this.uEnergy = loc(this.progFB, "u_energy");
    this.uKick = loc(this.progFB, "u_kick");
    this.uMidPhase = loc(this.progFB, "u_mid_phase");
    this.uMidPhaseWarp = loc(this.progFB, "u_mid_phase_warp");
    this.uMidPhaseShape = loc(this.progFB, "u_mid_phase_shape");
    this.uRayPhase = loc(this.progFB, "u_ray_phase");
    this.uShapeA = loc(this.progFB, "u_shapeA[0]");
    this.uShapeB = loc(this.progFB, "u_shapeB[0]");
    this.uMask = loc(this.progFB, "u_mask");

    // Locations (present)
    this.aPosPR = gl.getAttribLocation(this.progPresent, "a_pos");
    this.uTex = loc(this.progPresent, "u_tex");

    // Ping-pong targets (locked to initial size to avoid feedback wipes on resize jitter).
    this._w = 0;
    this._h = 0;
    // Canvas size for the present pass (can change independently).
    this._cw = 0;
    this._ch = 0;
    this._texA = this._texB = null;
    this._fbA = this._fbB = null;
    this._readTex = this._writeTex = null;
    this._readFB = this._writeFB = null;

    this.onResize();
  }

  onResize() {
    const gl = this.gl;
    if (this._destroyed || !gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;

    this._cw = cw;
    this._ch = ch;

    gl.viewport(0, 0, cw, ch);
  }

  _recreateTargets(w, h) {
    const gl = this.gl;
    const hadTargets = !!this._texA || !!this._texB;
    // cleanup old
    if (this._texA) gl.deleteTexture(this._texA);
    if (this._texB) gl.deleteTexture(this._texB);
    if (this._fbA) gl.deleteFramebuffer(this._fbA);
    if (this._fbB) gl.deleteFramebuffer(this._fbB);

    this._texA = this._createTex(w, h);
    this._texB = this._createTex(w, h);
    this._fbA = this._createFB(this._texA);
    this._fbB = this._createFB(this._texB);

    this._readTex = this._texA;
    this._writeTex = this._texB;
    this._readFB = this._fbA;
    this._writeFB = this._fbB;
    if (this._snapEnabled) {
      this._snapFbEvent(hadTargets ? "resize" : "create", w, h, performance.now(), true);
    }

    // initialize both buffers to black
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbA);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbB);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this._snapEnabled) {
      this._snapFbEvent("clear", w, h, performance.now(), true);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createTex(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internalFormat = gl.RGBA8;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  _createFB(tex) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Milkdrop: framebuffer incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
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
    const v = Math.max(0, x);
    const y = 1.0 - Math.exp(-v * 8.0);
    return Math.max(0, Math.min(1, y));
  }

  _clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  _smoothstep(edge0, edge1, x) {
    const t = this._clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  _phaseStep(phase, step) {
    let next = phase + step;
    next %= TWO_PI;
    return next < 0 ? next + TWO_PI : next;
  }

  _rand() {
    this._rng = (this._rng * 1664525 + 1013904223) >>> 0;
    return this._rng / 4294967296;
  }

  _spawnShape(vol, b, m, h) {
    const start = this._shapeIndex;
    let i = start;
    do {
      if (this._shapeLife[i] <= 0) {
        this._shapeIndex = (i + 1) % this._shapeCount;
        break;
      }
      i = (i + 1) % this._shapeCount;
    } while (i !== start);

    if (this._shapeLife[i] > 0) {
      if (this._shapeKill[i] <= 0) this._shapeKill[i] = 1.0;
      this._shapeIndex = (i + 1) % this._shapeCount;
      return false;
    }

    const ang = this._rand() * Math.PI * 2;
    const dirx = Math.cos(ang);
    const diry = Math.sin(ang);

    const speed = this._lerp(0.35, 0.90, vol) * (0.9 + 0.2 * this._rand());

    const wb = b * 1.2;
    const wm = m * 1.0;
    const wh = h * 0.8;
    const sum = wb + wm + wh;
    let sizeMin = 0.020;
    let sizeMax = 0.050;
    if (sum >= 0.05) {
      const pick = this._rand() * sum;
      if (pick < wb) {
        sizeMin = 0.020;
        sizeMax = 0.045;
      } else if (pick < wb + wm) {
        sizeMin = 0.012;
        sizeMax = 0.030;
      } else {
        sizeMin = 0.006;
        sizeMax = 0.015;
      }
    }
    const size = this._lerp(sizeMin, sizeMax, this._rand());

    const sides = 3 + Math.floor(this._rand() * 4);
    const hue = this._rand();
    const rot = this._rand() * Math.PI * 2;
    const spin = (this._rand() * 2 - 1) * 2.6;
    const life = 1.0;

    this._shapePos[i * 2] = 0;
    this._shapePos[i * 2 + 1] = 0;
    this._shapeDir[i * 2] = dirx;
    this._shapeDir[i * 2 + 1] = diry;
    this._shapeSpeed[i] = speed;
    this._shapeSize[i] = size;
    this._shapeSides[i] = sides;
    this._shapeRot[i] = rot;
    this._shapeSpin[i] = spin;
    this._shapeHue[i] = hue;
    this._shapeAge[i] = 0;
    this._shapeLife[i] = life;
    this._shapeKill[i] = 0;
    return true;
  }

  _updateShapes(dtSpawn, dtMove, vol, b, m, h, kickNow) {
    const baseRate = this._lerp(0.15, 2.2, vol);
    // Continuous spawn rate: keep mid + high driving spawn.
    // (Optional: small bass/kick influence retained but reduced.)
    const spawnRate = (baseRate + 0.70 * m + 0.85 * h + 0.15 * b + 0.25 * this._kick) * 0.75;
    // Spawn based on real elapsed time (not clamped dt).
    this._spawnAcc += dtSpawn * spawnRate;
    let spawned = 0;
    const toSpawn = Math.min(this._shapeCount, Math.floor(this._spawnAcc));
    if (toSpawn > 0) {
      for (let k = 0; k < toSpawn; k++) {
        if (!this._spawnShape(vol, b, m, h)) break;
        spawned++;
      }
      this._spawnAcc -= spawned;
    }

    // Instant burst on bass transients (attack), not sustained bass.
    // kickNow is derived from positive bass delta (db) in onFrame().
    const KICK_BURST = 5; // "X shapes" on a strong hit
    if (kickNow > 0.12) {
      const burstBase = Math.min(KICK_BURST, 1 + Math.floor(kickNow * (KICK_BURST - 1)));
      const burst = Math.max(1, Math.round(burstBase * 0.75));
      for (let k = 0; k < burst && spawned < this._shapeCount; k++) {
        if (!this._spawnShape(vol, b, m, h)) break;
        spawned++;
      }
    }

    for (let i = 0; i < this._shapeCount; i++) {
      const ai = i * 4;
      const bi = ai;

      if (this._shapeLife[i] <= 0) {
        this._shapeKill[i] = 0;
        this._shapeA[ai] = 0;
        this._shapeA[ai + 1] = 0;
        this._shapeA[ai + 2] = 0;
        this._shapeA[ai + 3] = 0;
        this._shapeB[bi] = 0;
        this._shapeB[bi + 1] = 0;
        this._shapeB[bi + 2] = 0;
        this._shapeB[bi + 3] = 0;
        continue;
      }

      this._shapeAge[i] += dtMove;

      let kill = this._shapeKill[i];
      if (kill > 0) {
        kill = Math.max(0, kill - dtMove * 2.0);
        this._shapeKill[i] = kill;
        if (kill === 0) {
          this._shapeLife[i] = 0;
          this._shapeA[ai + 2] = 0;
          this._shapeB[bi + 2] = 0;
          continue;
        }
      }

      const dx = this._shapeDir[i * 2] * this._shapeSpeed[i] * dtMove;
      const dy = this._shapeDir[i * 2 + 1] * this._shapeSpeed[i] * dtMove;
      const px = this._shapePos[i * 2] + dx;
      const py = this._shapePos[i * 2 + 1] + dy;
      this._shapePos[i * 2] = px;
      this._shapePos[i * 2 + 1] = py;
      this._shapeRot[i] += this._shapeSpin[i] * dtMove;

      if (px * px + py * py > 2.25) {
        this._shapeLife[i] = 0;
        this._shapeA[ai + 2] = 0;
        this._shapeB[bi + 2] = 0;
        continue;
      }

      const fadeIn = this._smoothstep(0.0, 0.20, this._shapeAge[i]);
      const r = Math.sqrt(px * px + py * py);
      const fadeOut = 1.0 - this._smoothstep(1.20, 1.45, r);
      const life = fadeIn * fadeOut * (kill > 0 ? kill : 1.0);

      this._shapeA[ai] = px;
      this._shapeA[ai + 1] = py;
      this._shapeA[ai + 2] = this._shapeSize[i];
      this._shapeA[ai + 3] = this._shapeSides[i];

      this._shapeB[bi] = this._shapeRot[i];
      this._shapeB[bi + 1] = this._shapeHue[i];
      this._shapeB[bi + 2] = life;
      this._shapeB[bi + 3] = 1.0;
    }
  }

  onFrame(frame) {
    const gl = this.gl;
    if (this._destroyed || !gl) return;
    if (gl.isContextLost && gl.isContextLost()) return;

    const cw = this.canvas.width | 0;
    const ch = this.canvas.height | 0;
    if (cw <= 2 || ch <= 2) return;

    // First-time init (lock FBO size to initial canvas size).
    if (!this._readTex || this._w <= 2 || this._h <= 2) {
      this._w = cw;
      this._h = ch;
      this._recreateTargets(this._w, this._h);
    }
    // Always track current canvas size for the present pass.
    this._cw = cw;
    this._ch = ch;

    this._frameCount++;
    if (this._snapEnabled) {
      this._snapForceRead = false;
    }

    const now = performance.now();
    let dtReal = dtFromFrameOrNow(frame, now, this);
    const dtRealIn = dtReal;
    if (this._dbgEnabled) {
      const dtBad = !Number.isFinite(dtRealIn);
      let state = this._dbgFlag("nonfinite_dtReal", dtBad, now);
      if (state) {
        this._dbgLog(
          "nonfinite_dtReal",
          `value=${dtRealIn} frame=${this._frameCount} dtReal=${dtRealIn}`,
          { frameT: frame?.t },
          now
        );
      }
      const dtFinite = Number.isFinite(dtRealIn);
      const dtNeg = dtFinite && dtRealIn < -1e-6;
      state = this._dbgFlag("dt_negative", dtNeg, now);
      if (state) {
        this._dbgLog(
          "dt_negative",
          `value=${dtRealIn} frame=${this._frameCount} dtReal=${dtRealIn}`,
          null,
          now
        );
      }
      const dtSpike200 = dtFinite && dtRealIn > 0.2;
      const dtSpike80 = dtFinite && dtRealIn > 0.08 && !dtSpike200;
      state = this._dbgFlag("dt_spike_200ms", dtSpike200, now);
      if (state) {
        this._dbgLog(
          "dt_spike_200ms",
          `value=${dtRealIn} frame=${this._frameCount} dtReal=${dtRealIn}`,
          null,
          now
        );
      }
      state = this._dbgFlag("dt_spike_80ms", dtSpike80, now);
      if (state) {
        this._dbgLog(
          "dt_spike_80ms",
          `value=${dtRealIn} frame=${this._frameCount} dtReal=${dtRealIn}`,
          null,
          now
        );
      }
    }
    if (!Number.isFinite(dtReal) || dtReal < 0) dtReal = 0;
    // Keep a clamped dt for motion/visual stability.
    let dt = Math.min(0.05, dtReal);
    if (this._dbgEnabled) {
      const dtBad = !Number.isFinite(dt);
      const state = this._dbgFlag("nonfinite_dt", dtBad, now);
      if (state) {
        this._dbgLog(
          "nonfinite_dt",
          `value=${dt} frame=${this._frameCount} dtReal=${dtReal}`,
          { dtReal },
          now
        );
      }
      if (dtBad) dt = 0;
    }

    const srcSpec = frame?.spectrum;
    let spec = srcSpec;
    if (srcSpec) {
      if (!this._specBuf || this._specBuf.length !== srcSpec.length) {
        this._specBuf = new Float32Array(srcSpec.length);
      }
      this._specBuf.set(srcSpec);
      spec = this._specBuf;
    }
    const gainIn = Number(frame?.gain ?? 1);
    let gain = gainIn;
    const srIn = Number(frame?.samplerate ?? 48000);
    let sr = srIn;
    const fftSizeIn = Number(frame?.fftSize ?? 2048);
    let fftSize = fftSizeIn;
    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_gain", !Number.isFinite(gainIn), now);
      if (state) {
        this._dbgLog(
          "nonfinite_gain",
          `value=${gainIn} frame=${this._frameCount} dtReal=${dtReal}`,
          { samplerate: srIn, fftSize: fftSizeIn },
          now
        );
      }
      if (!Number.isFinite(gain)) gain = 1;

      state = this._dbgFlag("nonfinite_sr", !Number.isFinite(srIn), now);
      if (state) {
        this._dbgLog(
          "nonfinite_sr",
          `value=${srIn} frame=${this._frameCount} dtReal=${dtReal}`,
          { gain: gainIn, fftSize: fftSizeIn },
          now
        );
      }
      if (!Number.isFinite(sr)) sr = 48000;

      state = this._dbgFlag("nonfinite_fftSize", !Number.isFinite(fftSizeIn), now);
      if (state) {
        this._dbgLog(
          "nonfinite_fftSize",
          `value=${fftSizeIn} frame=${this._frameCount} dtReal=${dtReal}`,
          { gain: gainIn, samplerate: srIn },
          now
        );
      }
      if (!Number.isFinite(fftSize)) fftSize = 2048;
    }

    const bassBand = this._bandHz(spec, sr, fftSize, 35, 140);
    const midBand = this._bandHz(spec, sr, fftSize, 180, 2200);
    const treBand = this._bandHz(spec, sr, fftSize, 2800, 12000);
    const energyBand = this._bandHz(spec, sr, fftSize, 45, 12000);

    let bassRaw = this._shape(bassBand * gain * 2.2);
    let midRaw = this._shape(midBand * gain * 1.6);
    let treRaw = this._shape(treBand * gain * 1.3);
    let energyRaw = this._shape(energyBand * gain * 1.9);
    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_bassRaw", !Number.isFinite(bassRaw), now);
      if (state) {
        this._dbgLog(
          "nonfinite_bassRaw",
          `value=${bassRaw} frame=${this._frameCount} dtReal=${dtReal}`,
          { band: bassBand, gain, samplerate: sr, fftSize },
          now
        );
      }
      if (!Number.isFinite(bassRaw)) bassRaw = 0;

      state = this._dbgFlag("nonfinite_midRaw", !Number.isFinite(midRaw), now);
      if (state) {
        this._dbgLog(
          "nonfinite_midRaw",
          `value=${midRaw} frame=${this._frameCount} dtReal=${dtReal}`,
          { band: midBand, gain, samplerate: sr, fftSize },
          now
        );
      }
      if (!Number.isFinite(midRaw)) midRaw = 0;

      state = this._dbgFlag("nonfinite_treRaw", !Number.isFinite(treRaw), now);
      if (state) {
        this._dbgLog(
          "nonfinite_treRaw",
          `value=${treRaw} frame=${this._frameCount} dtReal=${dtReal}`,
          { band: treBand, gain, samplerate: sr, fftSize },
          now
        );
      }
      if (!Number.isFinite(treRaw)) treRaw = 0;

      state = this._dbgFlag("nonfinite_energyRaw", !Number.isFinite(energyRaw), now);
      if (state) {
        this._dbgLog(
          "nonfinite_energyRaw",
          `value=${energyRaw} frame=${this._frameCount} dtReal=${dtReal}`,
          { band: energyBand, gain, samplerate: sr, fftSize },
          now
        );
      }
      if (!Number.isFinite(energyRaw)) energyRaw = 0;
    }

    const smoothRate = 10.0;
    // Smooth based on real time (cap just to avoid absurd jumps).
    const a = Math.exp(-Math.min(0.25, dtReal) * smoothRate);
    this._bass   = a * this._bass   + (1 - a) * bassRaw;
    this._mid    = a * this._mid    + (1 - a) * midRaw;
    this._treble = a * this._treble + (1 - a) * treRaw;
    this._energy = a * this._energy + (1 - a) * energyRaw;

    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_bass", !Number.isFinite(this._bass), now);
      if (state) {
        this._dbgLog(
          "nonfinite_bass",
          `value=${this._bass} frame=${this._frameCount} dtReal=${dtReal}`,
          { raw: bassRaw, a },
          now
        );
      }
      if (!Number.isFinite(this._bass)) this._bass = 0;

      state = this._dbgFlag("nonfinite_mid", !Number.isFinite(this._mid), now);
      if (state) {
        this._dbgLog(
          "nonfinite_mid",
          `value=${this._mid} frame=${this._frameCount} dtReal=${dtReal}`,
          { raw: midRaw, a },
          now
        );
      }
      if (!Number.isFinite(this._mid)) this._mid = 0;

      state = this._dbgFlag("nonfinite_treble", !Number.isFinite(this._treble), now);
      if (state) {
        this._dbgLog(
          "nonfinite_treble",
          `value=${this._treble} frame=${this._frameCount} dtReal=${dtReal}`,
          { raw: treRaw, a },
          now
        );
      }
      if (!Number.isFinite(this._treble)) this._treble = 0;

      state = this._dbgFlag("nonfinite_energy", !Number.isFinite(this._energy), now);
      if (state) {
        this._dbgLog(
          "nonfinite_energy",
          `value=${this._energy} frame=${this._frameCount} dtReal=${dtReal}`,
          { raw: energyRaw, a },
          now
        );
      }
      if (!Number.isFinite(this._energy)) this._energy = 0;
    }

    let midPhasePrev = this._midPhase;
    if (this._dbgEnabled) {
      const state = this._dbgFlag("nonfinite_midPhase", !Number.isFinite(midPhasePrev), now);
      if (state) {
        this._dbgLog(
          "nonfinite_midPhase",
          `value=${midPhasePrev} frame=${this._frameCount} dtReal=${dtReal}`,
          { mid: this._mid },
          now
        );
      }
      if (!Number.isFinite(midPhasePrev)) this._midPhase = 0;
    }
    this._midPhase = Number.isFinite(this._midPhase) ? this._midPhase : 0;
    midPhasePrev = this._midPhase;
    let midStep = dtReal * this._mid;
    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_midStep", !Number.isFinite(midStep), now);
      if (state) {
        this._dbgLog(
          "nonfinite_midStep",
          `value=${midStep} frame=${this._frameCount} dtReal=${dtReal}`,
          { mid: this._mid },
          now
        );
      }
      if (!Number.isFinite(midStep)) midStep = 0;

      state = this._dbgFlag("midPhase_step_gt_tau", midStep > TWO_PI, now);
      if (state) {
        this._dbgLog(
          "midPhase_step_gt_tau",
          `value=${midStep} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
    }
    let midWrapped = false;
    const midPhaseAfter = (midPhasePrev + midStep) % TWO_PI;
    if (this._dbgEnabled) {
      midWrapped = midStep > 0 && midPhaseAfter < midPhasePrev;
    }
    this._midPhase = midPhaseAfter;
    const midSafe = this._mid;
    this._midPhaseWarp = this._phaseStep(this._midPhaseWarp, dt * midSafe * 0.85);
    this._midPhaseShape = this._phaseStep(this._midPhaseShape, dt * midSafe * 0.95);

    // Prevent low-end steady tones from spinning the feedback "ray reflections" endlessly.
    // Drive rotation mostly from transients (kick) instead of steady energy/bass.
    const raySpeed = Math.min(0.35, 0.06 + 0.35 * this._kick + 0.08 * this._treble);
    let rayPhasePrev = this._rayPhase;
    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_rayPhase", !Number.isFinite(rayPhasePrev), now);
      if (state) {
        this._dbgLog(
          "nonfinite_rayPhase",
          `value=${rayPhasePrev} frame=${this._frameCount} dtReal=${dtReal}`,
          { raySpeed, treble: this._treble, kick: this._kick },
          now
        );
      }
      if (!Number.isFinite(rayPhasePrev)) this._rayPhase = 0;
    }
    this._rayPhase = Number.isFinite(this._rayPhase) ? this._rayPhase : 0;
    rayPhasePrev = this._rayPhase;
    let rayStep = dtReal * raySpeed;
    if (this._dbgEnabled) {
      let state = this._dbgFlag("nonfinite_rayStep", !Number.isFinite(rayStep), now);
      if (state) {
        this._dbgLog(
          "nonfinite_rayStep",
          `value=${rayStep} frame=${this._frameCount} dtReal=${dtReal}`,
          { raySpeed },
          now
        );
      }
      if (!Number.isFinite(rayStep)) rayStep = 0;

      state = this._dbgFlag("rayPhase_step_gt_tau", rayStep > TWO_PI, now);
      if (state) {
        this._dbgLog(
          "rayPhase_step_gt_tau",
          `value=${rayStep} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
    }
    let rayWrapped = false;
    const rayPhaseAfter = (rayPhasePrev + rayStep) % TWO_PI;
    if (this._dbgEnabled) {
      rayWrapped = rayStep > 0 && rayPhaseAfter < rayPhasePrev;
    }
    this._rayPhase = rayPhaseAfter;

    const db = Math.max(0, this._bass - this._prevBass);
    this._prevBass = this._bass;
    const kickNow = Math.min(1, db * 7.0);
    const kickDecayRate = 8.0;
    this._kick *= Math.exp(-dtReal * kickDecayRate);
    this._kick = Math.max(this._kick, kickNow);

    if (this._dbgEnabled) {
      const state = this._dbgFlag("nonfinite_kick", !Number.isFinite(this._kick), now);
      if (state) {
        this._dbgLog(
          "nonfinite_kick",
          `value=${this._kick} frame=${this._frameCount} dtReal=${dtReal}`,
          { db, kickNow },
          now
        );
      }
      if (!Number.isFinite(this._kick)) this._kick = 0;

      if (!this._dbgWrapWindowStartMs) this._dbgWrapWindowStartMs = now;
      if (now - this._dbgWrapWindowStartMs >= 1000) {
        this._dbgWrapWindowStartMs = now;
        this._dbgWrapCountMid = 0;
        this._dbgWrapCountRay = 0;
      }
      if (midWrapped) this._dbgWrapCountMid++;
      if (rayWrapped) this._dbgWrapCountRay++;

      let wrapState = this._dbgFlag("midPhase_wrap_rate", this._dbgWrapCountMid > 2, now);
      if (wrapState) {
        this._dbgLog(
          "midPhase_wrap_rate",
          `wraps=${this._dbgWrapCountMid} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
      wrapState = this._dbgFlag("rayPhase_wrap_rate", this._dbgWrapCountRay > 2, now);
      if (wrapState) {
        this._dbgLog(
          "rayPhase_wrap_rate",
          `wraps=${this._dbgWrapCountRay} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
    }

    const vol = this._clamp01(this._energy);
    const b = this._clamp01(this._bass);
    const m = this._clamp01(this._mid);
    const hi = this._clamp01(this._treble);
    this._updateShapes(dtReal, dt, vol, b, m, hi, kickNow);

    if (this._dbgEnabled) {
      const spawnBad = !Number.isFinite(this._spawnAcc);
      let state = this._dbgFlag("nonfinite_spawnAcc", spawnBad, now);
      if (state) {
        const baseRate = this._lerp(0.15, 2.2, vol);
        const spawnRate = (baseRate + 0.70 * m + 0.85 * hi + 0.15 * b + 0.25 * this._kick) * 0.75;
        this._dbgLog(
          "nonfinite_spawnAcc",
          `value=${this._spawnAcc} frame=${this._frameCount} dtReal=${dtReal}`,
          { spawnRate, dtSpawn: dtReal },
          now
        );
      }
      if (spawnBad) this._spawnAcc = 0;

      let badA = -1;
      let badAVal = 0;
      for (let i = 0; i < this._shapeA.length; i++) {
        const v = this._shapeA[i];
        if (!Number.isFinite(v)) {
          if (badA < 0) {
            badA = i;
            badAVal = v;
          }
          this._shapeA[i] = 0;
        }
      }
      state = this._dbgFlag("nonfinite_shapeA", badA >= 0, now);
      if (state) {
        this._dbgLog(
          "nonfinite_shapeA",
          `index=${badA} value=${badAVal} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }

      let badB = -1;
      let badBVal = 0;
      for (let i = 0; i < this._shapeB.length; i++) {
        const v = this._shapeB[i];
        if (!Number.isFinite(v)) {
          if (badB < 0) {
            badB = i;
            badBVal = v;
          }
          this._shapeB[i] = 0;
        }
      }
      state = this._dbgFlag("nonfinite_shapeB", badB >= 0, now);
      if (state) {
        this._dbgLog(
          "nonfinite_shapeB",
          `index=${badB} value=${badBVal} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
    }

    // IMPORTANT: never use external frame.t for this visualizer's timebase.
    // If upstream time resets/jumps, warp + center shapes snap (spawned shapes can look unaffected).
    if (this._dbgEnabled) {
      const timeBad = !Number.isFinite(this._t);
      const state = this._dbgFlag("nonfinite_time", timeBad, now);
      if (state) {
        this._dbgLog(
          "nonfinite_time",
          `value=${this._t} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
      if (timeBad) this._t = 0;
    }
    this._t = Number.isFinite(this._t) ? this._t : 0;
    this._t += dtReal;
    const t = this._t % TIME_WRAP;
    if (this._dbgEnabled) {
      const lastT = this._dbgLastT;
      const timeBack = Number.isFinite(lastT) && t + 1e-6 < lastT;
      const state = this._dbgFlag("time_wrap", timeBack, now);
      if (state) {
        this._dbgLog(
          "time_wrap",
          `prev=${lastT} next=${t} frame=${this._frameCount} dtReal=${dtReal}`,
          null,
          now
        );
      }
      this._dbgLastT = t;
    }
    if (this._snapEnabled) {
      this._snapLastDtReal = dtReal;

      const frameT = Number(frame?.t);
      const frameTValid = Number.isFinite(frameT);
      const dtSpike = dtReal > 0.05;
      if (dtSpike) {
        const msg = `frame=${this._frameCount} dtReal=${dtReal} u_time=${t}` +
          ` frame_t=${frameTValid ? frameT : "na"} nowMs=${now}`;
        const logged = this._snapLog("dt_spike", msg, now, true);
        if (logged) this._snapSnapshot(now, t, dtReal);
        this._snapForceRead = true;
      }

      const lastUTime = this._snapLastUTime;
      if (Number.isFinite(lastUTime) && t + 1e-6 < lastUTime) {
        const msg = `reason=u_time_back prev=${lastUTime} curr=${t}` +
          ` frame=${this._frameCount} dtReal=${dtReal}` +
          ` frame_t=${frameTValid ? frameT : "na"} nowMs=${now}`;
        const logged = this._snapLog("time_jump", msg, now, true);
        if (logged) this._snapSnapshot(now, t, dtReal);
        this._snapForceRead = true;
      }

      const lastFrameT = this._snapLastFrameT;
      if (frameTValid) {
        if (Number.isFinite(lastFrameT)) {
          const dtFrame = frameT - lastFrameT;
          if (dtFrame < -1e-3 || dtFrame > 0.05) {
            const msg = `reason=frame_t_jump prev=${lastFrameT} curr=${frameT} delta=${dtFrame}` +
              ` frame=${this._frameCount} dtReal=${dtReal} u_time=${t} nowMs=${now}`;
            const logged = this._snapLog("time_jump", msg, now, true);
            if (logged) this._snapSnapshot(now, t, dtReal);
            this._snapForceRead = true;
          }
        }
        this._snapLastFrameT = frameT;
      }

      if (Number.isFinite(this._snapLastMidPhase)) {
        this._snapCheckPhase("midPhase", this._snapLastMidPhase, this._midPhase, now, dtReal, t);
      }
      this._snapLastMidPhase = this._midPhase;

      if (Number.isFinite(this._snapLastRayPhase)) {
        this._snapCheckPhase("rayPhase", this._snapLastRayPhase, this._rayPhase, now, dtReal, t);
      }
      this._snapLastRayPhase = this._rayPhase;

      this._snapFillPhases(frame, t);
      if (this._snapPhasePrev && this._snapPhaseCurr && this._snapPhaseNames) {
        if (!this._snapPhasePrevValid) {
          for (let i = 0; i < this._snapPhaseCurr.length; i++) {
            this._snapPhasePrev[i] = this._snapPhaseCurr[i];
          }
          this._snapPhasePrevValid = true;
        } else {
          for (let i = 0; i < this._snapPhaseCurr.length; i++) {
            this._snapCheckPhase(this._snapPhaseNames[i], this._snapPhasePrev[i], this._snapPhaseCurr[i], now, dtReal, t);
            this._snapPhasePrev[i] = this._snapPhaseCurr[i];
          }
        }
      }

      this._snapLastUTime = t;
    }

    // --- PASS 1: feedback warp into writeFB (use FBO size) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._writeFB);
    gl.viewport(0, 0, this._w, this._h);

    gl.useProgram(this.progFB);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPosFB);
    gl.vertexAttribPointer(this.aPosFB, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._readTex);
    gl.uniform1i(this.uPrev, 0);

    gl.uniform2f(this.uRes, this._w, this._h);
    gl.uniform1f(this.uTime, t);
    gl.uniform1f(this.uDt, dt);
    gl.uniform1f(this.uBass, this._bass);
    gl.uniform1f(this.uMid, this._mid);
    gl.uniform1f(this.uTreble, this._treble);
    gl.uniform1f(this.uEnergy, this._energy);
    gl.uniform1f(this.uKick, this._kick);
    if (this.uMidPhase !== null) gl.uniform1f(this.uMidPhase, this._midPhase);
    if (this.uMidPhaseWarp !== null) gl.uniform1f(this.uMidPhaseWarp, this._midPhaseWarp);
    if (this.uMidPhaseShape !== null) gl.uniform1f(this.uMidPhaseShape, this._midPhaseShape);
    if (this.uRayPhase !== null) gl.uniform1f(this.uRayPhase, this._rayPhase);
    if (this.uShapeA !== null) gl.uniform4fv(this.uShapeA, this._shapeA);
    if (this.uShapeB !== null) gl.uniform4fv(this.uShapeB, this._shapeB);
    if (this.uMask !== null) gl.uniform1i(this.uMask, this._mask | 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (this._snapEnabled) this._snapFeedbackRead(now, t, dtReal);
    if (this._dbgEnabled) this._dbgGpuWatch(now, t, dt, dtReal);

    // --- PASS 2: present to screen (use canvas size) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._cw, this._ch);

    gl.useProgram(this.progPresent);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this.aPosPR);
    gl.vertexAttribPointer(this.aPosPR, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._writeTex);
    gl.uniform1i(this.uTex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap
    const tmpT = this._readTex;
    this._readTex = this._writeTex;
    this._writeTex = tmpT;

    const tmpF = this._readFB;
    this._readFB = this._writeFB;
    this._writeFB = tmpF;
    if (this._snapEnabled) {
      this._snapFbEvent("swap", this._w, this._h, now, false);
    }
  }

  destroy() {
    try {
      this._destroyed = true;
      this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);

      const gl = this.gl;
      gl.deleteProgram(this.progFB);
      gl.deleteProgram(this.progPresent);
      if (this._dbgProg) gl.deleteProgram(this._dbgProg);
      gl.deleteBuffer(this.vb);

      if (this._texA) gl.deleteTexture(this._texA);
      if (this._texB) gl.deleteTexture(this._texB);
      if (this._fbA) gl.deleteFramebuffer(this._fbA);
      if (this._fbB) gl.deleteFramebuffer(this._fbB);
      if (this._dbgTex) gl.deleteTexture(this._dbgTex);
      if (this._dbgFB) gl.deleteFramebuffer(this._dbgFB);
    } catch (e) {}
  }

  _dbgLog(kind, msg, obj, nowMs) {
    if (!this._dbgEnabled) return;
    const t = Number.isFinite(nowMs) ? nowMs : performance.now();
    const last = this._dbgLastEmitMs[kind] || 0;
    if (t - last < this._dbgThrottleMs) return;
    this._dbgLastEmitMs[kind] = t;

    const prefix = `[milkdrop][${kind}] `;
    const sink = globalThis.__vizDebugLog;
    if (typeof sink === "function") {
      let extra = "";
      if (obj) {
        try {
          extra = " " + JSON.stringify(obj);
        } catch (e) {
          extra = " " + String(obj);
        }
      }
      sink(prefix + msg + extra);
      return;
    }
    if (obj) console.warn(prefix + msg, obj);
    else console.warn(prefix + msg);
  }

  _dbgFlag(kind, active, nowMs) {
    if (!this._dbgEnabled) return 0;
    const prev = this._dbgFlags[kind] | 0;
    if (active) {
      this._dbgFlags[kind] = 1;
      const lastSummary = this._dbgLastSummaryMs[kind] || 0;
      if (!prev) {
        this._dbgLastSummaryMs[kind] = nowMs;
        return 1;
      }
      if (nowMs - lastSummary >= this._dbgSummaryMs) {
        this._dbgLastSummaryMs[kind] = nowMs;
        return 2;
      }
      return 0;
    }
    if (prev) {
      this._dbgFlags[kind] = 0;
      this._dbgLastSummaryMs[kind] = 0;
    }
    return 0;
  }

  _initDebugWatch() {
    const gl = this.gl;
    if (!gl) return;

    this._dbgProg = createProgram(gl, this._vs(), this._fsDebug());
    this._dbgPos = gl.getAttribLocation(this._dbgProg, "a_pos");
    const loc = (n) => gl.getUniformLocation(this._dbgProg, n);
    this._dbgPrev = loc("u_prev");
    this._dbgRes = loc("u_res");
    this._dbgTime = loc("u_time");
    this._dbgDt = loc("u_dt");
    this._dbgBass = loc("u_bass");
    this._dbgMid = loc("u_mid");
    this._dbgTreble = loc("u_treble");
    this._dbgEnergy = loc("u_energy");
    this._dbgKick = loc("u_kick");
    this._dbgMidPhase = loc("u_mid_phase");
    this._dbgMidPhaseWarp = loc("u_mid_phase_warp");
    this._dbgRayPhase = loc("u_ray_phase");

    this._dbgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._dbgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._dbgFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._dbgFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._dbgTex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this._dbgLog("dbg_fb", `debug FBO incomplete 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._dbgBuf = new Uint8Array(2 * 2 * 4);
    this._dbgGpuIntervalMs = 100;
  }

  _dbgGpuWatch(nowMs, t, dt, dtReal) {
    if (!this._dbgEnabled || !this._dbgProg || !this._dbgFB || !this._dbgBuf) return;
    if (nowMs < this._dbgNextGpuReadMs) return;
    this._dbgNextGpuReadMs = nowMs + this._dbgGpuIntervalMs;

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._dbgFB);
    gl.viewport(0, 0, 2, 2);
    gl.useProgram(this._dbgProg);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb);
    gl.enableVertexAttribArray(this._dbgPos);
    gl.vertexAttribPointer(this._dbgPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._readTex);
    if (this._dbgPrev) gl.uniform1i(this._dbgPrev, 0);
    if (this._dbgRes) gl.uniform2f(this._dbgRes, this._w, this._h);
    if (this._dbgTime) gl.uniform1f(this._dbgTime, t);
    if (this._dbgDt) gl.uniform1f(this._dbgDt, dt);
    if (this._dbgBass) gl.uniform1f(this._dbgBass, this._bass);
    if (this._dbgMid) gl.uniform1f(this._dbgMid, this._mid);
    if (this._dbgTreble) gl.uniform1f(this._dbgTreble, this._treble);
    if (this._dbgEnergy) gl.uniform1f(this._dbgEnergy, this._energy);
    if (this._dbgKick) gl.uniform1f(this._dbgKick, this._kick);
    if (this._dbgMidPhase) gl.uniform1f(this._dbgMidPhase, this._midPhase);
    if (this._dbgMidPhaseWarp) gl.uniform1f(this._dbgMidPhaseWarp, this._midPhaseWarp);
    if (this._dbgRayPhase) gl.uniform1f(this._dbgRayPhase, this._rayPhase);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, this._dbgBuf);

    this._dbgProcessGpu(nowMs, dtReal);
  }

  _dbgProcessGpu(nowMs, dtReal) {
    const buf = this._dbgBuf;
    if (!buf) return;

    let oob = 0;
    let nonfinite = 0;
    let clamp = 0;
    let maxA = 0;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;

    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const a = buf[i + 3];
      if (r > 127) oob = 1;
      if (g > 127) nonfinite = 1;
      if (b > 127) clamp = 1;
      if (a > maxA) maxA = a;
      if (r > maxR) maxR = r;
      if (g > maxG) maxG = g;
      if (b > maxB) maxB = b;
    }

    const bright = maxA >= this._dbgBrightThreshold;

    let state = this._dbgFlag("gpu_oob_uv", oob, nowMs);
    if (state) {
      this._dbgLog(
        "gpu_oob_uv",
        `frame=${this._frameCount} dtReal=${dtReal} maxR=${maxR} maxA=${maxA}`,
        null,
        nowMs
      );
    }

    state = this._dbgFlag("gpu_nonfinite", nonfinite, nowMs);
    if (state) {
      this._dbgLog(
        "gpu_nonfinite",
        `frame=${this._frameCount} dtReal=${dtReal} maxG=${maxG} maxA=${maxA}`,
        null,
        nowMs
      );
    }

    state = this._dbgFlag("gpu_clamp_hit", clamp, nowMs);
    if (state) {
      this._dbgLog(
        "gpu_clamp_hit",
        `frame=${this._frameCount} dtReal=${dtReal} maxB=${maxB} maxA=${maxA}`,
        null,
        nowMs
      );
    }

    state = this._dbgFlag("gpu_bright", bright, nowMs);
    if (state) {
      this._dbgLog(
        "gpu_bright",
        `frame=${this._frameCount} dtReal=${dtReal} maxA=${maxA}`,
        null,
        nowMs
      );
    }
  }

  _snapLog(kind, msg, nowMs, immediate) {
    if (!this._snapEnabled) return false;
    const t = Number.isFinite(nowMs) ? nowMs : performance.now();
    const last = (this._snapLastEmitMs && this._snapLastEmitMs[kind]) || 0;
    if (!immediate && t - last < this._snapThrottleMs) return false;
    if (this._snapLastEmitMs) this._snapLastEmitMs[kind] = t;

    const prefix = `[milkdrop][${kind}] `;
    const sink = globalThis.__vizDebugLog;
    if (typeof sink === "function") {
      sink(prefix + msg);
      return true;
    }
    console.warn(prefix + msg);
    return true;
  }

  _snapId(obj) {
    if (!this._snapEnabled || !obj || !this._snapObjIds) return 0;
    let id = this._snapObjIds.get(obj);
    if (!id) {
      id = this._snapObjIdNext++;
      this._snapObjIds.set(obj, id);
    }
    return id;
  }

  _snapSnapshot(nowMs, t, dtReal) {
    if (!this._snapEnabled) return;
    if (this._snapSnapshotFrame === this._frameCount) return;
    this._snapSnapshotFrame = this._frameCount;

    const uTime = Number.isFinite(t) ? t : (Number.isFinite(this._snapLastUTime) ? this._snapLastUTime : 0);
    const dt = Number.isFinite(dtReal) ? dtReal : (Number.isFinite(this._snapLastDtReal) ? this._snapLastDtReal : 0);
    const readId = this._snapId(this._readTex);
    const writeId = this._snapId(this._writeTex);
    const msg = `frame=${this._frameCount} dtReal=${dt} u_time=${uTime}` +
      ` b=${this._bass} m=${this._mid} tre=${this._treble} en=${this._energy} k=${this._kick}` +
      ` ray=${this._rayPhase} mid=${this._midPhase} fb=${readId}/${writeId}`;
    this._snapLog("snap", msg, nowMs, true);
  }

  _snapFbEvent(action, w, h, nowMs, immediate) {
    if (!this._snapEnabled) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const readId = this._snapId(this._readTex);
    const writeId = this._snapId(this._writeTex);
    const msg = `action=${action} w=${w} h=${h} dpr=${dpr} readTex=${readId} writeTex=${writeId} frame=${this._frameCount}`;
    const logged = this._snapLog("fb_event", msg, nowMs, immediate);
    if (logged) this._snapSnapshot(nowMs, this._snapLastUTime, this._snapLastDtReal);
    if (action !== "swap") this._snapForceRead = true;
  }

  _snapCheckPhase(name, prev, curr, nowMs, dtReal, uTime) {
    if (!this._snapEnabled || !Number.isFinite(prev) || !Number.isFinite(curr)) return false;
    const delta = Math.abs(curr - prev);
    if (delta <= 1.0) return false;
    const msg = `phase=${name} prev=${prev} curr=${curr} delta=${delta}` +
      ` frame=${this._frameCount} dtReal=${dtReal} u_time=${uTime}` +
      ` audio=b=${this._bass} m=${this._mid} tre=${this._treble} en=${this._energy} k=${this._kick}`;
    const logged = this._snapLog("phase_jump", msg, nowMs, true);
    if (logged) this._snapSnapshot(nowMs, uTime, dtReal);
    this._snapForceRead = true;
    return true;
  }

  _snapFillPhases(frame, uTime) {
    if (!this._snapEnabled || !this._snapPhaseCurr) return;
    const p = this._snapPhaseCurr;

    const f0 = frame?.phase0;
    if (f0 && f0.length >= 4 && Number.isFinite(f0[0]) && Number.isFinite(f0[1]) &&
        Number.isFinite(f0[2]) && Number.isFinite(f0[3])) {
      p[0] = Number(f0[0]);
      p[1] = Number(f0[1]);
      p[2] = Number(f0[2]);
      p[3] = Number(f0[3]);
    } else {
      p[0] = uTime * 0.30;
      p[1] = uTime * 0.21;
      p[2] = uTime * 1.25;
      p[3] = uTime * 1.05;
    }

    const f1 = frame?.phase1;
    if (f1 && f1.length >= 4 && Number.isFinite(f1[0]) && Number.isFinite(f1[1]) &&
        Number.isFinite(f1[2]) && Number.isFinite(f1[3])) {
      p[4] = Number(f1[0]);
      p[5] = Number(f1[1]);
      p[6] = Number(f1[2]);
      p[7] = Number(f1[3]);
    } else {
      p[4] = uTime * 1.70;
      p[5] = -uTime * 2.10;
      p[6] = uTime * 1.30;
      p[7] = uTime * 2.40;
    }

    const f2 = frame?.phase2;
    if (f2 && f2.length >= 4 && Number.isFinite(f2[0]) && Number.isFinite(f2[1]) &&
        Number.isFinite(f2[2]) && Number.isFinite(f2[3])) {
      p[8] = Number(f2[0]);
      p[9] = Number(f2[1]);
      p[10] = Number(f2[2]);
      p[11] = Number(f2[3]);
    } else {
      p[8] = uTime * 0.06;
      p[9] = uTime * 0.55;
      p[10] = this._midPhase;
      p[11] = uTime * 0.35;
    }

    const f3 = frame?.phase3;
    if (f3 && f3.length >= 4 && Number.isFinite(f3[0]) && Number.isFinite(f3[1]) &&
        Number.isFinite(f3[2]) && Number.isFinite(f3[3])) {
      p[12] = Number(f3[0]);
      p[13] = Number(f3[1]);
      p[14] = Number(f3[2]);
      p[15] = Number(f3[3]);
    } else {
      p[12] = uTime * 0.70;
      p[13] = uTime * 0.50;
      p[14] = 0.0;
      p[15] = 0.0;
    }
  }

  _snapFeedbackRead(nowMs, uTime, dtReal) {
    if (!this._snapEnabled || !this._snapPix || !this._snapPrevPix) return;
    const force = this._snapForceRead;
    if (!force && (this._frameCount % this._snapReadStride) !== 0) return;
    this._snapForceRead = false;

    const gl = this.gl;
    const x = (this._w * 0.5) | 0;
    const y = (this._h * 0.5) | 0;
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._snapPix);

    if (this._snapPrevPixValid) {
      const pr = this._snapPrevPix[0];
      const pg = this._snapPrevPix[1];
      const pb = this._snapPrevPix[2];
      const pa = this._snapPrevPix[3];
      const cr = this._snapPix[0];
      const cg = this._snapPix[1];
      const cb = this._snapPix[2];
      const ca = this._snapPix[3];
      const delta = Math.abs(cr - pr) + Math.abs(cg - pg) + Math.abs(cb - pb) + Math.abs(ca - pa);
      if (delta > this._snapPixThreshold) {
        const readId = this._snapId(this._readTex);
        const writeId = this._snapId(this._writeTex);
        const p0 = this._snapPhaseCurr ? this._snapPhaseCurr[0] : 0;
        const p1 = this._snapPhaseCurr ? this._snapPhaseCurr[4] : 0;
        const phaseSummary = `mid=${this._midPhase} ray=${this._rayPhase} p0=${p0} p1=${p1}`;
        const msg = `prev=${pr},${pg},${pb},${pa} curr=${cr},${cg},${cb},${ca} delta=${delta}` +
          ` frame=${this._frameCount} dtReal=${dtReal} u_time=${uTime}` +
          ` phases=${phaseSummary} fb=${readId}/${writeId}`;
        const logged = this._snapLog("feedback_jump", msg, nowMs, true);
        if (logged) this._snapSnapshot(nowMs, uTime, dtReal);
      }
    }

    this._snapPrevPix[0] = this._snapPix[0];
    this._snapPrevPix[1] = this._snapPix[1];
    this._snapPrevPix[2] = this._snapPix[2];
    this._snapPrevPix[3] = this._snapPix[3];
    this._snapPrevPixValid = true;
  }

  _vs() {
    return `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main(){
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }`;
  }

  _fsFeedback() {
    return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_prev;
uniform vec2  u_res;
uniform float u_time;
uniform float u_dt;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;
uniform float u_mid_phase;
uniform float u_mid_phase_warp;
uniform float u_mid_phase_shape;
uniform float u_ray_phase;
uniform int   u_mask;
const int SHAPES = 32;
uniform vec4 u_shapeA[SHAPES];
uniform vec4 u_shapeB[SHAPES];

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

mat2 rot2(float a){
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Signed distance to a regular N-gon centered at origin (approx; fast + looks good).
float sdNgon(vec2 p, float n, float r){
  float a = atan(p.y, p.x);
  float k = 6.28318530718 / n;
  return cos(floor(0.5 + a / k) * k - a) * length(p) - r;
}

float ribbon(vec2 p, float y0, float w){
  float d = abs(p.y - y0);
  return exp(-d * w);
}

void main(){
  vec2 uv = v_uv;
  float aspect = u_res.x / max(1.0, u_res.y);

  // centered coords (aspect-corrected)
  vec2 p = uv - 0.5;
  p.x *= aspect;

  float r = length(p);
  float ang = atan(p.y, p.x);

  // --- feedback warp (Milkdrop-ish) ---
  float swirl = 0.35 + u_mid*0.95 + u_energy*0.35;
  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  // Use bounded u_ray_phase for rotation so it can't "lap" dozens of times on steady low end.
  float a = ang + swirl*wob + u_ray_phase + u_mid_phase_warp;

  // zoom/pump driven by bass + kick
  float zoom = 0.985 - u_bass*0.018 + u_kick*0.028;
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;

  // treble shimmer warp
  float sh = (0.004 + 0.018*u_treble) * (0.65 + 0.55*u_energy);
  q += sh * vec2(
    sin(u_time*1.25 + p.y*6.0),
    cos(u_time*1.05 + p.x*5.0)
  );

  vec2 uv2 = q;
  uv2.x /= aspect;
  uv2 += 0.5;

  // --- per-pixel "mesh warp" (Milkdrop-ish) ---
  // Tiny sine-grid displacement BEFORE sampling feedback. Keeps trails lively with near-zero CPU cost.
  float mf = mix(18.0, 42.0, u_treble); // mesh frequency
  float ma = (0.0012 + 0.0048*u_energy) * (0.55 + 0.85*u_treble); // mesh amplitude
  vec2 mp = (uv2 - 0.5);
  mp.x *= aspect;
  vec2 gw = vec2(
    sin(mp.y*mf + u_time*1.70) + sin(mp.y*(mf*0.53) - u_time*2.10),
    cos(mp.x*mf + u_time*1.30) + cos(mp.x*(mf*0.61) + u_time*2.40)
  );
  uv2 += ma * gw;

  uv2 = clamp(uv2, vec2(0.001), vec2(0.999));

  vec3 prev = texture(u_prev, uv2).rgb;

  // feedback decay (keep trails but prevent runaway)
  float fade60 = 0.965 - 0.020*u_energy + 0.010*u_kick;
  fade60 = clamp(fade60, 0.85, 0.995);
  float fade = pow(fade60, u_dt * 60.0);
  prev *= fade;

  // subtle channel drift (color cycling vibe)
  prev *= vec3(1.005, 0.998, 1.002);
  float pm = max(prev.r, max(prev.g, prev.b));
  prev *= 1.0 / (1.0 + pm * 0.6);

  // --- new content layer ---
  float baseHue = fract(0.58 + 0.12*sin(u_time*0.06) + 0.18*u_mid + 0.10*u_treble);

  // Ribbon waveforms (classic milkdrop-ish feel)
  float amp = (0.10 + 0.18*u_mid + 0.10*u_bass) * (0.85 + 0.60*u_energy);
  float w1 = (55.0 + 90.0*u_treble);
  float w2 = (40.0 + 75.0*u_treble);

  float yA = 0.08*sin(p.x*2.2 + u_ray_phase*1.10) + 0.06*sin(p.x*4.6 - u_ray_phase*0.85);
  float yB = 0.09*sin(p.x*1.5 - u_ray_phase*0.95) + 0.05*sin(p.x*5.2 + u_ray_phase*1.05);
  float yC = 0.06*sin(p.x*3.1 + u_ray_phase*1.30) + 0.04*sin(p.x*6.1 - u_ray_phase*0.75);

  float lineA = ribbon(p, yA*amp, w1);
  float lineB = ribbon(p, yB*amp, w2);
  float lineC = ribbon(p, yC*amp, w2);

  vec3 colA = hsv2rgb(vec3(baseHue + 0.00, 0.90, 1.00));
  vec3 colB = hsv2rgb(vec3(baseHue + 0.33, 0.85, 1.00));
  vec3 colC = hsv2rgb(vec3(baseHue + 0.66, 0.80, 1.00));

  float lineGain = 0.25 + 0.75 * smoothstep(0.06, 0.28, u_energy);

  // Split additive layers so md_mask can isolate them.
  vec3 rays = vec3(0.0);
  vec3 shapes = vec3(0.0);

  // --- "rays" layer: ribbons + pulse ring ---
  rays += colA * lineA * (0.65 * lineGain);
  rays += colB * lineB * (0.52 * lineGain);
  rays += colC * lineC * (0.46 * lineGain);

  // Radial pulse rings (bass/kick)
  float ringR = 0.22 + 0.08*sin(u_time*0.55) + 0.12*u_bass;
  float ring = exp(-abs(r - ringR) * (28.0 + 38.0*u_kick));
  rays += hsv2rgb(vec3(baseHue + 0.12, 0.70, 1.00)) * ring * (0.25 + 0.85*u_kick);

  // --- rotating polygon "shapes" (Milkdrop-ish) ---
  // One hex "reactor" + one triangle "blade". Additive glow so it feels like a preset layer.
  float rotA = u_time*0.35 + u_mid_phase_shape;
  vec2 sp = p;

  vec2 s1p = rot2(rotA) * (sp * (1.10 + 0.25*u_energy));
  float d1 = sdNgon(s1p, 6.0, 0.23 + 0.08*u_bass);
  float s1 = exp(-abs(d1) * (18.0 + 28.0*u_energy));
  float f1 = smoothstep(0.015, 0.0, d1); // a little fill
  shapes += hsv2rgb(vec3(baseHue + 0.05, 0.80, 1.00)) * (s1*0.20 + f1*0.05) * (0.45 + 0.65*u_energy);

  vec2 offs = vec2(0.12*sin(u_time*0.70), 0.08*cos(u_time*0.50));
  vec2 s2p = rot2(-rotA*1.30 + 0.70) * ((sp + offs) * (1.25 + 0.20*u_energy));
  float d2 = sdNgon(s2p, 3.0, 0.18 + 0.06*u_mid);
  float s2 = exp(-abs(d2) * (22.0 + 30.0*u_energy));
  float f2 = smoothstep(0.018, 0.0, d2);
  shapes += hsv2rgb(vec3(baseHue + 0.45, 0.85, 1.00)) * (s2*0.18 + f2*0.04) * (0.40 + 0.70*u_energy);

  // --- spawned shapes (fixed speed per-shape, parameters set on spawn) ---
  float throwBoost = 0.90;
  for (int i = 0; i < SHAPES; i++) {
    vec4 sa = u_shapeA[i];
    vec4 sb = u_shapeB[i];
    float life = sb.z;
    if (life <= 0.0) continue;

    vec2 pos = sa.xy;
    float size = sa.z;
    float sides = sa.w;
    float rotS = sb.x;
    float hue = fract(baseHue + sb.y);

    vec2 lp = rot2(rotS) * (p - pos);
    float dS = sdNgon(lp, sides, size);
    float glow = exp(-abs(dS) * (20.0 + 40.0*u_energy));
    float fill = smoothstep(0.020, 0.0, dS);
    vec3 sc  = hsv2rgb(vec3(hue, 0.85, 1.0));
    shapes += sc * (glow*0.32 + fill*0.10) * throwBoost * life;
  }

  // Sparkles (treble)
  vec2 g = floor((uv * vec2(240.0, 135.0)) + u_time*vec2(12.0, 7.0));
  float h = hash12(g);
  float sparkle = smoothstep(0.996 - 0.004*u_treble, 1.0, h);
  shapes += vec3(1.0) * sparkle * (0.08 + 0.35*u_treble) * (0.5 + 0.6*u_energy);

  // Combine
  vec3 col;
  if (u_mask == 1) {
    // Warp debug view: red lines + border markers over the warp field.
    vec2 grid = abs(fract(uv2 * vec2(12.0, 7.0)) - 0.5);
    float lineW = 0.03;
    float gx = step(grid.x, lineW);
    float gy = step(grid.y, lineW);
    float edgeW = 0.015;
    float edge = max(
      max(step(uv2.x, edgeW), step(1.0 - uv2.x, edgeW)),
      max(step(uv2.y, edgeW), step(1.0 - uv2.y, edgeW))
    );
    float lines = max(max(gx, gy), edge);
    vec3 dbg = vec3(1.0, 0.08, 0.08) * lines;
    col = prev + dbg;
  } else if (u_mask == 2) {
    // Shapes only (center shapes + spawned shapes + sparkles)
    col = shapes;
  } else if (u_mask == 3) {
    // Rays only (ribbons + ring)
    col = rays;
  } else {
    // Normal
    col = prev + rays + shapes;
  }

  // Gentle limiter to prevent slow buildup over time.
  float m = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + m * 0.35);

  // Cheap "bloom-ish" curve
  col += col * col * (0.30 + 0.35*u_energy);

  // Vignette
  float vig = smoothstep(1.25, 0.20, r);
  col *= (0.55 + 0.45*vig);

  // Tone map
  col = col / (1.0 + col);
  col = pow(col, vec3(0.92));

  outColor = vec4(col, 1.0);
}`;
  }

  _fsDebug() {
    return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_prev;
uniform vec2  u_res;
uniform float u_time;
uniform float u_dt;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_energy;
uniform float u_kick;
uniform float u_mid_phase;
uniform float u_mid_phase_warp;
uniform float u_ray_phase;

vec2 pickUv(){
  float sx = (gl_FragCoord.x < 1.0) ? 0.25 : 0.75;
  float sy = (gl_FragCoord.y < 1.0) ? 0.25 : 0.75;
  return vec2(sx, sy);
}

void main(){
  vec2 uv = pickUv();
  float aspect = u_res.x / max(1.0, u_res.y);

  vec2 p = uv - 0.5;
  p.x *= aspect;

  float r = length(p);
  float ang = atan(p.y, p.x);

  float swirl = 0.35 + u_mid*0.95 + u_energy*0.35;
  float wob  = 0.45*sin(u_time*0.30 + r*2.70) + 0.25*cos(u_time*0.21 - r*4.10);
  float a = ang + swirl*wob + u_ray_phase + u_mid_phase_warp;

  float zoom = 0.985 - u_bass*0.018 + u_kick*0.028;
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;

  float sh = (0.004 + 0.018*u_treble) * (0.65 + 0.55*u_energy);
  q += sh * vec2(
    sin(u_time*1.25 + p.y*6.0),
    cos(u_time*1.05 + p.x*5.0)
  );

  vec2 uv2 = q;
  uv2.x /= aspect;
  uv2 += 0.5;

  float mf = mix(18.0, 42.0, u_treble);
  float ma = (0.0012 + 0.0048*u_energy) * (0.55 + 0.85*u_treble);
  vec2 mp = (uv2 - 0.5);
  mp.x *= aspect;
  vec2 gw = vec2(
    sin(mp.y*mf + u_time*1.70) + sin(mp.y*(mf*0.53) - u_time*2.10),
    cos(mp.x*mf + u_time*1.30) + cos(mp.x*(mf*0.61) + u_time*2.40)
  );
  uv2 += ma * gw;

  vec2 uv2_raw = uv2;
  vec2 uv2_clamped = clamp(uv2_raw, vec2(0.001), vec2(0.999));
  vec3 prev = texture(u_prev, uv2_clamped).rgb;

  float eps = 1e-4;
  float oob = (uv2_raw.x < -eps || uv2_raw.x > 1.0 + eps || uv2_raw.y < -eps || uv2_raw.y > 1.0 + eps) ? 1.0 : 0.0;
  float clampHit = (distance(uv2_raw, uv2_clamped) > eps) ? 1.0 : 0.0;
  bool nf = any(isnan(uv2_raw)) || any(isinf(uv2_raw)) ||
            any(isnan(uv2_clamped)) || any(isinf(uv2_clamped)) ||
            any(isnan(prev)) || any(isinf(prev));
  float nonfinite = nf ? 1.0 : 0.0;
  float bright = max(prev.r, max(prev.g, prev.b));

  outColor = vec4(oob, nonfinite, clampHit, bright);
}`;
  }

  _fsPresent() {
    return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;

void main(){
  vec3 col = texture(u_tex, v_uv).rgb;
  // tiny final pop
  col = pow(col, vec3(0.98));
  outColor = vec4(col, 1.0);
}`;
  }
}
