import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app import create_app
from myhands.camera import CameraService
from myhands.session import MyHandsSession

LOCAL = "http://127.0.0.1:8765"


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


def fake_session(idle_off_s=600):
    cam = CameraService(Source, stall_s=5.0)
    return MyHandsSession(cam, Tracker, loop_interval_s=0.005, idle_off_s=idle_off_s)


@pytest.fixture
def session():
    s = fake_session()
    yield s
    s.stop("user")
    time.sleep(0.05)


@pytest.fixture
def client(session):
    return TestClient(create_app(serve_ui=False, myhands_session=session), base_url=LOCAL)


def wait_until(pred, timeout=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.02)
    return False

def wait_stopped(s, timeout=5.0):
    ok = wait_until(lambda: any(e["type"] == "session_stopped" for _, e in s.events_after(0)), timeout)
    if s._thread is not None:
        s._thread.join(timeout)
    return ok


# ---------- routes ----------

def test_status_is_off_by_default_and_has_no_frames(client):
    body = client.get("/api/myhands/status").json()
    assert body["running"] is False
    assert body["camera_on"] is False
    assert "frame" not in body                       # no image data at top level
    assert isinstance(body["camera"]["frames_total"], int)   # counter only
    assert isinstance(body["tracker_available"], bool)


def test_start_and_stop(client, session):
    r = client.post("/api/myhands/start", json={"mode": "my_hands"})
    assert r.status_code == 200 and r.json()["running"] is True
    assert wait_until(lambda: session.status()["camera"]["frames_total"] > 0)
    r = client.post("/api/myhands/stop")
    assert r.status_code == 200
    assert wait_stopped(session)
    assert client.get("/api/myhands/status").json()["camera_on"] is False


def test_start_accepts_no_body_and_rejects_unknown_mode(client):
    assert client.post("/api/myhands/start").status_code == 200
    client.post("/api/myhands/stop")
    assert client.post("/api/myhands/start", json={"mode": "shell"}).status_code == 422


def test_scene_accepts_valid_tiles(client, session):
    body = {"objects": [{"id": "tile-notes", "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2, "z": 2}]}
    r = client.put("/api/myhands/scene", json=body)
    assert r.status_code == 200 and r.json() == {"count": 1}


@pytest.mark.parametrize("bad", [
    {"id": "a", "x": 1.5, "y": 0, "w": 0.1, "h": 0.1},          # out of range
    {"id": "a", "x": 0, "y": 0, "w": 0, "h": 0.1},              # zero size
    {"id": "has space", "x": 0, "y": 0, "w": 0.1, "h": 0.1},    # bad id
    {"id": "", "x": 0, "y": 0, "w": 0.1, "h": 0.1},             # empty id
    {"id": "a" * 65, "x": 0, "y": 0, "w": 0.1, "h": 0.1},       # too long
])
def test_scene_rejects_bad_objects(client, bad):
    assert client.put("/api/myhands/scene", json={"objects": [bad]}).status_code == 422


def test_scene_rejects_duplicate_ids_and_too_many_objects(client):
    dup = {"id": "a", "x": 0, "y": 0, "w": 0.1, "h": 0.1}
    assert client.put("/api/myhands/scene", json={"objects": [dup, dup]}).status_code == 400
    many = [{"id": f"o{i}", "x": 0, "y": 0, "w": 0.1, "h": 0.1} for i in range(51)]
    assert client.put("/api/myhands/scene", json={"objects": many}).status_code == 422


# ---------- local-only guard applies to the new routes ----------

def test_guard_blocks_foreign_host(client):
    r = client.get("/api/myhands/status", headers={"host": "evil.example"})
    assert r.status_code == 403


def test_guard_blocks_cross_site_post(client):
    r = client.post("/api/myhands/start", headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_guard_blocks_cross_site_websocket(client):
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect("/ws/myhands", headers={"origin": "https://evil.example", "host": "127.0.0.1:8765"}):
            pass
    assert info.value.code == 1008


# ---------- websocket ----------

def test_websocket_streams_events_with_sequence_numbers(client, session):
    client.post("/api/myhands/start")
    with client.websocket_connect("/ws/myhands?since=0", headers={"host": "127.0.0.1:8765"}) as ws:
        msg = ws.receive_json()
        assert msg["seq"] >= 1
        assert msg["event"]["type"] == "session_started"


def test_websocket_resumes_from_a_sequence_number(client, session):
    client.post("/api/myhands/start")
    assert wait_until(lambda: session.status()["camera"]["frames_total"] > 0)
    client.post("/api/myhands/stop")
    assert wait_stopped(session)
    last = session.status()["last_event_seq"]
    with client.websocket_connect(f"/ws/myhands?since={last - 1}", headers={"host": "127.0.0.1:8765"}) as ws:
        msg = ws.receive_json()
        assert msg["seq"] == last
        assert msg["event"]["type"] == "session_stopped"


def test_websocket_rejects_negative_since(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/myhands?since=-1", headers={"host": "127.0.0.1:8765"}):
            pass


# ---------- lazy imports ----------

def test_importing_the_app_does_not_import_camera_or_mediapipe():
    code = ("import sys; sys.path.insert(0, '.'); import backend.app; "
            "from backend.app import create_app; create_app(serve_ui=False); "
            "bad = [m for m in ('cv2', 'mediapipe') if m in sys.modules]; "
            "print(bad)")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         cwd=str(__import__("pathlib").Path(__file__).resolve().parent.parent))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"
