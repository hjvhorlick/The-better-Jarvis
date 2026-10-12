"""Regression tests for current Gemini model selection in the Python engine room."""
import pytest

from backend import config


@pytest.mark.parametrize("setting", ["SUPPER_TEXT_MODEL", "GEMINI_MODEL"])
@pytest.mark.parametrize(
    "legacy_model",
    [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-preview-05-20",
        "models/gemini-2.5-flash",
    ],
)
def test_legacy_text_model_overrides_migrate_to_current_stable(monkeypatch, setting, legacy_model):
    monkeypatch.delenv("SUPPER_TEXT_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.setenv(setting, legacy_model)

    assert config.get_text_model() == config.DEFAULT_TEXT_MODEL == "gemini-3.8-flash"


def test_primary_text_setting_wins_over_legacy_compatibility_setting(monkeypatch):
    monkeypatch.setenv("SUPPER_TEXT_MODEL", "custom-supported-model")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-2.5-flash")

    assert config.get_text_model() == "custom-supported-model"


def test_current_gemini_model_compatibility_setting_is_honoured(monkeypatch):
    monkeypatch.delenv("SUPPER_TEXT_MODEL", raising=False)
    monkeypatch.setenv("GEMINI_MODEL", "gemini-3.6-flash")

    assert config.get_text_model() == "gemini-3.6-flash"
