"""Camera preview for My Hands: the picture matches the hand's side, and it follows the rules.

The preview is a JPEG stream on this computer only. It is refused unless My Hands is on, it
shares the camera through the device registry, and it releases its lease when the stream ends.
The streaming test runs a real local server, because the in-process test client buffers the
whole response and would wait forever on an endless stream.
"""
import socket
import threading
import time

import httpx
import numpy as np
import pytest
import uvicorn
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.devices import DeviceRegistry
from myhands.camera import CameraService, preview_jpeg
from myhands.gestures import Config, GestureEngine
from myhands.session import MyHandsSession

LOCAL = "http://127.0.0.1:8765"


class PictureSource:
    """A fake camera. Its picture has a bright strip just left of centre (about x = 0.2)."""

    def __init__(self):
        self.n = 0

    def open(self):
        return True

    def read(self):
        self.n += 1
        img = np.zeros((120, 160, 3), np.uint8)
        img[:, 24:40] = 255                              # columns 24..39, centre near x = 0.2
        return True, img

    def close(self):
        pass


class Tracker:
    def process(self, frame):
        return []

    def close(self):
        pass


def _wait_until(pred, timeout=5.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _decode_gray(jpg: bytes):
    cv2 = pytest.importorskip("cv2")
    img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert img is not None, "the preview is not a valid JPEG"
    return img


def _bright_centre(img) -> float:
    """Brightness-weighted centre of the picture, as a fraction of its width (0 = left, 1 = right)."""
    col = img.mean(axis=0).astype(float)
    cols = np.arange(img.shape[1])
    return float((col * cols).sum() / col.sum() / img.shape[1])


def _make_app():
    registry = DeviceRegistry()
    registry.register("camera", CameraService(PictureSource, stall_s=5.0))
    session = MyHandsSession(registry.lease("camera", "myhands"), Tracker,
                             loop_interval_s=0.005, idle_off_s=600)
    app = create_app(serve_ui=False, devices=registry, myhands_session=session)
    return app, session, registry


class LiveServer:
    """Runs the app on 127.0.0.1 with a free port, for a real streamed response."""

    def __init__(self, app):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        assert _wait_until(lambda: self.server.started, 10.0), "the test server did not start"
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture
def made():
    app, session, registry = _make_app()
    yield app, session, registry
    session.stop("user")
    _wait_until(lambda: not session.running, 2.0)


# ----- the picture -----

def test_a_hand_on_the_right_of_the_picture_stays_on_the_right_when_mirrored():
    frame = np.zeros((120, 160, 3), np.uint8)
    frame[:, :40] = 255                                   # bright on the left of the camera image
    mirrored = _decode_gray(preview_jpeg(frame, mirror=True))
    plain = _decode_gray(preview_jpeg(frame, mirror=False))
    w = mirrored.shape[1]
    assert mirrored[:, : w // 4].mean() < 60              # left quarter is now dark
    assert mirrored[:, 3 * w // 4:].mean() > 180          # the bright strip is on the right
    assert plain[:, : w // 4].mean() > 180                # without mirroring it stays on the left


def test_the_pointer_and_the_picture_agree_about_the_side():
    # With mirror on, a hand at camera x = 0.2 maps to stage x = 0.8, so it appears on the right.
    # The preview uses the same flag, so the bright strip (x = 0.2 in the camera image) must be
    # at about x = 0.8 in the preview.
    from backend.myhands_api import MIRROR

    assert MIRROR is True
    e = GestureEngine(Config(mirror=MIRROR, smooth_min_cutoff=1000.0, smooth_beta=0.0, smooth_d_cutoff=1000.0))
    assert e._to_stage([[0.2, 0.5, 0.0]] * 21)[0] == pytest.approx(0.8)
    frame = np.zeros((120, 160, 3), np.uint8)
    frame[:, 24:40] = 255                                 # strip centred at x = 0.2
    img = _decode_gray(preview_jpeg(frame, mirror=MIRROR))
    assert _bright_centre(img) == pytest.approx(0.8, abs=0.03)


# ----- the rules -----

def test_the_preview_is_refused_while_my_hands_is_off(made):
    app, session, _ = made
    assert not session.running
    r = TestClient(app, base_url=LOCAL).get("/api/myhands/preview")
    assert r.status_code == 409


def test_the_preview_says_so_when_no_camera_is_registered():
    # An injected session with no camera in the registry: the preview cannot run, and says so.
    session = MyHandsSession(CameraService(PictureSource, stall_s=5.0), Tracker,
                             loop_interval_s=0.005, idle_off_s=600)
    client = TestClient(create_app(serve_ui=False, myhands_session=session), base_url=LOCAL)
    client.post("/api/myhands/start")
    try:
        r = client.get("/api/myhands/preview")
        assert r.status_code == 503
    finally:
        client.post("/api/myhands/stop")


def test_the_preview_streams_jpegs_and_releases_its_lease_when_my_hands_stops(made):
    app, session, registry = made
    with LiveServer(app) as base:
        assert httpx.post(f"{base}/api/myhands/start").status_code == 200
        assert _wait_until(lambda: session.camera.get_frame() is not None, 5.0)   # pictures are flowing
        with httpx.stream("GET", f"{base}/api/myhands/preview", timeout=10.0) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("multipart/x-mixed-replace")
            assert r.headers["cache-control"] == "no-store"
            buf = b""
            for piece in r.iter_bytes():
                buf += piece
                if b"--frame" in buf and b"\xff\xd9" in buf:    # one whole JPEG (start to end marker)
                    break
            assert b"\xff\xd8" in buf
            holders = registry.snapshot()["camera"]["holders"]
            assert "myhands" in holders                           # the session still holds the camera
            assert any(h.startswith("myhands_preview_") for h in holders)   # and so does the preview
            assert httpx.post(f"{base}/api/myhands/stop").status_code == 200
            # The stream ends when My Hands stops, and the preview gives its lease back.
            assert _wait_until(lambda: not any(h.startswith("myhands_preview_")
                                               for h in registry.snapshot()["camera"]["holders"]), 5.0)
        assert not session.running
