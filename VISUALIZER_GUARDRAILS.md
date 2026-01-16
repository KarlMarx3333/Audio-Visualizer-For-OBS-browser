# Visualizer Guardrails (Do Not Do List)

A compact, practical list of the stuff we **should not do** in our visualizers (Canvas2D + WebGL), especially for **OBS Browser Source (CEF)** where FPS and sizing differ from normal browsers.

---

## Timing & Simulation (FPS Independence)

- **DO NOT tie any behavior to FPS** (e.g., “spawn 2 per frame”, “move 1px per frame”). Always use `dt`.
- **DO NOT use clamped `dt` for rate math** (spawns-per-second, decay, envelopes).  
  If you clamp `dt` for stability, keep:
  - `dtReal` for rate/accumulator math
  - `dtMove` (clamped) for motion/integration
- **DO NOT wrap time (`u_time % X`)** for anything that drives motion/warps/phases. Wraps create visible discontinuities (“snaps”).
- **DO NOT let `dt` spikes teleport state.** Clamp motion/integration, but keep rate systems time-correct.
- **DO NOT let accumulators grow unbounded.** Clamp or wrap safely to avoid float drift.

---

## Spawning, Pools, and Lifetimes

- **DO NOT cap spawns per frame without catch-up.** If you use an accumulator, spawn `floor(acc)` per frame (with a sane safety limit), not “max 2”.
- **DO NOT use a tiny fixed pool with overwrite** unless you guarantee:
  - `poolSize >= spawnRate * expectedLifetime`
  Otherwise you get on-screen “despawn” via overwrites.
- **DO NOT make “burst” effects frame-based.** Bursts must be time/transient-driven (kick/edge detector), not “every frame while bass is high”.

---

## Audio Mapping & Dynamics

- **DO NOT use raw FFT bins directly as visuals.** Use rebinning + smoothing + shaping.
- **DO NOT use linear-frequency bars** for music spectra. Bass will look chunky and wrong. Use log bands.
- **DO NOT apply aggressive shaping curves blindly** (e.g. `v*v` everywhere). It commonly crushes mids/highs.
- **DO NOT drive major visual parameters from unstable one-frame audio deltas** without smoothing/thresholding (causes snapping/jitter).

---

## WebGL Performance & Correctness

- **DO NOT create/compile/link shaders per frame.**
- **DO NOT create buffers/textures/framebuffers per frame.**
- **DO NOT rely on huge `u_time` values** for long runs (float precision can cause quantized motion/jitter). Prefer phase accumulators or bounded time.
- **DO NOT hard-clamp feedback UVs** in a way that can “stick then pop” at edges. If you clamp, do it gently or use edge handling that doesn’t create discontinuities.
- **DO NOT clear with opaque alpha** in overlay mode (breaks transparent compositing).
- **DO NOT mismatch FBO size vs `u_res` / viewport.** Use the actual render target dimensions.

---

## Canvas2D Performance & Look

- **DO NOT use expensive blur filters every frame** (`ctx.filter = "blur(...)"`) in Canvas2D—CEF performance tanks.
- **DO NOT allocate lots of objects/arrays per frame** (points, gradients, colors). Preallocate and reuse.
- **DO NOT `clearRect` in overlay mode** if you want trails. Prefer `destination-out` fade and scale the fade by `dt`.
- **DO NOT hardcode point/bar counts** without size-based clamping. Scale density to canvas width.

---

## Resizing & OBS/CEF Quirks

- **DO NOT rebuild ping-pong targets on tiny size jitter** (OBS/CEF can fluctuate by 1px). Debounce resize rebuilds.
- **DO NOT ignore `devicePixelRatio`.** Mismatched canvas size causes blur and uneven scaling.
- **DO NOT assume OBS runs the same FPS as your real browser.** Design to look acceptable at 30fps.
- **DO NOT trust OBS caching during development.** Use refresh + cache busting when validating changes.

---

## Stability / Snap Prevention

- **DO NOT allow NaNs/Infs to propagate.** Clamp/sanitize inputs and protect shader math from invalid values.
- **DO NOT assume `frame.spectrum`, `frame.wave`, or `frame.fftSize` exist.** Guard inputs and use safe defaults.
- **DO NOT make global state depend on one missing audio frame.** If audio data is absent/invalid, hold last good values or ease toward silence—never hard-reset.
- **DO NOT reset phases/state on “non-finite” without logging.** If you must guard, also make it diagnosable.

---

## Complexity Traps

- **DO NOT add UI knobs/modes** unless required. Most visualizers should have a strong default.
- **DO NOT change the loader/lifecycle contract** (no custom rAF loops, no hidden timers, no global listeners that outlive `destroy()`).
- **DO NOT shadow critical variable names in the same scope.** It can break module load or hide bugs.
- **DO NOT leave debug logging enabled by default.** Gate behind a flag and throttle logs.
- **DO NOT introduce “helpful” behavior changes outside the request scope.** Fix what was asked, nothing extra.

---

## Quick Pre-Ship Checklist

- [ ] Looks similar in Chrome vs OBS Browser Source (30/60 fps)
- [ ] No per-frame shader/buffer/texture creation
- [ ] Spawn + decay are dt-based (not frame-based)
- [ ] Resize is debounced (no constant target rebuilds)
- [ ] Overlay-safe alpha handling
- [ ] No NaNs/Infs; missing audio frames don’t snap visuals
