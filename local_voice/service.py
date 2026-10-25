"""JARVIS's local voice service. One path, on this computer, no Gemini.

  Speaking  Kokoro makes the voice; this service plays it through the computer's speakers.
  Hearing   faster-whisper turns the microphone's audio (sent by the page) into words.

The Node server (server.ts) starts this file and forwards /api/voice/* to it. It listens on
127.0.0.1 only. The browser never speaks; it only captures the microphone.

Endpoints (JSON in, JSON out):
  GET  /health                       what is ready
  POST /speak       {text}           speak the text out loud; answers when playback has finished
  POST /stop        {}               stop the sentence being spoken now
  POST /transcribe  {rate, pcm}      pcm = base64 of mono little-endian int16 audio at `rate`

Settings (environment, optional):
  SUPPER_KOKORO_DIR          folder with kokoro-v1.0.onnx and voices-v1.0.bin (default models/kokoro)
  SUPPER_TTS_VOICE           Kokoro voice name (default bm_george, the British male voice)
  SUPPER_STT_MODEL           faster-whisper model: tiny, base, small, medium (default tiny.en — the fast one)
  SUPPER_STT_LANGUAGE        language code (default en)
  SUPPER_LOCAL_VOICE_PORT    port on 127.0.0.1 (default 3101)
  SUPPER_SPEAKER_DEVICE      speaker name or index; otherwise the speaker saved by the
                             desktop app (config/api_keys.json: output_device) is used
"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# numpy is imported defensively ON PURPOSE. Before this, a Python without numpy
# killed the whole service at import: the file never started, /health was never
# served, and the only clue was a traceback in the server console — while the
# dashboard still claimed a voice model. Now the service starts, /health tells
# the truth about what is missing, and every request gets a plain answer.
try:
    import numpy as np
    _numpy_error = ""
except Exception as _numpy_exc:   # pragma: no cover - depends on the machine
    np = None                     # type: ignore[assignment]
    _numpy_error = str(_numpy_exc)

ROOT = Path(__file__).resolve().parent.parent
# server.ts launches this file as a script, so Python's import path starts in
# local_voice/, not at the repository root. Add the root explicitly: the
# speaker-name resolver below deliberately reuses the desktop app's measured
# device picker (core/audio_devices.py) instead of inventing a second one.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
KOKORO_DIR = Path(os.environ.get("SUPPER_KOKORO_DIR", ROOT / "models" / "kokoro"))
KOKORO_MODEL = "kokoro-v1.0.onnx"
KOKORO_VOICES = "voices-v1.0.bin"
TTS_VOICE = os.environ.get("SUPPER_TTS_VOICE", "bm_george").strip() or "bm_george"
# tiny.en, not base: on a laptop CPU, base needs many seconds (tens, on an
# older machine) for one short sentence; tiny.en needs about a second and
# hears short commands just as well. SUPPER_STT_MODEL=base brings base back.
STT_MODEL = os.environ.get("SUPPER_STT_MODEL", "tiny.en").strip() or "tiny.en"
STT_LANGUAGE = os.environ.get("SUPPER_STT_LANGUAGE", "en").strip() or "en"
PORT = int(os.environ.get("SUPPER_LOCAL_VOICE_PORT", "3101"))
STT_RATE = 16000

_speak_lock = threading.Lock()   # one sentence at a time
_hear_lock = threading.Lock()
_active_stream = None            # the speakers' stream while JARVIS is talking (for /stop)
_output_device_cache: dict = {"key": None, "device": None, "label": "system default"}
_output_failed = ""              # why the speakers themselves last failed ('' = they have not)
_speech_stopped = False          # /stop was pressed: the current sentence ends quietly, no error
_kokoro = None
_whisper = None
# A failed speech-model load is remembered for a minute. Without this, every
# clip the browser sends pays for the whole failed download again (the model
# library retries a dead network for minutes), so hearing never just fails —
# it waits, every time, and the server hangs up first (broken pipe).
_whisper_failed: tuple[float, str] | None = None   # (when, plain reason)
_WHISPER_RETRY_S = 60
_speak_failed: str = ""            # why the voice itself could not be loaded ('' = no such failure)

# A model download that cannot reach the internet must fail in seconds, not
# after minutes of silent retries. Read by huggingface_hub when it loads.
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "10")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "10")


class VoiceError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def log(message: str) -> None:
    print(f"[local-voice] {message}", flush=True)


def _installed(module: str) -> bool:
    """Is the package there? find_spec rather than import: importing
    onnxruntime costs about a second, and /health is called often."""
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


def _need_numpy() -> None:
    if np is None:
        raise VoiceError(
            "no-package",
            f"numpy is not installed for this Python ({_numpy_error or 'import failed'}). "
            "Run: pip install -r backend/requirements-local-voice.txt",
        )


# ── Speaking ──────────────────────────────────────────────────────────────────
def kokoro_files_present() -> bool:
    return (KOKORO_DIR / KOKORO_MODEL).is_file() and (KOKORO_DIR / KOKORO_VOICES).is_file()


def kokoro():
    global _kokoro, _speak_failed
    if _kokoro is None:
        if not kokoro_files_present():
            raise VoiceError(
                "no-model",
                f"The Kokoro voice files are missing. Put {KOKORO_MODEL} and {KOKORO_VOICES} in {KOKORO_DIR} "
                "(docs/LOCAL_VOICE.md says where to get them).",
            )
        try:
            from kokoro_onnx import Kokoro
        except ImportError:
            raise VoiceError("no-package", "kokoro-onnx is not installed. Run: pip install -r backend/requirements-local-voice.txt")
        log(f"loading the Kokoro voice ({TTS_VOICE})")
        try:
            _kokoro = Kokoro(str(KOKORO_DIR / KOKORO_MODEL), str(KOKORO_DIR / KOKORO_VOICES))
        except Exception as err:
            _speak_failed = f"the Kokoro voice files could not be loaded ({err})"
            raise VoiceError("no-model", f"The Kokoro voice files could not be loaded ({err}). Check {KOKORO_MODEL} and {KOKORO_VOICES} in {KOKORO_DIR}.")
        _speak_failed = ""
        log("the Kokoro voice is ready")
    return _kokoro


def kokoro_lang() -> str:
    # British voices (bm_*/bf_*) are trained for en-gb; the rest default to en-us.
    return "en-gb" if TTS_VOICE.startswith("b") else "en-us"


# ── Which speakers? ──────────────────────────────────────────────────────────
# The desktop Jarvis learned this the hard way (core/audio_devices.py): a
# saved speaker NAME must be resolved through the host-API that was measured
# to actually move audio. Passing the bare name to sounddevice can pick a
# duplicate endpoint that opens, accepts every write instantly, and makes no
# sound at all — the exact "local voice says it spoke but I heard nothing"
# failure. This service used to ignore the saved speaker entirely and always
# took the PortAudio default. Now it uses the same saved choice and resolver
# as main.py, with SUPPER_SPEAKER_DEVICE as an override, and falls back to
# the system default rather than going silent.

def _configured_output_name() -> tuple[str, str]:
    """(speaker name/index as text, where it came from). '' = system default."""
    env = (os.environ.get("SUPPER_SPEAKER_DEVICE") or "").strip()
    if env:
        return env, "SUPPER_SPEAKER_DEVICE"
    try:
        from memory.config_manager import get_output_device

        return (get_output_device() or "").strip(), "the saved speaker"
    except Exception as err:  # a broken config must never take the voice down
        log(f"the saved speaker could not be read ({err}) — using the system default")
        return "", ""


def _output_label(sd, device, fallback: str = "system default") -> str:
    try:
        info = sd.query_devices(kind="output") if device is None else sd.query_devices(device)
        name = str((info or {}).get("name") or "").strip()
        return name or fallback
    except Exception:
        return fallback if device is None else str(device)


def resolve_output_device(rate: int = 24000):
    """Return (sounddevice device argument, human label) for the speakers.

    Cached by configured name + rate: resolving by name probes the host audio
    APIs with real (silent) streams, which is startup work, not per-sentence
    work. The cache is dropped whenever opening or writing fails, so an
    unplugged headset is re-decided on the next reply instead of failing for
    the whole session."""
    configured, _source = _configured_output_name()
    key = (configured, int(rate))
    if _output_device_cache.get("key") == key:
        return _output_device_cache.get("device"), _output_device_cache.get("label") or "system default"

    device = None
    label = "system default"
    if configured:
        if configured.isdigit():
            device = int(configured)
            label = configured
        else:
            try:
                from core import audio_devices

                audio_devices.configure(STT_RATE, int(rate))
                device = audio_devices.resolve(configured, "output")
                if device is None:
                    log(f"the saved speaker '{configured}' is not available — using the system default")
                    label = "system default"
                else:
                    label = configured
            except Exception as err:
                # Let sounddevice try the name itself; _open_output_stream
                # still falls back to the default if even that will not open.
                log(f"speaker lookup failed ({err}) — trying '{configured}' by name")
                device = configured
                label = configured

    try:
        import sounddevice as sd

        label = _output_label(sd, device, label)
    except Exception:
        pass

    _output_device_cache.update({"key": key, "device": device, "label": label})
    log(f"speakers: {label}" + (f" (saved choice: '{configured}')" if configured and label != configured else ""))
    return device, label


def _forget_output_device() -> None:
    _output_device_cache.update({"key": None, "device": None, "label": "system default"})


def _open_output_stream(sd, rate: int):
    """Open and start the output stream on the chosen speakers.

    A chosen device that will not open (asleep, exclusive mode, unplugged
    since it was resolved) must degrade to the system default in the same
    reply — exactly as main.py's _play_audio does — never to silence."""
    device, label = resolve_output_device(int(rate))
    try:
        stream = sd.OutputStream(samplerate=int(rate), channels=1, dtype="float32", device=device)
        stream.start()
        return stream, device, label
    except Exception as err:
        if device is None:
            raise
        log(f"speaker '{label}' would not open ({err}) — trying the system default")
        _forget_output_device()
        stream = sd.OutputStream(samplerate=int(rate), channels=1, dtype="float32", device=None)
        stream.start()
        return stream, None, _output_label(sd, None)


def verify_output_device() -> str:
    """Open the chosen speakers once and play 60 ms of silence through them.

    This makes /health honest: 'speaking ready' used to mean only that the
    packages and model files existed, even when the sound was going to a
    device that could not be opened at all. Returns the speakers' label."""
    global _output_failed
    _need_numpy()
    try:
        import sounddevice as sd
    except ImportError:
        raise VoiceError("no-speaker", "sounddevice is not installed. Run: pip install -r backend/requirements-local-voice.txt")
    stream = None
    try:
        stream, _device, label = _open_output_stream(sd, 24000)
        stream.write(np.zeros((max(1, int(24000 * 0.06)), 1), dtype=np.float32))
        _output_failed = ""
        log(f"speaker check passed — the local voice will use: {label}")
        return label
    except VoiceError:
        raise
    except Exception as err:
        _output_failed = f"this computer's speakers could not be opened ({err}). Check the output device."
        raise VoiceError("no-speaker", _output_failed)
    finally:
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass


def play_stream(text: str) -> None:
    """Speak with sound starting almost at once, on the chosen speakers.

    Kokoro hands over the voice in small pieces as it makes them; the first
    piece is played while the rest is still being made. The old way made the
    WHOLE text first and only then started the speakers — every reply began
    with seconds of silence, longer for longer replies.

    One stream per reply, closed when the reply ends. The previous version
    kept a *blocking* OutputStream open between replies: unlike the desktop
    app's callback Speaker (which continuously drains silence) or its
    LocalSpeaker (which plays each utterance afresh), an idle blocking
    stream can be left underflowed or suspended by the sound server, so the
    first reply sounds and later writes go nowhere. Opening per reply also
    means the saved speaker choice is re-read for every reply. A 60 ms burst
    of silence first wakes a suspended sink — the same trick the desktop
    app's LocalSpeaker uses — so the first syllable is not swallowed.
    """
    global _output_failed
    _need_numpy()
    try:
        import sounddevice as sd
    except ImportError:
        raise VoiceError("no-speaker", "sounddevice is not installed. Run: pip install -r backend/requirements-local-voice.txt")
    engine = kokoro()

    async def pump() -> None:
        global _active_stream
        started = time.monotonic()
        first = True
        stream = None
        stream_device = None
        stream_rate = 0
        wrote_speech = False

        def close_current(abort: bool = False) -> None:
            nonlocal stream
            global _active_stream
            current, stream = stream, None
            if current is None:
                return
            if _active_stream is current:
                _active_stream = None
            try:
                if abort or _speech_stopped:
                    current.abort()   # drop what is buffered: stop means now
                else:
                    current.stop()    # let the buffered tail finish playing
            except Exception:
                pass
            try:
                current.close()
            except Exception:
                pass

        def write_chunk(chunk, *, speech: bool = True) -> None:
            nonlocal stream, stream_device, wrote_speech
            global _active_stream
            try:
                stream.write(chunk)
                if speech:
                    wrote_speech = True
                return
            except Exception as err:
                # The chosen speakers opened but will not accept audio and no
                # speech has been heard yet: say this chunk on the default
                # instead of losing the reply.
                if stream_device is None or wrote_speech:
                    raise
                log(f"the chosen speakers would not accept audio ({err}) — trying the system default")
                _forget_output_device()
                close_current(abort=True)
                stream = sd.OutputStream(samplerate=stream_rate, channels=1, dtype="float32", device=None)
                stream.start()
                _active_stream = stream
                stream_device = None
                stream.write(chunk)
                if speech:
                    wrote_speech = True

        try:
            async for samples, rate in engine.create_stream(text, voice=TTS_VOICE, speed=1.0, lang=kokoro_lang()):
                rate = int(rate)
                chunk = np.asarray(samples, dtype=np.float32).reshape(-1, 1)
                if stream is None or stream_rate != rate:
                    if stream is not None:
                        close_current()
                    stream, stream_device, _label = _open_output_stream(sd, rate)
                    stream_rate = rate
                    _active_stream = stream
                    # Wake the sink before the first syllable (see docstring).
                    write_chunk(np.zeros((max(1, int(rate * 0.06)), 1), dtype=np.float32), speech=False)
                if first:
                    first = False
                    log(f"first sound after {time.monotonic() - started:.1f}s")
                # write() waits until there is room in the output buffer, so
                # the voice can never run ahead of the speakers.
                write_chunk(chunk)
        finally:
            close_current()
            _active_stream = None

    try:
        asyncio.run(pump())
        _output_failed = ""
    except VoiceError:
        raise
    except Exception as err:  # PortAudio errors: no output device, device busy, etc.
        if _speech_stopped:
            return   # the owner pressed stop: an aborted stream is the point, not an error
        _forget_output_device()
        _output_failed = f"this computer's speakers could not play the voice ({err}). Check the output device."
        raise VoiceError("no-speaker", _output_failed)


def play(samples, rate: int) -> None:
    """Older kokoro-onnx without streaming: play the whole reply at once, on
    the same chosen speakers (with the same wake-up silence and the same
    fall-back to the system default) as the streaming path."""
    global _output_failed
    _need_numpy()
    try:
        import sounddevice as sd
    except ImportError:
        raise VoiceError("no-speaker", "sounddevice is not installed. Run: pip install -r backend/requirements-local-voice.txt")
    device, label = resolve_output_device(int(rate))
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    try:
        audio = np.concatenate([np.zeros(max(1, int(rate * 0.06)), dtype=np.float32), audio])
    except Exception:
        pass  # the wake-up burst is best-effort; the speech itself is not

    def _once(dev) -> None:
        sd.play(audio, int(rate), device=dev)
        sd.wait()

    try:
        _once(device)
        _output_failed = ""
    except Exception as err:  # PortAudio errors: no output device, device busy, etc.
        if device is None:
            _output_failed = f"this computer's speakers could not play the voice ({err}). Check the output device."
            raise VoiceError("no-speaker", _output_failed)
        log(f"speaker '{label}' would not play ({err}) — trying the system default")
        _forget_output_device()
        try:
            _once(None)
            _output_failed = ""
        except Exception as err2:
            _output_failed = f"this computer's speakers could not play the voice ({err2}). Check the output device."
            raise VoiceError("no-speaker", _output_failed)


def speak(text: str) -> dict:
    text = text.strip()
    if not text:
        raise VoiceError("empty", "There was nothing to say.")
    log(f"speaking: \"{text[:80]}\"")
    with _speak_lock:
        global _speech_stopped
        _speech_stopped = False
        if hasattr(kokoro(), "create_stream"):
            play_stream(text)
        else:
            # Older kokoro-onnx without streaming: make it all, then play it.
            try:
                samples, rate = kokoro().create(text, voice=TTS_VOICE, speed=1.0, lang=kokoro_lang())
            except VoiceError:
                raise
            except Exception as err:
                raise VoiceError("failed", f"Kokoro could not make the voice: {err}")
            play(samples, int(rate))
    return {"ok": True}


def close_stream() -> None:
    """Abort the stream that is speaking now, if any."""
    global _active_stream
    stream, _active_stream = _active_stream, None
    if stream is not None:
        try:
            stream.abort()
            stream.close()
        except Exception:
            pass


def stop() -> None:
    # Cut the sound at once: abort the active stream (abort drops what is
    # buffered). The next reply opens a fresh stream. sd.stop() covers the
    # non-streaming play() fallback path.
    global _speech_stopped
    _speech_stopped = True
    close_stream()
    try:
        import sounddevice as sd
        sd.stop()
    except Exception:
        pass  # nothing was playing


# ── Hearing ───────────────────────────────────────────────────────────────────
def whisper():
    global _whisper, _whisper_failed
    if _whisper is None:
        if _whisper_failed is not None and time.monotonic() - _whisper_failed[0] < _WHISPER_RETRY_S:
            # Fail at once with the reason we already know, instead of making
            # this clip wait through another doomed download.
            raise VoiceError("no-model", _whisper_failed[1])
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise VoiceError("no-package", "faster-whisper is not installed. Run: pip install -r backend/requirements-local-voice.txt")
        log(f"loading the speech model ({STT_MODEL}); the first run downloads it once — this can take a minute")
        try:
            _whisper = WhisperModel(STT_MODEL, device="cpu", compute_type="int8")
        except Exception as err:
            reason = (f"The speech model ({STT_MODEL}) could not be loaded ({err}). "
                      "The first load needs the internet once; after that it works offline.")
            _whisper_failed = (time.monotonic(), reason)
            log(f"the speech model could not be loaded — hearing is off until this is fixed: {err}")
            raise VoiceError("no-model", reason)
        _whisper_failed = None
        log("the speech model is ready")
    return _whisper


def hear(rate: int, pcm_b64: str) -> dict:
    try:
        raw = base64.b64decode(pcm_b64, validate=False)
    except Exception:
        raise VoiceError("empty", "The audio arrived in a form I cannot read.")
    return hear_pcm(rate, raw)


def hear_pcm(rate: int, raw: bytes) -> dict:
    _need_numpy()
    audio = np.frombuffer(raw[: len(raw) - (len(raw) % 2)], dtype="<i2").astype(np.float32) / 32768.0
    seconds = audio.size / float(rate or STT_RATE)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    log(f"heard {seconds:.1f}s of audio (loudest point {peak:.2f} of 1.00) — turning it into words…")
    if audio.size < rate * 0.3:
        log("that clip was too short to be speech; nothing was sent back")
        return {"ok": False, "code": "too-short", "message": "I heard almost nothing, sir."}
    if peak < 0.02:
        # The browser sent audio, but it is effectively silence: the microphone
        # is muted, too far away, or the wrong input is selected. Say so plainly
        # instead of letting the speech model guess at silence.
        log("that clip was silent — check the microphone is not muted and is the selected input")
        return {"ok": False, "code": "too-quiet", "message": "I heard only silence, sir. Check the microphone is not muted and is the right one in the system sound settings."}
    if rate != STT_RATE:
        n_out = int(round(audio.size * STT_RATE / rate))
        audio = np.interp(np.linspace(0.0, 1.0, n_out), np.linspace(0.0, 1.0, audio.size), audio).astype(np.float32)
    with _hear_lock:
        started = time.monotonic()
        try:
            # No vad_filter: the browser already cut this clip at a pause, and a
            # second voice-activity filter throws quiet speech away.
            # without_timestamps + no conditioning on previous text: both make
            # decoding of a short clip noticeably faster, and neither is
            # needed — the words are the whole job here.
            segments, _info = whisper().transcribe(audio, language=STT_LANGUAGE or None, vad_filter=False, beam_size=1,
                                                   without_timestamps=True, condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segments).strip()
        except VoiceError:
            raise
        except Exception as err:
            raise VoiceError("failed", f"the speech model could not hear that: {err}")
        log(f"turning that into words took {time.monotonic() - started:.1f}s")
    if not text:
        log("the speech model found no words in that clip")
        return {"ok": False, "code": "empty", "message": "I heard sound, but no words I could make out, sir. Try again, a little closer to the microphone."}
    log(f"heard: \"{text[:120]}\"")
    return {"ok": True, "text": text}


def speak_reason() -> str:
    """Why speaking cannot work, in plain words. '' means it can."""
    if np is None:
        return "numpy is not installed for this Python"
    if not _installed("kokoro_onnx"):
        return "kokoro-onnx is not installed"
    if not _installed("sounddevice"):
        return "sounddevice is not installed"
    if not kokoro_files_present():
        return f"the Kokoro voice files ({KOKORO_MODEL}, {KOKORO_VOICES}) are missing from {KOKORO_DIR}"
    return _speak_failed or _output_failed


def hear_reason() -> str:
    """Why hearing cannot work, in plain words. '' means it can."""
    if np is None:
        return "numpy is not installed for this Python"
    if not _installed("faster_whisper"):
        return "faster-whisper is not installed"
    if _whisper_failed is not None:
        return _whisper_failed[1]
    return ""


def health() -> dict:
    speak_why, hear_why = speak_reason(), hear_reason()
    configured_output, _output_source = _configured_output_name()
    output_label = (_output_device_cache.get("label") or "system default") \
        if _output_device_cache.get("key") is not None else (configured_output or "system default")
    return {
        "ok": True,
        # "ready" must mean it can really do the work, not that this process is
        # running: the dashboard shows these lines in Settings → Voice.
        # Speaking and hearing are reported separately: a missing speech
        # model must not hide a working mouth (or the other way round).
        "speakReady": not speak_why,
        "speakReason": speak_why,
        "hearReady": not hear_why,
        "hearReason": hear_why,
        "outputDevice": output_label,
        "outputDeviceConfigured": configured_output,
        "numpy": np is not None,
        "voice": TTS_VOICE,
        "voiceFilesPresent": kokoro_files_present(),
        "voiceFolder": str(KOKORO_DIR),
        "speechModel": STT_MODEL,
    }


# ── HTTP ──────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisLocalVoice/1"

    def log_message(self, fmt: str, *args) -> None:  # keep the access log quiet
        return

    def _send(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The server stopped waiting (it gives /transcribe 120 s and /speak
            # 180 s). One plain line — not a page of traceback for a hang-up.
            log("the server had already stopped waiting, so that reply went nowhere. If this repeats, the line above it says what took so long.")

    def handle_error(self, request, client_address) -> None:  # one plain line, never a traceback for a disconnect
        log("a connection closed early; nothing else was affected.")

    def _json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        return data if isinstance(data, dict) else {}

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(health())
        else:
            self._send({"ok": False, "code": "not-found"}, 404)

    def do_POST(self) -> None:
        try:
            if self.path == "/transcribe" and (self.headers.get("Content-Type") or "").startswith("application/octet-stream"):
                # Raw sound, exactly as recorded — no base64, no JSON. The
                # sample rate rides in a header. This is the fast path the
                # page uses; the JSON form below is kept for the server's own
                # fallback caller.
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                rate = int(self.headers.get("X-Audio-Rate") or 16000)
                self._send(hear_pcm(rate, raw))
                return
            body = self._json_body()
            if self.path == "/speak":
                self._send(speak(str(body.get("text", ""))))
            elif self.path == "/stop":
                stop()
                self._send({"ok": True})
            elif self.path == "/transcribe":
                self._send(hear(int(body.get("rate") or 48000), str(body.get("pcm", ""))))
            else:
                self._send({"ok": False, "code": "not-found"}, 404)
        except VoiceError as err:
            log(f"{err.code}: {err.message}")
            self._send({"ok": False, "code": err.code, "message": err.message})
        except Exception as err:
            log(f"failed ({type(err).__name__}): {err}")
            traceback.print_exc()
            self._send({"ok": False, "code": "failed", "message": f"The local voice failed: {err}"}, 500)


def preload() -> None:
    """Load BOTH models in the background so the first use is not slow.

    The speech model matters most: before this, it loaded inside the first
    /transcribe request, the download + load outlasted the server's 120 s
    wait, and the reply died with a broken pipe — speech simply never arrived.
    """
    def load(fn, what: str) -> None:
        try:
            fn()
        except VoiceError as err:
            log(f"not ready ({what}): {err.message}")
        except Exception as err:
            log(f"not ready ({what}): {err}")

    def warm_voice() -> None:
        # Make one short sound and throw it away. The first real reply then
        # starts at once instead of paying the model's first-run cost.
        if np is None:
            log("speaking is off: numpy is not installed for this Python")
            return
        load(kokoro, "voice")
        if _kokoro is not None:
            try:
                with _speak_lock:
                    # Prove the speakers before claiming ready: resolve the
                    # saved choice and open it once (silently), so a wrong or
                    # dead output device is named here, at startup, in the
                    # [local-voice] lines — not discovered as silence later.
                    try:
                        verify_output_device()
                    except VoiceError as err:
                        log(f"speaking is NOT ready: {err.message}")
                    kokoro().create("Ready.", voice=TTS_VOICE, speed=1.0, lang=kokoro_lang())
                log("the voice is warmed up — speaking starts at once")
            except Exception:
                pass

    def warm_hearing() -> None:
        # Turn one second of silence into (no) words. Same reason: the first
        # real sentence must not pay the speech model's first-run cost.
        if np is None:
            log("hearing is off: numpy is not installed for this Python")
            return
        load(whisper, "hearing")
        if _whisper is not None:
            try:
                with _hear_lock:
                    segments, _info = whisper().transcribe(
                        np.zeros(STT_RATE, dtype=np.float32), language=STT_LANGUAGE or None,
                        vad_filter=False, beam_size=1, without_timestamps=True,
                        condition_on_previous_text=False)
                    _ = [s.text for s in segments]
                log("the speech model is warmed up — hearing reacts at once")
            except Exception:
                pass

    threading.Thread(target=warm_voice, daemon=True).start()
    threading.Thread(target=warm_hearing, daemon=True).start()


def main() -> None:
    log(f"starting on 127.0.0.1:{PORT} (voice {TTS_VOICE}, speech model {STT_MODEL})")
    speak_why, hear_why = speak_reason(), hear_reason()
    log(f"speaking: {'ready' if not speak_why else 'NOT ready — ' + speak_why}")
    log(f"hearing:  {'ready' if not hear_why else 'NOT ready — ' + hear_why}")
    if speak_why or hear_why:
        # Said once, at startup, in the server console where the owner looks —
        # and /health repeats it to the dashboard, so it is never a mystery.
        log("the voice service is running anyway: the dashboard's own browser voice still works. "
            "For this computer's voice: pip install -r backend/requirements-local-voice.txt (and put the Kokoro files in models/kokoro).")
    threading.Thread(target=preload, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("ready")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
