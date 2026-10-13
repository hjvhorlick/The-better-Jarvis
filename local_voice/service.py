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
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
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
_out_stream = None               # the speakers' stream, kept open between replies
_out_rate = 0
_speech_stopped = False          # /stop was pressed: the current sentence ends quietly, no error
_kokoro = None
_whisper = None
# A failed speech-model load is remembered for a minute. Without this, every
# clip the browser sends pays for the whole failed download again (the model
# library retries a dead network for minutes), so hearing never just fails —
# it waits, every time, and the server hangs up first (broken pipe).
_whisper_failed: tuple[float, str] | None = None   # (when, plain reason)
_WHISPER_RETRY_S = 60

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


# ── Speaking ──────────────────────────────────────────────────────────────────
def kokoro_files_present() -> bool:
    return (KOKORO_DIR / KOKORO_MODEL).is_file() and (KOKORO_DIR / KOKORO_VOICES).is_file()


def kokoro():
    global _kokoro
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
            raise VoiceError("no-model", f"The Kokoro voice files could not be loaded ({err}). Check {KOKORO_MODEL} and {KOKORO_VOICES} in {KOKORO_DIR}.")
        log("the Kokoro voice is ready")
    return _kokoro


def kokoro_lang() -> str:
    # British voices (bm_*/bf_*) are trained for en-gb; the rest default to en-us.
    return "en-gb" if TTS_VOICE.startswith("b") else "en-us"


def play_stream(text: str) -> None:
    """Speak with sound starting almost at once, on a stream that stays open.

    Kokoro hands over the voice in small pieces as it makes them; the first
    piece is played while the rest is still being made. The old way made the
    WHOLE text first and only then started the speakers — every reply began
    with seconds of silence, longer for longer replies.

    The speakers' stream is opened once and kept open between replies, like
    the standalone app's Speaker (backend/voice/audio.py): opening a stream
    is slow, and doing it for every sentence put a pause before every reply.
    """
    try:
        import sounddevice as sd
    except ImportError:
        raise VoiceError("no-speaker", "sounddevice is not installed. Run: pip install -r backend/requirements-local-voice.txt")
    engine = kokoro()

    def open_stream(rate: int):
        global _out_stream, _out_rate
        if _out_stream is None or _out_rate != int(rate):
            close_stream()
            _out_stream = sd.OutputStream(samplerate=int(rate), channels=1, dtype="float32")
            _out_rate = int(rate)
            _out_stream.start()
        return _out_stream

    async def pump() -> None:
        global _active_stream
        started = time.monotonic()
        first = True
        try:
            async for samples, rate in engine.create_stream(text, voice=TTS_VOICE, speed=1.0, lang=kokoro_lang()):
                stream = open_stream(int(rate))
                _active_stream = stream
                if first:
                    first = False
                    log(f"first sound after {time.monotonic() - started:.1f}s")
                # write() waits until there is room in the output buffer, so
                # the voice can never run ahead of the speakers.
                stream.write(np.asarray(samples, dtype=np.float32).reshape(-1, 1))
        finally:
            _active_stream = None
            # The stream stays open for the next reply (it plays silence
            # between replies); /stop and shutdown close it.

    try:
        asyncio.run(pump())
    except VoiceError:
        raise
    except Exception as err:  # PortAudio errors: no output device, device busy, etc.
        if _speech_stopped:
            return   # the owner pressed stop: an aborted stream is the point, not an error
        raise VoiceError("no-speaker", f"this computer's speakers could not play the voice ({err}). Check the output device.")


def play(samples, rate: int) -> None:
    try:
        import sounddevice as sd
    except ImportError:
        raise VoiceError("no-speaker", "sounddevice is not installed. Run: pip install -r backend/requirements-local-voice.txt")
    try:
        sd.play(np.asarray(samples, dtype=np.float32).reshape(-1), rate)
        sd.wait()
    except Exception as err:  # PortAudio errors: no output device, device busy, etc.
        raise VoiceError("no-speaker", f"this computer's speakers could not play the voice ({err}). Check the output device.")


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
    """Close the kept-open speakers' stream, if any."""
    global _out_stream, _out_rate
    stream, _out_stream, _out_rate = _out_stream, None, 0
    if stream is not None:
        try:
            stream.abort()
            stream.close()
        except Exception:
            pass


def stop() -> None:
    # Cut the sound at once: close the kept-open stream (abort drops what is
    # buffered). It reopens on the next reply. sd.stop() covers the old
    # play() fallback path.
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


def health() -> dict:
    return {
        "ok": True,
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
        load(kokoro, "voice")
        if _kokoro is not None:
            try:
                with _speak_lock:
                    kokoro().create("Ready.", voice=TTS_VOICE, speed=1.0, lang=kokoro_lang())
                log("the voice is warmed up — speaking starts at once")
            except Exception:
                pass

    def warm_hearing() -> None:
        # Turn one second of silence into (no) words. Same reason: the first
        # real sentence must not pay the speech model's first-run cost.
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
    threading.Thread(target=preload, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("ready")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
