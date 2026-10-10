from myhands.camera import CameraService, CameraState


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeSource:
    """Scriptable device. open_ok/read_ok are callables returning bool."""

    instances = []

    def __init__(self, world):
        self.world = world
        self.closed = False
        world["opens"] += 1
        FakeSource.instances.append(self)

    def open(self):
        return self.world["open_ok"]()

    def read(self):
        ok = self.world["read_ok"]()
        return ok, ("frame-%d" % self.world["opens"]) if ok else None

    def close(self):
        self.closed = True
        self.world["closes"] += 1


def make(world, clock, **kw):
    FakeSource.instances = []
    return CameraService(lambda: FakeSource(world), clock=clock, **kw)


def world(open_ok=lambda: True, read_ok=lambda: True):
    return {"open_ok": open_ok, "read_ok": read_ok, "opens": 0, "closes": 0}


def tick(cam, clock, seconds, step=0.1):
    t = 0.0
    while t < seconds:
        clock.t += step
        cam.step()
        t += step


def test_becomes_active_and_serves_frames():
    clock, w = FakeClock(), world()
    cam = make(w, clock)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 0.5)
    assert cam.state == CameraState.ACTIVE
    frame, seq = cam.get_frame()
    assert frame.startswith("frame-") and seq >= 1


def test_only_one_handle_is_opened_while_active():
    clock, w = FakeClock(), world()
    cam = make(w, clock)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 2.0)
    assert w["opens"] == 1


def test_stall_is_detected_and_recovers():
    clock = FakeClock()
    stalled = {"on": False}
    w = world(read_ok=lambda: not stalled["on"])
    cam = make(w, clock, stall_s=1.0)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 0.5)
    assert cam.state == CameraState.ACTIVE
    stalled["on"] = True
    tick(cam, clock, 0.3)
    assert cam.state in (CameraState.INTERRUPTED, CameraState.RECONNECTING)
    stalled["on"] = False
    tick(cam, clock, 3.0)
    assert cam.state == CameraState.ACTIVE
    assert cam.status()["reconnects"] >= 1


def test_open_failures_are_bounded_then_device_unavailable():
    clock, w = FakeClock(), world(open_ok=lambda: False)
    cam = make(w, clock, max_open_attempts=3)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 30.0)
    assert cam.state == CameraState.DEVICE_UNAVAILABLE
    assert w["opens"] == 3
    assert "video" in cam.status()["message"]           # actionable hint
    assert cam.get_frame() is None


def test_reconnects_are_bounded_then_error():
    clock, w = FakeClock(), world(read_ok=lambda: False)
    cam = make(w, clock, max_reconnects=3, stall_s=0.5)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 120.0)
    assert cam.state == CameraState.ERROR
    assert w["opens"] <= 1 + 3 + 1
    assert cam.get_frame() is None


def test_stop_releases_the_device_exactly_once():
    clock, w = FakeClock(), world()
    cam = make(w, clock)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 0.5)
    cam.stop()
    cam.stop()
    assert cam.state == CameraState.STOPPED
    assert w["closes"] == 1
    assert cam.get_frame() is None


def test_no_frames_before_start():
    clock, w = FakeClock(), world()
    cam = make(w, clock)
    assert cam.state == CameraState.NOT_INITIALIZED
    assert cam.get_frame() is None
    assert w["opens"] == 0


def test_a_device_failure_stays_visible_after_stop():
    clock, w = FakeClock(), world(open_ok=lambda: False)
    cam = make(w, clock, max_open_attempts=2)
    cam._running = True
    cam.state = CameraState.CONNECTING
    tick(cam, clock, 10.0)
    cam.stop()
    assert cam.state == CameraState.DEVICE_UNAVAILABLE
    assert "video" in cam.status()["message"]
