"""Audio self-test: does the speaker make sound, does the microphone hear anything,
and are the speech engines ready? Everything runs on this computer; nothing is sent anywhere.

Used by POST /api/voice/test (the "Test audio" button), the chat command "test the sound",
and tools/check_voice.py. Each check comes back as plain language:

    {"name": "speaker", "ok": true, "detail": "played a one-second beep ..."}

The speaker and microphone are opened through the device registry, so the one-owner rule
holds and the devices are released again when the test ends. The test refuses to run while
a Live voice session is on (the controller checks that before calling here).

Provenance: written for this project. No code taken from other projects.
"""
from __future__ import annotations

import math
import time
from typing import Callable

from . import stt, tts, wake
from .audio import AudioUnavailable, SPEAKER_RATE, default_device_names
from .vad import frame_rms

TONE_HZ = 440.0
TONE_S = 1.0
LISTEN_S = 3.0
LEASE = "audio_test"

# The level a normal spoken sentence must reach for voice to hear it (local.SPEECH_ON).
# Imported late to avoid a cycle; kept here as the single named default for the test.
SPEECH_LEVEL = 600.0


def tone_pcm(seconds: float = TONE_S, hz: float = TONE_HZ, rate: int = SPEAKER_RATE) -> bytes:
    """A soft sine beep, 16-bit mono PCM. Quiet enough not to startle (about -12 dBFS)."""
    n = int(seconds * rate)
    amp = 8000
    samples = bytearray()
    for i in range(n):
        v = int(amp * math.sin(2.0 * math.pi * hz * i / rate))
        samples += v.to_bytes(2, "little", signed=True)
    return bytes(samples)


def run(
    devices,
    mic,
    speaker,
    *,
    listen_s: float = LISTEN_S,
    speech_level: float = SPEECH_LEVEL,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict:
    """All checks, in order. Never raises: every failure becomes a readable check line."""
    checks = [
        _check_sound_system(),
        _check_speaker(devices, speaker, sleep=sleep, clock=clock),
        _check_microphone(devices, mic, listen_s=listen_s, speech_level=speech_level,
                          sleep=sleep, clock=clock),
        _availability("speech to text", stt.availability),
        _availability("spoken replies", tts.availability),
        _availability("wake word", wake.availability),
    ]
    return {"ok": all(c["ok"] for c in checks), "checks": checks}


# ----- the individual checks -----

def _check_sound_system() -> dict:
    """The sounddevice package and the system's default devices, by name (audio.py asks)."""
    ok, detail = default_device_names()
    return {"name": "sound system", "ok": ok, "detail": detail}


def _check_speaker(devices, speaker, *, sleep, clock) -> dict:
    lease = devices.lease("speaker", LEASE)
    try:
        lease.start()
    except AudioUnavailable as e:
        return {"name": "speaker", "ok": False, "detail": str(e)}
    try:
        pcm = tone_pcm()
        speaker.enqueue(pcm)
        deadline = clock() + TONE_S + 2.0
        while speaker.is_playing() and clock() < deadline:
            sleep(0.05)
        return {"name": "speaker", "ok": True,
                "detail": "played a one-second beep — if you heard nothing, "
                          "check the system volume and the output device"}
    finally:
        lease.stop()


def _check_microphone(devices, mic, *, listen_s, speech_level, sleep, clock) -> dict:
    lease = devices.lease("microphone", LEASE)
    try:
        lease.start()
    except AudioUnavailable as e:
        return {"name": "microphone", "ok": False, "detail": str(e)}
    heard = {"frames": 0, "peak": 0.0}

    def tap(block: bytes) -> None:
        heard["frames"] += 1
        heard["peak"] = max(heard["peak"], frame_rms(block))

    mic.add_tap(tap)
    try:
        deadline = clock() + listen_s
        while clock() < deadline:
            sleep(0.05)
    finally:
        mic.remove_tap(tap)
        lease.stop()

    if getattr(mic, "muted", False):
        return {"name": "microphone", "ok": False,
                "detail": "the microphone is muted — press Unmute and run the test again"}
    if heard["frames"] == 0:
        return {"name": "microphone", "ok": False,
                "detail": "no audio arrived from the microphone — check the input device "
                          "and the system's microphone permission for Python"}
    peak = heard["peak"]
    if peak < speech_level:
        return {"name": "microphone", "ok": False,
                "detail": (f"heard only silence (loudest level {peak:.0f}, speech needs about "
                           f"{speech_level:.0f}) — speak normally during the test, or raise the "
                           "microphone level in the system sound settings")}
    return {"name": "microphone", "ok": True,
            "detail": f"heard you clearly (loudest level {peak:.0f}, threshold {speech_level:.0f})"}


def _availability(name: str, check: Callable[[], tuple[bool, str]]) -> dict:
    try:
        ready, reason = check()
    except Exception as e:
        return {"name": name, "ok": False, "detail": f"check failed ({type(e).__name__})"}
    return {"name": name, "ok": bool(ready), "detail": reason}
