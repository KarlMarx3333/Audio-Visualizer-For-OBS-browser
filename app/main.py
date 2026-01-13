from __future__ import annotations

import signal
import threading
import time

from .config import load_config, save_config
from .state import StateStore
from .audio_engine import AudioEngine
from .analysis import Analyzer
from .server import create_app, ServerThread
from .tray import TrayApp


def main() -> None:
    cfg = load_config()
    save_config(cfg)

    state = StateStore()
    state.update(
        port=cfg.port,
        selected_device_id=cfg.selected_device_id,
        selected_device_name=cfg.selected_device_name,
        samplerate=cfg.samplerate,
        channels=cfg.channels,
        visualizer_name=cfg.visualizer_name,
        smoothing=cfg.smoothing,
        gain=cfg.gain,
        visual_smoothing=cfg.visual_smoothing,
        fft_size=cfg.fft_size,
        fps_cap=cfg.fps_cap,
    )

    stop_event = threading.Event()

    audio = AudioEngine()
    audio.configure(
        device_id=cfg.selected_device_id,
        device_name=cfg.selected_device_name,
        samplerate=cfg.samplerate,
        channels=cfg.channels,
    )
    audio.start()

    analyzer = Analyzer(audio)
    analyzer.configure(
        samplerate=cfg.samplerate,
        channels=cfg.channels,
        fft_size=cfg.fft_size,
        fps_cap=cfg.fps_cap,
        smoothing=cfg.smoothing,
    )
    analyzer.start()

    app = create_app(cfg, state, audio, analyzer)
    server = ServerThread(app, host="127.0.0.1", port=cfg.port)
    server.start()

    def monitor() -> None:
        while not stop_event.is_set():
            if audio.last_error:
                state.set_error(audio.last_error)
            else:
                state.set_running()

            try:
                fid, ts, td, spec, rms, peak, corr = analyzer.get_latest()
                state.update_metrics(frame_id=fid, ts=ts, rms=rms, peak=peak, corr=corr)
            except Exception:
                pass

            time.sleep(0.1)

    threading.Thread(target=monitor, name="Monitor", daemon=True).start()

    def shutdown() -> None:
        if stop_event.is_set():
            return
        stop_event.set()
        state.set_stopped()
        try:
            analyzer.stop()
        except Exception:
            pass
        try:
            audio.stop()
        except Exception:
            pass
        try:
            server.stop()
        except Exception:
            pass

    def _sig(signum, frame):
        shutdown()

    try:
        signal.signal(signal.SIGINT, _sig)
        signal.signal(signal.SIGTERM, _sig)
    except Exception:
        pass

    tray = TrayApp(cfg, state, audio, on_quit=shutdown)
    tray.run()


if __name__ == "__main__":
    main()
