# Architecture
ObsVizHost is a Windows tray application that captures microphone input, analyzes it in real time, and serves a local FastAPI web UI plus a WebSocket audio stream for OBS visualizers (stable `/render` and per-visualizer `/v/<name>`). At runtime it wires together a tray UI (`pystray`), an audio capture loop (`sounddevice`), an analysis worker (`numpy` FFT), a state store, and a local HTTP/WebSocket server (`uvicorn` + `FastAPI`), while the browser UI and visualizers live in `static/`.

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
│       │   ├── spectrum2d.js
│       │   ├── oscilloscope2d.js
│       │   ├── spectrogram2d.js
│       │   ├── vectorscope2d.js
│       │   ├── chroma_ring2d.js
│       │   ├── plasma_webgl.js
│       │   ├── feedback_webgl.js
│       │   └── tunnel_webgl.js
│       └── webgl/util.js
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
- **Config system** Purpose: load/save settings and clamp valid ranges; Key files: `app/config.py`; Public interfaces / classes: `AppConfig`, `load_config`, `save_config`, `config_path`, `update_config`; Depends on: `json`, `Path`, `os`; Used by: `app/main.py`, `app/server.py`, `app/tray.py`.
- **Audio capture** Purpose: device discovery, background capture, ring buffer; Key files: `app/audio_engine.py`; Public interfaces / classes: `AudioEngine`, `RingBuffer`, `list_input_devices`; Depends on: `sounddevice`, `numpy`, `threading`; Used by: `Analyzer`, `TrayApp`, `create_app` (devices API).
- **Analysis** Purpose: compute spectrum/time-domain metrics from latest audio; Key files: `app/analysis.py`; Public interfaces / classes: `Analyzer`, `hann_window`; Depends on: `numpy`, `AudioEngine`; Used by: `app/main.py` monitor thread, `app/server.py` WebSocket handler.
- **State store** Purpose: shared, thread-safe snapshot of app status and metrics; Key files: `app/state.py`; Public interfaces / classes: `StateStore`, `AppState`, `Metrics`; Depends on: `threading`, `dataclasses`; Used by: `main()` monitor thread, `TrayApp`, `create_app`.
- **HTTP/WebSocket server** Purpose: serve UI assets and stream analysis frames; Key files: `app/server.py`; Public interfaces / classes: `create_app`, `ServerThread`, `VISUALIZERS`; Depends on: `FastAPI`, `uvicorn`, `StateStore`, `Analyzer`, `AudioEngine`; Used by: `app/main.py`, browser UI in `static/`. Provides `/render` (stable OBS URL) and `/v/{name}` (fixed visualizer links).
- **Tray UI** Purpose: native tray icon and menus for device/visualizer selection; Key files: `app/tray.py`; Public interfaces / classes: `TrayApp`; Depends on: `pystray`, `PIL`, `StateStore`, `AudioEngine`, `VISUALIZERS`; Used by: `app/main.py`.
- **Browser UI and visualizers** Purpose: show status page and render audio visualizers; Key files: `static/index.html`, `static/visualizer.html`, `static/js/ws_client.js`, `static/js/visualizers/*.js`, `static/js/webgl/util.js`; Public interfaces / classes: `connectAudioWS`, `registry`, visualizer classes (e.g., `Spectrum2D`); Depends on: REST endpoints and `/ws/audio`; Used by: end users and OBS Browser Source. `static/visualizer.html` manages embed mode (transparent overlay), canvas sizing (~80% of available area), renderer switching (2D vs WebGL) by replacing the canvas when needed, and follows the server-selected visualizer when loaded via `/render`.

## Data flow
Primary happy path: audio input is captured, analyzed, and streamed to the browser.
```
Mic -> AudioEngine(InputStream callback) -> RingBuffer
     -> Analyzer(thread) -> StateStore(metrics)
     -> FastAPI /ws/audio -> ws_client.js -> Visualizer.onFrame()
```
User configuration updates follow two paths: tray menu actions call `AudioEngine.configure()` and `save_config()` in `app/tray.py`, and the web UI posts to `/api/device` or `/api/options` in `app/server.py`, which update config/state and restart the audio engine when needed.
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
- To add a new setting: add it to `AppConfig`, update `clamp()` if needed, and update `main()`/`StateStore`/API handlers and UI fields that expose it.

## Extensibility points
- Add a new visualizer: create a JS class in `static/js/visualizers/`, register it in `static/js/visualizers/registry.js`, and add to `VISUALIZERS` in `app/server.py` to expose it in the tray/UI.
- Add new analysis metrics: extend `Analyzer` in `app/analysis.py`, wire values into `StateStore` and `app/server.py`, and update `static/js/ws_client.js` parsing and the visualizer UI.
- Add REST endpoints or WebSocket variants: extend `create_app()` in `app/server.py` and update the browser UI accordingly.
- Add new tray actions: update `TrayApp` menu builders and handlers in `app/tray.py`.

## Testing and quality gates
- No automated tests or lint configs were found in the repo; there is no `tests/` directory and no CI config.
- Runtime validation is manual via `python -m app` and the browser UI.

## Known gaps / TODOs
- Error handling is mostly silent (many `except Exception: pass` blocks), which can hide real failures; see `app/audio_engine.py`, `app/main.py`, and `app/server.py`.
- There is no test harness or smoke test automation; the only guidance is in `README.md`.
