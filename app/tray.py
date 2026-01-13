from __future__ import annotations

import threading
import webbrowser
from typing import Callable

import pystray
from PIL import Image, ImageDraw

try:
    import tkinter as tk
    from tkinter import ttk
except Exception:
    tk = None
    ttk = None

from .config import AppConfig, save_config
from .state import StateStore
from .audio_engine import list_input_devices, AudioEngine
from .server import VISUALIZERS


def _make_icon() -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8, 8, 56, 56), radius=12, fill=(20, 20, 20, 255))
    bars = [16, 28, 40, 32, 48, 24, 36]
    x = 14
    for h in bars:
        d.rounded_rectangle((x, 52 - h, x + 4, 52), radius=2, fill=(180, 220, 255, 255))
        x += 6
    return img


class TrayApp:
    def __init__(self, cfg: AppConfig, state: StateStore, audio: AudioEngine, on_quit: Callable[[], None]) -> None:
        self.cfg = cfg
        self.state = state
        self.audio = audio
        self.on_quit = on_quit
        self._tuning_lock = threading.Lock()
        self._tuning_open = False
        self._tuning_root = None

        self.icon = pystray.Icon("ObsVizHost", _make_icon(), "ObsVizHost")
        self._rebuild_menu()


    def _rebuild_menu(self):
        viz_menu = pystray.Menu(*self._visualizer_items())
        dev_menu = pystray.Menu(*self._device_items())
        tuning_info = pystray.MenuItem(
            f"Gain: {self.cfg.gain:.2f}x | Smooth: {self.cfg.visual_smoothing:.2f}",
            None,
            enabled=False,
        )
        if tk is None:
            tuning_item = pystray.MenuItem("Audio Tuning (Tk unavailable)", None, enabled=False)
        else:
            tuning_item = pystray.MenuItem("Audio Tuning...", self._open_tuning)
        self.icon.menu = pystray.Menu(
            pystray.MenuItem("Open UI", self._open_ui),
            tuning_info,
            tuning_item,
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Visualizers", viz_menu),
            pystray.MenuItem("Input Device", dev_menu),
            pystray.MenuItem("Restart Audio Engine", self._restart_audio),
            pystray.MenuItem("Refresh Devices", self._refresh_devices),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._quit),
        )

    def _refresh_devices(self, icon, item):
        self._rebuild_menu()

    def _open_ui(self, icon, item):
        webbrowser.open(f"http://127.0.0.1:{self.cfg.port}/")

    def _restart_audio(self, icon, item):
        self.audio.configure(device_id=self.cfg.selected_device_id, device_name=self.cfg.selected_device_name,
                             samplerate=self.cfg.samplerate, channels=self.cfg.channels)
        self.audio.restart()

    def _open_tuning(self, icon, item):
        if tk is None:
            return
        with self._tuning_lock:
            if self._tuning_open:
                root = self._tuning_root
                if root is not None:
                    try:
                        root.after(0, self._focus_tuning)
                    except Exception:
                        pass
                return
            self._tuning_open = True
        threading.Thread(target=self._run_tuning_window, name="AudioTuning", daemon=True).start()

    def _focus_tuning(self):
        if not self._tuning_root:
            return
        try:
            self._tuning_root.deiconify()
            self._tuning_root.lift()
            self._tuning_root.attributes("-topmost", True)
            self._tuning_root.after(150, lambda: self._tuning_root.attributes("-topmost", False))
        except Exception:
            pass

    def _run_tuning_window(self):
        if tk is None or ttk is None:
            with self._tuning_lock:
                self._tuning_open = False
            return

        root = tk.Tk()
        root.title("Audio Tuning")
        root.resizable(False, False)

        with self._tuning_lock:
            self._tuning_root = root

        frame = ttk.Frame(root, padding=12)
        frame.grid(sticky="nsew")
        frame.columnconfigure(0, weight=1)
        frame.columnconfigure(1, weight=0)

        gain_var = tk.DoubleVar(value=self.cfg.gain)
        smooth_var = tk.DoubleVar(value=self.cfg.visual_smoothing)

        ttk.Label(frame, text="Gain").grid(row=0, column=0, sticky="w")
        gain_val = ttk.Label(frame, text=f"{gain_var.get():.2f}x")
        gain_val.grid(row=0, column=1, sticky="e")

        ttk.Label(frame, text="Smoothing").grid(row=2, column=0, sticky="w", pady=(8, 0))
        smooth_val = ttk.Label(frame, text=f"{smooth_var.get():.2f}")
        smooth_val.grid(row=2, column=1, sticky="e", pady=(8, 0))

        pending = {"id": None}

        def update_labels() -> None:
            gain_val.config(text=f"{gain_var.get():.2f}x")
            smooth_val.config(text=f"{smooth_var.get():.2f}")

        def apply_values() -> None:
            pending["id"] = None
            self.cfg.gain = float(gain_var.get())
            self.cfg.visual_smoothing = float(smooth_var.get())
            self.cfg.clamp()
            save_config(self.cfg)
            gain_var.set(self.cfg.gain)
            smooth_var.set(self.cfg.visual_smoothing)
            update_labels()
            self.state.update(gain=self.cfg.gain, visual_smoothing=self.cfg.visual_smoothing)
            self._rebuild_menu()
            try:
                self.icon.update_menu()
            except Exception:
                pass

        def schedule_apply(_value=None) -> None:
            update_labels()
            if pending["id"] is not None:
                try:
                    root.after_cancel(pending["id"])
                except Exception:
                    pass
            pending["id"] = root.after(120, apply_values)

        gain_scale = tk.Scale(
            frame,
            from_=0.2,
            to=4.0,
            resolution=0.01,
            orient="horizontal",
            showvalue=False,
            variable=gain_var,
            length=260,
            command=schedule_apply,
        )
        gain_scale.grid(row=1, column=0, columnspan=2, sticky="ew")

        smooth_scale = tk.Scale(
            frame,
            from_=0.0,
            to=0.95,
            resolution=0.01,
            orient="horizontal",
            showvalue=False,
            variable=smooth_var,
            length=260,
            command=schedule_apply,
        )
        smooth_scale.grid(row=3, column=0, columnspan=2, sticky="ew")

        def close_window() -> None:
            if pending["id"] is not None:
                try:
                    root.after_cancel(pending["id"])
                except Exception:
                    pass
            apply_values()
            root.destroy()

        btn = ttk.Button(frame, text="Close", command=close_window)
        btn.grid(row=4, column=0, columnspan=2, pady=(10, 0), sticky="ew")

        root.protocol("WM_DELETE_WINDOW", close_window)
        self._focus_tuning()
        root.mainloop()

        with self._tuning_lock:
            self._tuning_open = False
            self._tuning_root = None

    def _set_visualizer(self, vid: str):
        self.cfg.visualizer_name = vid
        save_config(self.cfg)
        self.state.update(visualizer_name=self.cfg.visualizer_name)

    def _visualizer_items(self):
        def _make_handler(vid: str):
            def _handler(icon, item):
                self._set_visualizer(vid)
            return _handler

        def _make_checked(vid: str):
            def _checked(item):
                return self.cfg.visualizer_name == vid
            return _checked

        items = []
        for v in VISUALIZERS:
            vid = v["id"]
            name = v["name"]

            items.append(pystray.MenuItem(
                name,
                _make_handler(vid),
                checked=_make_checked(vid),
                radio=True,
            ))
        return items

    def _set_device(self, dev_id: int, dev_name: str):
        self.cfg.selected_device_id = int(dev_id)
        self.cfg.selected_device_name = dev_name
        save_config(self.cfg)
        self.state.update(selected_device_id=self.cfg.selected_device_id, selected_device_name=self.cfg.selected_device_name)
        self.audio.configure(device_id=self.cfg.selected_device_id, device_name=self.cfg.selected_device_name,
                             samplerate=self.cfg.samplerate, channels=self.cfg.channels)
        self.audio.restart()

    def _device_items(self):
        def _make_handler(dev_id: int, dev_name: str):
            def _handler(icon, item):
                self._set_device(dev_id, dev_name)
            return _handler

        def _make_checked(dev_id: int):
            def _checked(item):
                return self.cfg.selected_device_id == dev_id
            return _checked

        devs = list_input_devices()
        items = []
        if not devs:
            items.append(pystray.MenuItem("No input devices found", None, enabled=False))
            return items

        for d in devs:
            label = f"{d.name} ({d.hostapi})"

            items.append(pystray.MenuItem(
                label,
                _make_handler(d.id, d.name),
                checked=_make_checked(d.id),
                radio=True,
            ))
        return items

    def _quit(self, icon, item):
        try:
            self.icon.visible = False
        except Exception:
            pass
        self.on_quit()
        try:
            self.icon.stop()
        except Exception:
            pass

    def run(self):
        self.icon.run()
