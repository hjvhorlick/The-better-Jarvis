"""Gesture engine: turns hand observations into pinch, grab, drag and release events.

No camera, no MediaPipe, no clock of its own: time is passed in, so every
rule is testable. Coordinates: camera image is normalised 0..1; stage
coordinates are normalised 0..1 after mirroring and calibration.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from .filters import OneEuroFilter

# MediaPipe Hands landmark indices (21-point hand model).
WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_MCP = 0, 4, 8, 9


@dataclass(frozen=True)
class Observation:
    """One tracked hand in one frame."""
    landmarks: tuple  # 21 x (x, y, z), normalised camera coordinates
    score: float      # handedness confidence, 0..1


@dataclass(frozen=True)
class SceneObject:
    id: str
    x: float
    y: float
    w: float
    h: float
    z: int = 0

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h


@dataclass(frozen=True)
class Config:
    min_confidence: float = 0.6
    pinch_on: float = 0.30
    pinch_off: float = 0.45
    pinch_hold_s: float = 0.120
    release_hold_s: float = 0.080
    loss_grace_s: float = 0.300
    cursor_hz: float = 30.0
    mirror: bool = True
    calib: tuple = (0.0, 0.0, 1.0, 1.0)  # cx0, cy0, cx1, cy1 in camera coordinates
    smooth_min_cutoff: float = 1.2
    smooth_beta: float = 0.01
    smooth_d_cutoff: float = 1.0


@dataclass
class _Grab:
    object_id: str
    dx: float
    dy: float
    x: float
    y: float


@dataclass
class _Pinch:
    state: str = "open"          # open | candidate | pinched | releasing
    since: float = 0.0


def pinch_ratio(lm) -> tuple[float, float]:
    """Return (ratio, hand_scale). Ratio = thumb-index gap divided by hand size."""
    def d(a, b):
        return math.dist((lm[a][0], lm[a][1]), (lm[b][0], lm[b][1]))
    scale = d(WRIST, MIDDLE_MCP)
    if scale <= 1e-6:
        return float("inf"), scale
    return d(THUMB_TIP, INDEX_TIP) / scale, scale


class GestureEngine:
    def __init__(self, config: Config | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.cfg = config or Config()
        self._clock = clock
        self._objects: list[SceneObject] = []
        self._hand_present = False
        self._last_seen = -math.inf
        self._last_score_high: bool | None = None
        self._pinch = _Pinch()
        self._grab: _Grab | None = None
        self._fx = OneEuroFilter(self.cfg.smooth_min_cutoff, self.cfg.smooth_beta, self.cfg.smooth_d_cutoff)
        self._fy = OneEuroFilter(self.cfg.smooth_min_cutoff, self.cfg.smooth_beta, self.cfg.smooth_d_cutoff)
        self._cursor: tuple[float, float] | None = None
        self._last_cursor_emit = -math.inf
        self._last_drag_emit = -math.inf

    # ----- scene -----
    def set_scene(self, objects: Iterable[SceneObject]) -> None:
        self._objects = sorted(objects, key=lambda o: -o.z)

    @property
    def scene(self) -> list[SceneObject]:
        return list(self._objects)

    @property
    def grabbed_id(self) -> str | None:
        return self._grab.object_id if self._grab else None

    @property
    def hand_present(self) -> bool:
        return self._hand_present

    @property
    def last_hand_seen(self) -> float:
        return self._last_seen

    # ----- mapping -----
    def _to_stage(self, lm) -> tuple[float, float]:
        x, y = lm[INDEX_TIP][0], lm[INDEX_TIP][1]
        if self.cfg.mirror:
            x = 1.0 - x
        cx0, cy0, cx1, cy1 = self.cfg.calib
        sx = (x - cx0) / (cx1 - cx0) if cx1 > cx0 else x
        sy = (y - cy0) / (cy1 - cy0) if cy1 > cy0 else y
        return min(1.0, max(0.0, sx)), min(1.0, max(0.0, sy))

    def _hit(self, px: float, py: float) -> SceneObject | None:
        for obj in self._objects:          # already topmost-first
            if obj.contains(px, py):
                return obj
        return None

    # ----- main step -----
    def update(self, observations: Iterable[Observation], now: float | None = None) -> list[dict]:
        t = self._clock() if now is None else now
        events: list[dict] = []
        hand = next((o for o in observations if o.score >= self.cfg.min_confidence), None)
        # Confidence level events (only on crossing).
        best = max((o.score for o in observations), default=0.0)
        high = best >= self.cfg.min_confidence
        if self._last_score_high is None or high != self._last_score_high:
            if self._last_score_high is not None:
                events.append({"type": "confidence_changed", "t": t, "score": round(best, 3),
                               "level": "high" if high else "low"})
            self._last_score_high = high

        if hand is not None:
            self._last_seen = t
            if not self._hand_present:
                self._hand_present = True
                events.append({"type": "hand_detected", "t": t})
            events += self._on_hand(hand, t)
        elif self._hand_present and (t - self._last_seen) > self.cfg.loss_grace_s:
            events += self._on_lost(t)
        return events

    def tick(self, now: float | None = None) -> list[dict]:
        """Time passed with no new observation: only the tracking-loss rule applies.

        Used between camera frames, so the grace period counts real time and a
        lost hand is noticed even when the camera is slow.
        """
        t = self._clock() if now is None else now
        if self._hand_present and (t - self._last_seen) > self.cfg.loss_grace_s:
            return self._on_lost(t)
        return []

    def release_all(self, reason: str, now: float | None = None) -> list[dict]:
        """Force-release everything (session stop, camera failure)."""
        t = self._clock() if now is None else now
        events: list[dict] = []
        if self._grab is not None:
            events.append(self._end_grab(t, reason))
        if self._pinch.state != "open":
            events.append({"type": "pinch_released", "t": t})
        self._pinch = _Pinch()
        self._cursor = None
        self._fx.reset()
        self._fy.reset()
        if self._hand_present:
            self._hand_present = False
            events.append({"type": "hand_lost", "t": t})
        return events

    # ----- internals -----
    def _on_lost(self, t: float) -> list[dict]:
        events = self.release_all("tracking_lost", now=t)
        return events

    def _on_hand(self, hand: Observation, t: float) -> list[dict]:
        events: list[dict] = []
        ratio, _ = pinch_ratio(hand.landmarks)
        raw_x, raw_y = self._to_stage(hand.landmarks)
        x = self._fx.apply(raw_x, t)
        y = self._fy.apply(raw_y, t)
        self._cursor = (x, y)

        if self._due(t, self._last_cursor_emit):
            events.append({"type": "cursor_moved", "t": t, "x": round(x, 4), "y": round(y, 4)})
            self._last_cursor_emit = t

        p = self._pinch
        if p.state == "open":
            if ratio < self.cfg.pinch_on:
                p.state, p.since = "candidate", t
        elif p.state == "candidate":
            if ratio >= self.cfg.pinch_on:
                p.state = "open"                       # blip: cancelled silently
            elif t - p.since >= self.cfg.pinch_hold_s:
                p.state, p.since = "pinched", t
                events.append({"type": "pinch_started", "t": t, "x": round(x, 4), "y": round(y, 4)})
                target = self._hit(x, y)
                if target is not None:
                    self._grab = _Grab(target.id, x - target.x, y - target.y, target.x, target.y)
                    events.append({"type": "object_grabbed", "t": t, "id": target.id,
                                   "x": round(target.x, 4), "y": round(target.y, 4)})
        elif p.state == "pinched":
            if ratio > self.cfg.pinch_off:
                p.state, p.since = "releasing", t
            elif self._grab is not None:
                events += self._drag(x, y, t, final=False)
        elif p.state == "releasing":
            if ratio <= self.cfg.pinch_off:
                p.state = "pinched"                    # flicker: stay pinched
                if self._grab is not None:
                    events += self._drag(x, y, t, final=False)
            elif t - p.since >= self.cfg.release_hold_s:
                if self._grab is not None:
                    events.append(self._end_grab(t, "release"))
                p.state = "open"
                events.append({"type": "pinch_released", "t": t})
        return events

    def _drag(self, x: float, y: float, t: float, final: bool) -> list[dict]:
        g = self._grab
        if g is None:
            return []
        nx = min(max(x - g.dx, 0.0), 1.0 - self._obj_w(g.object_id))
        ny = min(max(y - g.dy, 0.0), 1.0 - self._obj_h(g.object_id))
        g.x, g.y = nx, ny
        if final or self._due(t, self._last_drag_emit):
            self._last_drag_emit = t
            return [{"type": "object_dragged", "t": t, "id": g.object_id,
                     "x": round(nx, 4), "y": round(ny, 4)}]
        return []

    def _end_grab(self, t: float, reason: str) -> dict:
        g = self._grab
        self._grab = None
        return {"type": "object_released", "t": t, "id": g.object_id,
                "x": round(g.x, 4), "y": round(g.y, 4), "reason": reason}

    def _due(self, t: float, last: float) -> bool:
        """True when the throttle interval has passed. The epsilon absorbs float rounding of timestamps."""
        return t - last >= (1.0 / self.cfg.cursor_hz) - 1e-6

    def _obj_w(self, object_id: str) -> float:
        return next((o.w for o in self._objects if o.id == object_id), 0.0)

    def _obj_h(self, object_id: str) -> float:
        return next((o.h for o in self._objects if o.id == object_id), 0.0)
