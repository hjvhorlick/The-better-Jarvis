from fastapi.testclient import TestClient

from backend.app import create_app
from backend.chat import ChatService
from tests.test_chat import FakeClient, FakeModels

SECRET = "secret-test-key-xyz"
LOCAL = "http://127.0.0.1:8765"


def _client(isolated, monkeypatch, models=None, key=True):
    if key:
        monkeypatch.setenv("GEMINI_API_KEY", SECRET)
    models = models or FakeModels(reply="pong")
    svc = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    return TestClient(create_app(svc, serve_ui=False), base_url=LOCAL)


def test_health(isolated, monkeypatch):
    r = _client(isolated, monkeypatch).get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_status_never_returns_the_key(isolated, monkeypatch):
    body = _client(isolated, monkeypatch).get("/api/status").json()
    assert body["api_key_configured"] is True
    assert SECRET not in str(body)
    assert "gemini_api_key" not in str(body)


def test_chat_round_trip(isolated, monkeypatch):
    r = _client(isolated, monkeypatch).post("/api/chat", json={"text": "ping"})
    body = r.json()
    assert r.status_code == 200 and body["reply"] == "pong"
    assert body["source"] == "gemini" and body["intent"] is None


def test_chat_passes_workspace_into_system_instruction(isolated, monkeypatch):
    models = FakeModels(reply="ok")
    _client(isolated, monkeypatch, models=models).post(
        "/api/chat", json={"text": "hi", "workspace": "coding"})
    assert "Coding:" in models.calls[0]["config"]["system_instruction"]


def test_chat_rejects_unknown_workspace(isolated, monkeypatch):
    r = _client(isolated, monkeypatch).post("/api/chat", json={"text": "hi", "workspace": "nope"})
    assert r.status_code == 400


def test_chat_without_key_returns_503(isolated, monkeypatch):
    r = _client(isolated, monkeypatch, key=False).post("/api/chat", json={"text": "ping"})
    assert r.status_code == 503
    assert "GEMINI_API_KEY" in r.json()["detail"]


def test_upstream_failure_returns_502(isolated, monkeypatch):
    client = _client(isolated, monkeypatch, models=FakeModels(error=RuntimeError("boom")))
    assert client.post("/api/chat", json={"text": "ping"}).status_code == 502


def test_empty_text_is_validation_error(isolated, monkeypatch):
    assert _client(isolated, monkeypatch).post("/api/chat", json={"text": ""}).status_code == 422


def test_memory_summary_endpoint(isolated, monkeypatch):
    body = _client(isolated, monkeypatch).get("/api/memory/summary").json()
    assert body["file_present"] is True
    assert body["entries_by_category"]["preferences"] == 1


def test_workspaces_listed(isolated, monkeypatch):
    body = _client(isolated, monkeypatch).get("/api/workspaces").json()
    ids = [w["id"] for w in body["workspaces"]]
    assert {"general", "coding", "marketing", "design", "files"} <= set(ids)
    assert body["default"] == "general"


def test_files_endpoints_list_and_read(isolated, monkeypatch, tmp_path):
    root = tmp_path / "root"
    (root / "notes").mkdir(parents=True)
    (root / "hello.txt").write_text("hello world", encoding="utf-8")
    monkeypatch.setenv("SUPPER_FILE_ROOTS", str(root))
    client = _client(isolated, monkeypatch)
    roots = client.get("/api/files/roots").json()["roots"]
    assert roots and roots[0]["path"] == str(root.resolve())
    listing = client.get("/api/files/list", params={"path": str(root)}).json()
    names = [e["name"] for e in listing["entries"]]
    assert names == ["notes", "hello.txt"]          # folders first
    preview = client.get("/api/files/read", params={"path": str(root / "hello.txt")}).json()
    assert preview["text"] == "hello world"


def test_files_endpoint_refuses_outside_root(isolated, monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("nope", encoding="utf-8")
    monkeypatch.setenv("SUPPER_FILE_ROOTS", str(root))
    r = _client(isolated, monkeypatch).get("/api/files/read", params={"path": str(outside)})
    assert r.status_code == 403
