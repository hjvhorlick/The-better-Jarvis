"""The desktop app's Gemini voice preview: current models, style in metadata, both audio shapes.

These tests are the rules the Settings voice preview must follow, checked without a screen,
a speaker or a network call:

  * the models are the CURRENT ones (gemini-3.8-flash-tts, then gemini-3.8-flash-lite-tts).
    Every name this app used before — gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts,
    gemini-3.1-flash-tts-preview — is scheduled to shut down on 17 November 2026
    (ai.google.dev/gemini-api/docs/deprecations, Audio models table, read 2026-10-12);
  * a style direction travels in the part's speech metadata, never glued onto the words that
    are spoken (a directive in the transcript can be read aloud);
  * BOTH output shapes are decoded: the complete WAV the current models return, and the
    headerless PCM the older preview models returned — a WAV must never be re-wrapped;
  * only a WITHDRAWN MODEL NAME moves on to the next model. A refused key, an exhausted
    quota or a dead connection is not a retirement and must be reported as itself.
"""
import io
import struct
import wave

import pytest

from core import gemini_tts as g


# ----- which models -----

def test_the_current_voice_models_are_offered_in_order(monkeypatch):
    monkeypatch.delenv("SUPPER_VOICE_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_TTS_MODEL", raising=False)
    assert g.configured_voice_model() == "gemini-3.8-flash-tts"
    assert g.voice_model_candidates() == ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]


def test_legacy_voice_settings_are_migrated_and_current_overrides_are_respected(monkeypatch):
    monkeypatch.setenv("SUPPER_VOICE_MODEL", "gemini-2.5-flash-preview-tts")
    assert g.configured_voice_model() == "gemini-3.8-flash-tts"
    assert g.voice_model_candidates() == ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]
    assert g.voice_model_candidates("gemini-2.5-pro-preview-tts") == [
        "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"
    ]
    monkeypatch.delenv("SUPPER_VOICE_MODEL", raising=False)
    monkeypatch.setenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview")
    assert g.configured_voice_model() == "gemini-3.8-flash-tts"
    monkeypatch.delenv("GEMINI_TTS_MODEL", raising=False)
    monkeypatch.setenv("SUPPER_VOICE_MODEL", "gemini-3.8-flash-lite-tts")
    assert g.voice_model_candidates() == ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]


def test_a_name_google_is_switching_off_says_so_and_gives_the_date():
    note = g.retirement_note("gemini-3.1-flash-tts-preview")
    assert "17 November 2026" in note and "gemini-3.8-flash-tts" in note
    assert g.retirement_note("gemini-3.8-flash-tts") == ""


# ----- where the style goes -----

def test_the_style_is_metadata_and_never_part_of_the_spoken_words():
    contents = g.preview_contents("Hello sir, systems are online.",
                                 "SPEAKING STYLE: Calm, dry, understated British butler.")
    part = contents[0]["parts"][0]
    assert part["text"] == "Hello sir, systems are online."
    assert part["speech_metadata"]["style"] == "Calm, dry, understated British butler."
    assert "SPEAKING STYLE" not in part["text"]
    assert "Say naturally" not in part["text"]


def test_no_style_means_no_metadata_and_the_words_are_untouched():
    part = g.preview_contents("Good evening.")[0]["parts"][0]
    assert part == {"text": "Good evening."}


def test_the_request_asks_for_audio_in_the_selected_voice():
    config = g.preview_config("Charon")
    assert config["response_modalities"] == ["AUDIO"]
    assert config["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"] == "Charon"


def test_the_real_sdk_accepts_the_request_shape():
    """The dicts are handed to google-genai; they must coerce, not fail at the call."""
    pytest.importorskip("google.genai")
    from google.genai import types as t

    content = t.Content(**g.preview_contents("Testing one two.", "SPEAKING STYLE: brisk.")[0])
    assert content.parts[0].text == "Testing one two."
    assert content.parts[0].speech_metadata.style == "brisk."
    cfg = t.GenerateContentConfig(**g.preview_config("Charon"))
    assert cfg.speech_config.voice_config.prebuilt_voice_config.voice_name == "Charon"


# ----- the two audio shapes -----

def _wav(samples, rate=24000, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"".join(struct.pack("<h", s) for s in samples))
    return buffer.getvalue()


def test_a_complete_wav_is_read_as_it_arrived():
    pcm, rate = g.decode_audio(_wav([1, 2, 3, 4], rate=24000), "audio/wav")
    assert struct.unpack("<4h", pcm) == (1, 2, 3, 4)
    assert rate == 24000


def test_a_wav_at_another_rate_keeps_its_rate():
    pcm, rate = g.decode_audio(_wav([5, 6], rate=16000), "audio/wav")
    assert struct.unpack("<2h", pcm) == (5, 6) and rate == 16000


def test_stereo_wav_is_mixed_down_for_one_speaker():
    pcm, rate = g.decode_audio(_wav([10, 20, 30, 40], channels=2), "audio/wav")
    assert struct.unpack("<2h", pcm) == (15, 35) and rate == 24000


def test_headerless_pcm_still_works_and_takes_its_rate_from_the_mime_type():
    raw = struct.pack("<3h", 7, 8, 9)
    pcm, rate = g.decode_audio(raw, "audio/L16;codec=pcm;rate=16000")
    assert pcm == raw and rate == 16000
    pcm, rate = g.decode_audio(raw, "")
    assert pcm == raw and rate == 24000                      # the documented default


def test_wrapping_a_wav_in_another_header_would_be_a_bug_this_avoids():
    original = _wav([1, 2, 3, 4])
    pcm, _ = g.decode_audio(original, "audio/wav")
    assert pcm != original                                   # the header is stripped, not doubled
    assert pcm[:4] != b"RIFF"


def test_silence_from_the_model_is_an_error_not_a_quiet_success():
    with pytest.raises(ValueError):
        g.decode_audio(b"", "audio/wav")


# ----- when another model may be tried -----

class _Err(Exception):
    def __init__(self, message="", code=None, status=""):
        super().__init__(message)
        self.code = code
        self.status = status


@pytest.mark.parametrize("error", [
    _Err("This model models/old-tts is no longer available to new users.", code=404),
    _Err("Your account does not have permission to access model gemini-2.5-flash-preview-tts.", code=403),
    _Err("model not found", status="NOT_FOUND"),
    _Err("That model does not exist."),
    _Err("The model name is retired, use another."),
])
def test_a_withdrawn_or_unknown_name_may_move_on(error):
    assert g.is_model_unavailable(error) is True


@pytest.mark.parametrize("error", [
    _Err("API key not valid. Please pass a valid API key.", code=400),
    _Err("Permission denied for this key.", code=403),
    _Err("Quota exceeded for quota metric.", code=429, status="RESOURCE_EXHAUSTED"),
    _Err("Connection refused"),
    _Err("Timeout while connecting to the model server"),
    _Err("getaddrinfo failed: Name or service not known"),
    _Err("500 Internal error while generating audio", code=500),
    _Err("something entirely unexplained"),
])
def test_a_refused_key_a_spent_quota_or_a_dead_connection_is_final(error):
    assert g.is_model_unavailable(error) is False
