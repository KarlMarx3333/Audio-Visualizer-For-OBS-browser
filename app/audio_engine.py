from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional, List

import numpy as np
import sounddevice as sd


@dataclass
class DeviceInfo:
    id: int
    name: str
    hostapi: str
    max_input_channels: int
    default_samplerate: float


def list_input_devices() -> List[DeviceInfo]:
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    out: List[DeviceInfo] = []
    for idx, d in enumerate(devices):
        mic_ch = int(d.get("max_input_channels", 0) or 0)
        if mic_ch <= 0:
            continue
        hostapi_idx = int(d.get("hostapi", 0) or 0)
        hostapi_name = hostapis[hostapi_idx]["name"] if 0 <= hostapi_idx < len(hostapis) else "unknown"
        out.append(DeviceInfo(
            id=int(idx),
            name=str(d.get("name", f"Device {idx}")),
            hostapi=str(hostapi_name),
            max_input_channels=mic_ch,
            default_samplerate=float(d.get("default_samplerate", 48000.0) or 48000.0),
        ))
    return out


class RingBuffer:
    def __init__(self, *, seconds: float, samplerate: int, channels: int) -> None:
        self.samplerate = int(samplerate)
        self.channels = int(channels)
        self.size = int(max(1, seconds * self.samplerate))
        self._buf = np.zeros((self.size, self.channels), dtype=np.float32)
        self._write = 0
        self._lock = threading.RLock()

    def write(self, data: np.ndarray) -> None:
        if data.ndim == 1:
            data = data[:, None]
        frames = int(data.shape[0])
        if frames <= 0:
            return

        if data.shape[1] != self.channels:
            if self.channels == 1:
                data = np.mean(data, axis=1, keepdims=True).astype(np.float32, copy=False)
            else:
                if data.shape[1] == 1:
                    data = np.repeat(data, 2, axis=1).astype(np.float32, copy=False)
                else:
                    data = data[:, :self.channels].astype(np.float32, copy=False)

        with self._lock:
            n = frames
            w = self._write
            if n >= self.size:
                data = data[-self.size:]
                n = self.size
            end = w + n
            if end <= self.size:
                self._buf[w:end] = data[:n]
            else:
                first = self.size - w
                self._buf[w:] = data[:first]
                self._buf[:end - self.size] = data[first:n]
            self._write = (w + n) % self.size

    def read_latest(self, n_samples: int) -> np.ndarray:
        n = int(max(1, min(self.size, n_samples)))
        with self._lock:
            w = self._write
            start = (w - n) % self.size
            if start < w:
                out = self._buf[start:w].copy()
            else:
                out = np.vstack((self._buf[start:].copy(), self._buf[:w].copy()))
        return out


class AudioEngine:
    def __init__(self) -> None:
        self._stream: Optional[sd.InputStream] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.RLock()

        self.ring: Optional[RingBuffer] = None
        self.device_id: Optional[int] = None
        self.device_name: Optional[str] = None
        self.samplerate: int = 48000
        self.channels: int = 1
        self.last_error: Optional[str] = None

    def configure(self, *, device_id: Optional[int], device_name: Optional[str], samplerate: int, channels: int) -> None:
        with self._lock:
            self.device_id = device_id
            self.device_name = device_name
            self.samplerate = int(samplerate)
            self.channels = 1 if int(channels) <= 1 else 2

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="AudioEngine", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        with self._lock:
            s = self._stream
            self._stream = None
        if s is not None:
            try:
                s.stop()
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass
        t = self._thread
        if t:
            t.join(timeout=timeout)

    def restart(self) -> None:
        self.stop()
        self.start()

    def _resolve_device(self) -> Optional[int]:
        devs = list_input_devices()
        if self.device_id is not None:
            for d in devs:
                if d.id == self.device_id:
                    return d.id
        if self.device_name:
            for d in devs:
                if d.name == self.device_name:
                    return d.id
        try:
            default_in = sd.default.device[0]
            if default_in is not None and int(default_in) >= 0:
                for d in devs:
                    if d.id == int(default_in):
                        return d.id
        except Exception:
            pass
        return devs[0].id if devs else None

    def _run(self) -> None:
        # Retry loop to survive device unplug / stream failure.
        backoff = 1.0
        while not self._stop.is_set():
            self.last_error = None
            dev = self._resolve_device()
            if dev is None:
                self.last_error = "No input devices found."
                time.sleep(2.0)
                backoff = min(8.0, backoff * 1.5)
                continue

            self.ring = RingBuffer(seconds=6.0, samplerate=self.samplerate, channels=self.channels)

            def callback(indata, frames, time_info, status):
                if self._stop.is_set():
                    raise sd.CallbackStop()
                try:
                    data = np.asarray(indata, dtype=np.float32)
                    self.ring.write(data)
                except Exception:
                    pass

            try:
                with sd.InputStream(
                    device=dev,
                    channels=self.channels,
                    samplerate=self.samplerate,
                    dtype="float32",
                    callback=callback,
                    blocksize=0,
                ) as stream:
                    with self._lock:
                        self._stream = stream
                    backoff = 1.0
                    while not self._stop.is_set():
                        time.sleep(0.1)
            except Exception as e:
                self.last_error = f"Audio stream error: {e!s}"
            finally:
                with self._lock:
                    self._stream = None

            if self._stop.is_set():
                break

            time.sleep(backoff)
            backoff = min(8.0, backoff * 1.5)
