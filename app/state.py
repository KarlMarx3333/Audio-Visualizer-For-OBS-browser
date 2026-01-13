from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Metrics:
    frame_id: int = 0
    ts: float = 0.0
    rms: list[float] = field(default_factory=lambda: [0.0])
    peak: list[float] = field(default_factory=lambda: [0.0])
    corr: Optional[float] = None


@dataclass
class AppState:
    status: str = "starting"
    last_error: Optional[str] = None

    selected_device_id: Optional[int] = None
    selected_device_name: Optional[str] = None
    samplerate: int = 48000
    channels: int = 1

    port: int = 8787
    visualizer_name: str = "spectrum"
    smoothing: float = 0.65
    gain: float = 1.0
    visual_smoothing: float = 0.55
    fft_size: int = 2048
    fps_cap: int = 60

    metrics: Metrics = field(default_factory=Metrics)
    ws_clients: int = 0
    started_at: float = field(default_factory=time.time)


class StateStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state = AppState()

    def snapshot(self) -> AppState:
        with self._lock:
            s = self._state
            return AppState(
                status=s.status,
                last_error=s.last_error,
                selected_device_id=s.selected_device_id,
                selected_device_name=s.selected_device_name,
                samplerate=s.samplerate,
                channels=s.channels,
                port=s.port,
                visualizer_name=s.visualizer_name,
                smoothing=s.smoothing,
                gain=s.gain,
                visual_smoothing=s.visual_smoothing,
                fft_size=s.fft_size,
                fps_cap=s.fps_cap,
                metrics=Metrics(
                    frame_id=s.metrics.frame_id,
                    ts=s.metrics.ts,
                    rms=list(s.metrics.rms),
                    peak=list(s.metrics.peak),
                    corr=s.metrics.corr,
                ),
                ws_clients=s.ws_clients,
                started_at=s.started_at,
            )

    def update(self, **kwargs: Any) -> None:
        with self._lock:
            for k, v in kwargs.items():
                if hasattr(self._state, k):
                    setattr(self._state, k, v)

    def update_metrics(self, *, frame_id: int, ts: float, rms: list[float], peak: list[float], corr: Optional[float]) -> None:
        with self._lock:
            self._state.metrics.frame_id = int(frame_id)
            self._state.metrics.ts = float(ts)
            self._state.metrics.rms = list(rms)
            self._state.metrics.peak = list(peak)
            self._state.metrics.corr = corr

    def set_error(self, msg: str) -> None:
        with self._lock:
            self._state.status = "error"
            self._state.last_error = msg

    def set_running(self) -> None:
        with self._lock:
            self._state.status = "running"
            self._state.last_error = None

    def set_stopped(self) -> None:
        with self._lock:
            self._state.status = "stopped"
