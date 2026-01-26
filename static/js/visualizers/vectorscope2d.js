// Vectorscope2D (v0.2)
//
// Key tweak constants (sane defaults):
// - PTS_TARGET: decimated stereo points per frame (CPU guardrail)
// - ENERGY_GATE_LO/HI: alpha gate thresholds so silence decays to 0
// - FADE60_OVERLAY/BG: destination-out fade per 60fps frame (scaled by dt)
// - BASS_PERSIST_BOOST: bass slightly reduces fade (more persistence)
// - MODE_ENTER/MODE_EXIT: auto mode switch hysteresis (low energy vs high energy)
// - SEG_BREAK: segment length in low-energy mode (short segments/points)

const PTS_TARGET = 1024;
const PTS_MIN = 256;
const PTS_MAX = 1536;

const ENERGY_GATE_LO = 0.015;
const ENERGY_GATE_HI = 0.110;

const FADE60_OVERLAY = 0.120;
const FADE60_BG = 0.145;
const FADE_MIN = 0.030;
const FADE_MAX = 0.250;
const BASS_PERSIST_BOOST = 0.22;

const AGC_TARGET = 0.78;
const AGC_MIN = 0.35;
const AGC_MAX = 3.00;
const AGC_ATK = 14.0;
const AGC_REL = 5.5;

const SMOOTH_ENERGY = 10.0;
const SMOOTH_BANDS = 6.0;
const SMOOTH_CORR = 4.0;
const SMOOTH_GATE = 14.0;

const MODE_ENTER = 0.42;
const MODE_EXIT = 0.25;
const SEG_BREAK = 5;

const SCALE = 0.46;

const GRID_ALPHA_OVERLAY = 0.55; // multiplied by per-frame gating
const GRID_ALPHA_BG = 0.45;      // multiplied by per-frame gating

const BG_COLOR = "rgb(10, 8, 20)";
const BLACK = "rgb(0, 0, 0)";

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function smoothstep01(x) {
  // x assumed clamped 0..1
  return x * x * (3 - 2 * x);
}

function emaStep(dt, ratePerSec) {
  // returns blend factor k in [0..1] for: cur += (target-cur)*k
  // dt-correct, stable for dt spikes
  const x = dt * ratePerSec;
  return x <= 0 ? 0 : (x > 50 ? 1 : (1 - Math.exp(-x)));
}

function scalar0(v) {
  if (Number.isFinite(v)) return v;
  if (v && typeof v.length === "number") {
    const x = v[0];
    return Number.isFinite(x) ? x : NaN;
  }
  return NaN;
}

function scalar1(v) {
  if (v && typeof v.length === "number") {
    const x = v[1];
    return Number.isFinite(x) ? x : NaN;
  }
  return NaN;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class Vectorscope2D {
  static id = "vectorscope";
  static name = "Vectorscope / Goniometer (Canvas2D)";
  static renderer = "2d";

  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas ? this.canvas.getContext("2d", { alpha: true }) : null;

    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._lastNowMs = 0;

    // Smoothed audio controls
    this._energy = 0;
    this._bass = 0;
    this._mid = 0;
    this._high = 0;
    this._corr = 1;
    this._gate = 0;

    // AGC
    this._agc = 1.0;

    // Mode switching (low energy = segmented points, high energy = continuous trace)
    this._lineMode = false;

    // Cached grid (offscreen) and LUTs
    this._grid = null;
    this._gridCtx = null;
    this._gridBW = 0;
    this._gridBH = 0;
    this._gridOverlay = false;

    this._coreLUT = null;
    this._glowLUT = null;

    this._debug = false;
    if (typeof window !== "undefined") {
      const qs = new URLSearchParams(window.location.search || "");
      this._debug = qs.get("debug") === "1";
    }

    if (this.ctx) {
      this.ctx.lineJoin = "round";
      this.ctx.lineCap = "round";
    }

    this._buildColorLUT();
  }

  _buildColorLUT() {
    // Controlled palette (no rainbow spam): correlation -> neon hue family
    // Modern synthwave: corr=-1 hot pink, corr=0 purple, corr=+1 electric cyan.
    const neg = [255, 80, 210];
    const mid = [170, 85, 255];
    const pos = [80, 240, 255];

    const core = new Array(256);
    const glow = new Array(256);

    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (t < 0.5) {
        const u = t * 2;
        r = lerp(neg[0], mid[0], u);
        g = lerp(neg[1], mid[1], u);
        b = lerp(neg[2], mid[2], u);
      } else {
        const u = (t - 0.5) * 2;
        r = lerp(mid[0], pos[0], u);
        g = lerp(mid[1], pos[1], u);
        b = lerp(mid[2], pos[2], u);
      }

      // Core: slightly compressed brightness (keeps it crisp)
      const rc = r * 0.92;
      const gc = g * 0.92;
      const bc = b * 0.92;

      // Glow: a bit brighter and bluer, but capped
      const rg = Math.min(255, r * 1.02 + 12);
      const gg = Math.min(255, g * 1.00 + 10);
      const bg = Math.min(255, b * 1.06 + 18);

      core[i] = `rgb(${rc | 0}, ${gc | 0}, ${bc | 0})`;
      glow[i] = `rgb(${rg | 0}, ${gg | 0}, ${bg | 0})`;
    }

    this._coreLUT = core;
    this._glowLUT = glow;
  }

  _ensureGrid(cssW, cssH, dpr, overlay) {
    const bw = Math.max(2, (cssW * dpr) | 0);
    const bh = Math.max(2, (cssH * dpr) | 0);

    if (this._grid && this._gridBW === bw && this._gridBH === bh && this._gridOverlay === overlay) {
      return;
    }

    let g = this._grid;
    if (!g) {
      // Offscreen canvas (normal canvas works in CEF)
      g = (typeof document !== "undefined") ? document.createElement("canvas") : null;
      this._grid = g;
    }
    if (!g) return;

    g.width = bw;
    g.height = bh;
    this._gridBW = bw;
    this._gridBH = bh;
    this._gridOverlay = overlay;

    const gctx = g.getContext("2d", { alpha: true });
    this._gridCtx = gctx;
    if (!gctx) return;

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW * 0.5;
    const cy = cssH * 0.5;
    const r = Math.min(cssW, cssH) * SCALE;

    // Subtle synthwave reticle (tinted violet, never dominant)
    const major = overlay ? "rgba(210, 140, 255, 0.18)" : "rgba(190, 120, 255, 0.14)";
    const minor = overlay ? "rgba(210, 140, 255, 0.10)" : "rgba(190, 120, 255, 0.08)";

    const lwMajor = 1.0;
    const lwMinor = 1.0;

    // Axes + diagonals (diamond reference)
    gctx.save();
    gctx.globalCompositeOperation = "source-over";

    gctx.strokeStyle = major;
    gctx.lineWidth = lwMajor;

    gctx.beginPath();
    // Horizontal / vertical
    gctx.moveTo(0, cy);
    gctx.lineTo(cssW, cy);
    gctx.moveTo(cx, 0);
    gctx.lineTo(cx, cssH);
    // Diagonals
    gctx.moveTo(cx - r, cy + r);
    gctx.lineTo(cx + r, cy - r);
    gctx.moveTo(cx - r, cy - r);
    gctx.lineTo(cx + r, cy + r);
    gctx.stroke();
    gctx.restore();

    // Rings + diamonds (reticle)
    gctx.save();
    gctx.globalCompositeOperation = "source-over";
    gctx.strokeStyle = minor;
    gctx.lineWidth = lwMinor;

    const r1 = r;
    const r2 = r * 0.72;
    const r3 = r * 0.44;

    gctx.beginPath();
    gctx.arc(cx, cy, r1, 0, Math.PI * 2);
    gctx.arc(cx, cy, r2, 0, Math.PI * 2);
    gctx.arc(cx, cy, r3, 0, Math.PI * 2);

    // Diamond shapes
    gctx.moveTo(cx, cy - r1);
    gctx.lineTo(cx + r1, cy);
    gctx.lineTo(cx, cy + r1);
    gctx.lineTo(cx - r1, cy);
    gctx.closePath();

    gctx.moveTo(cx, cy - r2);
    gctx.lineTo(cx + r2, cy);
    gctx.lineTo(cx, cy + r2);
    gctx.lineTo(cx - r2, cy);
    gctx.closePath();

    gctx.stroke();
    gctx.restore();
  }

  onResize(w, h, dpr) {
    if (Number.isFinite(dpr) && dpr > 0) this._dpr = dpr;
    if (Number.isFinite(w) && w > 0) this._cssW = w;
    if (Number.isFinite(h) && h > 0) this._cssH = h;
    // grid is rebuilt lazily in onFrame using current canvas dims + overlay flag
  }

  onFrame(frame) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const f = frame || null;

    let dpr = (f && Number.isFinite(f.dpr) && f.dpr > 0) ? f.dpr : this._dpr;
    if (!(dpr > 0)) {
      const deviceDpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      dpr = deviceDpr > 0 ? deviceDpr : 1;
    }
    this._dpr = dpr;

    const backingW = canvas.width | 0;
    const backingH = canvas.height | 0;
    const cssW = backingW / dpr;
    const cssH = backingH / dpr;
    if (!(cssW > 1 && cssH > 1)) return;
    this._cssW = cssW;
    this._cssH = cssH;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // dt (seconds) - prefer frame.dt, but keep a safe fallback
    let dt = (f && Number.isFinite(f.dt)) ? f.dt : 0;
    if (!(dt > 0)) {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const last = this._lastNowMs;
      this._lastNowMs = now;
      dt = Number.isFinite(last) && last > 0 ? (now - last) * 0.001 : (1 / 60);
    }
    // Clamp for stability of fades/EMAs (rate math stays dt-correct via exp form).
    dt = clamp(dt, 0, 0.1);

    const overlay = !!(f && f.overlay);

    // --- Overlay-safe trails (remove alpha, don't paint black) ---
    // Bass slightly increases persistence by reducing fade.
    const bassRaw0 = (f && Number.isFinite(f.bass)) ? f.bass : 0;
    const bassRaw = clamp01(bassRaw0);
    // dt-correct: destination-out multiplies alpha by (1 - fade), so we convert
    // the 60fps fade constant into an equivalent fade for the current dt.
    const baseFade60 = overlay ? FADE60_OVERLAY : FADE60_BG;
    let fade60 = baseFade60 * (1 - BASS_PERSIST_BOOST * bassRaw);
    fade60 = clamp(fade60, 0.001, 0.95);
    const keep = Math.pow(1 - fade60, dt * 60);
    let fadeAlpha = 1 - keep;
    fadeAlpha = clamp(fadeAlpha, FADE_MIN, FADE_MAX);

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = fadeAlpha;
    ctx.fillStyle = BLACK;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();

    if (!overlay) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
    }

    // --- Audio controls (dt-correct smoothing) ---
    const energyRaw0 = (f && Number.isFinite(f.energy)) ? f.energy : 0;
    const gain0 = (f && Number.isFinite(f.gain)) ? f.gain : 1;
    const rms0 = scalar0(f && f.rms);
    const rms1 = scalar1(f && f.rms);
    const peak0 = scalar0(f && f.peak);
    const peak1 = scalar1(f && f.peak);
    let rms = 0;
    if (Number.isFinite(rms0)) rms = Math.max(rms, Math.abs(rms0));
    if (Number.isFinite(rms1)) rms = Math.max(rms, Math.abs(rms1));
    let peakAmp = 0;
    if (Number.isFinite(peak0)) peakAmp = Math.max(peakAmp, Math.abs(peak0));
    if (Number.isFinite(peak1)) peakAmp = Math.max(peakAmp, Math.abs(peak1));
    const midRaw0 = (f && Number.isFinite(f.mid)) ? f.mid : 0;
    const highRaw0 = (f && Number.isFinite(f.high)) ? f.high : 0;

    const energyFallback = clamp01(Math.max(rms * 6.0, peakAmp * 1.4) * gain0);
    const energyRaw = clamp01(Math.max(energyRaw0, energyFallback));
    const midRaw = clamp01(midRaw0);
    const highRaw = clamp01(highRaw0);

    const kE = emaStep(dt, SMOOTH_ENERGY);
    const kB = emaStep(dt, SMOOTH_BANDS);
    const kC = emaStep(dt, SMOOTH_CORR);

    this._energy += (energyRaw - this._energy) * kE;
    this._bass += (bassRaw - this._bass) * kB;
    this._mid += (midRaw - this._mid) * kB;
    this._high += (highRaw - this._high) * kB;

    // Correlation: prefer frame.corr, else derive a reasonable default for mono
    let corrIn = (f && Number.isFinite(f.corr)) ? f.corr : NaN;
    if (!Number.isFinite(corrIn)) {
      corrIn = (f && f.channels === 2) ? 0 : 1;
    }
    corrIn = clamp(corrIn, -1, 1);
    this._corr += (corrIn - this._corr) * kC;

    // Gate (silence -> 0)
    let g0 = (this._energy - ENERGY_GATE_LO) / (ENERGY_GATE_HI - ENERGY_GATE_LO);
    g0 = clamp01(g0);
    g0 = smoothstep01(g0);
    const kG = emaStep(dt, SMOOTH_GATE);
    this._gate += (g0 - this._gate) * kG;

    const gate = this._gate;

    // Mode hysteresis (prevents flicker)
    if (this._lineMode) {
      if (gate < MODE_EXIT) this._lineMode = false;
    } else {
      if (gate > MODE_ENTER) this._lineMode = true;
    }

    // If silent, don't draw anything new; the destination-out fade will decay to 0 alpha.
    if (gate < 0.002) return;

    // --- Grid (cached offscreen, blitted each frame, energy-gated) ---
    this._ensureGrid(cssW, cssH, dpr, overlay);
    if (this._grid) {
      const gridBase = overlay ? GRID_ALPHA_OVERLAY : GRID_ALPHA_BG;
      const gridAlpha = gridBase * (0.08 + 0.92 * gate);
      if (gridAlpha > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = gridAlpha;
        ctx.drawImage(this._grid, 0, 0, cssW, cssH);
        ctx.restore();
      }
    }

    // --- Auto gain (AGC), stable across tracks, no explosion in silence ---
    let userGain = (f && Number.isFinite(f.gain)) ? f.gain : 1;
    if (!(userGain > 0)) userGain = 1;

    const pk0 = scalar0(f && f.peak);
    const pk1 = scalar1(f && f.peak);
    let peak = 1e-4;
    if (Number.isFinite(pk0)) peak = Math.max(peak, Math.abs(pk0));
    if (Number.isFinite(pk1)) peak = Math.max(peak, Math.abs(pk1));
    if (!(peak > 0)) peak = 1e-4;

    let desired = AGC_TARGET / (peak * userGain);
    desired = clamp(desired, AGC_MIN, AGC_MAX);

    const atk = emaStep(dt, AGC_ATK);
    const rel = emaStep(dt, AGC_REL);
    const r = desired > this._agc ? atk : rel;
    this._agc += (desired - this._agc) * r;
    this._agc = clamp(this._agc, AGC_MIN, AGC_MAX);

    const g = userGain * this._agc;

    // --- Sample mapping (L vs R) ---
    const waveLR = (f && f.waveLR && f.waveLR.length) ? f.waveLR : null;
    const wave = (f && f.wave && f.wave.length) ? f.wave : null;

    const useStereo = !!(waveLR && waveLR.length >= 2 && f && f.channels === 2);
    let n = 0;
    if (useStereo) n = (waveLR.length / 2) | 0;
    else if (wave) n = wave.length | 0;

    if (n <= 1) return;

    // Point density: keep bounded and resolution-aware
    let pts = PTS_TARGET;
    const minDim = cssW < cssH ? cssW : cssH;
    // slightly more points at larger sizes, still clamped
    const sizePts = (minDim * 3.0) | 0;
    if (sizePts > pts) pts = sizePts;
    pts = clamp(pts, PTS_MIN, PTS_MAX) | 0;

    let step = (n / pts) | 0;
    if (step < 1) step = 1;

    const cx = cssW * 0.5;
    const cy = cssH * 0.5;
    const scale = minDim * SCALE;

    // Color based on correlation (controlled palette)
    const corr = clamp(this._corr, -1, 1);
    const ci = (((corr + 1) * 0.5) * 255) | 0;
    const coreColor = this._coreLUT ? this._coreLUT[ci] : "rgb(120, 220, 255)";
    const glowColor = this._glowLUT ? this._glowLUT[ci] : "rgb(80, 200, 255)";

    // Thickness and brightness driven by bands (clamped; no smear)
    let th = 1.05 + 1.8 * this._mid + 0.8 * gate;
    th = clamp(th, 0.9, 3.2);

    const shimmer = clamp01(this._high * 1.25);
    const alphaCore = clamp01((0.22 + 0.62 * gate) * gate);
    const alphaGlow = clamp01((0.08 + 0.14 * gate) * gate);
    const alphaSpark = clamp01(0.10 * shimmer * gate);

    // Choose drawing strategy
    const segmented = !this._lineMode;

    // Outer glow pass (additive, controlled)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = th * 2.8;
    ctx.globalAlpha = alphaGlow * 0.55;
    ctx.beginPath();

    let first = true;
    let seg = 0;

    if (useStereo) {
      for (let i = 0; i < n; i += step) {
        const base = i << 1;
        let L = waveLR[base] * g;
        let R = waveLR[base + 1] * g;
        if (!Number.isFinite(L)) L = 0;
        if (!Number.isFinite(R)) R = 0;
        L = clamp(L, -1.25, 1.25);
        R = clamp(R, -1.25, 1.25);
        const x = cx + L * scale;
        const y = cy - R * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    } else {
      // Mono -> diagonal line (L=R)
      for (let i = 0; i < n; i += step) {
        let v = wave[i] * g;
        if (!Number.isFinite(v)) v = 0;
        v = clamp(v, -1.25, 1.25);
        const x = cx + v * scale;
        const y = cy - v * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    }

    ctx.stroke();
    ctx.restore();

    // Inner glow pass (additive)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = th * 1.7;
    ctx.globalAlpha = alphaGlow * 0.85;
    ctx.beginPath();

    first = true;
    seg = 0;

    if (useStereo) {
      for (let i = 0; i < n; i += step) {
        const base = i << 1;
        let L = waveLR[base] * g;
        let R = waveLR[base + 1] * g;
        if (!Number.isFinite(L)) L = 0;
        if (!Number.isFinite(R)) R = 0;
        L = clamp(L, -1.25, 1.25);
        R = clamp(R, -1.25, 1.25);
        const x = cx + L * scale;
        const y = cy - R * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    } else {
      for (let i = 0; i < n; i += step) {
        let v = wave[i] * g;
        if (!Number.isFinite(v)) v = 0;
        v = clamp(v, -1.25, 1.25);
        const x = cx + v * scale;
        const y = cy - v * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    }

    ctx.stroke();
    ctx.restore();

    // Crisp core trace (source-over)
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = coreColor;
    ctx.lineWidth = th;
    ctx.globalAlpha = alphaCore;
    ctx.beginPath();

    first = true;
    seg = 0;

    if (useStereo) {
      for (let i = 0; i < n; i += step) {
        const base = i << 1;
        let L = waveLR[base] * g;
        let R = waveLR[base + 1] * g;
        if (!Number.isFinite(L)) L = 0;
        if (!Number.isFinite(R)) R = 0;
        L = clamp(L, -1.25, 1.25);
        R = clamp(R, -1.25, 1.25);
        const x = cx + L * scale;
        const y = cy - R * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    } else {
      for (let i = 0; i < n; i += step) {
        let v = wave[i] * g;
        if (!Number.isFinite(v)) v = 0;
        v = clamp(v, -1.25, 1.25);
        const x = cx + v * scale;
        const y = cy - v * scale;

        if (first) {
          ctx.moveTo(x, y);
          first = false;
          seg = 0;
        } else {
          if (segmented) {
            if (seg >= SEG_BREAK) {
              ctx.moveTo(x, y);
              seg = 0;
            } else {
              ctx.lineTo(x, y);
              seg++;
            }
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
    }

    ctx.stroke();
    ctx.restore();

    // Subtle sparkle/high pass highlight (very thin, additive, capped)
    if (alphaSpark > 0.002) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = coreColor;
      ctx.lineWidth = Math.max(0.9, th * 0.75);
      ctx.globalAlpha = alphaSpark;
      ctx.beginPath();

      first = true;
      seg = 0;

      if (useStereo) {
        for (let i = 0; i < n; i += (step << 1)) { // slightly sparser
          const base = i << 1;
          let L = waveLR[base] * g;
          let R = waveLR[base + 1] * g;
          if (!Number.isFinite(L)) L = 0;
          if (!Number.isFinite(R)) R = 0;
          L = clamp(L, -1.25, 1.25);
          R = clamp(R, -1.25, 1.25);
          const x = cx + L * scale;
          const y = cy - R * scale;

          if (first) {
            ctx.moveTo(x, y);
            first = false;
            seg = 0;
          } else {
            if (segmented) {
              if (seg >= (SEG_BREAK >> 1)) {
                ctx.moveTo(x, y);
                seg = 0;
              } else {
                ctx.lineTo(x, y);
                seg++;
              }
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
      } else {
        for (let i = 0; i < n; i += (step << 1)) {
          let v = wave[i] * g;
          if (!Number.isFinite(v)) v = 0;
          v = clamp(v, -1.25, 1.25);
          const x = cx + v * scale;
          const y = cy - v * scale;

          if (first) {
            ctx.moveTo(x, y);
            first = false;
            seg = 0;
          } else {
            if (segmented) {
              if (seg >= (SEG_BREAK >> 1)) {
                ctx.moveTo(x, y);
                seg = 0;
              } else {
                ctx.lineTo(x, y);
                seg++;
              }
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
      }

      ctx.stroke();
      ctx.restore();
    }
  }

  destroy() {
    // No external side effects.
    this._gridCtx = null;
    this._grid = null;
  }
}
