"""Concurrency guards for the local voice service used by the Node dashboard.

Model loading is exercised with fake packages so this test never downloads a
model or opens a microphone/speaker.
"""
from concurrent.futures import ThreadPoolExecutor
import sys
import threading
import time
from types import SimpleNamespace

from local_voice import service


def _race_load(load, workers=8):
    gate = threading.Barrier(workers)

    def run():
        gate.wait(timeout=2)
        return load()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda _index: run(), range(workers)))


def test_kokoro_is_constructed_once_for_parallel_first_replies(monkeypatch):
    made = []
    guard = threading.Lock()

    class FakeKokoro:
        def __init__(self, *_args):
            with guard:
                made.append(self)
            time.sleep(0.03)

    monkeypatch.setattr(service, "_kokoro", None)
    monkeypatch.setattr(service, "_speak_failed", "")
    monkeypatch.setattr(service, "kokoro_files_present", lambda: True)
    monkeypatch.setattr(service, "log", lambda _message: None)
    monkeypatch.setitem(sys.modules, "kokoro_onnx", SimpleNamespace(Kokoro=FakeKokoro))

    loaded = _race_load(service.kokoro)

    assert len(made) == 1
    assert all(model is made[0] for model in loaded)


def test_faster_whisper_is_constructed_once_for_parallel_first_transcripts(monkeypatch):
    made = []
    guard = threading.Lock()

    class FakeWhisperModel:
        def __init__(self, *_args, **_kwargs):
            with guard:
                made.append(self)
            time.sleep(0.03)

    monkeypatch.setattr(service, "_whisper", None)
    monkeypatch.setattr(service, "_whisper_failed", None)
    monkeypatch.setattr(service, "log", lambda _message: None)
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))

    loaded = _race_load(service.whisper)

    assert len(made) == 1
    assert all(model is made[0] for model in loaded)
