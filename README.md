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

A tray icon appears. Use **Open UI** or select visualizers/devices from the tray.

## OBS Browser Source
Use an URL like:
- `http://127.0.0.1:8787/v/spectrum?embed=1`
- `http://127.0.0.1:8787/v/plasma?embed=1`

## Included visualizers
- Spectrum Bars (Canvas2D)
- Oscilloscope (Canvas2D)
- Waterfall Spectrogram (Canvas2D)
- Chromagram / Pitch-Class Ring (Canvas2D)
- Neon Plasma (WebGL)
- Feedback Mirror (WebGL)

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
