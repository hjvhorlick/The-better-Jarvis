"""Local voice relay: the microphone, this computer's speech to text, the same agent as the typed
chat, and this computer's speech. Nothing in this path calls Gemini Live or another service.
(The agent itself still uses the rules of backend/agent.py: local answers first, Gemini last.)

Turn-taking
  * EnergyVAD finds where speech starts and stops. An utterance ends after about 0.8 s of quiet.
  * Utterances shorter than MIN_UTTERANCE_S are dropped. Longer than MAX_UTTERANCE_S are cut.
  * While a reply is being made and spoken, microphone frames are ignored, so the assistant does
    not hear its own voice.
  * Barge-in: the controller flushes the speaker when the owner talks over the reply, then calls
    on_barge_in(). The reply stops at once and the owner's words are heard.
  * The idle timer counts speech and replies, not silence, so the session ends after idle_s of
    quiet (the same rule as the Live session).

Every turn is published to the event bus (source "voice") as voice_turn, with role user or assistant.
The agent is called with quiet=True, so the chat log does not get the same turn twice.

Provenance: written for this project. The turn-taking is a standard energy-threshold design
(see backend/voice/vad.py). No code taken from other projects.
"""
from __future__ import annotations

import queue
import threading
import time
from collections import deque
from typing import Callable

from .audio import MIC_RATE, SPEAKER_RATE
from .vad import EnergyVAD, frame_rms

SPEECH_ON = 600.0
SPEECH_OFF = 350.0
ATTACK_FRAMES = 2
HANGOVER_FRAMES = 12            # about 0.8 s of quiet at 1024-sample blocks (64 ms)
PRE_ROLL_FRAMES = 4
MIN_UTTERANCE_S = 0.5
MAX_UTTERANCE_S = 20.0
MAX_SPOKEN_CHARS = 1200         # longer replies are cut for speech; the chat keeps the whole text
QUEUE_FRAMES = 200
FEED_LIMIT_BYTES = SPEAKER_RATE * 2 * 2     # keep about 2 s of reply queued in the speaker
FEED_CHUNK_BYTES = SPEAKER_RATE // 4 * 2    # 0.25 s chunks

# What speech recognition often invents from silence or noise. Ignored when the clip is short.
_NOISE_TEXTS = frozenset({"you", "thank you", "thanks", "thanks for watching", "bye", "bye bye", "oh"})


class LocalRelay:
    def __init__(
        self,
        *,
        speaker,
        bus,
        answer: Callable[[str], str] | None,
        transcriber,
        synthesiser=None,
        on_activity: Callable[[], None] = lambda: None,
        on_error: Callable[[str], None] = lambda message: None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        **_ignored,                      # the controller may pass callbacks only the Live relay uses
    ) -> None:
        self._speaker = speaker
        self._bus = bus
        self._answer = answer
        self._stt = transcriber
        self._tts = synthesiser
        self._activity = on_activity
        self._error_cb = on_error
        self._clock = clock
        self._sleep = sleep
        self._q: queue.Queue = queue.Queue(maxsize=QUEUE_FRAMES)
        self._vad = EnergyVAD(on_threshold=SPEECH_ON, off_threshold=SPEECH_OFF,
                              attack_frames=ATTACK_FRAMES, hangover_frames=HANGOVER_FRAMES)
        self._pre: deque = deque(maxlen=PRE_ROLL_FRAMES)
        self._utt: list[bytes] = []
        self._utt_samples = 0
        self._speech_frames = 0          # frames where speech was heard (not the quiet tail)
        self._in_utt = False
        self._hold = False               # a reply is being made or spoken: microphone ignored
        self._barged = threading.Event()
        self._stop: threading.Event | None = None
        self.turns = 0
        self.last_error = ""

    # ----- called from other threads -----

    def push(self, frame: bytes) -> None:
        """Audio thread. Frames arriving while the assistant is talking are dropped."""
        if self._hold and not self._barged.is_set():
            return
        try:
            self._q.put_nowait(frame)
        except queue.Full:
            try:
                self._q.get_nowait()     # keep the newest audio
                self._q.put_nowait(frame)
            except (queue.Empty, queue.Full):
                pass

    def on_barge_in(self) -> None:
        """Called by the controller when the owner talks over the reply."""
        self._barged.set()

    def run(self, stop: threading.Event) -> None:
        """Blocking. Call from a worker thread. Returns when `stop` is set."""
        self._stop = stop
        while not stop.is_set():
            try:
                frame = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            self.process(frame)

    # ----- the turn logic (synchronous, so tests can drive it) -----

    def process(self, frame: bytes) -> None:
        if self._hold:
            return
        speaking = self._vad.process(frame)
        loud = frame_rms(frame) >= SPEECH_OFF          # the hangover keeps `speaking` on; this does not
        samples = len(frame) // 2
        if not self._in_utt:
            self._pre.append(frame)
            if speaking:
                self._in_utt = True
                self._utt = list(self._pre)
                self._pre.clear()
                self._utt_samples = sum(len(f) // 2 for f in self._utt)
                self._speech_frames = 1
                self._activity()
            return
        self._utt.append(frame)
        self._utt_samples += samples
        if loud:
            self._speech_frames += 1
            self._activity()
        too_long = self._utt_samples / MIC_RATE >= MAX_UTTERANCE_S
        if speaking and not too_long:
            return                                      # still inside the utterance
        pcm = b"".join(self._utt)
        speech_seconds = self._speech_frames * samples / MIC_RATE
        self._in_utt = False
        self._utt = []
        self._utt_samples = 0
        self._speech_frames = 0
        self._vad.reset()
        if speech_seconds >= MIN_UTTERANCE_S:
            self._respond(pcm, speech_seconds)

    # ----- one turn -----

    def _respond(self, pcm: bytes, seconds: float) -> None:
        self._hold = True
        try:
            text = self._recognise(pcm)
            if not text or (text.lower().strip(" .!?") in _NOISE_TEXTS and seconds < 1.5):
                return
            self.turns += 1
            self._publish("voice_turn", role="user", text=text)
            reply = self._ask(text)
            self._publish("voice_turn", role="assistant", text=reply)
            self._activity()
            self._speak(reply)
        finally:
            self._hold = False
            self._barged.clear()

    def _recognise(self, pcm: bytes) -> str:
        if self._stt is None:
            self._fail("speech recognition is not installed")
            return ""
        try:
            return (self._stt.transcribe(pcm, MIC_RATE) or "").strip()
        except Exception as e:
            self._fail(f"speech recognition failed ({type(e).__name__})")
            return ""

    def _ask(self, text: str) -> str:
        if self._answer is None:
            return "Voice is not connected to the assistant yet."
        try:
            return str(self._answer(text) or "").strip() or "I have nothing to add."
        except Exception as e:                           # BudgetExhausted and friends carry a message
            message = str(e) or type(e).__name__
            self._fail(f"could not answer ({type(e).__name__})")
            return message

    def _speak(self, reply: str) -> None:
        if self._tts is None or not reply:
            return
        spoken = reply if len(reply) <= MAX_SPOKEN_CHARS else reply[:MAX_SPOKEN_CHARS].rsplit(" ", 1)[0] + "."
        try:
            pcm = self._tts.speak_pcm(spoken)
        except Exception as e:
            self._fail(f"spoken reply failed ({type(e).__name__})")
            return
        flushes_before = self._speaker.status().get("flushes", 0)
        offset = 0
        while offset < len(pcm):
            if self._stop is not None and self._stop.is_set():
                return
            if self._interrupted(flushes_before):
                return
            if self._speaker.status().get("buffered_bytes", 0) >= FEED_LIMIT_BYTES:
                self._sleep(0.05)
                continue
            chunk = pcm[offset:offset + FEED_CHUNK_BYTES]
            self._speaker.enqueue(chunk)
            offset += len(chunk)
        deadline = self._clock() + 2.0 + len(pcm) / (SPEAKER_RATE * 2)
        while self._speaker.is_playing() and self._clock() < deadline:
            if self._interrupted(flushes_before) or (self._stop is not None and self._stop.is_set()):
                return
            self._sleep(0.05)

    def _interrupted(self, flushes_before: int) -> bool:
        return self._barged.is_set() or self._speaker.status().get("flushes", 0) != flushes_before

    # ----- helpers -----

    def _publish(self, kind: str, **data) -> None:
        self._bus.publish("voice", {"type": kind, **data})

    def _fail(self, message: str) -> None:
        self.last_error = message
        self._error_cb(message)
