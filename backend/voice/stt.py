"""Speech to text on this computer, with no network call once the model is on disk.

Engine: faster-whisper (MIT). Its Whisper model weights are downloaded once from Hugging Face on
first use and cached; after that the app runs offline. Models are not in the repository.

Settings (environment, optional):
  SUPPER_STT_MODEL      model size: tiny, base, small, medium (default base; small is more accurate and slower)
  SUPPER_STT_LANGUAGE   language code such as en (default en). Empty means detect the language.

Input is 16-bit mono PCM at 16 kHz, the rate of the microphone (backend/voice/audio.py).
Nothing here is imported until a transcriber is actually used, so the app starts without it.

Provenance: written for this project against the faster-whisper API. No code taken from other projects.
"""
from __future__ import annotations

import importlib.util
import os

DEFAULT_MODEL = "base"
DEFAULT_LANGUAGE = "en"
MODEL_SIZES = ("tiny", "base", "small", "medium")


def settings() -> tuple[str, str]:
    model = os.environ.get("SUPPER_STT_MODEL", "").strip() or DEFAULT_MODEL
    if model not in MODEL_SIZES:
        model = DEFAULT_MODEL
    language = os.environ.get("SUPPER_STT_LANGUAGE", DEFAULT_LANGUAGE).strip()
    return model, language


def availability() -> tuple[bool, str]:
    """(ready, reason). Checks the package is installed; it does not download anything."""
    if importlib.util.find_spec("faster_whisper") is None:
        return False, "speech to text is not installed (see backend/requirements-local-voice.txt)"
    model, _ = settings()
    return True, f"speech to text on this computer (model '{model}', downloaded once on first use)"


class FasterWhisperTranscriber:
    def __init__(self, model_factory=None) -> None:
        self._factory = model_factory
        self._model = None

    def transcribe(self, pcm: bytes, rate: int) -> str:
        import numpy as np

        if rate != 16000:
            raise ValueError("speech to text expects 16 kHz audio")
        usable = pcm[: len(pcm) - (len(pcm) % 2)]
        audio = np.frombuffer(usable, dtype="<i2").astype(np.float32) / 32768.0
        model = self._load()
        _, language = settings()
        segments, _info = model.transcribe(audio, language=language or None, vad_filter=True, beam_size=1)
        return " ".join(seg.text.strip() for seg in segments).strip()

    def _load(self):
        if self._model is None:
            name, _ = settings()
            if self._factory is not None:
                self._model = self._factory(name)
            else:
                from faster_whisper import WhisperModel          # imported here, on first use
                self._model = WhisperModel(name, device="cpu", compute_type="int8")
        return self._model
