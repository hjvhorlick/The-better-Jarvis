"""The whole hand: reading all 21 landmarks, and the gestures that need them.

The old engine read four points and threw the rest away, which is why it could
only ever pinch. These tests pin down the parts that need the whole hand:

  · a fist is read from the curl of four fingers, not a fingertip gap
  · holding still turns an object, and the turn is driven by the palm's tilt
  · two hands scale, measured in 3D so depth counts
  · a clap is two palms closing fast
  · a claw pulls toward you, which only depth can tell from a sideways slide

Every hand here is built from real geometry, so the numbers mean something.
"""
import math
import time

import pytest

from myhands.gestures import Config, GestureEngine, Observation, SceneObject
from myhands.handframe import WRIST, HandFrame, palm_distance, read_hand

DT = 1.0 / 30.0


# ---------- building hands with real geometry ----------

def _mcp_positions():
    return {
        "thumb": (0.34, 0.74, 0.0),
        "index": (0.42, 0.62, 0.0),
        "middle": (0.50, 0.60, 0.0),
        "ring": (0.58, 0.62, 0.0),
        "pinky": (0.64, 0.66, 0.0),
    }


_FINGER_BASE = {"thumb": 1, "index": 5, "middle": 9, "ring": 13, "pinky": 17}


def build_hand(curl=0.0, spread=0.0, label="Right", score=0.95):
    """A 21-landmark hand with real geometry.

    `curl` 0 = every finger straight, 1 = every finger folded right over. It is
    placed by aiming the fingertip at an exact angle at the middle joint, so the
    curl the engine reads back is the curl asked for.
    `spread` 0 = fingers together, 1 = fanned wide.
    """
    lm = [(0.5, 0.9, 0.0)] * 21                     # everything defaults to the wrist
    lm[WRIST] = (0.5, 0.9, 0.0)
    reach = 0.17

    for name, (cx, cy, cz) in _mcp_positions().items():
        base = _FINGER_BASE[name]
        # The angle at the middle joint: 180 degrees is straight, 40 is folded.
        theta = math.radians(180.0 - 140.0 * curl)
        a = reach * 0.45                            # base -> middle joint
        d = reach * 0.55                            # middle joint -> tip
        pip = (cx, cy - a, cz)
        # Rotating the "down toward the wrist" direction by theta aims the tip.
        tip = (pip[0] - d * math.sin(theta), pip[1] + d * math.cos(theta), cz)
        # The far joint sits on the way to the tip.
        dip = (pip[0] + (tip[0] - pip[0]) * 0.6, pip[1] + (tip[1] - pip[1]) * 0.6, cz)

        lm[base + 0] = (cx, cy, cz)
        lm[base + 1] = pip
        lm[base + 2] = dip
        lm[base + 3] = tip

        # Spread fans the whole finger sideways, away from the hand's middle.
        if spread:
            fan = (spread - 0.5) * 0.30
            side = 1.0 if cx >= 0.5 else -1.0
            for i in range(4):
                x, y, z = lm[base + i]
                lm[base + i] = (x + fan * side * (i / 3.0), y, z)

    return Observation(landmarks=tuple(lm), score=score, label=label)


def tilt_about_centre(hand, yaw_deg=0.0, pitch_deg=0.0):
    """Turn a hand about its own centroid: it stays in the same place on screen
    but faces a different way. Yaw is a turn about the vertical axis, pitch
    about the horizontal — the two things that change the palm's normal."""
    lm = list(hand.landmarks)
    cx = sum(p[0] for p in lm) / 21.0
    cy = sum(p[1] for p in lm) / 21.0
    cz = sum(p[2] for p in lm) / 21.0
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    cyaw, syaw = math.cos(yaw), math.sin(yaw)
    cpit, spit = math.cos(pitch), math.sin(pitch)
    out = []
    for x, y, z in lm:
        dx, dy, dz = x - cx, y - cy, z - cz
        # yaw about the vertical (y) axis, then pitch about the horizontal (x)
        nx = dx * cyaw + dz * syaw
        nz = -dx * syaw + dz * cyaw
        ny = dy * cpit - nz * spit
        nz = dy * spit + nz * cpit
        out.append((cx + nx, cy + ny, cz + nz))
    return Observation(landmarks=tuple(out), score=hand.score, label=hand.label)


def exact(**kw):
    base = dict(mirror=False, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0)
    base.update(kw)
    return Config(**base)


def run(engine, frames, t0=0.0):
    events, t = [], t0
    for obs in frames:
        events += engine.update(obs, now=t)
        t += DT
    return events, t


def types(events):
    return [e["type"] for e in events]


# ---------- reading a whole hand ----------

def test_a_flat_hand_reads_as_open():
    f = read_hand(build_hand(curl=0.0).landmarks)
    assert f.fist < 0.15
    assert f.curl["index"] < 0.2 and f.curl["middle"] < 0.2
    assert f.scale > 0.25                       # wrist to middle base is real
    assert f.normal[2] > 0.9                    # palm faces the camera
    assert f.claw < 0.2


def test_a_closed_hand_reads_as_a_fist():
    f = read_hand(build_hand(curl=1.0).landmarks)
    assert f.fist > 0.8
    for finger in ("index", "middle", "ring", "pinky"):
        assert f.curl[finger] > 0.7, finger


def test_curl_rises_smoothly_rather_than_snapping():
    """A grab can be anticipated: the signal climbs, it does not jump."""
    values = [read_hand(build_hand(curl=c).landmarks).fist for c in (0.0, 0.25, 0.5, 0.75, 1.0)]
    assert values == sorted(values), values
    assert all(b > a for a, b in zip(values, values[1:])), values


def test_a_half_closed_spread_hand_reads_as_a_claw():
    f = read_hand(build_hand(curl=0.5, spread=0.8).landmarks)
    assert f.claw > 0.3
    # A flat hand and a fist are not claws.
    assert read_hand(build_hand(curl=0.0, spread=0.8).landmarks).claw < 0.2
    assert read_hand(build_hand(curl=1.0, spread=0.0).landmarks).claw < 0.2


def test_the_palm_normal_tells_which_way_the_hand_faces():
    flat = read_hand(build_hand().landmarks)
    assert abs(flat.tilt[0]) < 0.05 and abs(flat.tilt[1]) < 0.05

    turned = read_hand(tilt_about_centre(build_hand(), yaw_deg=35).landmarks)
    assert turned.tilt[0] > 0.4, turned.tilt     # yawed to one side

    raised = read_hand(tilt_about_centre(build_hand(), pitch_deg=30).landmarks)
    assert abs(raised.tilt[1]) > 0.3, raised.tilt


def test_a_turned_hand_still_reports_a_sane_normal():
    """Edge-on to the camera must not produce nonsense."""
    edge = read_hand(tilt_about_centre(build_hand(), pitch_deg=85).landmarks)
    assert math.isfinite(edge.tilt[0]) and math.isfinite(edge.tilt[1])
    assert abs(edge.tilt[1]) <= math.pi / 2 + 1e-6


def test_depth_is_kept_not_thrown_away():
    near = read_hand(build_hand().landmarks)
    lm = list(build_hand().landmarks)
    lm = [(x, y, z - 0.05) for (x, y, z) in lm]
    far = read_hand(tuple(lm))
    assert far.depth < near.depth                 # nearer the camera reads lower

    # A hand turned in space has landmarks at genuinely different depths.
    turned = read_hand(tilt_about_centre(build_hand(), yaw_deg=40).landmarks)
    assert turned.depth_spread > 0.05, turned.depth_spread


def test_a_degenerate_hand_is_answered_not_crashed():
    """Every landmark in one place: say "open hand", do not divide by zero."""
    f = read_hand([(0.5, 0.5, 0.0)] * 21)
    assert isinstance(f, HandFrame)
    assert f.fist == 0.0 and f.claw == 0.0
    assert f.pinch == 1.0
    assert math.isfinite(f.tilt[0]) and math.isfinite(f.tilt[1])


def test_two_palms_are_measured_in_three_dimensions():
    a = read_hand(build_hand(label="Left").landmarks)
    b = read_hand(build_hand(label="Right").landmarks)
    same_plane = palm_distance(a, b)
    # Same picture, but one hand is nearer the camera: the 3D distance grows.
    lm = [(x, y, z - 0.2) for (x, y, z) in b.landmarks]
    nearer = palm_distance(a, read_hand(tuple(lm)))
    assert nearer > same_plane + 0.15


# ---------- the fist ----------

def test_a_held_fist_grabs_and_letting_go_releases():
    e = GestureEngine(exact())
    frames = [[build_hand(curl=0.0)]] * 5 + [[build_hand(curl=1.0)]] * 12
    events, _ = run(e, frames)
    assert "fist_started" in types(events)
    grab = [ev for ev in events if ev["type"] == "fist_started"][0]
    assert 0.0 <= grab["x"] <= 1.0 and 0.0 <= grab["y"] <= 1.0
    assert grab["strength"] > 0.7

    events2, _ = run(e, [[build_hand(curl=0.0)]] * 6, t0=1.0)
    assert "fist_released" in types(events2)


def test_a_twitch_of_the_hand_is_not_a_fist():
    e = GestureEngine(exact())
    frames = [[build_hand(curl=1.0)]] * 2 + [[build_hand(curl=0.0)]] * 8
    events, _ = run(e, frames)
    assert "fist_started" not in types(events)


# ---------- hold still, then turn ----------

def test_holding_still_starts_a_turn_and_tilting_drives_it():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("model", 0.3, 0.3, 0.4, 0.4)])

    # Close the fist over the model and keep the hand in the same place.
    frames = [[build_hand(curl=0.0)]] * 3
    frames += [[build_hand(curl=1.0)]] * int(1.4 / DT)
    events, t = run(e, frames)
    assert "fist_started" in types(events)
    assert "rotate_started" in types(events), types(events)

    # Now tilt the hand about its own centre: it has not moved, only turned.
    frames = [[tilt_about_centre(build_hand(curl=1.0), yaw_deg=12)]] * 6
    events2, _ = run(e, frames, t0=t)
    deltas = [ev for ev in events2 if ev["type"] == "rotate_delta"]
    assert deltas, "tilting a held-still hand must turn the object"
    assert any(d["yaw"] > 0 for d in deltas)

    # Letting go ends the turn.
    events3, _ = run(e, [[build_hand(curl=0.0)]] * 6, t0=t + 1.0)
    assert "fist_released" in types(events3)
    assert "rotate_ended" in types(events3)


def test_a_moving_hand_never_starts_a_turn():
    e = GestureEngine(exact())
    # A closed fist that slides across the screen from the first frame on.
    # It moves slowly, 0.01 a frame, which is the case a naive "distance from
    # the last frame" test would wrongly call still.
    shifted = []
    for i in range(60):
        lm = [(x + i * 0.01, y, z) for (x, y, z) in build_hand(curl=1.0).landmarks]
        shifted.append([Observation(landmarks=tuple(lm), score=0.95, label="Right")])
    events, _ = run(e, shifted)
    assert "fist_started" in types(events)
    assert "rotate_started" not in types(events)


# ---------- two hands ----------

def _two_hands(gap=0.5, dz=0.0, curl=0.0):
    """A left and a right hand `gap` apart, measured palm to palm in 3D."""
    left = build_hand(curl=curl, label="Left")
    right = build_hand(curl=curl, label="Right")
    half = gap / 2.0
    lm_l = [(x - half, y, z) for (x, y, z) in left.landmarks]
    lm_r = [(x + half, y, z - dz) for (x, y, z) in right.landmarks]
    return [Observation(landmarks=tuple(lm_l), score=0.95, label="Left"),
            Observation(landmarks=tuple(lm_r), score=0.95, label="Right")]


def test_two_hands_scale_and_one_hand_leaving_ends_it():
    e = GestureEngine(exact())
    frames = [_two_hands(gap=0.5)] * 6
    events, t = run(e, frames)
    assert "scale_started" in types(events)

    # Move the hands apart: the scale must grow.
    frames = [_two_hands(gap=0.75)] * 6
    events2, _ = run(e, frames, t0=t)
    deltas = [ev for ev in events2 if ev["type"] == "scale_delta"]
    assert deltas and deltas[-1]["factor"] > 1.15, deltas

    # One hand leaves: scaling stops.
    events3, _ = run(e, [[build_hand(label="Left")]] * 4, t0=t + 1.0)
    assert "scale_ended" in types(events3)


def test_scaling_reads_depth_not_just_the_picture():
    """Two hands held the same distance apart on screen, but one moves nearer
    the camera: that is a real change of distance, and it must register."""
    e = GestureEngine(exact())
    _, t = run(e, [_two_hands()] * 6)
    events, _ = run(e, [_two_hands(dz=0.25)] * 8, t0=t)
    deltas = [ev for ev in events if ev["type"] == "scale_delta"]
    assert deltas and deltas[-1]["factor"] > 1.1, deltas


def test_two_hands_are_kept_apart_by_their_label():
    """Swapping which hand is left must not be read as the hands crossing."""
    e = GestureEngine(exact())
    a = [Observation(landmarks=build_hand(label="Left").landmarks, score=0.9, label="Left"),
         Observation(landmarks=build_hand(label="Right").landmarks, score=0.9, label="Right")]
    frames = [a] * 4
    b = [Observation(landmarks=build_hand(label="Right").landmarks, score=0.9, label="Right"),
         Observation(landmarks=build_hand(label="Left").landmarks, score=0.9, label="Left")]
    events, _ = run(e, frames + [b] * 4)
    assert len(e.frames) == 2
    assert set(e.frames) == {"Left", "Right"}


# ---------- clap ----------

def test_a_clap_centres_the_stage():
    e = GestureEngine(exact())
    far = [_two_hands(gap=0.55)] * 8
    near = [_two_hands(gap=0.08)] * 3          # palms slam together
    events, t = run(e, far)
    events2, _ = run(e, near, t0=t)
    claps = [ev for ev in events2 if ev["type"] == "clap"]
    assert claps, types(events2)
    assert 0.0 <= claps[0]["x"] <= 1.0


def test_a_clap_is_not_repeated_while_the_hands_stay_together():
    e = GestureEngine(exact())
    frames = [_two_hands(gap=0.55)] * 6 + [_two_hands(gap=0.08)] * 20
    events, _ = run(e, frames)
    assert types(events).count("clap") == 1


# ---------- claw and pull ----------

def test_a_claw_pulls_toward_the_camera():
    e = GestureEngine(exact())
    events, t = run(e, [[build_hand(curl=0.5, spread=0.8)]] * int(0.4 / DT))
    assert "pull_started" in types(events), types(events)

    # Now move the hand nearer the camera without moving it on screen.
    pulled = []
    for i in range(6):
        lm = [(x, y, z - i * 0.02) for (x, y, z) in build_hand(curl=0.5, spread=0.8).landmarks]
        pulled.append([Observation(landmarks=tuple(lm), score=0.95, label="Right")])
    events2, _ = run(e, pulled, t0=t + 0.5)
    deltas = [ev for ev in events2 if ev["type"] == "pull_delta"]
    assert deltas, "moving a clawed hand nearer the camera must pull"
    assert all(d["dz"] < 0 for d in deltas), deltas   # nearer = lower z

    events3, _ = run(e, [[build_hand(curl=0.0)]] * 6, t0=t + 1.2)
    assert "pull_ended" in types(events3)


# ---------- safety ----------

def test_losing_the_camera_ends_every_whole_hand_gesture():
    """Whatever the camera was doing, stopping it must leave nothing half on."""
    # A fist held still over the model, turning.
    e = GestureEngine(exact())
    e.set_scene([SceneObject("model", 0.3, 0.3, 0.4, 0.4)])
    run(e, [[build_hand(curl=1.0)]] * int(1.4 / DT))
    assert e.turning
    kinds = types(e.release_all("camera_failed", now=50.0))
    assert "fist_released" in kinds
    assert "rotate_ended" in kinds
    assert not e.turning and e.frames == {}

    # Two hands scaling.
    e2 = GestureEngine(exact())
    run(e2, [_two_hands()] * 6)
    assert "scale_ended" in types(e2.release_all("camera_failed", now=50.0))

    # A claw pulling toward the camera.
    e3 = GestureEngine(exact())
    run(e3, [[build_hand(curl=0.5, spread=0.8)]] * int(0.4 / DT))
    assert "pull_ended" in types(e3.release_all("camera_failed", now=50.0))


def test_tick_between_frames_starts_no_gesture():
    # Time passing on its own may notice a lost hand, but it invents nothing.
    e = GestureEngine(exact())
    run(e, [[build_hand(curl=1.0)]] * 3)
    assert e.tick(now=0.2) == []
    # Well past the grace period it reports the loss, and nothing else.
    assert types(e.tick(now=5.0)) == ["hand_lost"]


@pytest.mark.parametrize("curl", [0.0, 0.3, 0.6, 1.0])
def test_every_curl_reads_without_crashing(curl):
    f = read_hand(build_hand(curl=curl, spread=0.5).landmarks)
    assert 0.0 <= f.fist <= 1.0
    assert all(0.0 <= v <= 1.0 for v in f.curl.values())
    assert 0.0 <= f.spread <= 1.0
    assert all(math.isfinite(v) for v in f.centre + f.normal + f.direction)


# ---------- the gestures reach the outside world ----------

class _FakeSource:
    """A camera that hands out one frame per read."""

    def open(self):
        return True

    def read(self):
        return True, 1

    def close(self):
        pass


class _FakeTracker:
    """Hands back the observations scripted for each call."""

    def __init__(self, frames):
        self.frames = frames
        self.i = 0

    def process(self, frame):
        obs = self.frames[min(self.i, len(self.frames) - 1)]
        self.i += 1
        return obs

    def close(self):
        pass


def test_the_whole_hand_gestures_reach_the_event_bus():
    """A real session, camera to tracker to engine to bus: the new gestures must
    come out the far end, not stop inside the engine."""
    from myhands.session import MyHandsSession

    # A fist held still for long enough to start turning.
    frames = [[build_hand(curl=1.0, label="Right")]] * 200
    tick = [0.0]

    def clock():
        tick[0] += 1.0 / 30.0
        return tick[0]

    session = MyHandsSession(
        camera=ScriptedCamera(),
        tracker_factory=lambda: _FakeTracker(frames),
        engine=GestureEngine(Config(mirror=False, smooth_min_cutoff=1000.0,
                                    smooth_beta=0.0, smooth_d_cutoff=1000.0)),
        clock=clock,
        loop_interval_s=0.001,
    )
    session.start()
    try:
        ok = False
        for _ in range(300):
            kinds = {e["type"] for _, e in session.events_after(0)}
            if {"fist_started", "rotate_started"} <= kinds:
                ok = True
                break
            time.sleep(0.02)
        assert ok, "the fist and the hold-still turn never reached the bus"
        # And the status says how many hands are being read.
        assert session.status()["hands_read"] == 1
    finally:
        session.stop(reason="user")


class ScriptedCamera:
    """The smallest camera the session will accept. Every frame is new, which is
    what makes the session hand it to the tracker rather than just tick."""

    def __init__(self):
        self.state = None
        self.n = 0

    def start(self):
        return True

    def stop(self):
        return True

    def get_frame(self):
        self.n += 1
        return (None, self.n)

    def status(self):
        return {"state": "running", "message": ""}
