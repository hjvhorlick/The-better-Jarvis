"""Gemini Live relay: microphone audio up, spoken replies down, on the server.

The browser never sees the key or the audio. This module:
  * sends mic blocks through the `audio` field (Gemini 3.x Live rejects the older
    `media_chunks` field and closes the socket, as the legacy app found);
  * plays reply audio on the server speaker;
  * on an `interrupted` signal, flushes the speaker at once (barge-in);
  * publishes the spoken words (both sides) to the event bus as `voice_turn` events,
    which the browser shows in the chat. Transcripts are NOT written to the memory
    files. Memory stays read-only until V2-4;
  * keeps the session resumption handle in memory only, so a dropped connection can
    resume without losing context. The handle is never written to disk;
  * retries after a drop with a short back-off, and counts each reconnect against the
    daily budget.

The relay runs its own asyncio loop in a worker thread. Other threads hand it audio
through `push()`, which is thread-safe.

Provenance: written for this project from the legacy app's Live behaviour (main.py
_send_realtime, _build_config, the receive loop). No code taken from other projects.
"""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Callable

from .. import config

DEFAULT_VOICE = "Charon"
MAX_FAILURES = 3
BACKOFF_S = (2.0, 4.0, 8.0)
QUEUE_LIMIT = 200                 # about 13 s of 1024-sample blocks; older audio is dropped


def current_voice() -> str:
    try:
        from memory.config_manager import get_voice
        return get_voice()
    except Exception:
        return DEFAULT_VOICE


def default_config(instruction: str, voice: str, resume_handle: str | None):
    """The Live session settings. Audio out, transcripts both ways, resumable, sliding context."""
    from google.genai import types as t

    def prebuilt(name: str):
        return t.PrebuiltVoiceConfig(voice_name=name)

    def speech(name: str):
        return t.SpeechConfig(voice_config=t.VoiceConfig(prebuilt_voice_config=prebuilt(name)))

    def window():
        return t.ContextWindowCompressionConfig(sliding_window=t.SlidingWindow())

    resume = t.SessionResumptionConfig(handle=resume_handle)
    transcripts_out, transcripts_in = t.AudioTranscriptionConfig(), t.AudioTranscriptionConfig()
    return t.LiveConnectConfig(
        system_instruction=instruction,
        response_modalities=[t.Modality.AUDIO],
        speech_config=speech(voice),
        output_audio_transcription=transcripts_out,
        input_audio_transcription=transcripts_in,
        session_resumption=resume,
        context_window_compression=window(),
    )


def default_blob(data: bytes):
    from google.genai import types
    return types.Blob(data=data, mime_type="audio/pcm")


def default_client(api_key: str):
    from google import genai
    return genai.Client(api_key=api_key)


def default_connect(client, cfg):
    return client.aio.live.connect(model=config.LIVE_MODEL, config=cfg)


def _usable_handle(update) -> str | None:
    """The newest resumption handle in one server update, or None if it cannot be resumed."""
    if update is None or not getattr(update, "resumable", False):
        return None
    return getattr(update, "new_handle", None) or None


def _clean(text: str) -> str:
    return "".join(ch for ch in (text or "") if ch in "\n\t" or ord(ch) >= 32).strip()


class LiveRelay:
    def __init__(
        self,
        *,
        get_key: Callable[[], str | None],
        instruction: Callable[[], str],
        voice: Callable[[], str],
        speaker,
        bus,
        spend_reconnect: Callable[[], bool],
        on_activity: Callable[[], None],
        on_error: Callable[[str], None],
        client_factory=default_client,
        connect=default_connect,
        config_factory=default_config,
        blob_factory=default_blob,
        sleep_s: Callable[[float], None] | None = None,
    ) -> None:
        self._get_key = get_key
        self._instruction = instruction
        self._voice = voice
        self._speaker = speaker
        self._bus = bus
        self._spend = spend_reconnect
        self._activity = on_activity
        self._error_cb = on_error
        self._client_factory = client_factory
        self._connect = connect
        self._config_factory = config_factory
        self._blob = blob_factory
        self._backoff = BACKOFF_S
        self._loop: asyncio.AbstractEventLoop | None = None
        self._outq: asyncio.Queue | None = None
        self._stop: threading.Event | None = None
        self._resume_handle: str | None = None
        self._user_text: list[str] = []
        self._assistant_text: list[str] = []
        self.connects = 0
        self.last_error = ""

    # ----- called from other threads -----

    def push(self, frame: bytes) -> None:
        loop, outq = self._loop, self._outq
        if loop is None or outq is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._enqueue, frame)
        except RuntimeError:                      # loop closed while stopping
            pass

    def _enqueue(self, frame: bytes) -> None:
        if self._outq is None:
            return
        if self._outq.full():
            self._outq.get_nowait()               # keep the newest audio
        self._outq.put_nowait(frame)

    def run(self, stop: threading.Event) -> None:
        """Blocking. Call from a worker thread. Returns when `stop` is set or giving up."""
        self._stop = stop
        asyncio.run(self._main())

    # ----- relay loop -----

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._outq = asyncio.Queue(maxsize=QUEUE_LIMIT)
        failures = 0
        try:
            while not self._stop.is_set():
                if self.connects > 0 and not self._spend():
                    self._report("budget", "daily Gemini budget used up")
                    break
                key = self._get_key()
                if not key:
                    self._report("no_key", "no Gemini API key on this server")
                    break
                progressed = False
                try:
                    client = self._client_factory(key)
                    cfg = self._config_factory(self._instruction(), self._voice(), self._resume_handle)
                    self.connects += 1
                    async with self._connect(client, cfg) as session:
                        progressed = await self._session(session)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self._report("connection", type(e).__name__)
                if self._stop.is_set():
                    break
                failures = 0 if progressed else failures + 1
                if failures >= MAX_FAILURES:
                    self._report("gave_up", f"stopped after {MAX_FAILURES} failed connections")
                    break
                await self._wait(self._backoff[min(max(failures, 1), len(self._backoff)) - 1])
        finally:
            self._flush_turns()
            self._loop = None
            self._outq = None

    async def _session(self, session) -> bool:
        progressed = False

        async def sender():
            while True:
                frame = await self._outq.get()
                await session.send_realtime_input(audio=self._blob(frame))

        async def receiver():
            nonlocal progressed
            while True:
                async for response in session.receive():
                    progressed = True
                    self._handle(response)

        async def watcher():
            while not self._stop.is_set():
                await asyncio.sleep(0.2)

        tasks = [asyncio.ensure_future(sender()), asyncio.ensure_future(receiver()),
                 asyncio.ensure_future(watcher())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for t in done:
            if not t.cancelled() and t.exception() is not None:
                raise t.exception()
        return progressed

    def _handle(self, response) -> None:
        handle = _usable_handle(getattr(response, "session_resumption_update", None))
        if handle:
            self._resume_handle = handle

        data = getattr(response, "data", None)
        if data:
            self._activity()
            self._speaker.enqueue(data)

        sc = getattr(response, "server_content", None)
        if sc is None:
            return
        if getattr(sc, "interrupted", False):
            self._speaker.flush()
            self._flush_turns()
            self._bus.publish("voice", {"type": "barge_in"})
            self._activity()
        out_t = getattr(sc, "output_transcription", None)
        if out_t is not None and getattr(out_t, "text", None):
            text = _clean(out_t.text)
            if text and (not self._assistant_text or self._assistant_text[-1] != text):
                self._assistant_text.append(text)
                self._activity()
        in_t = getattr(sc, "input_transcription", None)
        if in_t is not None and getattr(in_t, "text", None):
            text = _clean(in_t.text)
            if text:
                self._user_text.append(text)
                self._activity()
        if getattr(sc, "turn_complete", False):
            self._flush_turns()

    def _flush_turns(self) -> None:
        user = " ".join(self._user_text).strip()
        assistant = " ".join(self._assistant_text).strip()
        self._user_text.clear()
        self._assistant_text.clear()
        if user:
            self._bus.publish("voice", {"type": "voice_turn", "role": "user", "text": user})
        if assistant:
            self._bus.publish("voice", {"type": "voice_turn", "role": "assistant", "text": assistant})

    def _report(self, code: str, message: str) -> None:
        self.last_error = message
        self._bus.publish("voice", {"type": "voice_error", "reason": code, "message": message})
        self._error_cb(message)

    async def _wait(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end and not self._stop.is_set():
            await asyncio.sleep(0.1)
