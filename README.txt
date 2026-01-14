ObsVizHost (Tray + Localhost Visualizers for OBS)

Tray app that captures mic input, computes analysis, and serves a localhost visualizer page for OBS Browser Source.

Install (Windows PowerShell)
  python -m venv .venv
  .\.venv\Scripts\activate
  pip install -r requirements.txt

Run
  python -m app.main

A tray icon appears. Use Open UI to open the control page, or select visualizers/devices from the tray to change the active visualizer for /render clients.

Audio tuning (tray)
  Use the tray menu Audio Tuning... to adjust Gain (0.2..4.0) and Visual Smoothing (0.0..0.95).
  Values persist in config.json and apply live, including OBS embed mode.
  The Gain/Smoothing sliders in the visualizer UI are read-only and mirror the tray values.

OBS Browser Source (stable URL)
  http://127.0.0.1:8787/render?embed=1

Interactive preview:
  http://127.0.0.1:8787/render

Direct, fixed visualizer links (no auto-switch):
  http://127.0.0.1:8787/v/spectrum?embed=1
  http://127.0.0.1:8787/v/plasma?embed=1
  http://127.0.0.1:8787/v/swarm?embed=1

Included visualizer demos (images in Demo/):
  particle_swarm_demo.png
  tunnel_webgl_demo.png
  feedback_demo.png
  plasma_demo.png
  chroma_ring_demo.png
  vectorscope_demo.png
  spectrogram_demo.png
  oscilloscope_demo.png
  spectrum_demo.png

Add a new visualizer
  1) Create static/js/visualizers/myviz.js exporting a class:
     export class MyViz {
       static id = "myviz";
       static name = "My Viz";
       static renderer = "2d"; // or "webgl"
       constructor(canvas){}
       onFrame(frame){}
       destroy(){}
     }
  2) Register it in static/js/visualizers/registry.js.
  3) Add it to VISUALIZERS in app/server.py to appear in the tray menu and index page.
