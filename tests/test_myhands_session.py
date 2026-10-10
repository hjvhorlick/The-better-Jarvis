import time

from myhands.camera import CameraService, CameraState
from myhands.gestures import Config, GestureEngine, Observation, SceneObject
from myhands.session import MyHandsSession


def hand(index_x, index_y, pinch_gap, score=0.95):
    lm = [(0.5, 0.5, 0.0)] * 21
    lm[0] = (0.5, 0.9, 0.0)
    lm[9] = (0.5, 0.6, 0.0)
    lm[8] = (index_x, index_y, 0.0)
    lm[4] = (index_x + pinch_gap * 0.3, index_y, 0.0)
    return Observation(landmarks=tuple(lm), score=score)


class ScriptedSource:
    """Camera device that yields a frame each read. Frame value = tick index."""

    def __init__(self):
        self.n = 0

    def open(self):
        return True

    def read(self):
        self.n += 1
        return True, self.n

    def close(self):
        pass


class ScriptedTracker:
    """Returns the observations scripted for each frame number (1-based)."""

    def __init__(self, script):
        self.script = script
        self.closed = False

    def process(self, frame):
        return self.script(frame)

    def close(self):
        self.closed = True


def wait_for(pred, timeout=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.02)
    return False

def wait_stopped(s, timeout=5.0):
    """Wait until the session has written session_stopped and its thread has finished."""
    ok = wait_for(lambda: any(e["type"] == "session_stopped" for _, e in s.events_after(0)), timeout)
    if s._thread is not None:
        s._thread.join(timeout)
    return ok



def kinds(session, after=0):
    return [e["type"] for _, e in session.events_after(after)]


def test_session_grabs_then_releases_on_user_stop():
    cfg = Config(mirror=False, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0)
    engine = GestureEngine(cfg)
    # frames 1-15: pinch on the card; 16+: pinch held, moving; never released
    def script(n):
        if n <= 15:
            return [hand(0.25, 0.25, 0.1)]
        return [hand(0.25 + (n - 15) * 0.01, 0.25, 0.1)]
    tracker = ScriptedTracker(script)
    cam = CameraService(ScriptedSource, stall_s=5.0)
    s = MyHandsSession(cam, lambda: tracker, engine=engine, loop_interval_s=0.005, idle_off_s=600)
    s.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    s.start()
    assert wait_for(lambda: "object_dragged" in kinds(s))
    s.stop("user")
    assert wait_stopped(s)
    ks = kinds(s)
    assert "object_grabbed" in ks
    released = [e for _, e in s.events_after(0) if e["type"] == "object_released"]
    assert released and released[-1]["reason"] == "session_stopped"   # never left grabbed
    assert "session_stopped" in ks
    assert tracker.closed is True
    assert cam.state.value == "stopped"


def test_idle_timeout_stops_the_session_with_auto_off():
    tracker = ScriptedTracker(lambda n: [])        # never a hand
    cam = CameraService(ScriptedSource, stall_s=5.0)
    s = MyHandsSession(cam, lambda: tracker, loop_interval_s=0.005, idle_off_s=0.3)
    s.start()
    assert wait_stopped(s)
    ks = kinds(s)
    assert "auto_off" in ks
    stopped = [e for _, e in s.events_after(0) if e["type"] == "session_stopped"][-1]
    assert stopped["reason"] == "auto_off"


def test_camera_that_cannot_open_ends_the_session_with_an_event():
    class Dead:
        def open(self):
            return False

        def read(self):
            return False, None

        def close(self):
            pass

    cam = CameraService(Dead, stall_s=5.0, max_open_attempts=2, backoff_s=(0.01,))
    tracker = ScriptedTracker(lambda n: [])
    s = MyHandsSession(cam, lambda: tracker, loop_interval_s=0.005, idle_off_s=600)
    s.start()
    assert wait_stopped(s)
    ks = kinds(s)
    assert "tracking_unavailable" in ks
    stopped = [e for _, e in s.events_after(0) if e["type"] == "session_stopped"][-1]
    assert stopped["reason"] == "camera_failed"


def test_status_reports_camera_and_hand_state():
    tracker = ScriptedTracker(lambda n: [hand(0.5, 0.5, 0.9)])
    cam = CameraService(ScriptedSource, stall_s=5.0)
    s = MyHandsSession(cam, lambda: tracker, loop_interval_s=0.005, idle_off_s=600)
    assert s.status()["running"] is False
    s.start()
    assert wait_for(lambda: s.status()["hand_present"])
    st = s.status()
    assert st["running"] is True and st["camera_on"] is True
    assert st["camera"]["state"] in ("active", "connecting")
    s.stop("user")
    assert wait_stopped(s)
    assert s.status()["camera_on"] is False


def test_double_start_is_a_no_op():
    tracker = ScriptedTracker(lambda n: [])
    cam = CameraService(ScriptedSource, stall_s=5.0)
    s = MyHandsSession(cam, lambda: tracker, loop_interval_s=0.005, idle_off_s=600)
    s.start()
    s.start()
    seqs = [e["type"] for _, e in s.events_after(0)]
    assert seqs.count("session_started") == 1
    s.stop("user")
    assert wait_stopped(s)


class StallingSource:
    """Delivers frames for the first `good_reads` reads, then stops delivering."""
    good_reads = 60
    reads = 0

    def open(self):
        return True

    def read(self):
        StallingSource.reads += 1
        if StallingSource.reads <= StallingSource.good_reads:
            return True, StallingSource.reads
        return False, None

    def close(self):
        pass


def test_camera_stall_drops_the_grab_within_the_grace_period():
    StallingSource.reads = 0
    cfg = Config(mirror=False, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0)
    engine = GestureEngine(cfg)
    tracker = ScriptedTracker(lambda n: [hand(0.25, 0.25, 0.1)])
    cam = CameraService(StallingSource, stall_s=0.3, backoff_s=(0.05,), max_reconnects=1000)
    s = MyHandsSession(cam, lambda: tracker, engine=engine, loop_interval_s=0.005, idle_off_s=600)
    s.set_scene([SceneObject("card", 0.2, 0.2, 0.2, 0.2)])
    s.start()
    assert wait_for(lambda: any(e["type"] == "object_released" for _, e in s.events_after(0)), timeout=8.0)
    released = [e for _, e in s.events_after(0) if e["type"] == "object_released"][0]
    assert released["reason"] == "tracking_lost"
    unavailable = [k for k in kinds(s) if k == "tracking_unavailable"]
    assert len(unavailable) == 1                  # one event per outage, not one per reconnect
    s.stop("user")
    assert wait_stopped(s)


def test_reconnect_flapping_emits_one_event_per_outage():
    class Flapping(StallingSource):
        good_reads = 60

    StallingSource.reads = 0
    tracker = ScriptedTracker(lambda n: [])
    cam = CameraService(Flapping, stall_s=0.2, backoff_s=(0.02,), max_reconnects=1000)
    s = MyHandsSession(cam, lambda: tracker, loop_interval_s=0.005, idle_off_s=600)
    s.start()
    assert wait_for(lambda: cam.status()["reconnects"] >= 4, timeout=8.0)
    assert kinds(s).count("tracking_unavailable") == 1
    s.stop("user")
    assert wait_stopped(s)


def test_missing_tracking_library_stops_with_a_clear_reason():
    def no_mediapipe():
        raise ModuleNotFoundError("No module named 'mediapipe'")

    cam = CameraService(ScriptedSource, stall_s=5.0)
    s = MyHandsSession(cam, no_mediapipe, loop_interval_s=0.005, idle_off_s=600)
    s.start()
    assert wait_stopped(s)
    evs = [e for _, e in s.events_after(0)]
    unavailable = [e for e in evs if e["type"] == "tracking_unavailable"]
    assert unavailable and "requirements-myhands.txt" in unavailable[0]["reason"]
    stopped = [e for e in evs if e["type"] == "session_stopped"][-1]
    assert stopped["reason"] == "tracker_failed"
    assert cam.state == CameraState.STOPPED            # camera released even though tracking never started
