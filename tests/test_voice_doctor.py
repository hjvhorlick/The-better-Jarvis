"""The audio self-test (backend/voice/doctor.py): hardware checks on fake streams,
the controller method, the HTTP route, the chat command and the policy tier."""

import pytest

from backend.devices import DeviceRegistry
from backend.events import EventBus
from backend.permissions import Tier, default_policy
from backend.router import match
from backend.voice import doctor
from backend.voice.audio import AudioUnavailable, Microphone, Speaker
from backend.voice.controller import VoiceError

from tests.test_voice_audio import FakeOpener, frame
from tests.test_voice_api import _client
from tests.test_voice_controller import Rig


class Clock:
    """A fake clock the fake sleep advances, so no test waits for real time."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def _rig(mic_fail=None, spk_fail=None):
    bus = EventBus()
    devices = DeviceRegistry(bus)
    mic_op = FakeOpener(fail_with=mic_fail)
    spk_op = FakeOpener(fail_with=spk_fail)
    clock = Clock()
    mic = Microphone(opener=mic_op)
    speaker = Speaker(opener=spk_op, clock=clock)
    devices.register("microphone", mic)
    devices.register("speaker", speaker)
    return devices, mic, speaker, mic_op, clock


def _run(devices, mic, speaker, clock, *, on_sleep=None):
    def sleep(seconds):
        clock.sleep(seconds)
        if on_sleep is not None:
            on_sleep()

    return doctor.run(devices, mic, speaker, listen_s=1.0, sleep=sleep, clock=clock)


def _by_name(result, name):
    return next(c for c in result["checks"] if c["name"] == name)


# ----- the checks themselves -----

def test_a_loud_microphone_and_a_working_speaker_pass():
    devices, mic, speaker, mic_op, clock = _rig()

    def speak():
        if mic_op.streams:                      # the mic is open during its check
            mic_op.streams[-1].callback(frame(2000))

    result = _run(devices, mic, speaker, clock, on_sleep=speak)
    spk = _by_name(result, "speaker")
    assert spk["ok"] is True and "beep" in spk["detail"]
    m = _by_name(result, "microphone")
    assert m["ok"] is True and "heard you" in m["detail"]
    # The test released everything: no holders are left behind.
    assert all(info["holders"] == [] for info in devices.snapshot().values())


def test_a_silent_microphone_fails_with_the_level_and_the_advice():
    devices, mic, speaker, mic_op, clock = _rig()

    def quiet():
        if mic_op.streams:
            mic_op.streams[-1].callback(frame(50))   # far below the speech level

    result = _run(devices, mic, speaker, clock, on_sleep=quiet)
    m = _by_name(result, "microphone")
    assert m["ok"] is False
    assert "silence" in m["detail"] and "speak normally" in m["detail"]
    assert result["ok"] is False


def test_a_microphone_that_sends_nothing_fails_and_names_the_permission():
    devices, mic, speaker, _, clock = _rig()
    result = _run(devices, mic, speaker, clock)
    m = _by_name(result, "microphone")
    assert m["ok"] is False and "no audio arrived" in m["detail"]


def test_a_muted_microphone_says_to_unmute():
    devices, mic, speaker, mic_op, clock = _rig()
    mic.set_muted(True)

    def speak():
        if mic_op.streams:
            mic_op.streams[-1].callback(frame(2000))  # dropped by mute before the tap

    result = _run(devices, mic, speaker, clock, on_sleep=speak)
    m = _by_name(result, "microphone")
    assert m["ok"] is False and "muted" in m["detail"]


def test_a_missing_speaker_fails_that_check_but_the_others_still_run():
    devices, mic, speaker, mic_op, clock = _rig(spk_fail=AudioUnavailable("no usable speaker"))
    result = _run(devices, mic, speaker, clock)
    assert _by_name(result, "speaker")["ok"] is False
    assert "no usable speaker" in _by_name(result, "speaker")["detail"]
    assert any(c["name"] == "microphone" for c in result["checks"])


def test_a_missing_microphone_fails_that_check_without_raising():
    devices, mic, speaker, _, clock = _rig(mic_fail=AudioUnavailable("no usable microphone"))
    result = _run(devices, mic, speaker, clock)
    m = _by_name(result, "microphone")
    assert m["ok"] is False and "no usable microphone" in m["detail"]


def test_the_engine_checks_report_their_reasons():
    devices, mic, speaker, _, clock = _rig()
    result = _run(devices, mic, speaker, clock)
    names = [c["name"] for c in result["checks"]]
    assert names == ["sound system", "speaker", "microphone",
                     "speech to text", "spoken replies", "wake word"]
    for name in ("speech to text", "spoken replies", "wake word"):
        assert _by_name(result, name)["detail"]          # always says something readable


def test_the_tone_is_mono_16_bit_and_one_second():
    pcm = doctor.tone_pcm()
    assert len(pcm) == doctor.SPEAKER_RATE * 2           # 1 s of 16-bit mono
    assert max(abs(int.from_bytes(pcm[i:i + 2], "little", signed=True))
               for i in range(0, 200, 2)) > 0            # it is not silence


# ----- through the controller -----

def test_the_controller_runs_the_test_and_publishes_the_outcome(tmp_path):
    rig = Rig(tmp_path)
    result = rig.ctrl.audio_test(listen_s=0.1)
    assert {"checks", "ok"} <= set(result)
    events = rig.events("audio_test")
    assert len(events) == 1 and events[0]["ok"] == result["ok"]


def test_the_test_is_refused_while_voice_is_live(tmp_path):
    rig = Rig(tmp_path)
    rig.ctrl.start_live()
    with pytest.raises(VoiceError) as e:
        rig.ctrl.audio_test()
    assert e.value.status == 409 and "Stop voice first" in str(e.value)
    rig.ctrl.stop_live()


# ----- over HTTP and in the chat -----

def test_the_route_returns_the_checks(tmp_path):
    body = _client(tmp_path).post("/api/voice/test").json()
    assert body["checks"] and all({"name", "ok", "detail"} <= set(c) for c in body["checks"])


def test_the_route_is_409_while_voice_is_live(tmp_path):
    c = _client(tmp_path)
    assert c.post("/api/voice/start").json()["live"] is True
    r = c.post("/api/voice/test")
    assert r.status_code == 409 and "Stop voice first" in r.json()["detail"]


def test_the_chat_command_reports_each_line(tmp_path):
    c = _client(tmp_path)
    reply = c.post("/api/chat", json={"text": "test the sound"}).json()["reply"]
    assert "Audio test" in reply and "microphone" in reply and ("✓" in reply or "✗" in reply)


def test_the_phrases_match_and_the_tier_is_safe():
    for text in ("test the sound", "test the audio", "check the mic",
                 "test my microphone", "test the speakers"):
        m = match(text)
        assert m is not None and m.action == "voice.test", text
    assert default_policy().tier_of("voice.test") is Tier.SAFE
