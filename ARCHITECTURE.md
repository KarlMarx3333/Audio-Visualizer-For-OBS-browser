# Architecture
ObsVizHost is a Windows tray application that captures microphone input, analyzes it in real time, and serves a local FastAPI web UI plus a WebSocket audio stream for OBS visualizers (stable `/render` and per-visualizer `/v/<name>`). At runtime it wires together a tray UI (`pystray`), an audio capture loop (`sounddevice`), an analysis worker (`numpy` FFT), a state store, and a local HTTP/WebSocket server (`uvicorn` + `FastAPI`), while the browser UI and visualizers live in `static/`.

## V2 direction (staged plan)
- Stage 1: V2-only registry, Safe Mode Oscilloscope (Canvas2D) fallback, strict error surfacing + auto-fallback.
- Stage 2: WebGL2-only fullscreen triangle multipass engine (GLSL300), BufferA/B/C + Image, optional feedback ping-pong, RGBA16F→RGBA8 fallback, built-in uniforms + audio textures.
- Stage 3: port order: plasma → tunnel → feedback (done), next: fractal_torus.
- Stage 4: audio contract cleanup (Python owns smoothing/AGC, add transient/onset scalar).
- Stage 5: categories + compositing policy (overlay vs background, alpha rules).
- Stage 6: hard ones later (Swarm stays custom until rewritten).

## Guardrails (non-negotiables)
- dt-invariant behavior (decays/advects scale with dt).
- no per-frame allocations in hot paths.
- no per-frame shader compile/link/getUniformLocation.
- no silent error swallowing; failures visible on-screen + console, auto-fallback to Safe Mode.
- overlay-safe alpha by default (no accidental opaque clears).

## Design guardrails
These constraints exist because OBS Browser Source (CEF) can run at variable FPS and is sensitive to GC spikes, shader churn, and opaque clears. The goal is stability and predictable compositing: dt-correct visuals, minimal runtime allocations, and visible failure modes that auto-fallback instead of silently degrading.

## Quick start mental model
- `python -m app` (or `python -m app.main`) calls `main()` in `app/main.py` via `app/__main__.py`.
- `main()` loads config from `app/config.py`, initializes `StateStore`, and starts `AudioEngine`.
- `AudioEngine` opens a `sounddevice.InputStream` and writes float32 audio frames into `RingBuffer`.
- `Analyzer` runs on its own thread, reads the ring buffer, computes time-domain + spectrum, and stores metrics.
- `ServerThread` runs a FastAPI app that serves `static/`, `/render`, `/v/{name}`, and a `/ws/audio` binary stream.
- A monitor thread polls `Analyzer` and pushes status/metrics into `StateStore`.
- `TrayApp` runs the tray icon loop; menu actions update config, state, and restart audio.
- The browser UI (`static/index.html` or `static/visualizer.html`) calls REST endpoints and connects to `/ws/audio`; `/render` follows the server-selected visualizer.

## Repository layout
```
.
├── app/
│   ├── __main__.py
│   ├── main.py
│   ├── audio_engine.py
│   ├── analysis.py
│   ├── server.py
│   ├── tray.py
│   ├── state.py
│   ├── config.py
│   └── __init__.py
├── static/
│   ├── index.html
│   ├── visualizer.html
│   ├── css/app.css
│   └── js/
│       ├── ws_client.js
│       ├── visualizers/
│       │   ├── registry.js
│       │   ├── oscilloscope2d.js
│       │   ├── plasma_webgl2_mp.js
│       │   ├── tunnel_webgl2_mp.js
│       │   ├── feedback_webgl2_mp.js
│       │   ├── radial_spectrum_webgl2_mp.js
│       │   ├── 3D_spectrum_webgl2_mp.js
│       │   └── galaxy_webgl2_mp.js
│       └── webgl/
│           ├── util.js
│           └── multipass_webgl2.js
├── docs/
│   └── demos/
│       ├── 3d_spectrum_demo.webp
│       ├── chroma_ring_demo.webp
│       ├── feedback_demo.webp
│       ├── galaxy_demo.webp
│       ├── oscilloscope2d_demo.webp
│       ├── plasma_demo.webp
│       ├── radial_spectrum_demo.webp
│       ├── tunnel_warp_demo.webp
│       └── vector_scope_demo.webp
├── requirements.txt
├── README.md
├── Repo_zipper.ps1
└── ARCHITECTURE.md
```
- `app/`: Python runtime code only; do not place static assets or generated files here.
- `static/`: Browser UI and visualizers; do not place Python modules or runtime config here.
- Repo root files (`requirements.txt`, `README.md`, `Repo_zipper.ps1`): docs and helper scripts; keep runtime code under `app/`.

## Core components
- **Bootstrap and lifecycle** Purpose: wire everything together and own shutdown flow; Key files: `app/__main__.py`, `app/main.py`; Public interfaces / classes: `main`; Depends on: `AppConfig`, `StateStore`, `AudioEngine`, `Analyzer`, `create_app`, `ServerThread`, `TrayApp`; Used by: `python -m app`.
- **Config system** Purpose: load/save settings and clamp valid ranges (including visualizer gain/visual smoothing); Key files: `app/config.py`; Public interfaces / classes: `AppConfig`, `load_config`, `save_config`, `config_path`, `update_config`; Depends on: `json`, `Path`, `os`; Used by: `app/main.py`, `app/server.py`, `app/tray.py`.
- **Audio capture** Purpose: device discovery, background capture, ring buffer; Key files: `app/audio_engine.py`; Public interfaces / classes: `AudioEngine`, `RingBuffer`, `list_input_devices`; Depends on: `sounddevice`, `numpy`, `threading`; Used by: `Analyzer`, `TrayApp`, `create_app` (devices API).
- **Analysis** Purpose: compute spectrum/time-domain metrics from latest audio; Key files: `app/analysis.py`; Public interfaces / classes: `Analyzer`, `hann_window`; Depends on: `numpy`, `AudioEngine`; Used by: `app/main.py` monitor thread, `app/server.py` WebSocket handler.
- **State store** Purpose: shared, thread-safe snapshot of app status and metrics; Key files: `app/state.py`; Public interfaces / classes: `StateStore`, `AppState`, `Metrics`; Depends on: `threading`, `dataclasses`; Used by: `main()` monitor thread, `TrayApp`, `create_app`.
- **HTTP/WebSocket server** Purpose: serve UI assets and stream analysis frames; Key files: `app/server.py`; Public interfaces / classes: `create_app`, `ServerThread`, `VISUALIZERS`; Depends on: `FastAPI`, `uvicorn`, `StateStore`, `Analyzer`, `AudioEngine`; Used by: `app/main.py`, browser UI in `static/`. Provides `/render` (stable OBS URL) and `/v/{name}` (fixed visualizer links).
- **Tray UI** Purpose: native tray icon and menus for device/visualizer selection plus the Audio Tuning window (gain + visual smoothing); Key files: `app/tray.py`; Public interfaces / classes: `TrayApp`; Depends on: `pystray`, `PIL`, `StateStore`, `AudioEngine`, `VISUALIZERS`, optional `tkinter`; Used by: `app/main.py`.
- **Browser UI and visualizers** Purpose: show status page and render audio visualizers; Key files: `static/index.html`, `static/visualizer.html`, `static/js/ws_client.js`, `static/js/visualizers/*.js`, `static/js/webgl/util.js`; Public interfaces / classes: `connectAudioWS`, `registry`, visualizer classes (e.g., `Oscilloscope2D`); Depends on: REST endpoints and `/ws/audio`; Used by: end users and OBS Browser Source. `static/visualizer.html` is the engine loop: it owns timing (`frame.dt`, `frame.t`), canvas sizing, and visualizer switching (it replaces the canvas when switching renderer types or between WebGL visualizers to avoid context conflicts). It pulls `gain` and `visual_smoothing` from `/api/state`, applies client-side smoothing, builds a stable per-frame payload, and follows the server-selected visualizer when loaded via `/render`. Embed mode (`?embed=1`) hides the topbar and keeps a transparent background; the error badge remains visible, and errors surface in an on-screen panel. In debug mode (`?debug=1`), it checks for visualizers mutating shared audio buffers.

## Visualizer contract (client-side)
- Visualizers are ES modules in `static/js/visualizers/` that export a class with `static id`, `static name`, and `static renderer` (`"2d"` or `"webgl"`), plus `constructor(canvas)` and `onFrame(frame)`. Optional lifecycle hooks: `onResize(width, height, dpr)` and `destroy()`.
- `static/js/visualizers/registry.js` registers visualizer classes. `createVisualizer()` falls back to `"safe_canvas2d"` if an ID is unknown.
- `static/visualizer.html` owns the render loop and calls `viz.onFrame(frame)` each animation frame; visualizers should treat this as their update tick (no separate RAF loop needed).
- Visualizers should animate using `frame.dt` (seconds) and `frame.t` (seconds); do not derive dt from `frame.ts`.
- WebGL visualizers manage their own GL resources (programs, textures, FBOs). V2 ports should use the WebGL2 multipass engine where possible.
- The `frame` payload passed to visualizers includes:
  - `frameId`, `ts` (raw source timestamp), `tsMs` (best-effort milliseconds)
  - `dt` (seconds), `t` (seconds), `time = { t, dt }`
  - `viewport = { w, h, dpr }`, plus `width`, `height`, `dpr`
  - `channels`, `rms`, `peak`, `corr`
  - `bass`, `mid`, `high`, `energy` (0..1 scalars)
  - `spectrum` (smoothed), `wave` (mono, smoothed), `waveLR` (stereo, smoothed or `null`)
  - `gain`, `samplerate`, `fftSize`, `overlay` (true when `?embed=1`)
- The smoothed arrays are reused; visualizers must treat `spectrum`, `wave`, and `waveLR` as read-only. Debug mode (`?debug=1`) detects mutations.
- `viz.onFrame()` is wrapped in try/catch; errors show a persistent on-screen error panel/badge and auto-fallback to Safe Mode.

## Multi-pass (V2 WebGL2) pipeline
Helper: `static/js/webgl/multipass_webgl2.js`.
It builds a quad-only pipeline using a fullscreen triangle, with an `Image` pass plus optional `BufferA/BufferB/BufferC` passes and ping-pong feedback when a pass opts in.
Key traits: WebGL2 + GLSL300, cached uniform locations, RGBA16F→RGBA8 fallback.
Built-in uniforms include `u_time`, `u_dt`, `u_frame`, `u_resolution`, `u_aspect`, audio scalars (`u_energy`, etc.), and audio textures (`u_specTex`, `u_waveTex`).

## Data flow
Primary happy path: audio input is captured, analyzed, and streamed to the browser.
```
Mic -> AudioEngine(InputStream callback) -> RingBuffer
     -> Analyzer(thread) -> StateStore(metrics)
     -> FastAPI /ws/audio (AVF1 binary) -> ws_client.js -> visualizer.html -> Visualizer.onFrame()
```
`static/visualizer.html` applies visual smoothing (EMA) using `visual_smoothing` from `/api/state` before building the `frame` object for visualizers.
User configuration updates follow two paths: tray menu actions call `AudioEngine.configure()` and `save_config()` in `app/tray.py`, and the web UI posts to `/api/device` or `/api/options` in `app/server.py`, which update config/state and restart the audio engine when needed. Gain and visual smoothing are tray-only controls, exposed via `/api/state` and mirrored by `static/visualizer.html`.
Visualizer selection updates from the tray or `/api/visualizer` update `StateStore`, and `/render` clients poll `/api/state` to swap visualizers without changing URL.

## Concurrency and threading
- `AudioEngine` starts a daemon thread (`threading.Thread`) and uses a `sounddevice.InputStream` callback to write into `RingBuffer` (`app/audio_engine.py`).
- `Analyzer` runs a daemon thread that pulls from the ring buffer and updates shared metrics (`app/analysis.py`).
- `ServerThread` runs `uvicorn.Server` on a daemon thread for the FastAPI app (`app/server.py`).
- `main()` launches a monitor thread that periodically updates `StateStore` from `Analyzer` (`app/main.py`).
- `TrayApp.run()` blocks on the tray event loop; menu callbacks call into audio/config (`app/tray.py`).
- Shared state is guarded with `threading.RLock` in `StateStore`, `AudioEngine`, `Analyzer`, and `RingBuffer`; the audio callback should stay lightweight (it only writes into the ring buffer).

## Configuration
- Config file lives in `%APPDATA%/ObsVizHost/config.json` on Windows, or `~/.obsvizhost/config.json` as a fallback; see `app/config.py`.
- `AppConfig` defaults are applied, `load_config()` merges JSON keys if present, and `AppConfig.clamp()` enforces ranges.
- Visualizer controls are split: `gain` (0.2..4.0) and `visual_smoothing` (0.0..0.95) are tray-managed, while `smoothing` (0.0..0.99) is for analyzer smoothing in `app/analysis.py`.
- To add a new setting: add it to `AppConfig`, update `clamp()` if needed, and update `main()`/`StateStore`/API handlers and UI fields that expose it.

## Extensibility points
- Add a new visualizer: create a JS class in `static/js/visualizers/`, register it in `static/js/visualizers/registry.js`, and update `VISUALIZERS` in `app/server.py` to keep the server list in sync.
- Add new analysis metrics: extend `Analyzer` in `app/analysis.py`, wire values into `StateStore` and `app/server.py`, and update `static/js/ws_client.js` parsing and the visualizer UI.
- Add REST endpoints or WebSocket variants: extend `create_app()` in `app/server.py` and update the browser UI accordingly.
- Add new tray actions: update `TrayApp` menu builders and handlers in `app/tray.py`.

## Testing and quality gates
- No automated tests or lint configs were found in the repo; there is no `tests/` directory and no CI config.
- Runtime validation is manual via `python -m app` and the browser UI.

## Known gaps / TODOs
- There is no test harness or smoke test automation; the only guidance is in `README.md`.
