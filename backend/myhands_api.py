"""HTTP and WebSocket routes for My Hands (hand-gesture control of the glass UI).

Privacy: camera frames never leave this computer and never go to any cloud service.
The only frames the browser receives are the preview pictures, served on this machine's
own address (the local-only guard refuses other hosts). Gesture events go over the local
WebSocket. Nothing is sent to Gemini.

  POST /api/myhands/start     start a session (camera on, tracking on)
  POST /api/myhands/stop      stop the session (camera released, grabs released)
  GET  /api/myhands/status    session and camera state, no frames
  GET  /api/myhands/preview   mirrored camera preview as a JPEG stream; 409 unless My Hands is on
  PUT  /api/myhands/scene     the tiles the browser shows: id, x, y, w, h, z (0..1 stage units)
  WS   /ws/myhands?since=N    gesture events with sequence numbers, from N onward

The session object is created lazily by default, so importing this module does
not import OpenCV or MediaPipe.
"""
from __future__ import annotations

import asyncio
import importlib.util
import itertools
import os
import time
from typing import Iterator, Literal

from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from myhands.camera import CameraService, OpenCVSource, preview_jpeg
from myhands.gestures import Config, GestureEngine, SceneObject
from myhands.session import MODE_MY_HANDS, MyHandsSession

MAX_SCENE_OBJECTS = 50
_ID_RE = r"^[A-Za-z0-9_.:-]+$"

# One setting for the whole picture. The gesture engine and the preview both use it, so the
# pointer and the picture always agree about which side is which.
MIRROR = True
PREVIEW_OWNER = "myhands_preview"      # the preview takes its own lease on the camera
PREVIEW_INTERVAL_S = 0.1               # at most 10 pictures a second
PREVIEW_BOUNDARY = "frame"
_preview_ids = itertools.count(1)


class StartIn(BaseModel):
    mode: Literal["my_hands"] = MODE_MY_HANDS


class SceneObjectIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=64, pattern=_ID_RE)
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    w: float = Field(..., gt=0.0, le=1.0)
    h: float = Field(..., gt=0.0, le=1.0)
    z: int = Field(default=0, ge=-1000, le=1000)


class SceneIn(BaseModel):
    objects: list[SceneObjectIn] = Field(..., max_length=MAX_SCENE_OBJECTS)


def tracker_available() -> bool:
    """Report whether the tracking libraries are installed, without importing them."""
    return all(importlib.util.find_spec(m) is not None for m in ("cv2", "mediapipe"))


def default_session(bus=None, devices=None) -> MyHandsSession:
    """Real camera and MediaPipe tracker. Nothing is opened until start().

    The camera is registered with the device registry and My Hands takes a lease on
    it, so any other owner (vision, the agent) shares the same handle.
    """
    from backend.devices import DeviceRegistry
    from myhands.tracker import MediaPipeHandTracker

    index = int(os.environ.get("SUPPER_CAMERA_INDEX", "0") or 0)
    if devices is None:
        devices = DeviceRegistry(bus)
    devices.register("camera", CameraService(lambda: OpenCVSource(index)))
    return MyHandsSession(
        camera=devices.lease("camera", "myhands"),
        tracker_factory=lambda: MediaPipeHandTracker(),
        engine=GestureEngine(Config(mirror=MIRROR)),
        idle_off_s=float(os.environ.get("SUPPER_MYHANDS_IDLE_OFF_S", "600")),
        bus=bus,
    )


def _status_payload(session: MyHandsSession) -> dict:
    data = session.status()
    data["tracker_available"] = tracker_available()
    return data


def _preview_frames(session: MyHandsSession, lease) -> Iterator[bytes]:
    """Yield the camera as a multipart JPEG stream until My Hands stops. The lease is released when
    the stream ends, however it ends."""
    last_seq = None
    try:
        while session.running:
            item = lease.get_frame()
            if item is not None and item[1] != last_seq:
                last_seq = item[1]
                try:
                    jpg = preview_jpeg(item[0], mirror=MIRROR)
                except Exception:              # one bad frame is skipped; the stream goes on
                    jpg = None
                if jpg:
                    head = (f"--{PREVIEW_BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                            f"Content-Length: {len(jpg)}\r\n\r\n").encode("ascii")
                    yield head + jpg + b"\r\n"
            time.sleep(PREVIEW_INTERVAL_S)
    finally:
        lease.stop()


def register(app: FastAPI, session: MyHandsSession, devices=None) -> None:
    """Routes for My Hands. `devices` is the app's device registry; the preview needs it to share
    the camera. Without it the preview answers 503 and nothing else changes."""
    router = APIRouter()

    @router.post("/api/myhands/start")
    def start(body: StartIn = StartIn()) -> dict:
        session.start(body.mode)
        return _status_payload(session)

    @router.post("/api/myhands/stop")
    def stop() -> dict:
        session.stop("user")
        return _status_payload(session)

    @router.get("/api/myhands/status")
    def status() -> dict:
        return _status_payload(session)

    @router.get("/api/myhands/preview")
    def preview():
        if not session.running:
            raise HTTPException(status_code=409, detail="My Hands is not on. Start it to see the camera.")
        if devices is None or not devices.has("camera"):
            raise HTTPException(status_code=503, detail="The camera is not available for a preview.")
        lease = devices.lease("camera", f"{PREVIEW_OWNER}_{next(_preview_ids)}")   # one owner per stream
        try:
            lease.start()                      # shares the camera My Hands already has open
        except Exception:
            raise HTTPException(status_code=503, detail="The camera could not be opened for a preview.")
        if not session.running:                # My Hands stopped while the lease was being taken
            lease.stop()
            raise HTTPException(status_code=409, detail="My Hands is not on. Start it to see the camera.")
        return StreamingResponse(
            _preview_frames(session, lease),
            media_type=f"multipart/x-mixed-replace; boundary={PREVIEW_BOUNDARY}",
            headers={"Cache-Control": "no-store"},
        )

    @router.put("/api/myhands/scene")
    def scene(body: SceneIn) -> dict:
        ids = [o.id for o in body.objects]
        if len(set(ids)) != len(ids):
            raise HTTPException(status_code=400, detail="duplicate object id")
        session.set_scene([SceneObject(o.id, o.x, o.y, o.w, o.h, o.z) for o in body.objects])
        return {"count": len(body.objects)}

    @router.websocket("/ws/myhands")
    async def ws_events(ws: WebSocket, since: int = Query(default=0, ge=0)) -> None:
        await ws.accept()
        last = since
        try:
            while True:
                for seq, event in session.events_after(last):
                    await ws.send_json({"seq": seq, "event": event})
                    last = seq
                await asyncio.sleep(0.03)
        except Exception:
            # client went away (or the socket failed): nothing else to do
            return

    app.include_router(router)
