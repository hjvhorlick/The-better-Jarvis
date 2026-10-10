"""Server-side microphone and speaker owners (sounddevice).

Both are device owners: they are registered with the device registry and opened only
while a lease is held. Nothing touches audio hardware at import time or at app start.

  Microphone  16 kHz, mono, 16-bit PCM. Mute drops blocks here, before any consumer,
              so muted audio never reaches the wake word or Gemini.
  Speaker     24 kHz, mono, 16-bit PCM. A byte buffer that the output callback drains.
              flush() empties it at once (barge-in).

The sounddevice import is lazy. If PortAudio or the package is missing, the owner
raises AudioUnavailable with a short hint, and the rest of the app keeps running.

Provenance: written for this project. The rates and block size match the legacy app
(main.py: SEND_SAMPLE_RATE 16000, RECEIVE_SAMPLE_RATE 24000, CHUNK_SIZE 1024).
"""
from __future__ import annotations

import threading
import time
from typing import Callable

MIC_RATE = 16000
SPEAKER_RATE = 24000
BLOCK_SAMPLES = 1024
MAX_SPEAKER_BUFFER_S = 10.0
_PLAYING_HOLD_S = 0.3

_HINT = ("audio needs the 'sounddevice' package and the PortAudio library. "
         "See backend/requirements-voice.txt. On Linux, install libportaudio2.")


class AudioUnavailable(RuntimeError):
    """The microphone or speaker cannot be opened. The message is safe to show."""


def _sounddevice():
    try:
        import sounddevice as sd
    except (ImportError, OSError):
        raise AudioUnavailable(_HINT) from None
    return sd


def _open_input(device, on_block: Callable[[bytes], None]):
    sd = _sounddevice()

    def callback(indata, frames, time_info, status):
        on_block(bytes(indata))

    try:
        return sd.RawInputStream(samplerate=MIC_RATE, blocksize=BLOCK_SAMPLES, device=device,
                                 channels=1, dtype="int16", callback=callback)
    except Exception as e:
        raise AudioUnavailable(f"no usable microphone ({type(e).__name__})") from None


def _open_output(device, on_fill: Callable[[int], bytes]):
    sd = _sounddevice()

    def callback(outdata, frames, time_info, status):
        outdata[:] = on_fill(len(outdata))

    try:
        return sd.RawOutputStream(samplerate=SPEAKER_RATE, blocksize=BLOCK_SAMPLES, device=device,
                                  channels=1, dtype="int16", callback=callback)
    except Exception as e:
        raise AudioUnavailable(f"no usable speaker ({type(e).__name__})") from None


class Microphone:
    """Device owner for the server microphone."""

    def __init__(self, device=None, opener=_open_input) -> None:
        self._device = device
        self._opener = opener
        self._stream = None
        self._sink: Callable[[bytes], None] | None = None
        self._muted = False
        self._lock = threading.Lock()
        self._error = ""
        self.blocks_total = 0
        self.blocks_muted = 0

    # device-registry interface
    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                return
            try:
                stream = self._opener(self._device, self._on_block)
                stream.start()
            except AudioUnavailable as e:
                self._error = str(e)
                raise
            except Exception as e:
                self._error = f"microphone failed to start ({type(e).__name__})"
                raise AudioUnavailable(self._error) from None
            self._stream = stream
            self._error = ""

    def stop(self) -> None:
        with self._lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

    def status(self) -> dict:
        return {
            "state": "streaming" if self._stream is not None else "stopped",
            "message": self._error,
            "muted": self._muted,
            "frames_total": self.blocks_total,
            "muted_blocks": self.blocks_muted,
        }

    # controller interface
    def set_sink(self, sink: Callable[[bytes], None] | None) -> None:
        self._sink = sink

    def set_muted(self, muted: bool) -> None:
        self._muted = bool(muted)

    @property
    def muted(self) -> bool:
        return self._muted

    def _on_block(self, data: bytes) -> None:
        self.blocks_total += 1
        if self._muted:
            self.blocks_muted += 1
            return
        sink = self._sink
        if sink is not None:
            sink(data)


class Speaker:
    """Device owner for the server speaker, with a playback buffer that barge-in can flush."""

    def __init__(self, device=None, opener=_open_output, clock: Callable[[], float] = time.monotonic) -> None:
        self._device = device
        self._opener = opener
        self._clock = clock
        self._stream = None
        self._buf = bytearray()
        self._cap = int(MAX_SPEAKER_BUFFER_S * SPEAKER_RATE * 2)
        self._lock = threading.Lock()
        self._last_sound = float("-inf")
        self._error = ""
        self.flushes = 0

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                return
            try:
                stream = self._opener(self._device, self._pull)
                stream.start()
            except AudioUnavailable as e:
                self._error = str(e)
                raise
            except Exception as e:
                self._error = f"speaker failed to start ({type(e).__name__})"
                raise AudioUnavailable(self._error) from None
            self._stream = stream
            self._error = ""

    def stop(self) -> None:
        with self._lock:
            stream, self._stream = self._stream, None
            self._buf.clear()
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

    def status(self) -> dict:
        return {
            "state": "streaming" if self._stream is not None else "stopped",
            "message": self._error,
            "buffered_bytes": len(self._buf),
            "flushes": self.flushes,
        }

    def enqueue(self, pcm: bytes) -> None:
        with self._lock:
            self._buf.extend(pcm)
            overflow = len(self._buf) - self._cap
            if overflow > 0:
                del self._buf[:overflow]                  # keep the newest audio

    def flush(self) -> int:
        """Drop everything not yet played. Returns the number of bytes dropped."""
        with self._lock:
            dropped = len(self._buf)
            self._buf.clear()
            self.flushes += 1
            return dropped

    def is_playing(self) -> bool:
        with self._lock:
            return bool(self._buf) or (self._clock() - self._last_sound) < _PLAYING_HOLD_S

    def _pull(self, nbytes: int) -> bytes:
        with self._lock:
            chunk = bytes(self._buf[:nbytes])
            del self._buf[:nbytes]
        if len(chunk) < nbytes:
            chunk += b"\x00" * (nbytes - len(chunk))
        if chunk.count(0) != len(chunk):
            with self._lock:
                self._last_sound = self._clock()
        return chunk
