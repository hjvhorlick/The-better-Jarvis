"""Text to speech on this computer, with no network call.

Two engines. The first one that is ready is used (SUPPER_TTS_ENGINE can force one, or "off"):

  kokoro   Kokoro-82M through kokoro-onnx (code: MIT; model: Apache-2.0). A natural voice. Needs
           two model files in models/kokoro/ (see docs/LOCAL_VOICE.md). Not in the repository.
  system   The computer's own voices through pyttsx3 (MPL-2.0). No download. Windows uses SAPI5
           voices, macOS its built-in voices, Linux needs the espeak-ng package. Plainer sound.

Both return 16-bit mono PCM at SPEAKER_RATE (24 kHz), the rate the speaker expects, so the rest of
the voice code does not care which engine is in use.

Settings (environment, optional):
  SUPPER_TTS_ENGINE   auto (default), kokoro, system, or off
  SUPPER_TTS_VOICE    Kokoro voice name (default af_heart)

Nothing heavy is imported until an engine is used.

Provenance: written for this project against the kokoro-onnx and pyttsx3 APIs. No code taken from
other projects.
"""
from __future__ import annotations

import importlib.util
import os
import tempfile
import wave
from pathlib import Path

from .. import config
from .audio import SPEAKER_RATE

KOKORO_DIR = config.REPO_ROOT / "models" / "kokoro"
KOKORO_MODEL = "kokoro-v1.0.onnx"
KOKORO_VOICES = "voices-v1.0.bin"
DEFAULT_KOKORO_VOICE = "af_heart"


def to_speaker_pcm(samples, rate: int) -> bytes:
    """Float samples (-1..1) or int16 mono samples at `rate` -> 16-bit PCM at SPEAKER_RATE."""
    import numpy as np

    data = np.asarray(samples)
    if data.dtype != np.int16:
        data = (np.clip(data.astype(np.float32), -1.0, 1.0) * 32767.0).astype(np.int16)
    if rate != SPEAKER_RATE and len(data) > 1:
        n_out = int(round(len(data) * SPEAKER_RATE / rate))
        x_old = np.linspace(0.0, 1.0, num=len(data))
        x_new = np.linspace(0.0, 1.0, num=max(n_out, 1))
        data = np.interp(x_new, x_old, data.astype(np.float32)).astype(np.int16)
    return data.astype("<i2").tobytes()


def kokoro_files_present(models_dir: Path = KOKORO_DIR) -> bool:
    return (models_dir / KOKORO_MODEL).is_file() and (models_dir / KOKORO_VOICES).is_file()


class KokoroSynthesiser:
    def __init__(self, models_dir: Path = KOKORO_DIR, voice: str | None = None, engine_factory=None) -> None:
        self._dir = Path(models_dir)
        self._voice = voice or os.environ.get("SUPPER_TTS_VOICE", "").strip() or DEFAULT_KOKORO_VOICE
        self._factory = engine_factory
        self._engine = None

    def speak_pcm(self, text: str) -> bytes:
        if self._engine is None:
            if self._factory is not None:
                self._engine = self._factory(str(self._dir / KOKORO_MODEL), str(self._dir / KOKORO_VOICES))
            else:
                from kokoro_onnx import Kokoro           # imported on first use
                self._engine = Kokoro(str(self._dir / KOKORO_MODEL), str(self._dir / KOKORO_VOICES))
        samples, rate = self._engine.create(text, voice=self._voice, speed=1.0, lang="en-us")
        return to_speaker_pcm(samples, int(rate))


class SystemSynthesiser:
    """The computer's voice through pyttsx3. Writes a WAV file per phrase, reads it back."""

    def __init__(self, engine_factory=None) -> None:
        self._factory = engine_factory
        self._engine = None

    def speak_pcm(self, text: str) -> bytes:
        if self._engine is None:
            if self._factory is not None:
                self._engine = self._factory()
            else:
                import pyttsx3                           # imported on first use
                self._engine = pyttsx3.init()
        fd, path = tempfile.mkstemp(suffix=".wav", prefix="jarvis-tts-")
        os.close(fd)
        try:
            self._engine.save_to_file(text, path)
            self._engine.runAndWait()
            return _read_wav_as_speaker_pcm(path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass


def _read_wav_as_speaker_pcm(path: str) -> bytes:
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("the system voice wrote audio that is not 16-bit")
        channels, rate = w.getnchannels(), w.getframerate()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    if channels > 1:
        raw = raw.reshape(-1, channels).mean(axis=1).astype(np.int16)
    return to_speaker_pcm(raw, rate)


def availability(models_dir: Path = KOKORO_DIR) -> tuple[bool, str]:
    """(ready, reason) for the engine that would be used. Checks only; loads nothing."""
    choice = os.environ.get("SUPPER_TTS_ENGINE", "auto").strip().lower() or "auto"
    if choice == "off":
        return False, "spoken replies are switched off (SUPPER_TTS_ENGINE=off)"
    if choice in ("auto", "kokoro") and kokoro_files_present(models_dir) \
            and importlib.util.find_spec("kokoro_onnx") is not None:
        return True, "spoken replies with the Kokoro voice on this computer"
    if choice == "kokoro":
        return False, "Kokoro voice files are not in models/kokoro/ (see docs/LOCAL_VOICE.md)"
    if importlib.util.find_spec("pyttsx3") is not None:
        return True, "spoken replies with this computer's own voice"
    return False, "no spoken-reply engine is installed (see backend/requirements-local-voice.txt)"


def choose(models_dir: Path = KOKORO_DIR):
    """The synthesiser to use, or None when spoken replies are off or no engine is installed."""
    ready, _ = availability(models_dir)
    if not ready:
        return None
    choice = os.environ.get("SUPPER_TTS_ENGINE", "auto").strip().lower() or "auto"
    if choice in ("auto", "kokoro") and kokoro_files_present(models_dir) \
            and importlib.util.find_spec("kokoro_onnx") is not None:
        return KokoroSynthesiser(models_dir)
    return SystemSynthesiser()
