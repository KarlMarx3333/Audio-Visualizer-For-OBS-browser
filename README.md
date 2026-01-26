# ObsVizHost (Tray + Localhost Visualizers for OBS)

OBS-focused audio visualizer host (V2 clean rewrite): V2-only registry, Safe Mode Oscilloscope fallback, and a WebGL2 multipass engine.

## Current V2 status
- V2 visualizer list: Safe Mode Oscilloscope (Canvas2D), Vectorscope, Chroma Ring, Plasma, Tunnel / Warp Speed, Feedback Mirror, Radial Spectrum, 3D Spectrum Dots, Galaxy.
- Safe Mode Oscilloscope fallback with visible errors and auto-fallback.
- WebGL2 multipass engine (GLSL300, fullscreen triangle, RGBA16F->RGBA8 fallback, feedback ping-pong).
- Current multipass ports include Plasma, Tunnel, Feedback, Radial Spectrum, 3D Spectrum Dots, and Galaxy.

## Credits / Shader Inspirations
- Original/adapted from: ‘Fractal Toras Tunnel’ by netgrind (2017-05-16) (Shadertoy: https://www.shadertoy.com/view/ld2yDD)
- Inspired by: ‘Disco tunnel’ by WAHa_06x36 (2018-05-08) (Shadertoy: https://www.shadertoy.com/view/XstfzB)

## Getting Started
Install dependencies (Windows PowerShell):
```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

Run the server:
```powershell
python -m app.main
```

Open in a browser:
- http://127.0.0.1:8787/ (control page)
- http://127.0.0.1:8787/render (interactive preview)

OBS Browser Source:
- Overlay: http://127.0.0.1:8787/render?embed=1
- Background: http://127.0.0.1:8787/render

Direct visualizer links:
- http://127.0.0.1:8787/v/safe_canvas2d?embed=1
- http://127.0.0.1:8787/v/vectorscope?embed=1
- http://127.0.0.1:8787/v/chroma_ring?embed=1
- http://127.0.0.1:8787/v/plasma?embed=1
- http://127.0.0.1:8787/v/radial_spectrum?embed=1
- http://127.0.0.1:8787/v/galaxy?embed=1
- http://127.0.0.1:8787/v/spectrum3d?embed=1
- http://127.0.0.1:8787/v/tunnel?embed=1
- http://127.0.0.1:8787/v/feedback?embed=1

## Demos (V2)
**Safe Mode Oscilloscope (Canvas2D)** — fallback waveform preview with overlay-safe output.
![Safe Mode Oscilloscope demo](Demo/oscilloscope2d_demo.webp)

**Vectorscope / Goniometer (Canvas2D)** — stereo phase and correlation display.
![Vectorscope demo](Demo/vector_scope_demo.webp)

**Chroma Ring / Pitch Classes (Canvas2D)** — pitch-class energy ring from the spectrum.
![Chroma Ring demo](Demo/chroma_ring_demo.webp)

**Plasma (WebGL2 Multipass)** — layered plasma with audio-reactive glow.
![Plasma demo](Demo/plasma_demo.webp)

**Tunnel / Warp Speed (WebGL2 Multipass)** — forward tunnel with audio-driven speed.
![Tunnel demo](Demo/tunnel_warp_demo.webp)

**Radial Spectrum (WebGL2 Multipass)** — circular spectrum bars with peak hats.
![Radial Spectrum demo](Demo/radial_spectrum_demo.webp)

**3D Spectrum Dots (WebGL2 Multipass)** — 3D band field rendered as dots.
![3D Spectrum Dots demo](Demo/3d_spectrum_demo.webp)

**Galaxy (WebGL2 Multipass)** — nebula + starfield driven by band energy.
![Galaxy demo](Demo/galaxy_demo.webp)

**Feedback Mirror (WebGL2 Multipass)** — recursive feedback with mirrored motion.
![Feedback demo](Demo/feedback_demo.webp)

## Audio tuning (tray)
Use the tray menu Audio Tuning... to adjust Gain (0.2..4.0) and Visual Smoothing (0.0..0.95).
Values persist in config.json and apply live. The Gain/Smoothing sliders in the visualizer UI are read-only and mirror the tray values.

## Guardrails (non-negotiables)
- dt-invariant behavior (decays/advects scale with dt).
- no per-frame allocations in hot paths.
- no per-frame shader compile/link/getUniformLocation.
- no silent error swallowing; failures visible on-screen + console, auto-fallback to Safe Mode.
- overlay-safe alpha by default (no accidental opaque clears).

## Visualizer engine contract
Visualizers are ES modules registered in static/js/visualizers/registry.js with a class implementing:
- constructor(canvas)
- onResize(width, height, dpr) (optional)
- onFrame(frame)
- destroy() (optional)

The host (static/visualizer.html) owns timing and passes a stable frame object each tick. Key fields and units:
- dt (seconds), t (seconds), and time = { t, dt }
- viewport = { w, h, dpr } plus width, height, dpr (backbuffer pixels)
- overlay (true when ?embed=1)
- spectrum, wave, waveLR (smoothed audio arrays, read-only)
- bass, mid, high, energy (0..1 scalars)
- gain, samplerate, fftSize, rms, peak, corr

Do not compute dt from ts; always use frame.dt.

## WebGL2 multipass engine
The multipass engine lives at static/js/webgl/multipass_webgl2.js and supports BufferA/B/C + Image passes.
It is WebGL2-only (GLSL300), uses a fullscreen triangle, caches uniform locations, and falls back from RGBA16F to RGBA8 when needed.
Built-in uniforms include u_time, u_dt, u_frame, u_resolution, u_aspect, audio scalars (u_energy, etc.), and audio textures (u_specTex, u_waveTex).

## Staged plan (V2)
- Stage 1: V2-only registry, Safe Mode Oscilloscope (Canvas2D) fallback, strict error surfacing + auto-fallback.
- Stage 2: WebGL2-only fullscreen triangle multipass engine (GLSL300), BufferA/B/C + Image, optional feedback ping-pong, RGBA16F->RGBA8 fallback, built-in uniforms + audio textures.
- Stage 3: port order: plasma -> tunnel -> feedback (done), next: fractal_torus.
- Stage 4: audio contract cleanup (Python owns smoothing/AGC, add transient/onset scalar).
- Stage 5: categories + compositing policy (overlay vs background, alpha rules).
- Stage 6: hard ones later (Swarm stays custom until rewritten).

## Troubleshooting
- Errors show in the on-screen error panel and in the browser console.
- Safe Mode activates on any visualizer failure; if you see Safe Mode, check the error panel/console.
- If WebSocket parsing fails, you will see a console error and the error panel will show the cause.

## Demo assets
Demo/ contains the current preview captures used in the README section above.

## Add a new visualizer
- Create a JS module in static/js/visualizers/ exporting a class with static id/name/renderer and the lifecycle methods.
- Register it in static/js/visualizers/registry.js.
- Update VISUALIZERS in app/server.py to keep the server list in sync.
