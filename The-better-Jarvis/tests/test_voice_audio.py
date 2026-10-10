"""Audio owners, speech detection and wake-word interface. No real audio device is opened."""
import array

import pytest

from backend.voice import wake
from backend.voice.audio import AudioUnavailable, Microphone, Speaker
from backend.voice.vad import EnergyVAD, frame_rms

BLOCK = 1024


def frame(level: int, samples: int = BLOCK) -> bytes:
    return array.array("h", [level] * samples).tobytes()


class FakeStream:
    def __init__(self, callback):
        self.callback = callback
        self.started = False
        self.stopped = False
        self.closed = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def close(self):
        self.closed = True


class FakeOpener:
    """Stands in for sounddevice. Keeps the callback so a test can push blocks."""

    def __init__(self, fail_with=None):
        self.fail_with = fail_with
        self.streams = []
        self.device = "unset"

    def __call__(self, device, callback):
        self.device = device
        if self.fail_with is not None:
            raise self.fail_with
        stream = FakeStream(callback)
        self.streams.append(stream)
        return stream


# ----- microphone -----

def test_microphone_passes_blocks_to_its_sink_and_counts_them():
    opener = FakeOpener()
    mic = Microphone(device=3, opener=opener)
    got = []
    mic.set_sink(got.append)
    mic.start()
    assert opener.device == 3
    opener.streams[0].callback(frame(100))
    assert got == [frame(100)] and mic.blocks_total == 1


def test_muted_microphone_drops_blocks_at_the_source():
    opener = FakeOpener()
    mic = Microphone(opener=opener)
    got = []
    mic.set_sink(got.append)
    mic.start()
    mic.set_muted(True)
    opener.streams[0].callback(frame(100))
    assert got == [] and mic.blocks_muted == 1 and mic.muted is True
    mic.set_muted(False)
    opener.streams[0].callback(frame(100))
    assert len(got) == 1


def test_microphone_start_is_idempotent_and_stop_closes_the_stream():
    opener = FakeOpener()
    mic = Microphone(opener=opener)
    mic.start()
    mic.start()
    assert len(opener.streams) == 1
    mic.stop()
    assert opener.streams[0].stopped and opener.streams[0].closed
    assert mic.status()["state"] == "stopped"


def test_missing_portaudio_becomes_audio_unavailable_with_the_hint():
    mic = Microphone(opener=FakeOpener(fail_with=AudioUnavailable("PortAudio library not found")))
    with pytest.raises(AudioUnavailable, match="PortAudio"):
        mic.start()
    assert "PortAudio" in mic.status()["message"]


def test_other_start_failures_are_reported_without_the_raw_error():
    mic = Microphone(opener=FakeOpener(fail_with=OSError("device busy: secret detail")))
    with pytest.raises(AudioUnavailable) as info:
        mic.start()
    assert "secret detail" not in str(info.value) and "OSError" in str(info.value)


# ----- speaker -----

def test_speaker_buffers_audio_and_flush_drops_it_all():
    spk = Speaker(opener=FakeOpener())
    spk.enqueue(b"\x01\x00" * 100)
    assert spk.is_playing() is True
    dropped = spk.flush()
    assert dropped == 200 and spk.flushes == 1
    assert spk.status()["buffered_bytes"] == 0


def test_speaker_keeps_only_the_newest_audio_when_the_buffer_is_full():
    spk = Speaker(opener=FakeOpener())
    cap = spk._cap
    spk.enqueue(b"\x01" * cap)
    spk.enqueue(b"\x02" * 10)
    assert len(spk._buf) == cap and spk._buf[-10:] == b"\x02" * 10


def test_speaker_pulls_silence_when_empty_and_is_not_playing_after_the_hold():
    now = [0.0]
    spk = Speaker(opener=FakeOpener(), clock=lambda: now[0])
    spk.enqueue(b"\x10\x00" * 8)
    assert spk._pull(16) == b"\x10\x00" * 8
    assert spk.is_playing() is True                 # still inside the hold window
    now[0] = 5.0
    assert spk._pull(16) == b"\x00" * 16
    assert spk.is_playing() is False


def test_speaker_stop_clears_the_buffer():
    opener = FakeOpener()
    spk = Speaker(opener=opener)
    spk.start()
    spk.enqueue(b"\x01\x00" * 4)
    spk.stop()
    assert opener.streams[0].closed and spk.status()["buffered_bytes"] == 0


# ----- speech detection -----

def test_frame_rms_of_silence_and_a_constant_level():
    assert frame_rms(frame(0)) == 0.0
    assert frame_rms(frame(1000)) == pytest.approx(1000.0)
    assert frame_rms(b"") == 0.0


def test_vad_needs_a_run_of_loud_frames_to_start():
    vad = EnergyVAD(on_threshold=500, off_threshold=300, attack_frames=3, hangover_frames=2)
    assert [vad.process(frame(600)) for _ in range(2)] == [False, False]
    assert vad.process(frame(600)) is True


def test_vad_one_quiet_frame_resets_the_attack_count():
    vad = EnergyVAD(on_threshold=500, off_threshold=300, attack_frames=3, hangover_frames=2)
    vad.process(frame(600)); vad.process(frame(600)); vad.process(frame(0))
    assert vad.process(frame(600)) is False


def test_vad_hangover_keeps_speaking_through_short_gaps_then_stops():
    vad = EnergyVAD(on_threshold=500, off_threshold=300, attack_frames=1, hangover_frames=3)
    assert vad.process(frame(800)) is True
    assert [vad.process(frame(0)) for _ in range(2)] == [True, True]
    assert vad.process(frame(0)) is False


def test_vad_rejects_off_threshold_above_on_threshold():
    with pytest.raises(ValueError):
        EnergyVAD(on_threshold=300, off_threshold=500)


def test_barge_in_thresholds_ignore_the_quieter_speaker_echo():
    # The controller uses on=1500. Speaker output near 1000 must not start barge-in.
    vad = EnergyVAD(on_threshold=1500, off_threshold=900, attack_frames=3, hangover_frames=8)
    assert not any(vad.process(frame(1000)) for _ in range(20))
    assert [vad.process(frame(2000)) for _ in range(3)] == [False, False, True]


# ----- wake word -----

def test_null_detector_never_fires():
    d = wake.NullDetector()
    assert d.feed(frame(9000)) is False
    d.close()


def test_availability_reports_missing_package_without_loading_anything(monkeypatch):
    monkeypatch.setattr(wake.importlib.util, "find_spec", lambda name: None)
    ready, reason = wake.availability()
    assert ready is False and "not installed" in reason


def _fake_openwakeword(monkeypatch, tmp_path, files=()):
    """A fake openwakeword package on disk: only the named files exist in resources/models.

    The bundled model folder is pointed at an empty place, so only the fake package counts.
    """
    monkeypatch.setattr(wake, "MODEL_DIR", tmp_path / "no-bundled-models")
    pkg = tmp_path / "openwakeword"
    models = pkg / "resources" / "models"
    models.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    for name in files:
        (models / name).write_bytes(b"x")
    spec = type("Spec", (), {"origin": str(pkg / "__init__.py")})()
    monkeypatch.setattr(wake.importlib.util, "find_spec", lambda name: spec)


def test_availability_needs_the_feature_models_and_the_wake_model(monkeypatch, tmp_path):
    _fake_openwakeword(monkeypatch, tmp_path, files=())
    ready, reason = wake.availability()
    assert ready is False and "not downloaded yet" in reason
    assert "melspectrogram.onnx" in reason and "hey_jarvis*.onnx" in reason


def test_availability_still_missing_the_wake_model_when_features_exist(monkeypatch, tmp_path):
    _fake_openwakeword(monkeypatch, tmp_path, files=("melspectrogram.onnx", "embedding_model.onnx"))
    ready, reason = wake.availability()
    assert ready is False and "hey_jarvis*.onnx" in reason and "melspectrogram" not in reason


def test_availability_ready_when_all_onnx_files_are_present(monkeypatch, tmp_path):
    _fake_openwakeword(monkeypatch, tmp_path,
                       files=("melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"))
    assert wake.availability() == (True, "ready")


def test_tflite_only_does_not_count_because_the_adapter_uses_onnx(monkeypatch, tmp_path):
    _fake_openwakeword(monkeypatch, tmp_path,
                       files=("melspectrogram.tflite", "embedding_model.tflite", "hey_jarvis_v0.1.tflite"))
    ready, _ = wake.availability()
    assert ready is False


class FakeModel:
    def __init__(self, scores):
        self.scores = list(scores)
        self.calls = 0

    def predict(self, samples):
        self.calls += 1
        assert len(samples) == wake.CHUNK_SAMPLES
        return {"hey_jarvis_v1": self.scores.pop(0) if self.scores else 0.0}


def test_detector_loads_the_model_lazily_and_fires_above_threshold():
    built = []

    def factory():
        built.append(1)
        return FakeModel([0.1, 0.9])

    d = wake.OpenWakeWordDetector(threshold=0.5, model_factory=factory)
    assert built == []                              # nothing loaded until audio arrives
    chunk = b"\x00\x00" * wake.CHUNK_SAMPLES
    assert d.feed(chunk) is False
    assert d.feed(chunk) is True
    assert built == [1]


def test_detector_waits_for_a_full_chunk_before_scoring():
    d = wake.OpenWakeWordDetector(model_factory=lambda: FakeModel([0.99]))
    assert d.feed(b"\x00\x00" * (wake.CHUNK_SAMPLES - 1)) is False
    assert d.feed(b"\x00\x00") is True


def test_detector_ignores_scores_for_other_models():
    class Other(FakeModel):
        def predict(self, samples):
            return {"alexa": 0.99}

    d = wake.OpenWakeWordDetector(model_factory=lambda: Other([]))
    assert d.feed(b"\x00\x00" * wake.CHUNK_SAMPLES) is False


def test_a_closed_detector_ignores_late_frames_and_does_not_reload_the_model():
    built = []

    def factory():
        built.append(1)
        return FakeModel([0.99])

    d = wake.OpenWakeWordDetector(model_factory=factory)
    d.close()
    assert d.feed(b"\x00\x00" * wake.CHUNK_SAMPLES) is False
    assert built == []
