"""Reading a whole hand: every landmark, depth kept.

The engine used to read four points — wrist, thumb tip, index tip, one knuckle —
and threw the other seventeen away, depth included. That is why it could only
ever pinch. This module reads all twenty-one, and keeps z, because that is where
the information actually lives:

  · the palm centroid moves far more smoothly than any fingertip, so a cursor
    built on it leads the hand instead of trailing it;
  · a finger curling is a signal that rises, not a threshold that snaps, so a
    grab can be anticipated rather than detected late;
  · the tilt of the whole hand is computable only across many points, and tilt
    is the only thing that can *turn* an object rather than slide it;
  · depth separates "reaching for it" from "pulling it toward me".

Everything here is a pure function of the landmarks, so it is testable without
a camera. Degenerate input — every landmark in the same place, which is what a
synthetic hand looks like — is answered with zeros rather than a crash.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# MediaPipe Hands landmark indices, in the order the model emits them.
WRIST = 0
THUMB_CMC, THUMB_MCP, THUMB_IP, THUMB_TIP = 1, 2, 3, 4
INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP = 5, 6, 7, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP = 9, 10, 11, 12
RING_MCP, RING_PIP, RING_DIP, RING_TIP = 13, 14, 15, 16
PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP = 17, 18, 19, 20

# Each finger as (base, middle joint, tip). The angle at the middle joint is the
# curl: straight is 180 degrees, closed is near 40.
FINGERS = {
    "thumb": (THUMB_CMC, THUMB_MCP, THUMB_TIP),
    "index": (INDEX_MCP, INDEX_PIP, INDEX_TIP),
    "middle": (MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP),
    "ring": (RING_MCP, RING_PIP, RING_TIP),
    "pinky": (PINKY_MCP, PINKY_PIP, PINKY_TIP),
}
FOUR_FINGERS = ("index", "middle", "ring", "pinky")


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _norm(a):
    return math.sqrt(_dot(a, a))


def _unit(a):
    n = _norm(a)
    if n <= 1e-9:
        return (0.0, 0.0, 0.0)
    return (a[0] / n, a[1] / n, a[2] / n)


def _angle_deg(at, to_a, to_b):
    """Angle at `at`, between the rays to `to_a` and `to_b`. 180 = straight."""
    u, v = _unit(_sub(to_a, at)), _unit(_sub(to_b, at))
    if u == (0.0, 0.0, 0.0) or v == (0.0, 0.0, 0.0):
        return 180.0                      # cannot tell: treat as open
    c = max(-1.0, min(1.0, _dot(u, v)))
    return math.degrees(math.acos(c))


@dataclass(frozen=True)
class HandFrame:
    """Everything readable about one whole hand in one frame."""

    landmarks: tuple                       # the raw 21 x (x, y, z), untouched
    centre: tuple = (0.0, 0.0, 0.0)        # palm centroid, all 21 points
    normal: tuple = (0.0, 0.0, 1.0)        # unit palm normal
    direction: tuple = (0.0, -1.0, 0.0)    # unit wrist -> middle base
    scale: float = 0.0                     # wrist -> middle base, 3D
    curl: dict = field(default_factory=dict)
    spread: float = 0.0                    # fingers apart, 0..1
    depth: float = 0.0                     # z of the wrist
    depth_spread: float = 0.0              # how much of the hand is nearer/further

    @property
    def fist(self) -> float:
        """0 = open hand, 1 = closed fist. The four fingers; the thumb is free
        so a thumbs-up is not read as a fist."""
        if not self.curl:
            return 0.0
        return sum(self.curl[f] for f in FOUR_FINGERS) / len(FOUR_FINGERS)

    @property
    def pinch(self) -> float:
        """0 = thumb and index together, 1 = wide apart. Scale-invariant."""
        gap = _norm(_sub(self.landmarks[THUMB_TIP], self.landmarks[INDEX_TIP]))
        if self.scale <= 1e-6:
            return 1.0
        return min(1.0, gap / (self.scale * 0.55))

    @property
    def claw(self) -> float:
        """0 = not a claw, 1 = a held claw: fingers half-curled and spread."""
        if not self.curl:
            return 0.0
        half = all(0.22 <= self.curl[f] <= 0.78 for f in FOUR_FINGERS)
        return self.spread if half else 0.0

    @property
    def tilt(self) -> tuple:
        """(yaw, pitch) in radians, from the palm normal.

        Yaw is which way the palm faces across the image; pitch is up or down.
        Both are what *turns* an object, and neither can be read from two
        fingertips.
        """
        nx, ny, nz = self.normal
        # Guard a hand turned edge-on to the camera, where the normal lies in
        # the image plane and the ratio would explode.
        nz = nz if abs(nz) > 0.30 else (0.30 if nz >= 0 else -0.30)
        return (math.atan2(nx, abs(nz)), math.atan2(ny, abs(nz)))


def read_hand(landmarks) -> HandFrame:
    """Build a HandFrame from 21 x (x, y, z). Safe on degenerate input."""
    lm = tuple(tuple(float(v) for v in p) for p in landmarks)
    if len(lm) < 21:
        lm = lm + ((0.0, 0.0, 0.0),) * (21 - len(lm))

    centre = (
        sum(p[0] for p in lm) / 21.0,
        sum(p[1] for p in lm) / 21.0,
        sum(p[2] for p in lm) / 21.0,
    )

    # Palm plane: wrist, index base, pinky base. These three never move much,
    # so the plane is stable even while the fingers are busy.
    v1 = _sub(lm[INDEX_MCP], lm[WRIST])
    v2 = _sub(lm[PINKY_MCP], lm[WRIST])
    normal = _unit(_cross(v1, v2))
    if normal == (0.0, 0.0, 0.0):
        normal = (0.0, 0.0, 1.0)
    # Face the camera: a front camera sees the back of the hand, so the normal
    # comes out pointing away. Flipping it here means "palm toward you" is
    # always positive z, whichever way round the tracker reports it.
    if normal[2] < 0:
        normal = (-normal[0], -normal[1], -normal[2])

    direction = _unit(_sub(lm[MIDDLE_MCP], lm[WRIST]))
    if direction == (0.0, 0.0, 0.0):
        direction = (0.0, -1.0, 0.0)

    scale = _norm(_sub(lm[MIDDLE_MCP], lm[WRIST]))

    curl = {}
    for name, (base, joint, tip) in FINGERS.items():
        deg = _angle_deg(lm[joint], lm[base], lm[tip])
        # 180 degrees straight -> 0; 40 degrees closed -> 1.
        curl[name] = max(0.0, min(1.0, (180.0 - deg) / 140.0))

    # Spread: how far the fingertips sit from the line through the palm, as a
    # fraction of hand size. A flat hand spreads wide; a fist has none.
    tips = [lm[FINGERS[f][2]] for f in FOUR_FINGERS]
    if scale > 1e-6:
        span = max(
            _norm(_sub(tips[i], tips[j]))
            for i in range(len(tips)) for j in range(i + 1, len(tips))
        )
        spread = max(0.0, min(1.0, (span / (scale * 2.6)) - 0.25) / 0.75)
    else:
        spread = 0.0

    zs = [p[2] for p in lm]
    depth = lm[WRIST][2]
    depth_spread = (max(zs) - min(zs)) if zs else 0.0

    return HandFrame(
        landmarks=lm, centre=centre, normal=normal, direction=direction,
        scale=scale, curl=curl, spread=spread, depth=depth,
        depth_spread=depth_spread,
    )


def palm_distance(a: HandFrame, b: HandFrame) -> float:
    """3D distance between two palms. Uses depth, so a hand nearer the camera
    reads as nearer even when it has not moved across the image."""
    return _norm(_sub(a.centre, b.centre))
