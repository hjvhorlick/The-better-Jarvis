"""My Hands session: camera → tracker → gesture engine → event log.

One session at a time. Every way of ending a session (user stop, idle timeout,
camera failure, tracker crash) first releases any grab, so nothing stays grabbed.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

from backend.events import EventBus

from .camera import CameraService, CameraState
from .gestures import GestureEngine, SceneObject

MODE_MY_HANDS = "my_hands"


class MyHandsSession:
    def __init__(
        self,
        camera: CameraService,
        tracker_factory: Callable[[], object],
        engine: GestureEngine | None = None,
        clock: Callable[[], float] = time.monotonic,
        idle_off_s: float = 600.0,
        loop_interval_s: float = 0.02,
        event_buffer: int = 1000,
        bus: EventBus | None = None,
    ) -> None:
        self.camera = camera
        self._tracker_factory = tracker_factory
        self.engine = engine or GestureEngine(clock=clock)
        self._clock = clock
        self._idle_off_s = idle_off_s
        self._interval = loop_interval_s

        self._lock = threading.Lock()          # guards engine, events and flags
        self._bus = bus or EventBus(capacity=event_buffer)
        self._running = False
        self._stop_reason: str | None = None
        self._thread: threading.Thread | None = None
        self._tracker = None
        self.mode: str | None = None
        self._last_hand_at = 0.0
        self._last_frame_seq = -1
        self._unavailable_reported: str | None = None

    # ----- public API -----
    @property
    def running(self) -> bool:
        return self._running

    def start(self, mode: str = MODE_MY_HANDS) -> None:
        if mode != MODE_MY_HANDS:
            raise ValueError("unknown mode")
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stop_reason = None
            self.mode = mode
            now = self._clock()
            self._last_hand_at = now
            self._last_frame_seq = -1
            self._unavailable_reported = None
            self._emit({"type": "session_started", "t": now, "mode": mode})
        self.camera.start()
        self._thread = threading.Thread(target=self._run, name="myhands-session", daemon=True)
        self._thread.start()

    def stop(self, reason: str = "user") -> None:
        with self._lock:
            if not self._running:
                return
            self._stop_reason = reason
            self._running = False
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=5.0)

    def set_scene(self, objects: list[SceneObject]) -> None:
        with self._lock:
            self.engine.set_scene(objects)

    def events_after(self, seq: int) -> list[tuple[int, dict]]:
        return self._bus.since(seq, source=MODE_MY_HANDS)

    def status(self) -> dict:
        now = self._clock()
        cam = self.camera.status()
        with self._lock:
            running = self._running
            hand_age = round(now - self._last_hand_at, 2) if running else None
            return {
                "running": running,
                "mode": self.mode,
                "camera_on": running and cam["state"] not in (
                    CameraState.STOPPED.value, CameraState.NOT_INITIALIZED.value,
                    CameraState.DEVICE_UNAVAILABLE.value, CameraState.ERROR.value),
                "camera": cam,
                "hand_present": self.engine.hand_present,
                "last_hand_age_s": hand_age,
                "grabbed_id": self.engine.grabbed_id,
                "idle_off_s": self._idle_off_s,
                "last_event_seq": self._bus.last_seq,
            }

    # ----- internals -----
    def _emit(self, event: dict) -> None:            # caller holds self._lock
        self._bus.publish(MODE_MY_HANDS, event)

    def _emit_all(self, events: list[dict]) -> None:  # caller holds self._lock
        for e in events:
            self._emit(e)

    def _run(self) -> None:
        try:
            self._tracker = self._tracker_factory()
            while True:
                with self._lock:
                    if not self._running:
                        break
                self._tick(self._clock())
                time.sleep(self._interval)
        except Exception as e:                          # never leave a grab behind
            if isinstance(e, ImportError):
                text = "hand tracking is not installed (see backend/requirements-myhands.txt)"
            else:
                text = f"hand tracking failed ({type(e).__name__})"
            with self._lock:
                self._emit({"type": "tracking_unavailable", "t": self._clock(), "reason": text})
                self._stop_reason = self._stop_reason or "tracker_failed"
                self._running = False
        finally:
            self._finish()

    def _tick(self, now: float) -> None:
        cam_state = self.camera.state
        frame = self.camera.get_frame()
        with self._lock:
            if frame is None or frame[1] == self._last_frame_seq:
                if cam_state in (CameraState.DEVICE_UNAVAILABLE, CameraState.ERROR, CameraState.STOPPED):
                    self._stop_reason = "camera_failed"
                    self._emit({"type": "tracking_unavailable", "t": now,
                                "reason": self.camera.status()["message"]})
                    self._running = False
                    return
                if cam_state in (CameraState.INTERRUPTED, CameraState.RECONNECTING):
                    if self._unavailable_reported is None:          # one event per outage
                        self._unavailable_reported = cam_state.value
                        self._emit({"type": "tracking_unavailable", "t": now,
                                    "reason": self.camera.status()["message"]})
                # No new observation this tick: let the loss-grace rule run on real time.
                self._emit_all(self.engine.tick(now))
            else:
                self._unavailable_reported = None
                self._last_frame_seq = frame[1]
                observations = self._tracker.process(frame[0])
                self._emit_all(self.engine.update(observations, now))
                if self.engine.hand_present:
                    self._last_hand_at = now
            if self._running and now - self._last_hand_at >= self._idle_off_s:
                self._stop_reason = "auto_off"
                self._emit({"type": "auto_off", "t": now})
                self._running = False

    def _finish(self) -> None:
        now = self._clock()
        reason = self._stop_reason or "session_stopped"
        engine_reason = "camera_failed" if reason == "camera_failed" else "session_stopped"
        with self._lock:
            self._emit_all(self.engine.release_all(engine_reason, now))
            self._emit({"type": "session_stopped", "t": now, "reason": reason})
            self._running = False
            self.mode = None
        self.camera.stop()
        if self._tracker is not None:
            self._tracker.close()
            self._tracker = None
