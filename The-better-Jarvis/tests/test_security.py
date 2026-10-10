import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.chat import ChatService
from backend.security import host_is_local, origin_is_local
from tests.test_chat import FakeClient, FakeModels


@pytest.mark.parametrize("host", [
    "127.0.0.1", "127.0.0.1:8765", "localhost", "localhost:8765", "[::1]:8765", "::1",
])
def test_local_hosts_allowed(host):
    assert host_is_local(host)


@pytest.mark.parametrize("host", [
    "", "evil.example", "evil.example:8765", "127.0.0.1.evil.example", "192.168.1.20:8765",
    "localhost.evil.example",
])
def test_other_hosts_refused(host):
    assert not host_is_local(host)


@pytest.mark.parametrize("origin", [
    "http://127.0.0.1:8765", "http://localhost:8765", "http://localhost", "http://[::1]:8765",
])
def test_local_origins_allowed(origin):
    assert origin_is_local(origin)


@pytest.mark.parametrize("origin", [
    "https://evil.example", "http://localhost.evil.example", "null", "http://192.168.1.20:8765",
])
def test_foreign_origins_refused(origin):
    assert not origin_is_local(origin)


def _app(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    svc = ChatService(client_factory=lambda k: FakeClient(FakeModels()), model="m")
    return create_app(svc, serve_ui=False)


def test_dns_rebinding_host_is_blocked(isolated, monkeypatch):
    client = TestClient(_app(monkeypatch), base_url="http://evil.example")
    r = client.get("/api/health")
    assert r.status_code == 403


def test_cross_site_origin_is_blocked(isolated, monkeypatch):
    client = TestClient(_app(monkeypatch), base_url="http://127.0.0.1:8765")
    r = client.post("/api/chat", json={"text": "hi"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_local_origin_is_allowed(isolated, monkeypatch):
    client = TestClient(_app(monkeypatch), base_url="http://127.0.0.1:8765")
    r = client.get("/api/health", headers={"Origin": "http://localhost:8765"})
    assert r.status_code == 200


def test_requests_without_origin_still_work(isolated, monkeypatch):
    client = TestClient(_app(monkeypatch), base_url="http://127.0.0.1:8765")
    assert client.get("/api/health").status_code == 200


# ----- an explicitly allowed extra host (hosted preview only; off by default) -----

from backend.security import LocalOnlyGuard, extra_hosts  # noqa: E402

PREVIEW = "8765-sandbox123.e2b.app"


def test_extra_hosts_are_off_by_default(monkeypatch):
    monkeypatch.delenv("SUPPER_EXTRA_HOSTS", raising=False)
    assert extra_hosts() == frozenset()
    assert not host_is_local(PREVIEW)


def test_an_allowed_extra_host_is_accepted_exactly(monkeypatch):
    monkeypatch.setenv("SUPPER_EXTRA_HOSTS", f" {PREVIEW.upper()} , other.example ")
    allowed = extra_hosts()
    assert host_is_local(PREVIEW, allowed)
    assert not host_is_local("evil-" + PREVIEW, allowed)       # no suffix matching
    assert not host_is_local("8765-sandbox999.e2b.app", allowed)


def test_the_preview_origin_is_accepted_only_for_the_allowed_host():
    allowed = frozenset({PREVIEW})
    assert origin_is_local(f"https://{PREVIEW}", allowed)
    assert not origin_is_local(f"http://{PREVIEW}", allowed)    # https only for extra hosts
    assert not origin_is_local("https://attacker.example", allowed)
    assert not origin_is_local(f"https://{PREVIEW}")            # not allowed without the setting


def test_the_guard_uses_the_allowed_host_end_to_end():
    import asyncio

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    def call(headers, guard):
        out = []

        async def send(message):
            out.append(message)

        async def receive():
            return {"type": "http.request"}

        scope = {"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers]}
        asyncio.run(guard(scope, receive, send))
        return out[0]["status"]

    guard = LocalOnlyGuard(app, extra=frozenset({PREVIEW}))
    assert call([("host", PREVIEW), ("origin", f"https://{PREVIEW}")], guard) == 200
    assert call([("host", "evil.example")], guard) == 403
    assert call([("host", "127.0.0.1:8765")], LocalOnlyGuard(app, extra=frozenset())) == 200
