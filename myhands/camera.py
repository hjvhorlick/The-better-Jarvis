"""Single-owner camera service with explicit states and bounded recovery.

Only this service opens the camera. Consumers call get_frame(); they never open
a device themselves. The state machine is driven by step(), so tests can run it
deterministically; start() runs step() on a background thread.
"""
from __future__ import annotations

import threading
import time
from enum import Enum
from typing import Any, Callable, Protocol


class CameraState(str, Enum):
    NOT_INITIALIZED = "not_initialized"
    CONNECTING = "connecting"
    ACTIVE = "active"
    INTERRUPTED = "interrupted"
    RECONNECTING = "reconnecting"
    DEVICE_UNAVAILABLE = "device_unavailable"
    ERROR = "error"
    STOPPED = "stopped"


class FrameSource(Protocol):
    def open(self) -> bool: ...
    def read(self) -> tuple[bool, Any]: ...
    def close(self) -> None: ...


class OpenCVSource:
    """Real camera via OpenCV. Imported lazily so tests never need it."""

    def __init__(self, index: int = 0) -> None:
        self.index = index
        self._cap = None

    def open(self) -> bool:
        import cv2
        self._cap = cv2.VideoCapture(self.index)
        return bool(self._cap.isOpened())

    def read(self) -> tuple[bool, Any]:
        if self._cap is None:
            return False, None
        return self._cap.read()

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None


DEVICE_HINT = ("Check that no other program is using the camera. On Linux, make sure "
               "your user is in the 'video' group.")


class CameraService:
    def __init__(
        self,
        source_factory: Callable[[], FrameSource],
        clock: Callable[[], float] = time.monotonic,
        stall_s: float = 2.0,
        max_open_attempts: int = 3,
        max_reconnects: int = 5,
        backoff_s: tuple = (0.5, 1.0, 2.0, 4.0, 8.0),
        stable_reset_s: float = 10.0,
    ) -> None:
        self._factory = source_factory
        self._clock = clock
        self._stall_s = stall_s
        self._max_open = max_open_attempts
        self._max_reconnects = max_reconnects
        self._backoff = backoff_s
        self._stable_reset_s = stable_reset_s

        self._lock = threading.Lock()
        self._source: FrameSource | None = None
        self.state = CameraState.NOT_INITIALIZED
        self.message = ""
        self._open_attempts = 0
        self._reconnects = 0
        self._next_attempt_at = 0.0
        self._last_frame_at = 0.0
        self._active_since = 0.0
        self._frame: Any = None
        self._frame_seq = 0
        self._frames_total = 0
        self._opens_total = 0
        self._closes_total = 0
        self._thread: threading.Thread | None = None
        self._running = False

    # ----- consumer API -----
    def get_frame(self) -> tuple[Any, int] | None:
        """Latest frame and its sequence number, or None if there is none."""
        with self._lock:
            if self._frame is None or self.state != CameraState.ACTIVE:
                return None
            return self._frame, self._frame_seq

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state.value,
                "message": self.message,
                "frames_total": self._frames_total,
                "reconnects": self._reconnects,
                "opens_total": self._opens_total,
                "closes_total": self._closes_total,
            }

    # ----- lifecycle -----
    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self.state = CameraState.CONNECTING
            self.message = "opening camera"
            self._open_attempts = 0
            self._reconnects = 0
            self._next_attempt_at = 0.0
        self._thread = threading.Thread(target=self._run, name="myhands-camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._running = False
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=3.0)
        self._close_source()
        with self._lock:
            # Keep a failure visible after the session ends, so the reason is not lost.
            if self.state not in (CameraState.DEVICE_UNAVAILABLE, CameraState.ERROR):
                self.state = CameraState.STOPPED
                self.message = "stopped"
            self._frame = None

    def _run(self) -> None:
        while True:
            with self._lock:
                if not self._running:
                    break
            self.step()
            time.sleep(0.01)

    # ----- state machine (deterministic; tests call this directly) -----
    def step(self) -> None:
        now = self._clock()
        with self._lock:
            state = self.state
        if state in (CameraState.CONNECTING, CameraState.RECONNECTING):
            if now >= self._next_attempt_at:
                self._try_open(now)
        elif state == CameraState.ACTIVE:
            self._read_once(now)
        elif state == CameraState.INTERRUPTED:
            self._begin_reconnect(now)

    def _try_open(self, now: float) -> None:
        self._opens_total += 1
        src = None
        ok = False
        try:
            src = self._factory()
            ok = bool(src.open())
        except Exception as e:  # device errors vary by OS; report the type only
            self._set_message(f"open failed ({type(e).__name__})")
        if ok:
            with self._lock:
                self._source = src
                self.state = CameraState.ACTIVE
                self.message = "camera active"
                self._last_frame_at = now
                self._active_since = now
                self._open_attempts = 0
            return
        if src is not None:
            try:
                src.close()
            except Exception:
                pass
        self._open_attempts += 1
        with self._lock:
            if self._open_attempts >= self._max_open:
                if self.state == CameraState.RECONNECTING:
                    self.state = CameraState.ERROR
                    self.message = "camera did not come back after an interruption. " + DEVICE_HINT
                else:
                    self.state = CameraState.DEVICE_UNAVAILABLE
                    self.message = "camera not available. " + DEVICE_HINT
                self._running = False
            else:
                self._next_attempt_at = now + self._backoff_for(self._open_attempts - 1)

    def _read_once(self, now: float) -> None:
        src = self._source
        ok, frame = False, None
        try:
            ok, frame = src.read() if src is not None else (False, None)
        except Exception as e:
            self._set_message(f"read failed ({type(e).__name__})")
        if ok and frame is not None:
            with self._lock:
                self._last_frame_at = now
                self._frame = frame
                self._frame_seq += 1
                self._frames_total += 1
                if self._reconnects and now - self._active_since >= self._stable_reset_s:
                    self._reconnects = 0
            return
        if now - self._last_frame_at >= self._stall_s or not ok:
            self._close_source()
            with self._lock:
                self.state = CameraState.INTERRUPTED
                self.message = "camera stopped delivering frames"
                self._frame = None

    def _begin_reconnect(self, now: float) -> None:
        with self._lock:
            self._reconnects += 1
            if self._reconnects > self._max_reconnects:
                self.state = CameraState.ERROR
                self.message = "camera kept failing; stopped trying. " + DEVICE_HINT
                self._running = False
                return
            self.state = CameraState.RECONNECTING
            self.message = f"reconnecting ({self._reconnects}/{self._max_reconnects})"
            self._open_attempts = 0
            self._next_attempt_at = now + self._backoff_for(self._reconnects - 1)

    def _backoff_for(self, n: int) -> float:
        return self._backoff[min(n, len(self._backoff) - 1)]

    def _set_message(self, text: str) -> None:
        with self._lock:
            self.message = text

    def _close_source(self) -> None:
        src, self._source = self._source, None
        if src is not None:
            self._closes_total += 1
            try:
                src.close()
            except Exception:
                pass


def preview_jpeg(frame, mirror: bool, max_width: int = 640, quality: int = 70) -> bytes:
    """Encode one camera frame as a JPEG for the on-screen preview.

    `mirror` flips the picture left to right, the same flip the gesture engine applies to hand
    positions. A hand that enters from the right of the view therefore enters from the right of
    the picture, and the pointer moves the same way. The flip happens once, here, on this computer.
    """
    import cv2

    img = cv2.flip(frame, 1) if mirror else frame
    h, w = img.shape[:2]
    if w > max_width:
        img = cv2.resize(img, (max_width, max(1, int(h * max_width / w))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise ValueError("could not encode the camera frame")
    return buf.tobytes()
