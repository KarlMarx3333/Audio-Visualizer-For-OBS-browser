from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Optional

APP_NAME = "ObsVizHost"


def _default_config_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / APP_NAME
    home = Path.home()
    return home / f".{APP_NAME.lower()}"


@dataclass
class AppConfig:
    port: int = 8787
    selected_device_id: Optional[int] = None
    selected_device_name: Optional[str] = None
    samplerate: int = 48000
    channels: int = 1
    visualizer_name: str = "spectrum"
    smoothing: float = 0.65
    fft_size: int = 2048
    fps_cap: int = 60
    embed_default: bool = True

    def clamp(self) -> None:
        self.port = int(max(1024, min(65535, self.port)))
        self.samplerate = int(max(8000, min(192000, self.samplerate)))
        self.channels = 1 if int(self.channels) <= 1 else 2
        self.smoothing = float(max(0.0, min(0.99, self.smoothing)))

        fft = int(self.fft_size)
        if fft < 256:
            fft = 256
        p = 1
        while p < fft:
            p <<= 1
        self.fft_size = int(min(16384, p))

        self.fps_cap = int(max(10, min(120, self.fps_cap)))


def config_path() -> Path:
    cfg_dir = _default_config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    return cfg_dir / "config.json"


def load_config() -> AppConfig:
    cfg = AppConfig()
    path = config_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for k, v in data.items():
                if hasattr(cfg, k):
                    setattr(cfg, k, v)
        except Exception:
            pass
    cfg.clamp()
    return cfg


def save_config(cfg: AppConfig) -> None:
    cfg.clamp()
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(cfg), indent=2), encoding="utf-8")


def update_config(cfg: AppConfig, patch: dict[str, Any]) -> AppConfig:
    for k, v in patch.items():
        if hasattr(cfg, k):
            setattr(cfg, k, v)
    cfg.clamp()
    save_config(cfg)
    return cfg
