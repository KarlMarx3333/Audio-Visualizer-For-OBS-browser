from __future__ import annotations

import asyncio
import struct
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

from .config import AppConfig, save_config
from .state import StateStore
from .audio_engine import list_input_devices, AudioEngine
from .analysis import Analyzer

VISUALIZERS = [
    {"id": "spectrum", "name": "Spectrum Bars", "renderer": "2d"},
    {"id": "oscilloscope", "name": "Oscilloscope", "renderer": "2d"},
    {"id": "spectrogram", "name": "Waterfall Spectrogram", "renderer": "2d"},
    {"id": "vectorscope", "name": "Stereo Vectorscope / Goniometer", "renderer": "2d"},
    {"id": "chroma", "name": "Chromagram / Pitch-Class Ring", "renderer": "2d"},
    {"id": "plasma", "name": "Neon Plasma (WebGL)", "renderer": "webgl"},
    {"id": "feedback", "name": "Feedback Mirror (WebGL)", "renderer": "webgl"},
    {"id": "tunnel", "name": "Tunnel / Warp Speed (WebGL)", "renderer": "webgl"},
    {"id": "swarm", "name": "Particle Swarm / Explosions (WebGL2)", "renderer": "webgl"},
]


def _static_dir() -> Path:
    here = Path(__file__).resolve()
    root = here.parent.parent
    return root / "static"


def create_app(cfg: AppConfig, state: StateStore, audio: AudioEngine, analyzer: Analyzer) -> FastAPI:
    static_dir = _static_dir()
    app = FastAPI()
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    def index():
        return FileResponse(str(static_dir / "index.html"))

    @app.get("/v/{name}")
    def visualizer(name: str):
        return FileResponse(str(static_dir / "visualizer.html"))

    @app.get("/render")
    def render():
        return FileResponse(str(static_dir / "visualizer.html"))

    @app.get("/api/visualizers")
    def api_visualizers():
        return JSONResponse(VISUALIZERS)

    @app.get("/api/devices")
    def api_devices():
        devs = list_input_devices()
        return JSONResponse([{
            "id": d.id,
            "name": d.name,
            "hostapi": d.hostapi,
            "max_input_channels": d.max_input_channels,
            "default_samplerate": d.default_samplerate,
        } for d in devs])

    @app.get("/api/state")
    def api_state():
        s = state.snapshot()
        return JSONResponse({
            "status": s.status,
            "last_error": s.last_error,
            "selected_device_id": s.selected_device_id,
            "selected_device_name": s.selected_device_name,
            "samplerate": s.samplerate,
            "channels": s.channels,
            "port": s.port,
            "visualizer_name": s.visualizer_name,
            "smoothing": s.smoothing,
            "fft_size": s.fft_size,
            "fps_cap": s.fps_cap,
            "ws_clients": s.ws_clients,
            "metrics": {
                "frame_id": s.metrics.frame_id,
                "ts": s.metrics.ts,
                "rms": s.metrics.rms,
                "peak": s.metrics.peak,
                "corr": s.metrics.corr,
            }
        })

    @app.post("/api/device")
    async def api_set_device(payload: Dict[str, Any]):
        device_id = payload.get("device_id", None)
        device_name = payload.get("device_name", None)
        try:
            device_id = int(device_id) if device_id is not None else None
        except Exception:
            device_id = None

        cfg.selected_device_id = device_id
        if device_name:
            cfg.selected_device_name = str(device_name)
        save_config(cfg)

        state.update(selected_device_id=cfg.selected_device_id, selected_device_name=cfg.selected_device_name)

        audio.configure(device_id=cfg.selected_device_id, device_name=cfg.selected_device_name,
                        samplerate=cfg.samplerate, channels=cfg.channels)
        audio.restart()
        return JSONResponse({"ok": True})

    @app.post("/api/visualizer")
    async def api_set_visualizer(payload: Dict[str, Any]):
        vid = str(payload.get("visualizer", "spectrum"))
        cfg.visualizer_name = vid
        save_config(cfg)
        state.update(visualizer_name=cfg.visualizer_name)
        return JSONResponse({"ok": True})

    @app.post("/api/options")
    async def api_set_options(payload: Dict[str, Any]):
        changed_audio = False
        if "samplerate" in payload:
            try:
                cfg.samplerate = int(payload["samplerate"])
                changed_audio = True
            except Exception:
                pass
        if "channels" in payload:
            try:
                cfg.channels = 1 if int(payload["channels"]) <= 1 else 2
                changed_audio = True
            except Exception:
                pass
        if "fft_size" in payload:
            try:
                cfg.fft_size = int(payload["fft_size"])
            except Exception:
                pass
        if "fps_cap" in payload:
            try:
                cfg.fps_cap = int(payload["fps_cap"])
            except Exception:
                pass
        if "smoothing" in payload:
            try:
                cfg.smoothing = float(payload["smoothing"])
            except Exception:
                pass

        cfg.clamp()
        save_config(cfg)

        state.update(
            samplerate=cfg.samplerate,
            channels=cfg.channels,
            fft_size=cfg.fft_size,
            fps_cap=cfg.fps_cap,
            smoothing=cfg.smoothing,
        )
        analyzer.configure(
            samplerate=cfg.samplerate,
            channels=cfg.channels,
            fft_size=cfg.fft_size,
            fps_cap=cfg.fps_cap,
            smoothing=cfg.smoothing,
        )

        if changed_audio:
            audio.configure(device_id=cfg.selected_device_id, device_name=cfg.selected_device_name,
                            samplerate=cfg.samplerate, channels=cfg.channels)
            audio.restart()

        return JSONResponse({"ok": True})

    @app.websocket("/ws/audio")
    async def ws_audio(ws: WebSocket):
        await ws.accept()
        snap = state.snapshot()
        state.update(ws_clients=snap.ws_clients + 1)
        try:
            last_sent = -1
            while True:
                frame_id, ts, td, spec, rms, peak, corr = analyzer.get_latest()
                if frame_id == last_sent:
                    fps = max(10, int(getattr(cfg, "fps_cap", 60)))
                    await asyncio.sleep(max(0.001, 1.0 / (fps * 4.0)))
                    continue
                last_sent = frame_id
                ch = int(td.shape[1])
                td_len = int(td.shape[0])
                sp_len = int(spec.shape[0])

                header = struct.pack("<4sIdHHHH", b"AVF1", frame_id, float(ts), ch, td_len, sp_len, 0)
                rms_arr = (rms + [0.0, 0.0])[:ch]
                peak_arr = (peak + [0.0, 0.0])[:ch]
                corr_val = corr if corr is not None else float("nan")
                metrics = struct.pack("<" + ("f"*ch) + ("f"*ch) + "f",
                                      *[float(x) for x in rms_arr],
                                      *[float(x) for x in peak_arr],
                                      float(corr_val))
                td_bytes = td.astype("float32", copy=False).tobytes(order="C")
                spec_bytes = spec.astype("float32", copy=False).tobytes(order="C")
                await ws.send_bytes(header + metrics + td_bytes + spec_bytes)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            snap2 = state.snapshot()
            state.update(ws_clients=max(0, snap2.ws_clients - 1))

    return app


class ServerThread:
    def __init__(self, app: FastAPI, host: str, port: int) -> None:
        self.config = uvicorn.Config(
            app=app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
            ws="wsproto",
            ws_ping_interval=None,
        )
        self.server = uvicorn.Server(self.config)
        self.thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.server.run, name="UvicornServer", daemon=True)
        self.thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=timeout)
