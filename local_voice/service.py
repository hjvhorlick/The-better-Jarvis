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
  SUPPER_TTS_VOICE           Kokoro voice name (default af_heart)
  SUPPER_STT_MODEL           faster-whisper model: tiny, base, small, medium (default base)
  SUPPER_STT_LANGUAGE        language code (default en)
  SUPPER_LOCAL_VOICE_PORT    port on 127.0.0.1 (default 3101)
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
KOKORO_DIR = Path(os.environ.get("SUPPER_KOKORO_DIR", ROOT / "models" / "kokoro"))
KOKORO_MODEL = "kokoro-v1.0.onnx"
KOKORO_VOICES = "voices-v1.0.bin"
TTS_VOICE = os.environ.get("SUPPER_TTS_VOICE", "af_heart").strip() or "af_heart"
STT_MODEL = os.environ.get("SUPPER_STT_MODEL", "base").strip() or "base"
STT_LANGUAGE = os.environ.get("SUPPER_STT_LANGUAGE", "en").strip() or "en"
PORT = int(os.environ.get("SUPPER_LOCAL_VOICE_PORT", "3101"))
STT_RATE = 16000

_speak_lock = threading.Lock()   # one sentence at a time
_hear_lock = threading.Lock()
_kokoro = None
_whisper = None


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
        _kokoro = Kokoro(str(KOKORO_DIR / KOKORO_MODEL), str(KOKORO_DIR / KOKORO_VOICES))
        log("the Kokoro voice is ready")
    return _kokoro


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
    with _speak_lock:
        try:
            samples, rate = kokoro().create(text, voice=TTS_VOICE, speed=1.0, lang="en-us")
        except VoiceError:
            raise
        except Exception as err:
            raise VoiceError("failed", f"Kokoro could not make the voice: {err}")
        play(samples, int(rate))
    return {"ok": True}


def stop() -> None:
    try:
        import sounddevice as sd
        sd.stop()
    except Exception:
        pass  # nothing was playing


# ── Hearing ───────────────────────────────────────────────────────────────────
def whisper():
    global _whisper
    if _whisper is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise VoiceError("no-package", "faster-whisper is not installed. Run: pip install -r backend/requirements-local-voice.txt")
        log(f"loading the speech model ({STT_MODEL}); the first run downloads it once")
        _whisper = WhisperModel(STT_MODEL, device="cpu", compute_type="int8")
        log("the speech model is ready")
    return _whisper


def hear(rate: int, pcm_b64: str) -> dict:
    try:
        raw = base64.b64decode(pcm_b64, validate=False)
    except Exception:
        raise VoiceError("empty", "The audio arrived in a form I cannot read.")
    audio = np.frombuffer(raw[: len(raw) - (len(raw) % 2)], dtype="<i2").astype(np.float32) / 32768.0
    if audio.size < rate * 0.3:
        return {"ok": False, "code": "too-short", "message": "I heard almost nothing, sir."}
    if rate != STT_RATE:
        n_out = int(round(audio.size * STT_RATE / rate))
        audio = np.interp(np.linspace(0.0, 1.0, n_out), np.linspace(0.0, 1.0, audio.size), audio).astype(np.float32)
    with _hear_lock:
        try:
            segments, _info = whisper().transcribe(audio, language=STT_LANGUAGE or None, vad_filter=True, beam_size=1)
            text = " ".join(s.text.strip() for s in segments).strip()
        except VoiceError:
            raise
        except Exception as err:
            raise VoiceError("failed", f"the speech model could not hear that: {err}")
    if not text:
        return {"ok": False, "code": "empty", "message": "I heard no words in that."}
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
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
            log(f"failed: {err}")
            traceback.print_exc()
            self._send({"ok": False, "code": "failed", "message": f"The local voice failed: {err}"}, 500)


def preload() -> None:
    """Load the voice in the background so the first sentence is not slow."""
    try:
        kokoro()
    except VoiceError as err:
        log(f"not ready: {err.message}")
    except Exception as err:
        log(f"not ready: {err}")


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
