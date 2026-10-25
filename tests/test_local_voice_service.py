"""The dashboard's local voice sidecar (local_voice/service.py): speakers.

The failure these tests pin down was silent by construction. The desktop
Jarvis resolves the owner's saved speaker NAME through core/audio_devices —
which measures which host API actually moves audio — but this service opened
sounddevice with no device at all, so the Kokoro voice went to whatever the
OS default happened to be and reported success into the wrong (or a dead)
endpoint. The service also kept one blocking output stream open between
replies, so a suspended sink could swallow every reply after the first.

No real audio hardware or speech models here: sounddevice and Kokoro are
fakes, and a tiny stand-in covers the two numpy calls playback makes.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("local_voice_service", ROOT / "local_voice" / "service.py")
service = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = service
_spec.loader.exec_module(service)

REAL_RESOLVE = service.resolve_output_device


class FakeArray(list):
    def reshape(self, *shape):
        if shape == (-1, 1):
            return [[x] for x in self]
        return list(self)


class FakeNP:
    float32 = "float32"

    @staticmethod
    def asarray(samples, dtype=None):
        return samples if isinstance(samples, FakeArray) else FakeArray(samples)

    @staticmethod
    def zeros(shape, dtype=None):
        if isinstance(shape, tuple):
            rows, cols = shape
            return [[0.0] * cols for _ in range(rows)]
        return FakeArray([0.0] * int(shape))

    @staticmethod
    def concatenate(parts):
        out = FakeArray()
        for part in parts:
            out.extend(list(part))
        return out


class FakeStream:
    instances: list = []
    fail_open: set = set()
    fail_write: set = set()

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.device = kwargs.get("device")
        self.writes = []
        self.started = self.stopped = self.aborted = self.closed = False
        type(self).instances.append(self)
        if self.device in type(self).fail_open:
            raise RuntimeError("device will not open")

    def start(self):
        self.started = True

    def write(self, chunk):
        if self.device in type(self).fail_write:
            raise RuntimeError("device will not accept audio")
        self.writes.append(chunk)

    def stop(self):
        self.stopped = True

    def abort(self):
        self.aborted = True

    def close(self):
        self.closed = True


def make_fake_sd():
    plays = []

    def play(data, rate=None, device=None):
        plays.append({"data": data, "rate": rate, "device": device})

    return SimpleNamespace(
        OutputStream=FakeStream,
        play=play,
        wait=lambda: None,
        stop=lambda: None,
        plays=plays,
        query_devices=lambda device=None, kind=None: {
            "name": "Chosen Speakers" if device == 7 else "Default Speakers"
        },
    )


class FakeKokoro:
    async def create_stream(self, text, voice, speed, lang):
        yield [0.1, 0.2], 24000
        yield [0.3], 24000

    def create(self, text, voice, speed, lang):
        return [0.25, 0.5], 24000


@pytest.fixture
def voice_service(monkeypatch):
    FakeStream.instances = []
    FakeStream.fail_open = set()
    FakeStream.fail_write = set()
    sd = make_fake_sd()
    monkeypatch.setitem(sys.modules, "sounddevice", sd)
    monkeypatch.setattr(service, "np", FakeNP)
    monkeypatch.setattr(service, "_kokoro", FakeKokoro())
    monkeypatch.setattr(service, "_active_stream", None)
    monkeypatch.setattr(service, "_speech_stopped", False)
    monkeypatch.setattr(service, "_output_failed", "")
    service._forget_output_device()
    monkeypatch.setattr(service, "resolve_output_device", lambda rate=24000: (7, "Chosen Speakers"))
    return SimpleNamespace(sd=sd)


def test_play_stream_uses_the_chosen_speakers_and_closes_after_the_reply(voice_service):
    service.play_stream("Hello, sir.")
    assert [s.device for s in FakeStream.instances] == [7], \
        "the local voice must open the resolved speaker, not the bare default"
    stream = FakeStream.instances[0]
    assert stream.started and stream.stopped and stream.closed and not stream.aborted
    assert len(stream.writes) == 3, "wake-up silence, then the two Kokoro pieces"
    assert len(stream.writes[0]) == 1440 and all(row == [0.0] for row in stream.writes[0])
    assert stream.writes[1] == [[0.1], [0.2]]
    assert stream.writes[2] == [[0.3]]
    assert service._active_stream is None
    assert service._output_failed == ""


def test_a_chosen_speaker_that_will_not_open_falls_back_to_the_default_same_reply(voice_service):
    FakeStream.fail_open = {7}
    service.play_stream("Hello, sir.")
    assert [s.device for s in FakeStream.instances] == [7, None]
    assert len(FakeStream.instances[1].writes) == 3, "the reply is still spoken, on the default"


def test_a_chosen_speaker_that_will_not_accept_audio_falls_back_before_any_speech(voice_service):
    FakeStream.fail_write = {7}
    service.play_stream("Hello, sir.")
    assert [s.device for s in FakeStream.instances] == [7, None]
    assert FakeStream.instances[0].aborted and FakeStream.instances[0].closed
    assert len(FakeStream.instances[1].writes) == 3


def test_the_non_streaming_path_uses_the_same_chosen_speakers(voice_service):
    service.play([0.25, 0.5], 24000)
    assert len(voice_service.sd.plays) == 1
    played = voice_service.sd.plays[0]
    assert played["device"] == 7
    assert played["rate"] == 24000
    assert len(played["data"]) == 1440 + 2, "the wake-up silence rides in front of the speech"


def test_a_saved_speaker_name_is_resolved_through_the_desktop_device_picker(voice_service, monkeypatch):
    calls = {}
    audio = types.ModuleType("core.audio_devices")
    audio.configure = lambda in_rate, out_rate: calls.update(configure=(in_rate, out_rate))
    audio.resolve = lambda name, kind: calls.update(resolve=(name, kind)) or 7
    core = types.ModuleType("core")
    core.audio_devices = audio
    monkeypatch.setitem(sys.modules, "core", core)
    monkeypatch.setitem(sys.modules, "core.audio_devices", audio)
    monkeypatch.setattr(service, "_configured_output_name", lambda: ("USB Headset", "the saved speaker"))
    service._forget_output_device()

    device, label = REAL_RESOLVE(24000)
    assert device == 7
    assert label == "Chosen Speakers"
    assert calls["configure"] == (service.STT_RATE, 24000)
    assert calls["resolve"] == ("USB Headset", "output"), \
        "names are resolved to the measured endpoint, never passed bare to sounddevice"


def test_the_environment_speaker_overrides_the_saved_one(monkeypatch):
    monkeypatch.setenv("SUPPER_SPEAKER_DEVICE", "USB Headset")
    assert service._configured_output_name() == ("USB Headset", "SUPPER_SPEAKER_DEVICE")
