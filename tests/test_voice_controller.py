"""VoiceController state rules, with real audio owners on fake streams and a fake relay."""

import time

import pytest

from backend.devices import DeviceRegistry
from backend.events import EventBus
from backend.quota import DailyBudget
from backend.voice.audio import AudioUnavailable, Microphone, Speaker
from backend.voice.controller import VoiceController, VoiceError

from tests.test_voice_audio import FakeOpener, frame


class FakeRelay:
    instances = []

    def __init__(self, **callbacks):
        self.callbacks = callbacks
        self.pushed = []
        self.ran = False
        self.finished = False
        FakeRelay.instances.append(self)

    def push(self, data):
        self.pushed.append(data)

    def run(self, stop):
        self.ran = True
        stop.wait(5)
        self.finished = True


class FakeDetector:
    def __init__(self, fire_on=None):
        self.fire_on = fire_on
        self.fed = 0
        self.closed = False

    def feed(self, data):
        self.fed += 1
        return self.fire_on is not None and self.fed == self.fire_on

    def close(self):
        self.closed = True


class Rig:
    def __init__(self, tmp_path, *, key="k", budget_limit=20, idle_s=60.0, wake=(True, "ready"),
                 mic_fail=None, spk_fail=None, watchdog=False, fire_on=None):
        FakeRelay.instances.clear()
        self.bus = EventBus()
        self.devices = DeviceRegistry(self.bus)
        self.mic_op = FakeOpener(fail_with=mic_fail)
        self.spk_op = FakeOpener(fail_with=spk_fail)
        self.clock = [0.0]
        self.mic = Microphone(opener=self.mic_op)
        self.spk = Speaker(opener=self.spk_op, clock=lambda: self.clock[0])
        self.devices.register("microphone", self.mic)
        self.devices.register("speaker", self.spk)
        self.budget = DailyBudget(budget_limit, path=tmp_path / "quota.json")
        self.key = key
        self.wake = wake
        self.detectors = []
        self.fire_on = fire_on
        self.ctrl = VoiceController(
            mic=self.mic, speaker=self.spk, devices=self.devices, bus=self.bus, budget=self.budget,
            get_key=lambda: self.key,
            make_relay=lambda **cb: FakeRelay(**cb),
            wake_available=lambda: self.wake,
            make_detector=self._make_detector,
            idle_s=idle_s, watchdog=watchdog,
        )

    def _make_detector(self):
        d = FakeDetector(fire_on=self.fire_on)
        self.detectors.append(d)
        return d

    def mic_block(self, data):
        """What the sound driver does: hand one block to the microphone owner."""
        self.mic_op.streams[-1].callback(data)

    def events(self, kind=None):
        out = [e for _, e in self.bus.since(0, source="voice")]
        return [e for e in out if kind is None or e["type"] == kind]

    def holders(self):
        snap = self.devices.snapshot()
        return {name: info["holders"] for name, info in snap.items()}


def strip(event):
    """Drop the fields the bus stamps (source, at) so tests compare what the controller sent."""
    return {k: v for k, v in event.items() if k not in ("source", "at")}


def wait_until(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


# ----- start and stop -----

def test_start_opens_both_devices_and_starts_the_relay(rig):
    state = rig.ctrl.start_live("button")
    assert state["live"] is True and state["origin"] == "button"
    assert rig.mic.status()["state"] == "streaming" and rig.spk.status()["state"] == "streaming"
    assert wait_until(lambda: FakeRelay.instances and FakeRelay.instances[0].ran)
    assert rig.holders()["microphone"] == ["voice"] and rig.holders()["speaker"] == ["voice"]
    assert strip(rig.events("voice_state")[-1]) == {"type": "voice_state", "state": "live", "origin": "button"}


def test_start_without_a_key_is_503_and_opens_nothing(tmp_path):
    rig = Rig(tmp_path, key=None)
    with pytest.raises(VoiceError) as info:
        rig.ctrl.start_live()
    assert info.value.status == 503
    assert rig.mic.status()["state"] == "stopped" and FakeRelay.instances == []
    assert rig.holders()["microphone"] == []


def test_start_while_offline_is_503_and_spends_nothing_more(tmp_path):
    rig = Rig(tmp_path)
    rig.budget.mark_exhausted()                    # Google's 429, not this app's count
    with pytest.raises(VoiceError) as info:
        rig.ctrl.start_live()
    assert info.value.status == 503 and "offline" in str(info.value)
    assert FakeRelay.instances == [] and rig.mic.status()["state"] == "stopped"


def test_starting_twice_does_not_make_a_second_session(rig):
    rig.ctrl.start_live()
    rig.ctrl.start_live()
    assert len(FakeRelay.instances) == 1
    assert rig.budget.snapshot()["used"] == 1


def test_a_missing_microphone_is_503_and_leaves_no_holder(tmp_path):
    rig = Rig(tmp_path, mic_fail=AudioUnavailable("PortAudio library not found"))
    with pytest.raises(VoiceError) as info:
        rig.ctrl.start_live()
    assert info.value.status == 503 and "PortAudio" in str(info.value)
    assert rig.holders()["microphone"] == [] and rig.holders()["speaker"] == []
    assert rig.ctrl.live is False and "PortAudio" in rig.ctrl.status()["last_error"]


def test_a_missing_speaker_rolls_the_microphone_back(tmp_path):
    rig = Rig(tmp_path, spk_fail=AudioUnavailable("no output device"))
    with pytest.raises(VoiceError):
        rig.ctrl.start_live()
    assert rig.mic_op.streams[0].closed is True
    assert rig.holders()["microphone"] == [] and rig.ctrl.live is False


def test_stop_releases_devices_and_stops_the_relay(rig):
    rig.ctrl.start_live()
    relay = FakeRelay.instances[0]
    state = rig.ctrl.stop_live("user")
    assert state["live"] is False
    assert rig.mic_op.streams[0].closed is True and rig.spk_op.streams[0].closed is True
    assert rig.holders()["microphone"] == [] and rig.holders()["speaker"] == []
    assert rig.events("voice_state")[-1]["state"] == "off"
    assert relay.finished is True                    # the relay thread was told to stop and exited


def test_stopping_when_not_live_is_harmless(rig):
    assert rig.ctrl.stop_live()["live"] is False


# ----- audio routing -----

def test_microphone_blocks_go_to_the_relay_while_live(rig):
    rig.ctrl.start_live()
    rig.mic_block(frame(100))
    rig.mic_block(frame(200))
    assert FakeRelay.instances[0].pushed == [frame(100), frame(200)]


def test_mute_stops_audio_at_the_microphone(rig):
    rig.ctrl.start_live()
    rig.ctrl.set_muted(True)
    rig.mic_block(frame(100))
    assert FakeRelay.instances[0].pushed == [] and rig.ctrl.status()["muted"] is True
    assert rig.events("voice_state")[-1]["state"] == "muted"
    rig.ctrl.set_muted(False)
    rig.mic_block(frame(100))
    assert len(FakeRelay.instances[0].pushed) == 1


def test_barge_in_flushes_playing_audio_on_loud_speech(rig):
    rig.ctrl.start_live()
    rig.spk.enqueue(b"\x01\x00" * 4000)              # the assistant is speaking
    rig.mic_block(frame(2000))
    rig.mic_block(frame(2000))
    rig.mic_block(frame(2000))
    assert rig.spk.flushes == 1
    assert rig.spk.status()["buffered_bytes"] == 0
    assert any(e["type"] == "barge_in" for e in rig.events())


def test_quiet_sound_while_speaking_does_not_barge_in(rig):
    rig.ctrl.start_live()
    rig.spk.enqueue(b"\x01\x00" * 4000)
    for _ in range(10):
        rig.mic_block(frame(1000))                   # echo-level sound, below the barge-in threshold
    assert rig.spk.flushes == 0


def test_loud_speech_while_silent_does_not_flush(rig):
    rig.ctrl.start_live()
    for _ in range(5):
        rig.mic_block(frame(3000))
    assert rig.spk.flushes == 0


# ----- idle stop -----

def test_live_session_stops_after_idle_silence(tmp_path):
    rig = Rig(tmp_path, idle_s=0.2, watchdog=True)
    rig.ctrl.start_live()
    assert wait_until(lambda: rig.ctrl.live is False, timeout=4)
    assert strip(rig.events("voice_state")[-1]) == {"type": "voice_state", "state": "off", "reason": "idle"}


def test_activity_keeps_the_session_alive(tmp_path):
    rig = Rig(tmp_path, idle_s=0.5, watchdog=True)
    rig.ctrl.start_live()
    for _ in range(8):
        time.sleep(0.15)
        FakeRelay.instances[0].callbacks["on_activity"]()
    assert rig.ctrl.live is True
    rig.ctrl.stop_live()


# ----- wake word -----

def test_wake_word_is_refused_when_not_ready(tmp_path):
    rig = Rig(tmp_path, wake=(False, "wake word model not downloaded yet"))
    with pytest.raises(VoiceError) as info:
        rig.ctrl.set_wake(True)
    assert info.value.status == 409 and "not downloaded" in str(info.value)
    assert rig.detectors == [] and rig.ctrl.status()["wake"]["enabled"] is False


def test_wake_listens_on_the_server_and_starts_live_when_heard(tmp_path):
    rig = Rig(tmp_path, fire_on=3)
    rig.ctrl.set_wake(True)
    assert rig.ctrl.status()["wake"]["enabled"] is True
    assert rig.holders()["microphone"] == ["wake"]
    for _ in range(3):
        rig.mic_block(frame(100))
    assert wait_until(lambda: rig.ctrl.live)
    assert rig.ctrl.status()["origin"] == "wake"
    assert any(e["type"] == "voice_wake" for e in rig.events())
    rig.ctrl.close()


def test_frames_do_not_reach_the_wake_detector_while_live(tmp_path):
    rig = Rig(tmp_path, fire_on=None)
    rig.ctrl.set_wake(True)
    rig.ctrl.start_live()
    for _ in range(4):
        rig.mic_block(frame(100))
        time.sleep(0.02)
    assert rig.detectors[0].fed == 0
    assert len(FakeRelay.instances[0].pushed) == 4
    rig.ctrl.close()


def test_wake_keeps_the_microphone_open_after_a_live_session_ends(tmp_path):
    rig = Rig(tmp_path, fire_on=None)
    rig.ctrl.set_wake(True)
    rig.ctrl.start_live()
    rig.ctrl.stop_live()
    assert rig.holders()["microphone"] == ["wake"]
    assert rig.mic.status()["state"] == "streaming"
    rig.ctrl.close()


def test_disabling_wake_closes_the_detector_and_the_microphone(tmp_path):
    rig = Rig(tmp_path)
    rig.ctrl.set_wake(True)
    detector = rig.detectors[0]
    state = rig.ctrl.set_wake(False)
    assert state["wake"]["enabled"] is False
    assert detector.closed is True and rig.holders()["microphone"] == []
    assert rig.events("voice_state")[-1]["state"] == "wake_off"


def test_wake_fails_cleanly_when_the_microphone_is_missing(tmp_path):
    rig = Rig(tmp_path, mic_fail=AudioUnavailable("no input device"))
    with pytest.raises(VoiceError) as info:
        rig.ctrl.set_wake(True)
    assert info.value.status == 503
    assert rig.detectors[0].closed is True
    assert rig.ctrl.status()["wake"]["enabled"] is False and rig.holders()["microphone"] == []


def test_setting_wake_to_its_current_value_changes_nothing(tmp_path):
    rig = Rig(tmp_path)
    rig.ctrl.set_wake(False)
    assert rig.detectors == []
    rig.ctrl.set_wake(True)
    rig.ctrl.set_wake(True)
    assert len(rig.detectors) == 1
    rig.ctrl.close()


# ----- status and shutdown -----

def test_status_reports_devices_and_wake_readiness(rig):
    s = rig.ctrl.status()
    assert s["live"] is False and s["wake"] == {"enabled": False, "available": True, "reason": "ready"}
    assert set(s) >= {"live", "origin", "muted", "wake", "idle_off_s", "last_error", "mic", "speaker"}


def test_close_stops_live_and_wake(tmp_path):
    rig = Rig(tmp_path)
    rig.ctrl.set_wake(True)
    rig.ctrl.start_live()
    rig.ctrl.close()
    assert rig.ctrl.live is False and rig.ctrl.status()["wake"]["enabled"] is False
    assert rig.holders()["microphone"] == [] and rig.holders()["speaker"] == []


# ----- wake word failure paths -----

def test_a_failing_wake_detector_stops_listening_and_says_why(tmp_path, monkeypatch):
    def broken(self, data):
        raise RuntimeError("model file damaged")
    monkeypatch.setattr(FakeDetector, "feed", broken)
    rig = Rig(tmp_path)
    rig.ctrl.set_wake(True)
    rig.mic_block(frame(100))
    assert wait_until(lambda: "wake word stopped" in rig.ctrl.status()["last_error"])
    assert rig.ctrl.status()["last_error"] == "wake word stopped (RuntimeError)"
    assert rig.ctrl.live is False
    rig.ctrl.close()


def test_a_heard_wake_word_without_a_key_reports_the_error_and_does_not_go_live(tmp_path):
    rig = Rig(tmp_path, key=None, fire_on=1)
    rig.ctrl.set_wake(True)
    rig.mic_block(frame(100))
    assert wait_until(lambda: rig.ctrl.status()["last_error"] != "")
    assert rig.ctrl.status()["last_error"] == "No Gemini API key on this server. Voice needs one."
    assert rig.ctrl.live is False
    assert any(e["type"] == "voice_wake" for e in rig.events())
    rig.ctrl.close()
