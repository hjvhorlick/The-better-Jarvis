import time

import pytest

from backend.devices import DeviceRegistry
from backend.events import EventBus
from myhands.camera import CameraService, CameraState
from myhands.gestures import GestureEngine
from myhands.session import MyHandsSession


class FakeDevice:
    def __init__(self):
        self.starts = 0
        self.stops = 0
        self.frame = 0

    def start(self):
        self.starts += 1

    def stop(self):
        self.stops += 1

    def status(self):
        return {"starts": self.starts, "stops": self.stops}

    def get_frame(self):
        return ("frame", self.frame)


def test_first_lease_starts_and_last_release_stops_the_device_once():
    dev = FakeDevice()
    reg = DeviceRegistry(EventBus())
    reg.register("camera", dev)
    a = reg.lease("camera", "myhands")
    b = reg.lease("camera", "vision")
    a.start()
    b.start()
    assert dev.starts == 1                       # one handle, shared
    a.stop()
    assert dev.stops == 0                        # still held by vision
    b.stop()
    assert dev.stops == 1                        # last owner released it


def test_repeated_start_and_stop_by_the_same_owner_are_idempotent():
    dev = FakeDevice()
    reg = DeviceRegistry()
    reg.register("camera", dev)
    lease = reg.lease("camera", "myhands")
    lease.start()
    lease.start()
    lease.stop()
    lease.stop()
    assert (dev.starts, dev.stops) == (1, 1)


def test_reads_pass_through_to_the_device():
    dev = FakeDevice()
    dev.frame = 7
    reg = DeviceRegistry()
    reg.register("camera", dev)
    assert reg.lease("camera", "myhands").get_frame() == ("frame", 7)


def test_lease_changes_are_published_and_snapshot_lists_holders():
    bus = EventBus()
    dev = FakeDevice()
    reg = DeviceRegistry(bus)
    reg.register("camera", dev)
    lease = reg.lease("camera", "myhands")
    lease.start()
    assert reg.snapshot()["camera"]["holders"] == ["myhands"]
    lease.stop()
    kinds = [e["type"] for _, e in bus.since(0, source="devices")]
    assert kinds == ["lease_acquired", "lease_released"]
    assert reg.snapshot()["camera"]["holders"] == []


def test_unknown_device_and_duplicate_registration_fail_loudly():
    reg = DeviceRegistry()
    reg.register("camera", FakeDevice())
    with pytest.raises(ValueError):
        reg.register("camera", FakeDevice())
    with pytest.raises(KeyError):
        reg.lease("microphone", "myhands")
    with pytest.raises(ValueError):
        reg.lease("camera", "")


# ----- real session on the real registry, with a scripted camera -----

class Source:
    def __init__(self):
        self.n = 0

    def open(self):
        return True

    def read(self):
        self.n += 1
        return True, self.n

    def close(self):
        pass


class Tracker:
    def process(self, frame):
        return []

    def close(self):
        pass


def _wait(pred, timeout=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_my_hands_session_holds_the_camera_lease_and_releases_it_on_stop():
    bus = EventBus()
    reg = DeviceRegistry(bus)
    camera = CameraService(Source, stall_s=5.0)
    reg.register("camera", camera)
    session = MyHandsSession(
        camera=reg.lease("camera", "myhands"),
        tracker_factory=Tracker,
        engine=GestureEngine(),
        loop_interval_s=0.005,
        idle_off_s=600,
        bus=bus,
    )
    session.start()
    assert _wait(lambda: reg.snapshot()["camera"]["holders"] == ["myhands"])
    assert _wait(lambda: camera.status()["frames_total"] > 0)
    session.stop("user")
    assert _wait(lambda: any(e["type"] == "session_stopped" for _, e in session.events_after(0)))
    session._thread.join(5)
    assert reg.snapshot()["camera"]["holders"] == []
    assert camera.state == CameraState.STOPPED
    # the session's events are on the shared bus, tagged with their source
    assert {e["source"] for _, e in bus.since(0)} >= {"my_hands", "devices"}


def test_a_device_that_fails_to_start_is_not_recorded_as_held():
    class Broken(FakeDevice):
        def start(self):
            raise RuntimeError("no hardware")

    reg = DeviceRegistry(EventBus())
    dev = Broken()
    reg.register("microphone", dev)
    lease = reg.lease("microphone", "voice")
    with pytest.raises(RuntimeError):
        lease.start()
    assert reg.snapshot()["microphone"]["holders"] == []
    dev.start = FakeDevice().start                        # hardware back: a retry works
    lease.start()
    assert reg.snapshot()["microphone"]["holders"] == ["voice"]
