"""JARVIS startup compatibility hooks.

This module is loaded automatically by Python when the repository root is on
sys.path.  It patches the live camera UI before MainWindow is instantiated.
The patch keeps camera capture lightweight on low-power Linux systems and
reuses the same working V4L2 device selection as the vision capture code.
"""

from __future__ import annotations

import importlib
import threading


_installed = False


def _patch_ui(module) -> None:
    global _installed
    if _installed:
        return
    MainWindow = getattr(module, "MainWindow", None)
    if MainWindow is None:
        return

    original_init = MainWindow.__init__

    def _init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self._cam_frame_lock = threading.Lock()
        self._cam_frame_pending = False

    def _on_cam_frame(self, data: bytes) -> None:
        try:
            px = module.QPixmap()
            px.loadFromData(data)
            if px.isNull():
                return
            w = self._cam_live_lbl.width()
            h = self._cam_live_lbl.height()
            if w > 1 and h > 1:
                self._cam_live_lbl.setPixmap(
                    px.scaled(
                        w,
                        h,
                        module.Qt.AspectRatioMode.KeepAspectRatio,
                        module.Qt.TransformationMode.FastTransformation,
                    )
                )
        finally:
            with self._cam_frame_lock:
                self._cam_frame_pending = False

    def _cam_loop(self) -> None:
        try:
            import cv2

            # Use the exact working device chosen by screen_processor when
            # possible.  This avoids the live preview opening video0 while the
            # vision capture has correctly selected the external USB node.
            cam_idx = -1
            try:
                from actions.screen_processor import _get_camera_index
                cam_idx = int(_get_camera_index())
            except Exception:
                pass

            if cam_idx < 0:
                try:
                    cfg = module._read_full_config()
                    cam_idx = int(cfg.get("camera_index", 0))
                except Exception:
                    cam_idx = 0

            try:
                backend = cv2.CAP_DSHOW if module._OS == "Windows" else cv2.CAP_ANY
            except AttributeError:
                backend = 0

            cap = cv2.VideoCapture(cam_idx, backend)
            if not cap.isOpened() and cam_idx != 0:
                cap = cv2.VideoCapture(0, backend)
            if not cap.isOpened():
                return

            try:
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            except Exception:
                pass

            for _ in range(5):
                cap.read()

            # Ten GUI updates/sec is enough for a monitoring preview and avoids
            # flooding the Qt event queue on the user's low-power Celeron.
            while not self._cam_stop.wait(0.10) and cap.isOpened():
                ret, frame = cap.read()
                if not ret or frame is None:
                    continue

                with self._cam_frame_lock:
                    if self._cam_frame_pending:
                        continue
                    self._cam_frame_pending = True

                try:
                    ok, buf = cv2.imencode(
                        ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 60]
                    )
                    if not ok:
                        with self._cam_frame_lock:
                            self._cam_frame_pending = False
                        continue
                    self._cam_frame_sig.emit(buf.tobytes())
                except Exception:
                    with self._cam_frame_lock:
                        self._cam_frame_pending = False
                    raise

            cap.release()
        except Exception as e:
            print(f"[Camera] Stream error: {e}")
        finally:
            self._cam_stream_sig.emit(False)

    MainWindow.__init__ = _init
    MainWindow._on_cam_frame = _on_cam_frame
    MainWindow._cam_loop = _cam_loop
    _installed = True


class _UiLoader:
    """Import hook that patches ui.py immediately after it is loaded."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname != "ui":
            return None
        import sys
        from importlib.machinery import PathFinder

        spec = PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None:
            return None

        original_loader = spec.loader

        class _Loader:
            def create_module(self, spec):
                if hasattr(original_loader, "create_module"):
                    return original_loader.create_module(spec)
                return None

            def exec_module(self, module):
                original_loader.exec_module(module)
                _patch_ui(module)

        spec.loader = _Loader()
        return spec


import sys
if not any(type(x).__name__ == "_UiLoader" for x in sys.meta_path):
    sys.meta_path.insert(0, _UiLoader())
