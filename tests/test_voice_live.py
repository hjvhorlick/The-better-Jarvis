"""Gemini Live relay, with a scripted fake session. No network, no key."""
import asyncio
import threading
import time
from types import SimpleNamespace

from backend import config
from backend.events import EventBus
from backend.voice import live
from backend.voice.live import LiveRelay


class FakeSpeaker:
    def __init__(self):
        self.chunks = []
        self.flushes = 0

    def enqueue(self, pcm):
        self.chunks.append(pcm)

    def flush(self):
        self.flushes += 1
        return 0


class FakeSession:
    """Sends are recorded. receive() yields the scripted responses, then waits."""

    def __init__(self, script, sent):
        self._script = list(script)
        self._sent = sent

    async def send_realtime_input(self, audio):
        self._sent.append(audio)

    async def receive(self):
        for item in self._script:
            if isinstance(item, BaseException):
                raise item                          # a dropped connection
            yield item
        while True:
            await asyncio.sleep(0.01)


class FakeConnection:
    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


def make_relay(script=(), connect_error=None, spend=None, key="k", bus=None, errors=None, sessions=None):
    """`sessions`: optional list of scripts, one per connection (overrides `script`)."""
    sent = []
    speaker = FakeSpeaker()
    bus = bus or EventBus()
    calls = {"connect": 0, "spend": 0, "activity": 0}

    def connect(client, cfg):
        calls["connect"] += 1
        calls["cfg"] = cfg
        if connect_error is not None:
            raise connect_error
        this = sessions.pop(0) if sessions else script
        return FakeConnection(FakeSession(this, sent))

    def spend_reconnect():
        calls["spend"] += 1
        return True if spend is None else spend()

    def bump():
        calls["activity"] += 1

    relay = LiveRelay(
        get_key=lambda: key,
        instruction=lambda: "be JARVIS",
        voice=lambda: "Charon",
        speaker=speaker,
        bus=bus,
        spend_reconnect=spend_reconnect,
        on_activity=bump,
        on_error=(errors.append if errors is not None else (lambda m: None)),
        client_factory=lambda k: SimpleNamespace(key=k),
        connect=connect,
        config_factory=lambda instr, voice, handle: SimpleNamespace(
            instruction=instr, voice=voice, handle=handle),
        blob_factory=lambda data: SimpleNamespace(data=data),
    )
    relay._backoff = (0.01, 0.01, 0.01)
    return SimpleNamespace(relay=relay, sent=sent, speaker=speaker, bus=bus, calls=calls)


def run_for(fx, seconds=0.3, before=None):
    stop = threading.Event()
    thread = threading.Thread(target=fx.relay.run, args=(stop,), daemon=True)
    thread.start()
    time.sleep(0.05)
    if before:
        before()
    time.sleep(seconds)
    stop.set()
    thread.join(timeout=5)
    assert not thread.is_alive()


def voice_events(bus):
    return [e for _, e in bus.since(0, source="voice")]


def resp(**kw):
    return SimpleNamespace(**{"data": None, "session_resumption_update": None,
                              "server_content": None, **kw})


def content(**kw):
    base = {"interrupted": False, "turn_complete": False,
            "input_transcription": None, "output_transcription": None}
    base.update(kw)
    return SimpleNamespace(**base)


def text(t):
    return SimpleNamespace(text=t)


# ----- audio up -----

def test_pushed_audio_reaches_the_session_through_the_audio_field():
    fx = make_relay()
    run_for(fx, before=lambda: [fx.relay.push(b"\x01\x02" * 8) for _ in range(3)])
    assert len(fx.sent) >= 1
    assert all(item.data == b"\x01\x02" * 8 for item in fx.sent)


def test_push_before_the_loop_is_ready_is_dropped_quietly():
    fx = make_relay()
    fx.relay.push(b"\x00\x00")                      # no loop yet: must not raise
    assert fx.sent == []


def test_queue_keeps_the_newest_audio_when_full():
    fx = make_relay()
    fx.relay._loop = None
    fx.relay._outq = asyncio.Queue(maxsize=2)
    for value in (b"a", b"b", b"c"):
        fx.relay._enqueue(value)
    assert [fx.relay._outq.get_nowait() for _ in range(2)] == [b"b", b"c"]


# ----- audio down, barge-in, transcripts -----

def test_reply_audio_goes_to_the_speaker_and_counts_as_activity():
    fx = make_relay(script=[resp(data=b"\x10\x00" * 10), resp(data=b"\x20\x00" * 10)])
    run_for(fx)
    assert fx.speaker.chunks == [b"\x10\x00" * 10, b"\x20\x00" * 10]
    assert fx.calls["activity"] >= 2


def test_interruption_flushes_the_speaker_and_tells_the_bus():
    fx = make_relay(script=[resp(server_content=content(interrupted=True))])
    run_for(fx)
    assert fx.speaker.flushes >= 1
    assert any(e["type"] == "barge_in" for e in voice_events(fx.bus))


def test_transcripts_are_published_per_turn_and_not_repeated():
    script = [
        resp(server_content=content(input_transcription=text("what time"))),
        resp(server_content=content(input_transcription=text("is it"))),
        resp(server_content=content(output_transcription=text("It is ten."))),
        resp(server_content=content(output_transcription=text("It is ten."), turn_complete=True)),
        resp(server_content=content(output_transcription=text("Anything else?"), turn_complete=True)),
    ]
    fx = make_relay(script=script)
    run_for(fx)
    turns = [e for e in voice_events(fx.bus) if e["type"] == "voice_turn"]
    assert {"role": "user", "text": "what time is it"} in [
        {k: t[k] for k in ("role", "text")} for t in turns]
    # A repeated fragment inside one turn is kept once; the next turn is its own line.
    assert [t["text"] for t in turns if t["role"] == "assistant"] == ["It is ten.", "Anything else?"]


def test_control_characters_are_stripped_from_transcripts():
    fx = make_relay(script=[resp(server_content=content(
        input_transcription=text("hel\x00lo\x07 there"), turn_complete=True))])
    run_for(fx)
    turns = [e for e in voice_events(fx.bus) if e["type"] == "voice_turn"]
    assert turns[0]["text"] == "hello there"


def test_resumption_handle_is_kept_in_memory_and_reused_on_reconnect():
    handle = SimpleNamespace(resumable=True, new_handle="h-1")
    fx = make_relay(sessions=[
        [resp(session_resumption_update=handle), ConnectionError("network blip")],
        [],
    ])
    handles = []
    orig = fx.relay._config_factory
    fx.relay._config_factory = lambda instr, voice, h: (handles.append(h), orig(instr, voice, h))[1]
    run_for(fx, seconds=0.4)
    assert handles[:2] == [None, "h-1"]


# ----- failures and budget -----

def test_gives_up_after_repeated_failed_connections_and_says_why():
    errors = []
    fx = make_relay(connect_error=ConnectionError("down"), errors=errors)
    stop = threading.Event()
    t = threading.Thread(target=fx.relay.run, args=(stop,), daemon=True)
    t.start()
    t.join(timeout=5)
    assert not t.is_alive()
    assert fx.calls["connect"] == live.MAX_FAILURES
    assert any(e["reason"] == "gave_up" for e in voice_events(fx.bus) if e["type"] == "voice_error")
    assert errors and "stopped after" in errors[-1]


def test_reconnect_is_charged_to_the_budget_and_stops_when_refused():
    budget_calls = []

    def refuse():
        budget_calls.append(1)
        return False

    fx = make_relay(connect_error=ConnectionError("down"), spend=refuse)
    stop = threading.Event()
    t = threading.Thread(target=fx.relay.run, args=(stop,), daemon=True)
    t.start()
    t.join(timeout=5)
    assert not t.is_alive()
    assert budget_calls == [1]
    assert fx.calls["connect"] == 1                  # the first connect was paid by the controller
    # The relay stops because the app is OFFLINE (try_spend() returns False only
    # then) — never because this app's own count ran out.
    assert any(e["reason"] == "offline" for e in voice_events(fx.bus) if e["type"] == "voice_error")


def test_no_key_stops_before_any_connection():
    fx = make_relay(key=None)
    stop = threading.Event()
    fx.relay.run(stop)                               # returns at once
    assert fx.calls["connect"] == 0
    assert any(e["reason"] == "no_key" for e in voice_events(fx.bus) if e["type"] == "voice_error")


def test_stop_during_a_session_ends_it_promptly():
    fx = make_relay(script=[])
    started = time.monotonic()
    run_for(fx, seconds=0.2)
    assert time.monotonic() - started < 3


# ----- config shape (no network) -----

def test_default_config_carries_model_voice_instruction_and_resumption():
    cfg = live.default_config("be JARVIS", "Charon", "handle-9")
    assert cfg.response_modalities == ["AUDIO"]
    assert cfg.system_instruction == "be JARVIS"
    assert cfg.speech_config.voice_config.prebuilt_voice_config.voice_name == "Charon"
    assert cfg.session_resumption.handle == "handle-9"
    assert cfg.context_window_compression.sliding_window is not None
    assert cfg.input_audio_transcription is not None and cfg.output_audio_transcription is not None


def test_the_session_asks_for_nothing_3_8_live_has_removed():
    """gemini-3.8-live rejects the settings the 3.1 preview accepted.

    Google's migration notes for 3.8 Live: thinking levels are not supported (leave
    thinking_level / thinking_config out), affective dialogue must not be sent, and
    proactive audio is built into the model — asking for it to be OFF is an error.
    The SDK still defines these fields, so only the request itself can prove they
    are absent. Source: ai.google.dev/gemini-api/docs/models/gemini-3.8-live, read 2026-10-12.
    """
    cfg = live.default_config("be JARVIS", "Charon", None)
    assert getattr(cfg, "thinking_config", None) is None
    assert getattr(cfg, "enable_affective_dialog", None) is None
    assert getattr(cfg, "proactivity", None) is None


def test_default_blob_is_16_bit_pcm_mime_type():
    blob = live.default_blob(b"\x00\x01")
    assert blob.data == b"\x00\x01" and blob.mime_type == "audio/pcm"


def test_live_model_comes_from_config():
    """The current stable Live model.

    The name this app used before, models/gemini-3.1-flash-live-preview, is shut
    down on 17 November 2026; gemini-3.8-live is Google's recommended replacement
    and has no shutdown date. Source: ai.google.dev/gemini-api/docs/deprecations,
    read 2026-10-12.
    """
    assert config.LIVE_MODEL == "models/gemini-3.8-live"


def test_a_full_audio_queue_keeps_the_newest_audio():
    """Live relay: when the queue is full, the oldest block is dropped, so the reply is never behind."""
    import asyncio
    from backend.voice.live import LiveRelay

    relay = LiveRelay(get_key=lambda: None, instruction=lambda: "", voice=lambda: "Charon",
                      speaker=None, bus=None, spend_reconnect=lambda: True, on_activity=lambda: None,
                      on_error=lambda m: None)
    relay._outq = asyncio.Queue(maxsize=2)
    for block in (b"1", b"2", b"3"):
        relay._enqueue(block)
    assert [relay._outq.get_nowait() for _ in range(2)] == [b"2", b"3"]
