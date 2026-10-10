from types import SimpleNamespace

import pytest

from backend import config
from backend.chat import BackendNotConfigured, ChatService, UpstreamError


class FakeModels:
    def __init__(self, reply="hello from fake", error=None):
        self.calls = []
        self._reply = reply
        self._error = error

    def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self._error:
            raise self._error
        return SimpleNamespace(text=self._reply)


class FakeClient:
    def __init__(self, models):
        self.models = models


def _service(models):
    keys = []

    def factory(api_key):
        keys.append(api_key)
        return FakeClient(models)

    svc = ChatService(client_factory=factory, model="test-model")
    svc._keys = keys
    return svc


def test_no_key_is_reported_clearly(isolated):
    svc = _service(FakeModels())
    with pytest.raises(BackendNotConfigured):
        svc.reply("hi")


def test_env_key_is_used_and_persona_is_sent(isolated, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    models = FakeModels(reply="Good evening, sir.")
    svc = _service(models)
    assert svc.reply("hi there") == "Good evening, sir."
    call = models.calls[0]
    assert call["model"] == "test-model"
    assert "[IDENTITY]" in call["config"]["system_instruction"]
    assert "Ayse" in call["config"]["system_instruction"]      # memory reached the prompt
    assert call["contents"][-1] == {"role": "user", "parts": [{"text": "hi there"}]}


def test_key_read_from_config_file(isolated, monkeypatch):
    import json
    config.API_CONFIG_PATH.write_text(json.dumps({"gemini_api_key": "file-key"}), encoding="utf-8")
    assert config.get_gemini_api_key() == "file-key"


def test_history_is_sent_back_on_next_turn(isolated, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    models = FakeModels(reply="one")
    svc = _service(models)
    svc.reply("first")
    models._reply = "two"
    svc.reply("second")
    contents = models.calls[1]["contents"]
    assert [c["role"] for c in contents] == ["user", "model", "user"]


def test_upstream_error_hides_provider_message(isolated, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "super-secret-key")
    svc = _service(FakeModels(error=RuntimeError("bad key super-secret-key")))
    with pytest.raises(UpstreamError) as info:
        svc.reply("hi")
    assert "super-secret-key" not in str(info.value)
    assert "RuntimeError" in str(info.value)


def test_empty_message_rejected(isolated, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    with pytest.raises(ValueError):
        _service(FakeModels()).reply("   ")
