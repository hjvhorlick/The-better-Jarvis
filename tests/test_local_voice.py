"""Local voice: speech in and out on this computer, with the same agent as the chat.

The speech engines are fakes here: the real models are large and download from the internet,
and this environment has no audio device. What these tests check is the logic around them:
turn-taking, what is heard and what is ignored, barge-in, errors, the Gemini-free default, and
that the speech adapters turn their output into the rate the speaker expects.
"""
import array
import os
import threading
import wave
from types import SimpleNamespace

import pytest

from backend.devices import DeviceRegistry
from backend.events import EventBus
from backend.quota import DailyBudget
from backend.voice import factory, stt, tts
from backend.voice.audio import MIC_RATE, SPEAKER_RATE, Microphone, Speaker
from backend.voice.controller import VoiceController, VoiceError
from backend.voice.local import HANGOVER_FRAMES, LocalRelay, MAX_SPOKEN_CHARS, MAX_UTTERANCE_S
from tests.test_voice_audio import FakeOpener, frame

SPEECH = 3000          # well above SPEECH_ON (600)
QUIET = 0              # below SPEECH_OFF (350)
BLOCK = 1024           # samples per microphone block (64 ms at 16 kHz)


# ----- fakes -----

class FakeBus:
    def __init__(self):
        self.events = []

    def publish(self, source, event):
        self.events.append((source, event))

    def voice(self, kind=None):
        return [e for s, e in self.events if s == "voice" and (kind is None or e["type"] == kind)]


class FakeSpeaker:
    """Records what is queued and mimics the real speaker's counters."""

    def __init__(self):
        self.queued = bytearray()
        self.flushes = 0
        self.playing = False
        self.on_enqueue = None

    def enqueue(self, pcm):
        self.queued.extend(pcm)
        if self.on_enqueue is not None:
            self.on_enqueue(len(self.queued))

    def flush(self):
        self.flushes += 1
        return 0

    def status(self):
        return {"state": "streaming", "buffered_bytes": 0, "flushes": self.flushes}

    def is_playing(self):
        return self.playing


class FakeSTT:
    def __init__(self, texts=(), fail=None):
        self.texts = list(texts)
        self.fail = fail
        self.calls = []

    def transcribe(self, pcm, rate):
        self.calls.append((len(pcm), rate))
        if self.fail is not None:
            raise self.fail
        return self.texts.pop(0) if self.texts else ""


class FakeTTS:
    def __init__(self, seconds=0.5, fail=None):
        self.seconds = seconds
        self.fail = fail
        self.texts = []

    def speak_pcm(self, text):
        self.texts.append(text)
        if self.fail is not None:
            raise self.fail
        return bytes(int(SPEAKER_RATE * self.seconds) * 2)


def _relay(*, stt_engine=None, tts_engine=None, answer=None, speaker=None, bus=None, errors=None,
           activity=None, clock=None):
    speaker = speaker or FakeSpeaker()
    bus = bus or FakeBus()
    relay = LocalRelay(
        speaker=speaker, bus=bus,
        answer=answer if answer is not None else (lambda text: f"Reply to {text}"),
        transcriber=stt_engine if stt_engine is not None else FakeSTT(["hello jarvis"]),
        synthesiser=tts_engine,
        on_activity=activity or (lambda: None),
        on_error=(errors.append if errors is not None else (lambda m: None)),
        clock=clock or (lambda: 0.0),
        sleep=lambda s: None,
    )
    return SimpleNamespace(relay=relay, speaker=speaker, bus=bus)


def _say(relay, seconds=1.0):
    """Feed loud frames for about `seconds`, the way the microphone would."""
    for _ in range(max(1, int(round(seconds * MIC_RATE / BLOCK)))):
        relay.process(frame(SPEECH, BLOCK))


def _quiet(relay, blocks=HANGOVER_FRAMES + 1):
    for _ in range(blocks):
        relay.process(frame(QUIET, BLOCK))


# ----- turn-taking -----

def test_a_spoken_request_is_heard_answered_and_spoken(tmp_path):
    stt_engine = FakeSTT(["what is my favourite tea"])
    spoken = FakeTTS()
    r = _relay(stt_engine=stt_engine, tts_engine=spoken, answer=lambda t: "Earl grey.")
    _quiet(r.relay, 3)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert len(stt_engine.calls) == 1
    turns = r.bus.voice("voice_turn")
    assert [(t["role"], t["text"]) for t in turns] == [
        ("user", "what is my favourite tea"), ("assistant", "Earl grey.")]
    assert spoken.texts == ["Earl grey."]
    assert len(r.speaker.queued) == int(SPEAKER_RATE * 0.5) * 2
    assert r.relay.turns == 1


def test_the_speech_recogniser_receives_the_microphone_audio_at_16k(tmp_path):
    stt_engine = FakeSTT(["hi there"])
    r = _relay(stt_engine=stt_engine)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    pcm_len, rate = stt_engine.calls[0]
    assert rate == MIC_RATE
    assert pcm_len >= int(MIC_RATE * 0.9) * 2           # the speech plus the pre-roll, as 16-bit samples


def test_a_short_cough_is_not_sent_to_the_recogniser(tmp_path):
    stt_engine = FakeSTT(["never"])
    r = _relay(stt_engine=stt_engine)
    _say(r.relay, 0.2)                                 # under MIN_UTTERANCE_S of speech
    _quiet(r.relay)
    assert stt_engine.calls == []
    assert r.bus.voice("voice_turn") == []


def test_a_very_long_utterance_is_cut_and_answered(tmp_path):
    stt_engine = FakeSTT(["a long story"])
    r = _relay(stt_engine=stt_engine)
    _say(r.relay, MAX_UTTERANCE_S + 1.0)
    assert len(stt_engine.calls) == 1                  # cut at the limit, before any silence
    assert r.bus.voice("voice_turn")[0]["role"] == "user"


def test_silence_does_not_count_as_activity_but_speech_does(tmp_path):
    seen = []
    r = _relay(activity=lambda: seen.append(1))
    _quiet(r.relay, 40)
    assert seen == []                                  # quiet never keeps the session alive
    _say(r.relay, 0.5)
    assert len(seen) > 0


def test_recognition_noise_on_a_short_clip_is_ignored(tmp_path):
    answered = []
    r = _relay(stt_engine=FakeSTT(["thank you"]), answer=lambda t: answered.append(t) or "x")
    _say(r.relay, 0.6)
    _quiet(r.relay)
    assert answered == []


def test_an_empty_transcript_gets_no_answer_and_no_speech(tmp_path):
    spoken = FakeTTS()
    answered = []
    r = _relay(stt_engine=FakeSTT([""]), tts_engine=spoken, answer=lambda t: answered.append(t) or "x")
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert answered == [] and spoken.texts == []


# ----- the reply is not heard by the assistant itself -----

def test_microphone_frames_are_ignored_while_the_reply_is_spoken(tmp_path):
    r = _relay(tts_engine=FakeTTS(seconds=0.5))

    def echo(_queued):
        r.relay.push(frame(SPEECH, BLOCK))            # the speaker's own sound reaching the microphone

    r.speaker.on_enqueue = echo
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert r.relay._q.qsize() == 0                    # the echo was dropped, not queued
    assert len(r.bus.voice("voice_turn")) == 2        # and it did not start a second turn


# ----- barge-in -----

def test_barge_in_stops_the_reply_at_once(tmp_path):
    spoken = FakeTTS(seconds=6.0)                     # long enough to need several chunks
    r = _relay(tts_engine=spoken)
    total = int(SPEAKER_RATE * 6.0) * 2

    def interrupt(queued):
        r.relay.on_barge_in()

    r.speaker.on_enqueue = interrupt
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert len(r.speaker.queued) < total
    assert len(r.speaker.queued) <= 2 * (SPEAKER_RATE // 4 * 2)      # one chunk, then stopped


def test_after_barge_in_the_owner_is_heard_again(tmp_path):
    stt_engine = FakeSTT(["first question", "the second one"])
    r = _relay(stt_engine=stt_engine, tts_engine=FakeTTS(seconds=6.0))
    r.speaker.on_enqueue = lambda queued: r.relay.on_barge_in()
    _say(r.relay, 1.0)
    _quiet(r.relay)
    r.speaker.on_enqueue = None
    assert r.relay.push(frame(SPEECH, BLOCK)) is None
    assert r.relay._q.qsize() == 1                    # accepted again once the reply has stopped
    assert not r.relay._barged.is_set()


def test_a_reply_that_is_not_interrupted_plays_to_the_end(tmp_path):
    spoken = FakeTTS(seconds=1.0)
    r = _relay(tts_engine=spoken)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert len(r.speaker.queued) == int(SPEAKER_RATE * 1.0) * 2


# ----- errors and missing parts -----

def test_a_failed_recogniser_is_reported_and_the_next_turn_still_works(tmp_path):
    errors = []
    stt_engine = FakeSTT(["after the failure"], fail=RuntimeError("boom"))
    r = _relay(stt_engine=stt_engine, errors=errors)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert errors == ["speech recognition failed (RuntimeError)"]
    stt_engine.fail = None
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert [t["text"] for t in r.bus.voice("voice_turn") if t["role"] == "user"] == ["after the failure"]


def test_an_agent_error_is_spoken_as_its_message(tmp_path):
    class Budget(RuntimeError):
        pass

    def answer(text):
        raise Budget("Today's Gemini budget is used up.")

    errors = []
    spoken = FakeTTS()
    r = _relay(answer=answer, tts_engine=spoken, errors=errors)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert spoken.texts == ["Today's Gemini budget is used up."]
    assert errors == ["could not answer (Budget)"]


def test_without_a_voice_engine_the_reply_is_text_only(tmp_path):
    r = _relay(tts_engine=None)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert r.speaker.queued == bytearray()
    assert [t["role"] for t in r.bus.voice("voice_turn")] == ["user", "assistant"]


def test_a_failed_voice_engine_is_reported_and_no_audio_is_queued(tmp_path):
    errors = []
    r = _relay(tts_engine=FakeTTS(fail=OSError("no voice")), errors=errors)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert errors == ["spoken reply failed (OSError)"]
    assert r.speaker.queued == bytearray()


def test_long_replies_are_cut_for_speech_but_kept_whole_in_the_chat(tmp_path):
    long_reply = ("word " * 400).strip()
    spoken = FakeTTS()
    r = _relay(tts_engine=spoken, answer=lambda t: long_reply)
    _say(r.relay, 1.0)
    _quiet(r.relay)
    assert len(spoken.texts[0]) <= MAX_SPOKEN_CHARS + 1
    assert r.bus.voice("voice_turn")[-1]["text"] == long_reply


def test_a_stop_request_ends_the_loop(tmp_path):
    r = _relay()
    stop = threading.Event()
    stop.set()
    r.relay.run(stop)                                  # returns at once
    assert r.relay.turns == 0


# ----- speech in: the adapter -----

class _Segment:
    def __init__(self, text):
        self.text = text


class _FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((len(audio), kwargs))
        return iter([_Segment(" hello"), _Segment(" there ")]), None


def test_faster_whisper_adapter_joins_the_segments_and_uses_the_settings(monkeypatch):
    model = _FakeModel()
    monkeypatch.setenv("SUPPER_STT_LANGUAGE", "en")
    transcriber = stt.FasterWhisperTranscriber(model_factory=lambda name: model)
    text = transcriber.transcribe(bytes(MIC_RATE * 2), MIC_RATE)
    assert text == "hello there"
    n, kwargs = model.calls[0]
    assert n == MIC_RATE and kwargs["language"] == "en" and kwargs["vad_filter"] is True


def test_the_adapter_refuses_audio_that_is_not_16k():
    with pytest.raises(ValueError):
        stt.FasterWhisperTranscriber(model_factory=lambda name: _FakeModel()).transcribe(b"\0\0", 24000)


def test_the_model_loads_once(monkeypatch):
    loads = []

    def factory_fn(name):
        loads.append(name)
        return _FakeModel()

    t = stt.FasterWhisperTranscriber(model_factory=factory_fn)
    t.transcribe(bytes(3200), MIC_RATE)
    t.transcribe(bytes(3200), MIC_RATE)
    assert len(loads) == 1


def test_an_unknown_model_size_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("SUPPER_STT_MODEL", "gigantic")
    assert stt.settings()[0] == stt.DEFAULT_MODEL
    monkeypatch.setenv("SUPPER_STT_MODEL", "small")
    assert stt.settings()[0] == "small"


def test_speech_recognition_reports_missing_when_not_installed(monkeypatch):
    monkeypatch.setattr(stt.importlib.util, "find_spec", lambda name: None)
    ready, reason = stt.availability()
    assert ready is False and "requirements-local-voice" in reason


# ----- speech out: the adapters and the rate -----

def test_float_audio_at_another_rate_is_converted_to_the_speaker_rate():
    samples = [0.0] * 16000                            # one second at 16 kHz
    pcm = tts.to_speaker_pcm(samples, 16000)
    assert len(pcm) == SPEAKER_RATE * 2                # one second at 24 kHz, 16-bit


def test_loud_float_samples_are_clipped_not_wrapped():
    pcm = tts.to_speaker_pcm([2.0, -2.0], SPEAKER_RATE)
    values = array.array("h")
    values.frombytes(pcm)
    assert list(values) == [32767, -32767]


def test_kokoro_adapter_passes_the_voice_and_converts_its_output(tmp_path):
    calls = {}

    class FakeKokoro:
        def create(self, text, voice, speed, lang):
            calls.update(text=text, voice=voice, speed=speed, lang=lang)
            return [0.0] * 12000, 24000                # half a second at 24 kHz

    def engine_factory(model, voices):
        calls["files"] = (model.split("/")[-1], voices.split("/")[-1])
        return FakeKokoro()

    synth = tts.KokoroSynthesiser(tmp_path, voice="af_test", engine_factory=engine_factory)
    pcm = synth.speak_pcm("Hello.")
    assert len(pcm) == 12000 * 2
    assert calls["voice"] == "af_test" and calls["lang"] == "en-us"
    assert calls["files"] == (tts.KOKORO_MODEL, tts.KOKORO_VOICES)


def test_system_voice_adapter_reads_the_wav_it_writes_and_removes_it():
    written = {}

    class FakeEngine:
        def save_to_file(self, text, path):
            written["path"] = path
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(22050)
                w.writeframes(array.array("h", [1000] * 2205).tobytes())

        def runAndWait(self):
            written["ran"] = True

    pcm = tts.SystemSynthesiser(engine_factory=lambda: FakeEngine()).speak_pcm("Hi")
    assert written["ran"] is True
    assert len(pcm) == SPEAKER_RATE // 10 * 2         # 0.1 s at 24 kHz
    assert not os.path.exists(written["path"])        # the temporary file is removed


def test_speech_out_is_off_when_asked(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPPER_TTS_ENGINE", "off")
    ready, reason = tts.availability(tmp_path)
    assert ready is False and "switched off" in reason
    assert tts.choose(tmp_path) is None


def test_kokoro_is_chosen_when_its_files_and_package_are_present(monkeypatch, tmp_path):
    (tmp_path / tts.KOKORO_MODEL).write_bytes(b"x")
    (tmp_path / tts.KOKORO_VOICES).write_bytes(b"x")
    monkeypatch.setenv("SUPPER_TTS_ENGINE", "auto")
    monkeypatch.setattr(tts.importlib.util, "find_spec", lambda name: object())
    assert isinstance(tts.choose(tmp_path), tts.KokoroSynthesiser)


def test_the_system_voice_is_used_when_kokoro_files_are_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPPER_TTS_ENGINE", "auto")
    monkeypatch.setattr(tts.importlib.util, "find_spec", lambda name: object())
    assert isinstance(tts.choose(tmp_path), tts.SystemSynthesiser)


def test_a_forced_kokoro_without_files_says_where_they_go(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPPER_TTS_ENGINE", "kokoro")
    ready, reason = tts.availability(tmp_path)
    assert ready is False and "models/kokoro" in reason


# ----- the controller, the engine setting and the Gemini-free default -----

class _Rig:
    def __init__(self, tmp_path, *, engine="local", stt_ready=(True, "ready"), key=None):
        self.bus = EventBus()
        self.devices = DeviceRegistry(self.bus)
        self.mic = Microphone(opener=FakeOpener())
        self.spk = Speaker(opener=FakeOpener(), clock=lambda: 0.0)
        self.devices.register("microphone", self.mic)
        self.devices.register("speaker", self.spk)
        self.budget = DailyBudget(20, path=tmp_path / "quota.json")
        self.relays = []
        self.key = key

        def make_relay(**callbacks):
            self.relays.append(callbacks)
            return _NullRelay()

        self.ctrl = VoiceController(
            mic=self.mic, speaker=self.spk, devices=self.devices, bus=self.bus, budget=self.budget,
            get_key=lambda: self.key, make_relay=make_relay, wake_available=lambda: (False, "off"),
            make_detector=lambda: None, watchdog=False, engine=lambda: engine,
            local_ready=lambda: stt_ready,
        )


class _NullRelay:
    def run(self, stop):
        stop.wait(0.05)

    def push(self, frame):
        pass


def test_local_voice_starts_with_no_key_and_spends_no_budget(tmp_path):
    rig = _Rig(tmp_path, engine="local", key=None)
    status = rig.ctrl.start_live("button")
    assert status["live"] is True and status["engine"] == "local"
    assert rig.budget.snapshot()["used"] == 0
    assert "answer" in rig.relays[0] and "spend_reconnect" not in rig.relays[0]
    rig.ctrl.stop_live("test")


def test_local_voice_is_refused_when_speech_recognition_is_missing(tmp_path):
    rig = _Rig(tmp_path, engine="local", stt_ready=(False, "not installed"))
    with pytest.raises(VoiceError) as info:
        rig.ctrl.start_live("button")
    assert info.value.status == 409 and "not ready" in str(info.value)
    assert rig.mic.status()["state"] != "streaming"    # no hardware opened


def test_the_live_engine_still_needs_a_key_and_the_budget(tmp_path):
    rig = _Rig(tmp_path, engine="live", key=None)
    with pytest.raises(VoiceError) as info:
        rig.ctrl.start_live("button")
    assert info.value.status == 503


def test_the_engine_setting_defaults_to_local_and_accepts_live(monkeypatch):
    monkeypatch.delenv("SUPPER_VOICE_ENGINE", raising=False)
    assert factory.engine_setting() == "local"
    monkeypatch.setenv("SUPPER_VOICE_ENGINE", "LIVE")
    assert factory.engine_setting() == "live"
    monkeypatch.setenv("SUPPER_VOICE_ENGINE", "cloud-something")
    assert factory.engine_setting() == "local"


def test_the_app_builds_local_voice_by_default_without_opening_hardware(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPPER_VOICE_ENGINE", raising=False)
    bus = EventBus()
    devices = DeviceRegistry(bus)
    budget = DailyBudget(20, path=tmp_path / "quota.json")
    voice = factory.build(bus=bus, devices=devices, budget=budget, chat=SimpleNamespace(system_instruction=lambda: ""))
    status = voice.status()
    assert status["engine"] == "local"
    assert status["live"] is False and status["mic"]["state"] != "streaming"
    assert budget.snapshot()["used"] == 0
    voice.attach_answerer(lambda text: "ok")
    assert voice._ask_agent("hi") == "ok"


def test_status_reports_whether_local_voice_is_ready(tmp_path):
    rig = _Rig(tmp_path, engine="local", stt_ready=(False, "not installed"))
    assert rig.ctrl.status()["local_ready"] == {"ready": False, "reason": "not installed"}


def test_the_controller_tells_the_local_relay_when_the_owner_talks_over_the_reply(tmp_path):
    seen = []

    class Relay(_NullRelay):
        def on_barge_in(self):
            seen.append("barge")

    rig = _Rig(tmp_path, engine="local")
    rig.ctrl._make_relay = lambda **cb: Relay()
    rig.ctrl.start_live("button")
    rig.spk.enqueue(bytes(4000))                       # the assistant is talking
    for _ in range(4):                                 # loud enough for barge-in (1500)
        rig.ctrl._on_frame(frame(2500, BLOCK))
    assert seen == ["barge"]
    rig.ctrl.stop_live("test")


def test_the_relay_runs_on_its_own_thread_and_takes_frames_from_push(tmp_path):
    answered = threading.Event()
    r = _relay(answer=lambda text: answered.set() or "ok")
    stop = threading.Event()
    worker = threading.Thread(target=r.relay.run, args=(stop,), daemon=True)
    worker.start()
    try:
        for _ in range(3):
            r.relay.push(frame(QUIET, BLOCK))
        for _ in range(int(1.0 * MIC_RATE / BLOCK)):
            r.relay.push(frame(SPEECH, BLOCK))
        for _ in range(HANGOVER_FRAMES + 2):
            r.relay.push(frame(QUIET, BLOCK))
        assert answered.wait(3.0)
    finally:
        stop.set()
        worker.join(3.0)
    assert not worker.is_alive()
