import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app import create_app
from backend.devices import DeviceRegistry
from backend.events import EventBus
from myhands.camera import CameraService
from myhands.gestures import GestureEngine
from myhands.session import MyHandsSession

LOCAL = "http://127.0.0.1:8765"
SECRET = "secret-v21-key-abc"
HOST = {"host": "127.0.0.1:8765"}


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


@pytest.fixture
def stack(isolated, monkeypatch):
    """App wired like production: one bus, one device registry, My Hands on both."""
    monkeypatch.setenv("GEMINI_API_KEY", SECRET)
    bus = EventBus()
    reg = DeviceRegistry(bus)
    camera = CameraService(Source, stall_s=5.0)
    reg.register("camera", camera)
    session = MyHandsSession(camera=reg.lease("camera", "myhands"), tracker_factory=Tracker,
                             engine=GestureEngine(), loop_interval_s=0.005, idle_off_s=600, bus=bus)
    app = create_app(serve_ui=False, myhands_session=session, bus=bus, devices=reg)
    client = TestClient(app, base_url=LOCAL)
    yield client, bus, reg, session
    session.stop("user")
    time.sleep(0.05)


def _wait(pred, timeout=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_diagnostics_shows_devices_bus_and_myhands_without_secrets(stack):
    client, bus, reg, session = stack
    client.post("/api/myhands/start")
    assert _wait(lambda: reg.snapshot()["camera"]["holders"] == ["myhands"])
    body = client.get("/api/diagnostics").json()
    assert body["devices"]["camera"]["holders"] == ["myhands"]
    assert body["bus"]["last_seq"] >= 1
    assert body["api_key_configured"] is True
    assert SECRET not in str(body)
    assert "/" not in str(body["file_roots_available"])        # a count, not paths
    client.post("/api/myhands/stop")
    assert _wait(lambda: session.status()["running"] is False)


def test_diagnostics_lists_recent_problems(stack):
    client, bus, reg, session = stack
    bus.publish("test", {"type": "error", "reason": "disk full"})
    bus.publish("my_hands", {"type": "session_stopped", "reason": "user"})          # not a fault
    bus.publish("my_hands", {"type": "session_stopped", "reason": "camera_failed"})  # a fault
    problems = client.get("/api/diagnostics").json()["recent_problems"]
    assert [p["message"] for p in problems] == ["disk full", "camera_failed"]
    assert problems[0]["source"] == "test"


def test_event_stream_carries_my_hands_and_device_events_in_one_sequence(stack):
    client, bus, reg, session = stack
    client.post("/api/myhands/start")
    assert _wait(lambda: len(bus.since(0)) >= 2)          # session_started + lease_acquired
    expected = len(bus.since(0))
    with client.websocket_connect("/ws/events?since=0", headers=HOST) as ws:
        seen = [ws.receive_json() for _ in range(expected)]
        seqs = [m["seq"] for m in seen]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        sources = {m["event"]["source"] for m in seen}
        assert sources <= {"my_hands", "devices"} and sources
    client.post("/api/myhands/stop")
    assert _wait(lambda: session.status()["running"] is False)


def test_event_stream_resumes_after_a_sequence_number(stack):
    client, bus, reg, session = stack
    for i in range(3):
        bus.publish("test", {"type": "tick", "i": i})
    with client.websocket_connect("/ws/events?since=1", headers=HOST) as ws:
        first = ws.receive_json()
        assert first["seq"] == 2 and first["event"]["i"] == 1


def test_event_stream_is_guarded_against_cross_site_websocket(stack):
    client, bus, reg, session = stack
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect("/ws/events", headers={"host": "127.0.0.1:8765",
                                                              "origin": "https://evil.example"}):
            pass
    assert info.value.code == 1008


def test_diagnostics_is_guarded_against_foreign_host(stack):
    client, bus, reg, session = stack
    assert client.get("/api/diagnostics", headers={"host": "evil.example"}).status_code == 403
