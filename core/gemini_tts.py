"""Gemini text-to-speech for the desktop app — one place that knows the current voice models.

The desktop app speaks through Gemini in two places: the Live session (main.py, voice
in and out) and the Settings voice preview (ui.py). This module holds everything the
preview needs to be right, so the rules can be tested without a screen or a speaker:

  * which voice models are current. Verified against Google's documentation on
    2026-10-12: `gemini-3.8-flash-tts` is the flagship and `gemini-3.8-flash-lite-tts`
    the fast, cheaper one (both released 22 September 2026, no shutdown announced).
    The names this app used before — `gemini-2.5-flash-preview-tts`,
    `gemini-2.5-pro-preview-tts` and `gemini-3.1-flash-tts-preview` — are scheduled to
    shut down on 17 November 2026, and Google's recommended replacement for every one
    of them is the 3.8 pair. Source: ai.google.dev/gemini-api/docs/deprecations (Audio models table)
    and ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts.

  * where a style direction belongs. Google's speech-generation guide is explicit: the
    spoken transcript goes in the text, and the *style* goes in the part's
    `speech_metadata.style`. A directive glued onto the transcript ("Say naturally: …")
    can be read aloud, which is a bug the owner hears rather than reads.

  * what comes back. The 3.8 TTS models return a COMPLETE WAV file (`audio/wav`) by
    default — Google's example writes the bytes straight to `out.wav`. The older
    preview models returned headerless PCM with the sample rate in the mime type
    (`audio/L16;codec=pcm;rate=24000`). Both are decoded here; a WAV wrapped in a
    second WAV header is silence, so the two are never confused.

  * when to try another model. ONLY a withdrawn model name (404 / NOT_FOUND /
    "no longer available") moves on to the next name. A refused key, an exhausted
    quota or a dead connection fails the same way on every model, and pretending
    otherwise just spends the owner's budget twice for the same silence.

Provenance: written for this project (CC BY-NC 4.0, see CREDITS.md) against the
documentation above and the installed `google-genai` SDK. No code taken from other
projects.
"""
from __future__ import annotations

import io
import os
import wave

# The current voice models, best first. The second is used only when the first is
# withdrawn (see is_model_unavailable) — never as a quiet downgrade.
DEFAULT_VOICE_MODEL = "gemini-3.8-flash-tts"
FALLBACK_VOICE_MODELS = ("gemini-3.8-flash-lite-tts",)

# Names this app used before, with the shutdown Google has announced for them. Kept
# only so the app can say honestly why a configured name is about to stop answering.
RETIRED_VOICE_MODELS = {
    "gemini-2.5-flash-preview-tts": ("17 November 2026", DEFAULT_VOICE_MODEL),
    "gemini-2.5-pro-preview-tts": ("17 November 2026", DEFAULT_VOICE_MODEL),
    "gemini-3.1-flash-tts-preview": ("17 November 2026", DEFAULT_VOICE_MODEL),
}

# Words that mean "this is not a model problem": a bad key, a spent quota, or the
# network. Checked BEFORE the not-found words, because "connection ... not found"
# is a connection failure, not a withdrawn model.
_NOT_A_MODEL_PROBLEM = (
    "api key", "api_key", "permission", "unauthor", "forbidden",
    "quota", "rate limit", "resource_exhausted", "resource exhausted", "billing",
    "connection", "network", "timeout", "timed out", "unreachable", "refused",
    "name or service not known", "temporary failure", "ssl", "proxy", "certificate",
)
_MODEL_GONE_WORDS = (
    "not found", "not_found", "does not exist", "no longer available",
    "unsupported model", "is not supported", "unknown model", "retired",
)
_MODEL_GONE_STATUSES = {"NOT_FOUND", "MODEL_NOT_FOUND", "UNIMPLEMENTED"}


def _current_voice_model(model: str) -> str:
    """Move a known legacy preview TTS setting to the current stable model."""
    value = (model or "").strip()
    normalized = value.removeprefix("models/")
    if normalized in RETIRED_VOICE_MODELS:
        return DEFAULT_VOICE_MODEL
    return value or DEFAULT_VOICE_MODEL


def configured_voice_model() -> str:
    """Resolve the voice setting, migrating known legacy preview names."""
    for name in ("SUPPER_VOICE_MODEL", "GEMINI_TTS_MODEL"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return _current_voice_model(value)
    return DEFAULT_VOICE_MODEL


def voice_model_candidates(configured: str | None = None) -> list[str]:
    """The current configured model first, then stable fallbacks.

    Known legacy preview TTS settings are migrated before a request can use them.
    Only an actually withdrawn name is allowed to move on to a fallback.
    """
    first = _current_voice_model((configured or configured_voice_model()).strip())
    order = [first]
    for name in (DEFAULT_VOICE_MODEL,) + FALLBACK_VOICE_MODELS:
        if name not in order:
            order.append(name)
    return order


def retirement_note(model: str) -> str:
    """A plain-language note when a name is due to be switched off, else ''."""
    entry = RETIRED_VOICE_MODELS.get((model or "").strip())
    if not entry:
        return ""
    when, replacement = entry
    return (f"{model} is switched off on {when}; the app uses {replacement} instead, "
            f"and moves on to it by itself if {model} stops answering.")


def style_for_metadata(style: str) -> str:
    """A style direction as the speech metadata wants it, without the prompt label.

    `VOICE_STYLES` holds prompt-style directions that begin "SPEAKING STYLE: …". The
    label is an instruction to the model, not part of the direction, so it is dropped.
    """
    text = " ".join(str(style or "").split())
    if text.upper().startswith("SPEAKING STYLE:"):
        text = text[len("SPEAKING STYLE:"):].strip()
    return text


def preview_contents(line: str, style: str = "") -> list[dict]:
    """The request contents: the words to say, with the style as metadata (never as text)."""
    part: dict = {"text": str(line or "")}
    style_text = style_for_metadata(style)
    if style_text:
        part["speech_metadata"] = {"style": style_text}
    return [{"role": "user", "parts": [part]}]


def preview_config(voice: str) -> dict:
    """The request config: audio out, one prebuilt voice."""
    return {
        "response_modalities": ["AUDIO"],
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": voice}}},
    }


def is_model_unavailable(exc: BaseException) -> bool:
    """True only when the model NAME is the problem (withdrawn/unknown).

    False for a refused key, an exhausted quota, a dead connection, or anything the
    error does not clearly identify as a missing model — so those are reported to the
    owner instead of being papered over with another model.
    """
    code = getattr(exc, "code", None)
    if code is None:
        code = getattr(exc, "status_code", None)
    try:
        numeric = int(code) if code is not None else None
    except (TypeError, ValueError):
        numeric = None
    status = str(getattr(exc, "status", "") or "").upper()
    message = str(exc).lower()

    if numeric == 404 or status in _MODEL_GONE_STATUSES:
        return True

    # A 403 can mean the key is valid but cannot access this specific model. That
    # should permit a fallback; a generic key/project permission failure must not.
    key_specific_denial = any(word in message for word in (
        "api key", "api_key", "permission denied for this key",
        "invalid api key", "key not valid", "unauthenticated",
    ))
    model_scoped_denial = (
        any(word in message for word in ("model", "models/", "gemini-"))
        and any(word in message for word in (
            "permission to access", "access denied", "not authorized",
            "not allowed", "restricted", "unavailable to your account",
        ))
    )
    if not key_specific_denial and model_scoped_denial and (numeric == 403 or status == "PERMISSION_DENIED"):
        return True

    if numeric in (400, 401, 403, 429, 500, 503):
        # A named status that is NOT a missing model. 400 is included on purpose:
        # "invalid argument" is a request problem, not a withdrawn model.
        return False
    if any(word in message for word in _NOT_A_MODEL_PROBLEM):
        return False
    if any(word in message for word in _MODEL_GONE_WORDS):
        return True
    return False


def decode_audio(data: bytes, mime_type: str = "") -> tuple[bytes, int]:
    """Return 16-bit mono little-endian PCM and its sample rate.

    A complete WAV (the 3.8 TTS default) is read with the standard library. Headerless
    PCM — what the older preview models returned — is passed through, with the rate
    taken from the mime type (`audio/L16;codec=pcm;rate=24000`) or 24000.
    """
    raw = bytes(data or b"")
    if len(raw) > 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        with wave.open(io.BytesIO(raw), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
        if width != 2:
            raise ValueError(f"the voice answered with {width * 8}-bit samples, which this player cannot use")
        if channels == 2:
            # Straight mono downmix: the speakers take one channel.
            import array as _array
            stereo = _array.array("h")
            stereo.frombytes(frames)
            mono = _array.array("h", stereo[0::2])
            for i, value in enumerate(stereo[1::2]):
                mono[i] = int((mono[i] + value) / 2)
            frames = mono.tobytes()
        elif channels != 1:
            raise ValueError(f"the voice answered with {channels} channels, which this player cannot use")
        return frames, rate or 24000
    if not raw:
        raise ValueError("the voice sent no audio back")
    rate = 24000
    marker = str(mime_type or "").lower()
    if "rate=" in marker:
        try:
            rate = int(marker.split("rate=", 1)[1].split(";")[0].strip())
        except ValueError:
            rate = 24000
    return raw, rate
