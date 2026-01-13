# ObsVizHost (Tray + Localhost Visualizers for OBS)

Tray app that captures **mic input**, computes analysis, and serves a **localhost visualizer page** for OBS Browser Source.

## Install (Windows PowerShell)
```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Run
```powershell
python -m app.main
```

A tray icon appears. Use **Open UI** to open the control page, or select visualizers/devices from the tray to change the active visualizer for `/render` clients.

## OBS Browser Source (stable URL)
Use the stable endpoint so OBS never needs a new URL:
- `http://127.0.0.1:8787/render?embed=1`

Interactive preview:
- `http://127.0.0.1:8787/render`

Direct, fixed visualizer links (no auto-switch):
- `http://127.0.0.1:8787/v/spectrum?embed=1`
- `http://127.0.0.1:8787/v/plasma?embed=1`

## Included visualizers Demos

### Particle Swarm
![Particle Swarm](Demo/particle_swarm_demo.png)

### Tunnel (WebGL)
![Tunnel](Demo/tunnel_webgl_demo.png)

### Feedback
![Feedback](Demo/feedback_demo.png)

### Plasma
![Plasma](Demo/plasma_demo.png)

### Chroma Ring
![Chroma Ring](Demo/chroma_ring_demo.png)

### Vectorscope
![Vectorscope](Demo/vectorscope_demo.png)

### Spectrogram
![Spectrogram](Demo/spectrogram_demo.png)

### Oscilloscope
![Oscilloscope](Demo/oscilloscope_demo.png)


## Add a new visualizer
1) Create `static/js/visualizers/myviz.js` exporting a class:
```js
export class MyViz {
  static id = "myviz";
  static name = "My Viz";
  static renderer = "2d"; // or "webgl"
  constructor(canvas){}
  onFrame(frame){}
  destroy(){}
}
```
2) Register it in `static/js/visualizers/registry.js`.
3) (Optional) Add it to `VISUALIZERS` in `app/server.py` to appear in tray menu and index page.
