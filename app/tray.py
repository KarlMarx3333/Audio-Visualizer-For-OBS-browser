from __future__ import annotations

import webbrowser
from typing import Callable

import pystray
from PIL import Image, ImageDraw

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

        self.icon = pystray.Icon("ObsVizHost", _make_icon(), "ObsVizHost")
        self._rebuild_menu()


    def _rebuild_menu(self):
        viz_menu = pystray.Menu(*self._visualizer_items())
        dev_menu = pystray.Menu(*self._device_items())
        self.icon.menu = pystray.Menu(
            pystray.MenuItem("Open UI", self._open_ui),
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
