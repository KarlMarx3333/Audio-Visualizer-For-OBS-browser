from __future__ import annotations

import threading
import time
from typing import Optional, Tuple

import numpy as np

from .audio_engine import AudioEngine


def hann_window(n: int) -> np.ndarray:
    return np.hanning(n).astype(np.float32)


class Analyzer:
    def __init__(self, audio: AudioEngine) -> None:
        self.audio = audio
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self.frame_id: int = 0
        self.ts: float = 0.0

        self.channels: int = 1
        self.samplerate: int = 48000
        self.fft_size: int = 2048
        self.fps_cap: int = 60
        self.smoothing: float = 0.65

        self.time_domain: np.ndarray = np.zeros((1024, 1), dtype=np.float32)
        self.spectrum: np.ndarray = np.zeros((1025,), dtype=np.float32)
        self.rms: list[float] = [0.0]
        self.peak: list[float] = [0.0]
        self.corr: Optional[float] = None

        self._win = hann_window(self.fft_size)
        self._prev_spec: Optional[np.ndarray] = None

    def configure(self, *, samplerate: int, channels: int, fft_size: int, fps_cap: int, smoothing: float) -> None:
        with self._lock:
            self.samplerate = int(samplerate)
            self.channels = 1 if int(channels) <= 1 else 2
            self.fft_size = int(fft_size)
            self.fps_cap = int(fps_cap)
            self.smoothing = float(smoothing)
            self._win = hann_window(self.fft_size)
            self._prev_spec = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="Analyzer", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def get_latest(self) -> Tuple[int, float, np.ndarray, np.ndarray, list[float], list[float], Optional[float]]:
        with self._lock:
            return (
                int(self.frame_id),
                float(self.ts),
                self.time_domain.copy(),
                self.spectrum.copy(),
                list(self.rms),
                list(self.peak),
                self.corr,
            )

    def _compute_corr(self, x: np.ndarray) -> Optional[float]:
        if x.shape[1] < 2:
            return None
        l = x[:, 0] - float(np.mean(x[:, 0]))
        r = x[:, 1] - float(np.mean(x[:, 1]))
        denom = float(np.sqrt(np.sum(l*l) * np.sum(r*r)))
        if denom <= 1e-12:
            return None
        return float(np.sum(l*r) / denom)

    def _run(self) -> None:
        td_len = 1024
        while not self._stop.is_set():
            t0 = time.time()
            ring = self.audio.ring
            if ring is None:
                time.sleep(0.05)
                continue

            with self._lock:
                fft_size = self.fft_size
                fps_cap = self.fps_cap
                smoothing = self.smoothing
                win = self._win

            x_fft = ring.read_latest(fft_size)
            x_td = ring.read_latest(td_len)

            if x_fft.shape[1] != self.channels:
                if self.channels == 1:
                    x_fft = np.mean(x_fft, axis=1, keepdims=True)
                    x_td = np.mean(x_td, axis=1, keepdims=True)
                else:
                    if x_fft.shape[1] == 1:
                        x_fft = np.repeat(x_fft, 2, axis=1)
                        x_td = np.repeat(x_td, 2, axis=1)
                    else:
                        x_fft = x_fft[:, :self.channels]
                        x_td = x_td[:, :self.channels]

            rms = []
            peak = []
            for c in range(x_td.shape[1]):
                xc = x_td[:, c]
                rms.append(float(np.sqrt(np.mean(xc * xc) + 1e-12)))
                peak.append(float(np.max(np.abs(xc)) + 1e-12))

            corr = self._compute_corr(x_td) if self.channels == 2 else None

            x_mono = x_fft[:, 0] if x_fft.shape[1] == 1 else np.mean(x_fft, axis=1)
            xw = x_mono * win
            spec = np.abs(np.fft.rfft(xw)).astype(np.float32)
            spec /= max(1.0, float(fft_size) / 2.0)

            if self._prev_spec is None or smoothing <= 0:
                sm = spec
            else:
                sm = (smoothing * self._prev_spec + (1.0 - smoothing) * spec).astype(np.float32)
            self._prev_spec = sm

            with self._lock:
                self.frame_id += 1
                self.ts = time.time()
                self.time_domain = x_td.astype(np.float32, copy=True)
                self.spectrum = sm.astype(np.float32, copy=True)
                self.rms = rms
                self.peak = peak
                self.corr = corr

            target_dt = 1.0 / max(10, fps_cap)
            dt = time.time() - t0
            delay = target_dt - dt
            if delay > 0:
                time.sleep(delay)
