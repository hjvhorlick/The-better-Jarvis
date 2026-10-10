import random

from myhands.filters import OneEuroFilter
from myhands.gestures import Config, GestureEngine, Observation, SceneObject, pinch_ratio

DT = 1.0 / 30.0


def hand(index_x, index_y, pinch_gap, score=0.95):
    """Synthetic hand: hand scale 0.3 (wrist to middle base), thumb-index gap = pinch_gap * scale."""
    lm = [(0.5, 0.5, 0.0)] * 21
    lm[0] = (0.5, 0.9, 0.0)           # wrist
    lm[9] = (0.5, 0.6, 0.0)           # middle MCP -> scale 0.3
    lm[8] = (index_x, index_y, 0.0)   # index tip
    lm[4] = (index_x + pinch_gap * 0.3, index_y, 0.0)  # thumb tip
    return Observation(landmarks=tuple(lm), score=score)


def exact(**kw):
    """Config that effectively disables smoothing so positions can be asserted exactly."""
    base = dict(mirror=False, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0)
    base.update(kw)
    return Config(**base)


def run(engine, frames, t0=0.0):
    """frames: list of observation-lists, one per DT step. Returns all events."""
    events, t = [], t0
    for obs in frames:
        events += engine.update(obs, now=t)
        t += DT
    return events, t


def types(events):
    return [e["type"] for e in events]


# ---------- filter ----------

def test_one_euro_reduces_jitter_on_a_still_hand():
    rng = random.Random(1)
    raw = [0.5 + rng.uniform(-0.01, 0.01) for _ in range(300)]
    f = OneEuroFilter(min_cutoff=1.2, beta=0.01, d_cutoff=1.0)
    smooth = [f.apply(x, i * DT) for i, x in enumerate(raw)]

    def var(xs):
        m = sum(xs) / len(xs)
        return sum((x - m) ** 2 for x in xs) / len(xs)

    assert var(smooth[50:]) < var(raw[50:]) * 0.5


def test_one_euro_follows_fast_motion_without_much_lag():
    f = OneEuroFilter(min_cutoff=1.2, beta=0.5, d_cutoff=1.0)
    out = None
    for i in range(60):
        out = f.apply(float(i) * 0.05, i * DT)   # steady fast move
    assert abs(out - 59 * 0.05) < 0.1


# ---------- pinch measurement ----------

def test_pinch_ratio_is_scale_invariant():
    near = hand(0.5, 0.5, 0.2).landmarks
    # same hand, bigger on screen: scale doubles, gap doubles
    big = list(near)
    big[0] = (0.5, 0.8, 0)
    big[9] = (0.5, 0.2, 0)              # scale 0.6
    big[4] = (0.5 + 0.2 * 0.6, 0.5, 0)  # gap 0.2 * scale
    r1, _ = pinch_ratio(near)
    r2, _ = pinch_ratio(tuple(big))
    assert abs(r1 - r2) < 1e-6


def test_zero_scale_is_treated_as_open_hand():
    lm = [(0.5, 0.5, 0.0)] * 21
    assert pinch_ratio(lm)[0] == float("inf")


# ---------- pinch state machine ----------

def test_brief_touch_does_not_start_a_pinch():
    e = GestureEngine(exact())
    frames = [[hand(0.5, 0.5, 0.1)]] * 2 + [[hand(0.5, 0.5, 0.8)]] * 5   # ~66 ms touch
    events, _ = run(e, frames)
    assert "pinch_started" not in types(events)


def test_held_pinch_starts_and_hysteresis_keeps_it():
    e = GestureEngine(exact())
    frames = [[hand(0.5, 0.5, 0.1)]] * 8          # ~260 ms: starts
    frames += [[hand(0.5, 0.5, 0.38)]] * 10       # between on (0.30) and off (0.45): holds
    events, _ = run(e, frames)
    assert "pinch_started" in types(events)
    assert "pinch_released" not in types(events)


def test_release_needs_a_held_open_hand():
    e = GestureEngine(exact())
    frames = [[hand(0.5, 0.5, 0.1)]] * 8
    frames += [[hand(0.5, 0.5, 0.9)]] * 1         # one open frame: not a release
    frames += [[hand(0.5, 0.5, 0.1)]] * 3
    events, _ = run(e, frames)
    assert "pinch_released" not in types(events)


# ---------- grab, drag, release ----------

def test_grab_drag_release_leaves_object_where_it_was_dropped():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", x=0.2, y=0.2, w=0.2, h=0.2)])
    frames = [[hand(0.25, 0.25, 0.1)]] * 8                       # pinch on the card
    frames += [[hand(0.25 + i * 0.01, 0.25 + i * 0.008, 0.1)] for i in range(1, 21)]   # drag
    frames += [[hand(0.45, 0.41, 0.9)]] * 6                      # open: release
    events, _ = run(e, frames)
    kinds = types(events)
    assert kinds.count("object_grabbed") == 1
    assert "object_dragged" in kinds
    released = [ev for ev in events if ev["type"] == "object_released"][-1]
    assert released["reason"] == "release"
    last_drag = [ev for ev in events if ev["type"] == "object_dragged"][-1]
    assert (released["x"], released["y"]) == (last_drag["x"], last_drag["y"])
    assert e.grabbed_id is None


def test_pinch_on_empty_space_starts_no_grab():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", x=0.2, y=0.2, w=0.2, h=0.2)])
    events, _ = run(e, [[hand(0.9, 0.9, 0.1)]] * 8)
    assert "pinch_started" in types(events)
    assert "object_grabbed" not in types(events)


def test_topmost_object_is_grabbed_when_two_overlap():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("under", 0.2, 0.2, 0.3, 0.3, z=1),
                 SceneObject("over", 0.3, 0.3, 0.3, 0.3, z=5)])
    events, _ = run(e, [[hand(0.35, 0.35, 0.1)]] * 8)
    grabbed = [ev for ev in events if ev["type"] == "object_grabbed"]
    assert grabbed and grabbed[0]["id"] == "over"


def test_dragged_object_stays_inside_the_stage():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", x=0.7, y=0.7, w=0.2, h=0.2)])
    frames = [[hand(0.8, 0.8, 0.1)]] * 8 + [[hand(0.99, 0.99, 0.1)]] * 10
    events, _ = run(e, frames)
    last = [ev for ev in events if ev["type"] == "object_dragged"][-1]
    assert last["x"] <= 1.0 - 0.2 + 1e-9 and last["y"] <= 1.0 - 0.2 + 1e-9


# ---------- safety: tracking loss never leaves a grab behind ----------

def test_tracking_loss_releases_a_grab():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    frames = [[hand(0.25, 0.25, 0.1)]] * 8 + [[]] * 20    # ~0.66 s without a hand
    events, _ = run(e, frames)
    released = [ev for ev in events if ev["type"] == "object_released"]
    assert released and released[-1]["reason"] == "tracking_lost"
    assert "hand_lost" in types(events)
    assert e.grabbed_id is None


def test_short_dropout_keeps_the_grab():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    frames = [[hand(0.25, 0.25, 0.1)]] * 8 + [[]] * 3 + [[hand(0.3, 0.3, 0.1)]] * 3   # ~100 ms gap
    events, _ = run(e, frames)
    assert "object_released" not in types(events)
    assert e.grabbed_id == "card"


def test_low_confidence_counts_as_no_hand_and_is_reported():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    frames = [[hand(0.25, 0.25, 0.1)]] * 8 + [[hand(0.25, 0.25, 0.1, score=0.3)]] * 25
    events, _ = run(e, frames)
    kinds = types(events)
    assert "confidence_changed" in kinds
    assert any(ev.get("reason") == "tracking_lost" for ev in events if ev["type"] == "object_released")


def test_release_all_reports_the_given_reason():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    run(e, [[hand(0.25, 0.25, 0.1)]] * 8)
    events = e.release_all("camera_failed", now=10.0)
    released = [ev for ev in events if ev["type"] == "object_released"]
    assert released and released[0]["reason"] == "camera_failed"
    assert e.grabbed_id is None


# ---------- mapping and throttling ----------

def test_mirror_maps_the_camera_image_for_a_front_camera():
    e = GestureEngine(Config(mirror=True, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0))
    events, _ = run(e, [[hand(0.2, 0.5, 0.9)]])
    moved = [ev for ev in events if ev["type"] == "cursor_moved"][0]
    assert abs(moved["x"] - 0.8) < 1e-3


def test_calibration_rectangle_maps_a_corner_to_the_full_stage():
    e = GestureEngine(exact(calib=(0.25, 0.0, 0.75, 1.0)))
    events, _ = run(e, [[hand(0.5, 0.5, 0.9)]])
    moved = [ev for ev in events if ev["type"] == "cursor_moved"][0]
    assert abs(moved["x"] - 0.5) < 1e-3
    events, _ = run(e, [[hand(0.25, 0.5, 0.9)]], t0=5.0)
    moved = [ev for ev in events if ev["type"] == "cursor_moved"][0]
    assert abs(moved["x"] - 0.0) < 1e-3


def test_cursor_events_are_throttled_to_30_per_second():
    e = GestureEngine(exact(cursor_hz=30.0))
    frames = [[hand(0.5, 0.5, 0.9)]] * 300                    # 10 s at 30 fps
    events, _ = run(e, frames)
    cursor = [ev for ev in events if ev["type"] == "cursor_moved"]
    assert 280 <= len(cursor) <= 310


def test_tick_without_observations_applies_the_loss_grace_on_real_time():
    e = GestureEngine(exact())
    e.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    _, t_end = run(e, [[hand(0.25, 0.25, 0.1)]] * 8)       # grab; last hand seen at 7 * DT
    last_seen = 7 * DT
    assert e.grabbed_id == "card"
    assert e.tick(now=last_seen + 0.1) == []               # 100 ms: inside the grace
    events = e.tick(now=last_seen + 0.5)                   # 500 ms: lost
    assert [ev["type"] for ev in events if ev["type"] == "object_released"] == ["object_released"]
    assert e.grabbed_id is None and not e.hand_present


def test_tick_does_not_emit_confidence_changes():
    e = GestureEngine(exact())
    run(e, [[hand(0.5, 0.5, 0.9)]] * 3)
    events = e.tick(now=1.0)
    assert "confidence_changed" not in types(events)
