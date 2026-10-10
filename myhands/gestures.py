"""Gesture engine: turns hand observations into gesture events.

No camera, no MediaPipe, no clock of its own: time is passed in, so every rule
is testable. Coordinates: camera image is normalised 0..1; stage coordinates
are normalised 0..1 after mirroring and calibration.

The engine reads the whole hand, not two fingertips. `myhands/handframe.py`
turns each frame's 21 landmarks into a palm centroid, a palm normal, a per
finger curl and a depth reading; this file turns those into gestures:

  pinch            thumb to index: precise, small movements
  fist             the whole hand closes: a firm grasp of something big
  hold still       keep your hand in place and the object starts to turn
  two hands        move your hands apart or together to scale
  clap             bring your palms together: centre it
  claw             half-close and pull: bring it toward you

Every gesture is a separate small state machine, so adding one never changes
how another behaves. Depth is kept throughout: pulling toward you is a
different gesture from sliding sideways, and only z tells them apart.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from .filters import OneEuroFilter
from .handframe import HandFrame, palm_distance, read_hand

# MediaPipe Hands landmark indices (21-point hand model).
WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_MCP = 0, 4, 8, 9


@dataclass(frozen=True)
class Observation:
    """One tracked hand in one frame."""
    landmarks: tuple  # 21 x (x, y, z), normalised camera coordinates
    score: float      # handedness confidence, 0..1
    label: str = ""   # "Left" or "Right" from MediaPipe; keeps two hands apart


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

    # ---- whole-hand rules ----
    fist_on: float = 0.74          # fingers curled this far: a fist
    fist_off: float = 0.46          # and this far open again
    fist_hold_s: float = 0.090      # held this long before it counts
    still_radius: float = 0.022     # palm may wander this far and count as still
    still_s: float = 1.000          # held this long before turning starts
    rotate_hz: float = 30.0         # how often a turn is reported
    clap_gap: float = 0.30          # palms closer than this, closing fast
    clap_speed: float = 1.10        # closing this fast (normalised units / second)
    clap_cooldown_s: float = 0.700
    scale_hz: float = 30.0
    claw_on: float = 0.30           # half-curled and spread: a claw
    claw_off: float = 0.14
    claw_hold_s: float = 0.120
    pull_hz: float = 30.0


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


@dataclass
class _Fist:
    state: str = "open"          # open | closing | closed
    since: float = 0.0


@dataclass
class _Rotate:
    state: str = "idle"          # idle | still | turning
    still_since: float = 0.0
    anchor: tuple = (0.0, 0.0)
    last_tilt: tuple = (0.0, 0.0)
    last_emit: float = -math.inf


@dataclass
class _Scale:
    active: bool = False
    base: float = 0.0
    last_emit: float = -math.inf


@dataclass
class _Clap:
    last_gap: float | None = None
    last_t: float | None = None
    cooled_until: float = -math.inf


@dataclass
class _Pull:
    state: str = "open"          # open | clawed | pulling
    since: float = 0.0
    origin: tuple = (0.0, 0.0, 0.0)
    last_emit: float = -math.inf


def pinch_ratio(lm) -> tuple[float, float]:
    """Return (ratio, hand_scale). Ratio = thumb-index gap divided by hand size."""
    def d(a, b):
        return math.dist((lm[a][0], lm[a][1]), (lm[b][0], lm[b][1]))
    scale = d(WRIST, MIDDLE_MCP)
    if scale <= 1e-6:
        return float("inf"), scale
    return d(THUMB_TIP, INDEX_TIP) / scale, scale


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


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

        # Whole-hand state. Each gesture keeps its own so they never interact.
        self._frames: dict[str, HandFrame] = {}
        self._fist = _Fist()
        self._rotate = _Rotate()
        self._scale = _Scale()
        self._clap = _Clap()
        self._pull = _Pull()

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

    @property
    def frames(self) -> dict[str, HandFrame]:
        """The whole-hand reading of every hand in the last frame."""
        return dict(self._frames)

    @property
    def turning(self) -> bool:
        """True while a held-still hand is turning something."""
        return self._rotate.state == "turning"

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
            # The whole-hand rules need every hand on screen, not just the first.
            events += self._on_gestures(
                [o for o in observations if o.score >= self.cfg.min_confidence], t)
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
        events += self._reset_whole_hand(t, reason)
        if self._hand_present:
            self._hand_present = False
            events.append({"type": "hand_lost", "t": t})
        return events

    def _reset_whole_hand(self, t: float, reason: str) -> list[dict]:
        """Put every whole-hand gesture back to rest, reporting what was live."""
        events: list[dict] = []
        if self._fist.state == "closed":
            events.append({"type": "fist_released", "t": t, "reason": reason})
        if self._rotate.state == "turning":
            events.append({"type": "rotate_ended", "t": t, "reason": reason})
        if self._scale.active:
            events.append({"type": "scale_ended", "t": t, "reason": reason})
        if self._pull.state == "pulling":
            events.append({"type": "pull_ended", "t": t, "reason": reason})
        self._fist = _Fist()
        self._rotate = _Rotate()
        self._scale = _Scale()
        self._clap = _Clap()
        self._pull = _Pull()
        self._frames = {}
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

    # ---------- the whole hand ----------

    def _on_gestures(self, hands: list[Observation], t: float) -> list[dict]:
        """Read every hand as a whole, then run each gesture rule."""
        events: list[dict] = []
        frames: dict[str, HandFrame] = {}
        for i, obs in enumerate(hands):
            # MediaPipe labels hands Left and Right, which is what keeps two
            # hands distinct from frame to frame. Synthetic hands have no label,
            # so fall back to their order in the list.
            key = obs.label or f"h{i}"
            frames[key] = read_hand(obs.landmarks)
        self._frames = frames

        if not frames:
            return events

        ordered = list(frames.values())
        primary = ordered[0]
        events += self._fist_rule(primary, t)
        events += self._rotate_rule(primary, t)
        events += self._clap_rule(ordered, t)
        events += self._claw_rule(primary, t)
        if len(ordered) >= 2:
            events += self._scale_rule(ordered[0], ordered[1], t)
        elif self._scale.active:
            events.append({"type": "scale_ended", "t": t, "reason": "hand_left"})
            self._scale = _Scale()
        return events

    def _fist_rule(self, frame: HandFrame, t: float) -> list[dict]:
        """The whole hand closes. A firm grasp, for something too big to pinch."""
        f = self._fist
        value = frame.fist
        if f.state == "open":
            if value >= self.cfg.fist_on:
                f.state, f.since = "closing", t
        elif f.state == "closing":
            if value < self.cfg.fist_off:
                f.state = "open"                       # twitch: cancelled silently
            elif t - f.since >= self.cfg.fist_hold_s:
                f.state = "closed"
                x, y = self._stage_of(frame)
                return [{"type": "fist_started", "t": t, "x": x, "y": y,
                         "strength": round(value, 3)}]
        elif f.state == "closed":
            if value <= self.cfg.fist_off:
                f.state = "open"
                return [{"type": "fist_released", "t": t}]
        return []

    def _rotate_rule(self, frame: HandFrame, t: float) -> list[dict]:
        """Hold your hand still and the object starts to turn.

        Stillness is measured on the palm centroid, which is far steadier than a
        fingertip, so the rule does not fire by accident while you are working.
        The turn itself is driven by the palm's tilt, which is the one thing
        only the whole hand can tell us.
        """
        r = self._rotate
        # Turning only means something while something is actually held.
        if self._grab is None and self._fist.state != "closed":
            if r.state != "idle":
                was = r.state
                r.state, r.still_since = "idle", 0.0
                if was == "turning":
                    return [{"type": "rotate_ended", "t": t, "reason": "released"}]
            return []

        cx, cy = frame.centre[0], frame.centre[1]
        first = r.anchor == (0.0, 0.0)
        # Measured from where the stillness began, not from the last frame, so a
        # hand that drifts slowly across the screen is still a moving hand.
        moved = 1.0 if first else math.dist((cx, cy), r.anchor)
        if moved > self.cfg.still_radius:
            r.anchor = (cx, cy)
            r.still_since = t
            if r.state == "turning":
                r.state = "still"
                return [{"type": "rotate_ended", "t": t, "reason": "moved"}]
            if r.state != "idle":
                r.state = "still"          # restarted: the stillness so far is void
            return []

        if r.state == "idle":
            r.state, r.still_since = "still", t
            r.last_tilt = frame.tilt
            return []

        if r.state == "still":
            if t - r.still_since >= self.cfg.still_s:
                r.state = "turning"
                r.last_tilt = frame.tilt
                r.last_emit = t
                return [{"type": "rotate_started", "t": t}]
            return []

        # turning
        if not self._due_hz(t, r.last_emit, self.cfg.rotate_hz):
            return []
        r.last_emit = t
        yaw, pitch = frame.tilt
        dyaw, dpitch = yaw - r.last_tilt[0], pitch - r.last_tilt[1]
        r.last_tilt = (yaw, pitch)
        if abs(dyaw) < 1e-4 and abs(dpitch) < 1e-4:
            return []
        return [{"type": "rotate_delta", "t": t,
                 "yaw": round(dyaw, 5), "pitch": round(dpitch, 5)}]

    def _scale_rule(self, a: HandFrame, b: HandFrame, t: float) -> list[dict]:
        """Two hands: move them apart or together to scale.

        The distance is measured in 3D, so bringing your hands toward the camera
        reads as closer even when they have not moved across the image.
        """
        s = self._scale
        gap = palm_distance(a, b)
        if not s.active:
            s.active, s.base = True, max(gap, 1e-6)
            s.last_emit = t
            return [{"type": "scale_started", "t": t, "factor": 1.0}]
        if not self._due_hz(t, s.last_emit, self.cfg.scale_hz):
            return []
        s.last_emit = t
        factor = gap / s.base if s.base > 1e-6 else 1.0
        # A dead band keeps a resting pair of hands from drifting the scale.
        if abs(factor - 1.0) < 0.004:
            return []
        return [{"type": "scale_delta", "t": t, "factor": round(factor, 4)}]

    def _clap_rule(self, frames: list[HandFrame], t: float) -> list[dict]:
        """Bring your palms together: centre it on stage."""
        if len(frames) < 2:
            self._clap = _Clap()
            return []
        c = self._clap
        gap = palm_distance(frames[0], frames[1])
        if c.last_gap is not None and c.last_t is not None:
            dt = max(t - c.last_t, 1e-6)
            speed = (c.last_gap - gap) / dt          # positive = closing
            if (speed >= self.cfg.clap_speed and gap <= self.cfg.clap_gap
                    and t >= c.cooled_until):
                c.cooled_until = t + self.cfg.clap_cooldown_s
                mid = ((frames[0].centre[0] + frames[1].centre[0]) / 2,
                       (frames[0].centre[1] + frames[1].centre[1]) / 2)
                c.last_gap, c.last_t = gap, t
                return [{"type": "clap", "t": t,
                         "x": round(mid[0], 4), "y": round(mid[1], 4)}]
        c.last_gap, c.last_t = gap, t
        return []

    def _claw_rule(self, frame: HandFrame, t: float) -> list[dict]:
        """Half-close the hand and pull: bring it toward you.

        This is the gesture that needs depth. Sliding sideways and pulling
        toward the camera look identical in x and y; only z separates them.
        """
        p = self._pull
        value = frame.claw
        if p.state == "open":
            if value >= self.cfg.claw_on:
                p.state, p.since = "clawed", t
        elif p.state == "clawed":
            if value < self.cfg.claw_off:
                p.state = "open"
            elif t - p.since >= self.cfg.claw_hold_s:
                p.state = "pulling"
                p.origin = frame.centre
                p.last_emit = t
                return [{"type": "pull_started", "t": t,
                         "z": round(frame.centre[2], 4)}]
        elif p.state == "pulling":
            if value < self.cfg.claw_off:
                p.state = "open"
                return [{"type": "pull_ended", "t": t}]
            if not self._due_hz(t, p.last_emit, self.cfg.pull_hz):
                return []
            p.last_emit = t
            cx, cy, cz = frame.centre
            ox, oy, oz = p.origin
            if abs(cz - oz) < 1e-4 and abs(cx - ox) < 1e-4 and abs(cy - oy) < 1e-4:
                return []
            return [{"type": "pull_delta", "t": t,
                     "dx": round(cx - ox, 4), "dy": round(cy - oy, 4),
                     "dz": round(cz - oz, 4)}]
        return []

    def _stage_of(self, frame: HandFrame) -> tuple[float, float]:
        """Where a whole-hand gesture sits on the stage, for the browser."""
        x, y = frame.centre[0], frame.centre[1]
        if self.cfg.mirror:
            x = 1.0 - x
        cx0, cy0, cx1, cy1 = self.cfg.calib
        sx = (x - cx0) / (cx1 - cx0) if cx1 > cx0 else x
        sy = (y - cy0) / (cy1 - cy0) if cy1 > cy0 else y
        return round(_clamp(sx), 4), round(_clamp(sy), 4)

    def _due_hz(self, t: float, last: float, hz: float) -> bool:
        return t - last >= (1.0 / hz) - 1e-6

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
