"""Voice controller: one place that decides when the microphone, speaker and Gemini Live run.

Modes
  Live     a voice session is running. Started by the owner (button, or a confirmed chat
           request), or by wake word. Its engine is chosen by SUPPER_VOICE_ENGINE:
             local (default)  this computer: speech to text, the agent, speech out.
                              Nothing is sent to Gemini Live or any other service.
             live             the Gemini Live relay: mic audio goes up, replies come down.
  Wake     the wake-word detector listens on this computer only. Nothing leaves the
           machine until the wake word is heard, then a session starts.

Rules
  * The Gemini Live engine needs a key and one unit of the daily budget (backend/quota.py).
    The local engine needs neither; it needs its speech recognition to be installed.
  * A Live session stops after `idle_s` seconds with no speech from either side.
  * Mute stops audio at the microphone itself, so neither Live nor the detector sees it.
  * Barge-in: while the assistant is speaking, a clear loud voice from the owner flushes
    the speaker at once. A higher threshold than normal speech is used, to reduce
    the speaker's own sound triggering it. Headphones are still recommended.
  * Every state change is published to the event bus (source "voice").

Provenance: written for this project. The barge-in idea (stop playback as soon as the
user speaks) is a common voice-assistant pattern; no code was taken from other projects.
"""
from __future__ import annotations

import queue
import threading
import time
from typing import Callable

from .audio import AudioUnavailable
from .vad import EnergyVAD

BARGE_IN_ON = 1500.0
BARGE_IN_OFF = 900.0
WAKE_QUEUE = 64


class VoiceError(RuntimeError):
    """A request that cannot be done now. `status` is the HTTP status to use."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


class VoiceController:
    def __init__(
        self,
        *,
        mic,
        speaker,
        devices,
        bus,
        budget,
        get_key: Callable[[], str | None],
        make_relay: Callable[..., object],
        wake_available: Callable[[], tuple[bool, str]],
        make_detector: Callable[[], object],
        idle_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        watchdog: bool = True,
        engine: Callable[[], str] = lambda: "live",
        local_ready: Callable[[], tuple[bool, str]] = lambda: (True, ""),
        wake_default: Callable[[], bool] = lambda: False,
    ) -> None:
        self._mic = mic
        self._speaker = speaker
        self._bus = bus
        self._budget = budget
        self._get_key = get_key
        self._make_relay = make_relay
        self._wake_available = wake_available
        self._make_detector = make_detector
        self._idle_s = float(idle_s)
        self._clock = clock
        self._lock = threading.RLock()

        self._mic_live = devices.lease("microphone", "voice")
        self._spk_live = devices.lease("speaker", "voice")
        self._mic_wake = devices.lease("microphone", "wake")

        self._relay = None
        self._relay_stop: threading.Event | None = None
        self._relay_thread: threading.Thread | None = None
        self._source = ""
        self._last_activity = 0.0
        self._last_error = ""
        self._barge = EnergyVAD(on_threshold=BARGE_IN_ON, off_threshold=BARGE_IN_OFF,
                                attack_frames=3, hangover_frames=8)

        self._wake_on = False
        self._detector = None
        self._wake_q: queue.Queue = queue.Queue(maxsize=WAKE_QUEUE)
        self._wake_stop: threading.Event | None = None
        self._wake_thread: threading.Thread | None = None

        self._engine = engine
        self._local_ready = local_ready
        self._wake_default = wake_default
        self._answerer: Callable[[str], str] | None = None

        self._closed = threading.Event()
        self._watchdog = watchdog
        self._watch_thread: threading.Thread | None = None
        self._mic.set_sink(self._on_frame)

    # ----- public -----

    @property
    def live(self) -> bool:
        return self._relay is not None

    @property
    def engine(self) -> str:
        return "local" if self._engine() == "local" else "live"

    def attach_answerer(self, answer: Callable[[str], str]) -> None:
        """Set the function that answers a spoken request (the agent). Used by the local engine."""
        self._answerer = answer

    def start_live(self, source: str = "button") -> dict:
        with self._lock:
            if self.live:
                return self.status()
            local = self.engine == "local"
            if local:
                ready, reason = self._local_ready()
                if not ready:
                    raise VoiceError(f"Local voice is not ready: {reason}.", 409)
            else:
                if not self._get_key():
                    raise VoiceError("No Gemini API key on this server. Voice needs one.", 503)
                if not self._budget.try_spend():
                    raise VoiceError("Today's Gemini budget is used up. Voice resumes after local midnight.", 429)
            stop = threading.Event()
            callbacks = dict(on_activity=self._touch, on_error=self._set_error)
            if local:
                callbacks["answer"] = self._ask_agent
            else:
                callbacks["spend_reconnect"] = self._budget.try_spend
            relay = self._make_relay(**callbacks)
            try:
                self._mic_live.start()
                try:
                    self._spk_live.start()
                except AudioUnavailable:
                    self._mic_live.stop()
                    raise
            except AudioUnavailable as e:
                self._last_error = str(e)
                raise VoiceError(str(e), 503) from None

            self._relay = relay
            self._relay_stop = stop
            self._source = source
            self._last_activity = self._clock()
            self._last_error = ""
            self._relay_thread = threading.Thread(target=relay.run, args=(stop,),
                                                  daemon=True, name="voice-live")
            self._relay_thread.start()
            self._start_watchdog()
            self._publish("voice_state", state="live", origin=source)
            return self.status()

    def stop_live(self, reason: str = "user") -> dict:
        with self._lock:
            if not self.live:
                return self.status()
            stop, thread = self._relay_stop, self._relay_thread
            self._relay = None
            self._relay_stop = None
            self._relay_thread = None
            self._mic_live.stop()
            self._spk_live.stop()
            self._barge.reset()
        if stop is not None:
            stop.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)
        self._publish("voice_state", state="off", reason=reason)
        return self.status()

    def autostart_wake(self) -> dict:
        """At start-up: listen for the wake word, if the setting is on and the model is installed.
        Quiet when it cannot start: the status says why, and nothing is raised."""
        if not self._wake_default():
            return self.status()
        ready, _ = self._wake_available()
        if not ready:
            return self.status()
        try:
            return self.set_wake(True)
        except VoiceError as e:
            self._set_error(str(e))
            return self.status()

    def set_muted(self, muted: bool) -> dict:
        self._mic.set_muted(muted)
        self._publish("voice_state", state="muted" if muted else "unmuted")
        return self.status()

    def set_wake(self, enabled: bool) -> dict:
        with self._lock:
            if enabled == self._wake_on:
                return self.status()
            if enabled:
                ready, reason = self._wake_available()
                if not ready:
                    raise VoiceError(f"Wake word is not ready: {reason}.", 409)
                detector = self._make_detector()
                try:
                    self._mic_wake.start()
                except AudioUnavailable as e:
                    detector.close()
                    self._last_error = str(e)
                    raise VoiceError(str(e), 503) from None
                self._detector = detector
                self._wake_on = True
                self._wake_stop = threading.Event()
                self._wake_thread = threading.Thread(target=self._wake_loop, args=(self._wake_stop, detector),
                                                     daemon=True, name="voice-wake")
                self._wake_thread.start()
            else:
                self._wake_on = False
                if self._wake_stop is not None:
                    self._wake_stop.set()
                self._mic_wake.stop()
                if self._detector is not None:
                    self._detector.close()
                    self._detector = None
                self._wake_stop = None
                self._wake_thread = None
            self._publish("voice_state", state="wake_on" if enabled else "wake_off")
            return self.status()

    def status(self) -> dict:
        ready, reason = self._wake_available()
        local_ok, local_reason = self._local_ready()
        return {
            "live": self.live,
            "engine": self.engine,
            "origin": self._source if self.live else "",
            "muted": self._mic.muted,
            "wake": {"enabled": self._wake_on, "available": ready, "reason": reason},
            "local_ready": {"ready": local_ok, "reason": local_reason},
            "idle_off_s": self._idle_s,
            "last_error": self._last_error,
            "mic": self._mic.status(),
            "speaker": self._speaker.status(),
        }

    def close(self) -> None:
        self._closed.set()
        if self._wake_on:
            self.set_wake(False)
        self.stop_live("shutdown")

    # ----- frame routing (audio thread) -----

    def _on_frame(self, frame: bytes) -> None:
        relay = self._relay
        if relay is not None:
            if self._speaker.is_playing() and self._barge.process(frame):
                dropped = self._speaker.flush()
                self._bus.publish("voice", {"type": "barge_in", "dropped_bytes": dropped})
                self._touch()
                hook = getattr(relay, "on_barge_in", None)
                if hook is not None:
                    hook()                                   # the local engine stops its reply
            relay.push(frame)
            return
        if self._wake_on:
            try:
                self._wake_q.put_nowait(frame)
            except queue.Full:
                pass

    # ----- workers -----

    def _wake_loop(self, stop: threading.Event, detector) -> None:
        while not stop.is_set():
            try:
                frame = self._wake_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if self.live:
                continue                               # the Live session has the microphone
            try:
                fired = detector.feed(frame)
            except Exception as e:
                self._set_error(f"wake word stopped ({type(e).__name__})")
                return
            if fired:
                self._publish("voice_wake", word="hey jarvis")
                try:
                    self.start_live(source="wake")
                except VoiceError as e:
                    self._set_error(str(e))

    def _start_watchdog(self) -> None:
        if not self._watchdog or (self._watch_thread is not None and self._watch_thread.is_alive()):
            return
        self._watch_thread = threading.Thread(target=self._watch, daemon=True, name="voice-idle")
        self._watch_thread.start()

    def _watch(self) -> None:
        # Runs only while a Live session exists; exits when the session ends.
        while not self._closed.wait(1.0):
            if not self.live:
                return
            if self._clock() - self._last_activity > self._idle_s:
                self.stop_live("idle")
                return

    # ----- helpers -----

    def _touch(self) -> None:
        self._last_activity = self._clock()

    def _ask_agent(self, text: str) -> str:
        answer = self._answerer
        if answer is None:
            raise VoiceError("The assistant is not ready yet.", 503)
        return answer(text)

    def _set_error(self, message: str) -> None:
        self._last_error = message

    def _publish(self, kind: str, **data) -> None:
        self._bus.publish("voice", {"type": kind, **data})
