"""Voice endpoints (JSON). Every route passes the local-only guard, like the rest of the API.

  GET  /api/voice/status
  POST /api/voice/start            {} -> status          (the owner's button is the consent)
  POST /api/voice/stop             {} -> status
  POST /api/voice/mute             {"muted": bool} -> status
  POST /api/voice/test             {} -> {"ok": bool, "checks": [{name, ok, detail}, ...]}
        plays a short beep, listens to the microphone for a few seconds, and reports each
        part of the voice path in plain language. 409 while a voice session is running.
  POST /api/voice/wake             {"enabled": bool}
        disable: applied at once -> status
        enable : needs the owner's OK -> {"confirmation": {...}}; the wake listener starts
                 only after Approve in the confirmations panel.

Errors: 409 wake word not ready · 503 offline (no key, Google's 429, or the owner's
switch) or no audio device. The app's own daily count never refuses a call — it warns.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel

from .controller import VoiceController, VoiceError


class MuteIn(BaseModel):
    muted: bool


class WakeIn(BaseModel):
    enabled: bool


WAKE_SUMMARY = ("Listen for 'Hey Jarvis' on this computer. Audio is checked here, "
                "and nothing is sent anywhere until the wake word is heard.")


def _http(e: VoiceError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=str(e))


def register(app: FastAPI, voice: VoiceController, confirmations) -> None:
    router = APIRouter()

    @router.get("/api/voice/status")
    def status() -> dict:
        return voice.status()

    @router.post("/api/voice/start")
    def start() -> dict:
        try:
            return voice.start_live(source="button")
        except VoiceError as e:
            raise _http(e)

    @router.post("/api/voice/stop")
    def stop() -> dict:
        return voice.stop_live(reason="user")

    @router.post("/api/voice/mute")
    def mute(body: MuteIn) -> dict:
        return voice.set_muted(body.muted)

    @router.post("/api/voice/test")
    def audio_test() -> dict:
        try:
            return voice.audio_test()
        except VoiceError as e:
            raise _http(e)

    @router.post("/api/voice/wake")
    def wake(body: WakeIn) -> dict:
        if not body.enabled:
            return voice.set_wake(False)
        wake_state = voice.status()["wake"]
        if not wake_state["available"]:
            reason = wake_state["reason"]
            raise HTTPException(status_code=409, detail=f"Wake word is not ready: {reason}.")
        view = confirmations.request(
            "voice.wake", WAKE_SUMMARY,
            run=lambda: _enable_wake(voice))
        return {"confirmation": view}

    app.include_router(router)


def _enable_wake(voice: VoiceController) -> str:
    try:
        voice.set_wake(True)
    except VoiceError as e:
        return f"Wake word could not start: {e}"
    return "Wake word listening is on."
