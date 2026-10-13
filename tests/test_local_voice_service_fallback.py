"""The standalone local voice service (local_voice/service.py).

Before the fix, a missing Kokoro download meant /speak always failed and the
dashboard was silent. These tests check the guarantee that replaced that:
Kokoro missing → the operating system's own voice speaks; both missing → one
plain message that points at the browser voice instead of silence. The real
Kokoro/OS voices are never invoked: both edges are replaced.
"""
import importlib.util
from pathlib import Path

import pytest

SERVICE_PATH = Path(__file__).resolve().parent.parent / "local_voice" / "service.py"


def _load_service():
    spec = importlib.util.spec_from_file_location("jarvis_local_voice_service", SERVICE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


service = _load_service()


def test_health_reports_what_is_missing_instead_of_failing():
    health = service.health()
    assert health["ok"] is True
    assert "voiceFilesPresent" in health
    assert "systemVoice" in health  # name of the OS fallback, or None
    assert set(health["packages"]) == {"kokoro_onnx", "faster_whisper", "sounddevice"}


def test_speak_falls_back_to_the_system_voice_when_kokoro_is_missing(monkeypatch):
    spoken = []

    def no_kokoro():
        raise service.VoiceError("no-model", "The Kokoro voice files are missing.")

    monkeypatch.setattr(service, "kokoro", no_kokoro)
    monkeypatch.setattr(service, "speak_system", spoken.append)
    assert service.speak("Hello, sir.") == {"ok": True, "via": "system"}
    assert spoken == ["Hello, sir."]


def test_speak_says_where_the_working_voice_is_when_nothing_local_can_speak(monkeypatch):
    def no_kokoro():
        raise service.VoiceError("no-model", "The Kokoro voice files are missing.")

    def no_system(_text):
        raise service.VoiceError("no-system-voice", "No system voice found.")

    monkeypatch.setattr(service, "kokoro", no_kokoro)
    monkeypatch.setattr(service, "speak_system", no_system)
    with pytest.raises(service.VoiceError) as info:
        service.speak("Hello, sir.")
    assert "Kokoro voice files are missing" in info.value.message
    assert "browser" in info.value.message.lower()


def test_speak_refuses_empty_text():
    with pytest.raises(service.VoiceError):
        service.speak("   ")
