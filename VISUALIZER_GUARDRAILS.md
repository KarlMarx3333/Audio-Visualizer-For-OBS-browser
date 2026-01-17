# Visualizer Guardrails (Do Not Do List)

A compact, practical list of the stuff we should not do in our visualizers (Canvas2D + WebGL), especially for OBS Browser Source (CEF) where FPS and sizing differ from normal browsers.

---

## Timing & Simulation (FPS Independence)

- DO NOT tie any behavior to FPS (e.g., "spawn 2 per frame", "move 1px per frame"). Always use dt.
- DO NOT use clamped dt for rate math (spawns-per-second, decay, envelopes). If you clamp for stability, keep:
  - dtReal for rate/accumulator math
  - dtMove (clamped) for motion/integration
- DO NOT use frame-rate-dependent motion or decay. Always express rates in per-second units.
- DO NOT let dt spikes teleport state. Clamp motion/integration, but keep rate systems time-correct.
- DO NOT let accumulators grow unbounded. Clamp or wrap safely to avoid float drift.
- DO NOT use fixed smoothing coefficients (e.g., a = 0.86) unless dt-corrected.
  - Preferred pattern: a = pow(a60, dt*60).
- DO NOT let u_time grow unbounded when shaders use it heavily. Prefer phase accumulators or bounded time.
- DO NOT wrap time if it drives non-periodic motion (translation/integration). Wrap only for periodic/phase usage.
  - Preferred: phase = (phase + omega*dt) % TAU.

---

## Spawning, Pools, and Lifetimes

- DO NOT cap spawns per frame without catch-up. If you use an accumulator, spawn floor(acc) per frame (with a sane safety limit), not "max 2".
- DO NOT use a tiny fixed pool with overwrite unless you guarantee:
  - poolSize >= spawnRate * expectedLifetime
  Otherwise you get on-screen despawn via overwrites.
- DO NOT make burst effects frame-based. Bursts must be transient-driven (kick/edge detector), not "every frame while bass is high".
- DO NOT treat "bass is high" as a beat. Use flux (max(0, bassNow - bassPrev)) with thresholding.
- DO NOT allow continuous re-trigger during sustained bass. Use local maxima + cooldown and/or hysteresis.
- DO NOT skip warmup logic if first-hit mega burst risk exists.

---

## Audio Mapping & Dynamics

- DO NOT use raw FFT bins directly as visuals. Use rebinning + smoothing + shaping.
- DO NOT use linear-frequency bars for music spectra. Bass will look chunky and wrong. Use log bands.
- DO NOT use raw magnitudes without compression. Prefer dB/log scaling (or log1p).
- DO NOT use mean-only band energy for kick-like behavior. Use peak or a peak/RMS blend.
- DO NOT apply aggressive shaping curves blindly (e.g., v*v everywhere). It commonly crushes mids/highs.
- DO NOT drive major visual parameters from unstable one-frame audio deltas without smoothing/thresholding.

---

## Loudness Normalization (AGC / Anti-Drift)

- DO NOT let different tracks create wildly different visual intensity. Implement slow AGC:
  - Track long-term energy with a slow EMA (multi-second), set visualGain = target / avgEnergy, clamp min/max.
- DO NOT let AGC explode in silence. Freeze or clamp AGC when energy is near-zero.

---

## Feedback / Trails (Ping-Pong Stability)

- DO NOT run feedback without an explicit decay < 1.0 (no unity-gain loops).
- DO NOT use fixed decay constants if you want consistent 30 vs 60 FPS look.
  - Preferred pattern: decay = pow(decay60, dt*60).
- DO NOT ignore 8-bit burn-in / quantization sticking in feedback buffers.
  - If using 8-bit FBOs: clamp tiny values to black (or periodic soft reset).
  - Prefer float/half-float feedback targets when available.
- DO NOT forget CLAMP_TO_EDGE on ping-pong textures (prevents wrap smearing on zoom/rotate).
- DO NOT allow runaway brightness. Add a safety damp/watchdog if total brightness climbs over minutes.

---

## WebGL Performance & Correctness

- DO NOT create/compile/link shaders per frame.
- DO NOT create buffers/textures/framebuffers per frame.
- DO NOT hard-clamp feedback UVs in a way that can stick then pop at edges. Use gentle edge handling.
- DO NOT clear with opaque alpha in overlay mode (breaks transparent compositing).
- DO NOT mismatch FBO size vs u_res / viewport. Use actual render target dimensions.
- DO NOT add lots of draw calls/state switches if it can be batched/instanced.
- DO NOT thrash useProgram/bindTexture unnecessarily inside the frame loop.

---

## Canvas2D Performance & Look

- DO NOT use expensive blur filters every frame (ctx.filter = "blur(...)") in Canvas2D. CEF performance tanks.
- DO NOT clearRect in overlay mode if you want trails. Prefer destination-out fade and scale by dt.
- DO NOT hardcode point/bar counts without size-based clamping. Scale density to canvas width.
- DO NOT scroll 1px per frame (spectrogram/waterfall). Scroll must be px-per-second via dt accumulator:
  - scrollAcc += scrollPxPerSec * dt; n = floor(scrollAcc); scrollAcc -= n; drawImage(off, 0, n);

---

## GC / Allocations (Real-Time Loop Hygiene)

- DO NOT allocate inside hot loops (per-bin/per-point/per-pixel).
  - Example to avoid: returning [r,g,b] arrays per pixel/bin.
  - Prefer LUT/typed arrays and write scalars directly.
- DO NOT define helper functions inside onFrame for visualizers that run every frame.
- DO NOT allocate lots of objects/arrays per frame (points, gradients, colors). Preallocate and reuse.

---

## Resizing & OBS/CEF Quirks

- DO NOT rebuild ping-pong targets on tiny size jitter (OBS/CEF can fluctuate by 1px). Debounce resize rebuilds.
- DO NOT ignore devicePixelRatio. Mismatched canvas size causes blur and uneven scaling.
- DO NOT assume OBS runs the same FPS as your real browser. Design to look acceptable at 30fps.
- DO NOT trust OBS caching during development. Use refresh + cache busting when validating changes.

---

## Stability / Snap Prevention

- DO NOT allow NaNs/Infs to propagate. Clamp/sanitize inputs and protect shader math from invalid values.
- DO NOT assume frame.spectrum, frame.wave, or frame.fftSize exist. Guard inputs and use safe defaults.
- DO NOT make global state depend on one missing audio frame. If audio data is absent/invalid, hold last good values or ease toward silence.
- DO NOT reset phases/state on non-finite without logging. If you must guard, make it diagnosable.

---

## Complexity Traps

- DO NOT add UI knobs/modes unless required. Most visualizers should have a strong default.
- DO NOT change the loader/lifecycle contract (no custom rAF loops, no hidden timers, no global listeners that outlive destroy()).
- DO NOT shadow critical variable names in the same scope. It can break module load or hide bugs.
- DO NOT leave debug logging enabled by default. Gate behind a flag and throttle logs.
- DO NOT introduce helpful behavior changes outside the request scope. Fix what was asked, nothing extra.

---

## Repo-Specific Known Offenders (Examples)

- Spectrogram2D: per-frame 1px scroll + per-pixel array alloc in vivid() return path.
- FeedbackMirrorWebGL / ParticleSwarmWebGL2: fixed smoothing constants (non-dt), and helper functions defined inside onFrame.
- Vectorscope2D / ChromaRing2D: constant fade/smoothing (non-dt), so OBS 30fps looks different than 60fps.

---

## Quick Pre-Ship Checklist

- [ ] Looks similar in Chrome vs OBS Browser Source (30/60 fps)
- [ ] No per-frame shader/buffer/texture creation
- [ ] Spawn + decay are dt-based (not frame-based)
- [ ] Resize is debounced (no constant target rebuilds)
- [ ] Overlay-safe alpha handling
- [ ] No NaNs/Infs; missing audio frames do not snap visuals
