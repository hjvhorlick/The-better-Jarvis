"""Builds the voice controller with the real devices and the voice engines.

Nothing here opens hardware or loads a model. Devices open when a lease starts them; models
load on first use.

Settings (environment, all optional):
  SUPPER_VOICE_ENGINE     local (default: this computer, no Gemini) or live (Gemini Live)
  SUPPER_WAKE_WORD        on (default: listen for "Hey Jarvis" once the model is installed) or off
  SUPPER_MIC_DEVICE       microphone name or index (default: system default)
  SUPPER_SPEAKER_DEVICE   speaker name or index (default: system default)
  SUPPER_VOICE_IDLE_S     seconds without speech before a session stops (default 60)
  SUPPER_STT_MODEL, SUPPER_STT_LANGUAGE, SUPPER_TTS_ENGINE, SUPPER_TTS_VOICE: see stt.py and tts.py
"""
from __future__ import annotations

import os

from .. import config
from . import live, local, stt, tts, wake
from .audio import Microphone, Speaker
from .controller import VoiceController

ENGINES = ("local", "live")


def wake_setting() -> bool:
    """SUPPER_WAKE_WORD: on (default) listens for "Hey Jarvis" when the app starts; off does not."""
    return os.environ.get("SUPPER_WAKE_WORD", "on").strip().lower() not in ("off", "0", "no", "false")


def engine_setting() -> str:
    raw = os.environ.get("SUPPER_VOICE_ENGINE", "").strip().lower()
    return raw if raw in ENGINES else "local"


def _device_setting(name: str):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return int(raw) if raw.isdigit() else raw


def build(*, bus, devices, budget, chat) -> VoiceController:
    mic = Microphone(device=_device_setting("SUPPER_MIC_DEVICE"))
    speaker = Speaker(device=_device_setting("SUPPER_SPEAKER_DEVICE"))
    devices.register("microphone", mic)
    devices.register("speaker", speaker)

    transcriber = stt.FasterWhisperTranscriber()
    synthesiser = _LazySynthesiser()

    def make_relay(*, answer=None, **callbacks):
        if engine_setting() == "live":
            return live.LiveRelay(
                get_key=config.get_gemini_api_key,
                instruction=chat.system_instruction,
                voice=live.current_voice,
                speaker=speaker,
                bus=bus,
                **callbacks,
            )
        return local.LocalRelay(
            speaker=speaker,
            bus=bus,
            answer=answer,
            transcriber=transcriber,
            synthesiser=synthesiser.get(),
            **callbacks,
        )

    def local_ready() -> tuple[bool, str]:
        ready, reason = stt.availability()
        return ready, reason

    idle = float(os.environ.get("SUPPER_VOICE_IDLE_S", "60") or 60)
    return VoiceController(
        mic=mic,
        speaker=speaker,
        devices=devices,
        bus=bus,
        budget=budget,
        get_key=config.get_gemini_api_key,
        make_relay=make_relay,
        wake_available=wake.availability,
        make_detector=wake.OpenWakeWordDetector,
        idle_s=idle,
        engine=engine_setting,
        local_ready=local_ready,
        wake_default=wake_setting,
    )


class _LazySynthesiser:
    """Chooses the spoken-reply engine on first use, so nothing loads at start-up."""

    def __init__(self) -> None:
        self._value = None
        self._chosen = False

    def get(self):
        if not self._chosen:
            self._value = tts.choose()
            self._chosen = True
        return self._value
