"""Wake word as the normal way to start voice: on at start-up when the model is installed.

Checks: it stays off when the setting says so, or when the model is not installed (and says why);
it turns on when ready; a missing microphone does not crash start-up; the app closes voice at
shutdown; the model download needs an explicit licence flag and calls openWakeWord's own download.
No microphone and no network are used: the audio and detector are fakes.
"""
from fastapi.testclient import TestClient

from backend import config
from backend.app import create_app
from backend.chat import ChatService
from backend.devices import DeviceRegistry
from backend.events import EventBus
from backend.quota import DailyBudget
from backend.voice import factory
from backend.voice.audio import AudioUnavailable, Microphone, Speaker
from backend.voice.controller import VoiceController
from tests.test_voice_audio import FakeOpener

import importlib.util
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "tools" / "check_wake_model.py"
_spec = importlib.util.spec_from_file_location("check_wake_model", TOOL)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

import shutil
import wave

import pytest

from backend.voice import wake

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "wake"


class FakeDetector:
    def __init__(self):
        self.closed = False

    def feed(self, frame):
        return False

    def close(self):
        self.closed = True


def _controller(tmp_path, *, wake_default, wake_ready=(True, "ready"), mic_fail=None):
    bus = EventBus()
    devices = DeviceRegistry(bus)
    mic = Microphone(opener=FakeOpener(fail_with=mic_fail))
    spk = Speaker(opener=FakeOpener(), clock=lambda: 0.0)
    devices.register("microphone", mic)
    devices.register("speaker", spk)
    detectors = []

    def make_detector():
        d = FakeDetector()
        detectors.append(d)
        return d

    ctrl = VoiceController(
        mic=mic, speaker=spk, devices=devices, bus=bus,
        budget=DailyBudget(20, path=tmp_path / "quota.json"),
        get_key=lambda: None, make_relay=lambda **cb: None,
        wake_available=lambda: wake_ready, make_detector=make_detector,
        watchdog=False, wake_default=lambda: wake_default,
    )
    return ctrl, detectors


def test_wake_stays_off_when_the_setting_is_off(tmp_path):
    ctrl, detectors = _controller(tmp_path, wake_default=False)
    assert ctrl.autostart_wake()["wake"]["enabled"] is False
    assert detectors == []


def test_wake_says_why_and_stays_off_when_the_model_is_not_installed(tmp_path):
    ctrl, detectors = _controller(tmp_path, wake_default=True, wake_ready=(False, "model not downloaded"))
    status = ctrl.autostart_wake()                       # must not raise
    assert status["wake"]["enabled"] is False
    assert status["wake"]["reason"] == "model not downloaded"
    assert detectors == []


def test_wake_turns_on_at_start_when_ready(tmp_path):
    ctrl, detectors = _controller(tmp_path, wake_default=True)
    status = ctrl.autostart_wake()
    assert status["wake"]["enabled"] is True
    assert len(detectors) == 1
    ctrl.close()
    assert detectors[0].closed is True


def test_a_missing_microphone_does_not_stop_start_up(tmp_path):
    ctrl, detectors = _controller(tmp_path, wake_default=True, mic_fail=AudioUnavailable("no microphone"))
    status = ctrl.autostart_wake()                       # no exception
    assert status["wake"]["enabled"] is False
    assert status["last_error"] == "no microphone"
    assert detectors and detectors[0].closed             # the detector is closed again, not left open


def test_the_setting_is_on_unless_switched_off(monkeypatch):
    monkeypatch.delenv("SUPPER_WAKE_WORD", raising=False)
    assert factory.wake_setting() is True
    monkeypatch.setenv("SUPPER_WAKE_WORD", "off")
    assert factory.wake_setting() is False
    monkeypatch.setenv("SUPPER_WAKE_WORD", "No")
    assert factory.wake_setting() is False


class _VoiceSpy:
    def __init__(self):
        self.calls = []

    def status(self):
        return {"live": False, "wake": {"enabled": False, "available": False, "reason": "spy"}}

    def autostart_wake(self):
        self.calls.append("autostart")
        return self.status()

    def close(self):
        self.calls.append("close")


def test_the_app_starts_wake_at_start_up_and_closes_voice_at_shutdown(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")
    spy = _VoiceSpy()
    app = create_app(ChatService(client_factory=None, model="x"), serve_ui=False, voice=spy)
    with TestClient(app, base_url="http://127.0.0.1:8765"):
        assert spy.calls == ["autostart"]
    assert spy.calls == ["autostart", "close"]


# ----- the bundled model files -----

def test_the_bundled_files_match_their_checksums_and_wake_is_ready():
    for name in (wake.WAKE_MODEL_FILE, *wake.FEATURE_MODELS):
        assert (wake.MODEL_DIR / name).is_file(), name
        assert wake._sha256(wake.MODEL_DIR / name) == wake.BUNDLED_SHA256[name], name
    ready, reason = wake.availability()
    assert ready is True and reason == "ready"


def test_a_corrupted_bundled_file_stops_wake_and_says_so(monkeypatch, tmp_path):
    folder = tmp_path / "wake_models"
    shutil.copytree(wake.MODEL_DIR, folder)
    (folder / "melspectrogram.onnx").write_bytes(b"not the model")
    monkeypatch.setattr(wake, "MODEL_DIR", folder)
    ready, reason = wake.availability()
    assert ready is False and "melspectrogram.onnx" in reason and "checksum" in reason


def test_the_checker_reports_ready_and_exit_zero(capsys):
    code = check.main()
    out = capsys.readouterr().out
    assert code == 0
    assert "CC BY-NC-SA 4.0" in out and "Wake word is ready" in out
    assert out.count("OK ") == 3


def test_the_checker_reports_a_missing_file_and_exit_one(monkeypatch, tmp_path, capsys):
    folder = tmp_path / "wake_models"
    shutil.copytree(wake.MODEL_DIR, folder)
    (folder / "embedding_model.onnx").unlink()
    monkeypatch.setattr(wake, "MODEL_DIR", folder)
    monkeypatch.setattr(wake, "_package_models_dir", lambda: tmp_path / "no-package")
    code = check.main()
    out = capsys.readouterr().out
    assert code == 1 and "MISSING  embedding_model.onnx" in out and "not ready" in out


def test_the_app_never_downloads_anything_for_the_wake_word():
    source = (Path(wake.__file__)).read_text(encoding="utf-8")
    assert "download_models" not in source and "urlopen" not in source and "requests" not in source


# ----- real detection on the bundled model (synthesized speech, not a microphone) -----

def _read_wav(path):
    import numpy as np
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def _best_score(path):
    import numpy as np
    pytest.importorskip("openwakeword")
    pytest.importorskip("onnxruntime")
    model = wake._load_model()
    pad = np.zeros(16000, dtype=np.int16)
    pcm = np.concatenate([pad, _read_wav(path), pad])
    best = 0.0
    for i in range(0, len(pcm) - wake.CHUNK_SAMPLES + 1, wake.CHUNK_SAMPLES):
        for name, value in model.predict(pcm[i:i + wake.CHUNK_SAMPLES]).items():
            if str(name).startswith(wake.WAKE_MODEL):
                best = max(best, float(value))
    return best


@pytest.mark.parametrize("clip", ["hey_jarvis_a.wav", "hey_jarvis_c.wav"])
def test_hey_jarvis_speech_is_detected(clip):
    assert _best_score(FIXTURES / clip) >= 0.5


@pytest.mark.parametrize("clip", ["neg_lights.wav", "neg_hello.wav"])
def test_other_speech_is_not_detected(clip):
    assert _best_score(FIXTURES / clip) < 0.1
