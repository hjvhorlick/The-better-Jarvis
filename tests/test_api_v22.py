from fastapi.testclient import TestClient

from backend.app import create_app
from backend.chat import ChatService
from backend.events import EventBus
from backend.quota import DailyBudget
from tests.test_agent import ROOTS, FakeSession
from tests.test_chat import FakeClient, FakeModels

LOCAL = "http://127.0.0.1:8765"
SECRET = "secret-v22-key-qrs"


def _client(isolated, monkeypatch, limit=20, models=None, key=True):
    if key:
        monkeypatch.setenv("GEMINI_API_KEY", SECRET)
    models = models or FakeModels(reply="pong")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    bus = EventBus()
    session = FakeSession()
    budget = DailyBudget(limit, path=isolated / "runtime" / "quota.json")
    app = create_app(chat, serve_ui=False, myhands_session=session, bus=bus, budget=budget,
                     roots=lambda: ROOTS)
    client = TestClient(app, base_url=LOCAL)
    client.session = session
    client.models = models
    client.bus = bus
    client.budget = budget
    return client


def test_local_chat_answer_has_its_source(isolated, monkeypatch):
    body = _client(isolated, monkeypatch).post("/api/chat", json={"text": "what time is it"}).json()
    assert body["source"] == "local" and body["intent"] == "time.now" and body["reply"].startswith("It is ")


def test_gemini_chat_answer_has_its_source(isolated, monkeypatch):
    body = _client(isolated, monkeypatch).post("/api/chat", json={"text": "hello there"}).json()
    assert body["source"] == "gemini" and body["reply"] == "pong"


def test_starting_my_hands_from_chat_needs_a_click(isolated, monkeypatch):
    c = _client(isolated, monkeypatch)
    body = c.post("/api/chat", json={"text": "turn on my hands"}).json()
    assert body["source"] == "confirmation"
    pending = c.get("/api/confirmations").json()["pending"]
    assert [p["id"] for p in pending] == [body["confirmation"]["id"]]
    assert c.session.started == []
    answer = c.post(f"/api/confirmations/{pending[0]['id']}", json={"approve": True}).json()
    assert answer["status"] == "approved" and c.session.started == ["my_hands"]
    assert c.get("/api/confirmations").json()["pending"] == []


def test_answering_an_unknown_confirmation_is_404(isolated, monkeypatch):
    r = _client(isolated, monkeypatch).post("/api/confirmations/nope", json={"approve": True})
    assert r.status_code == 404


def test_denying_a_confirmation_over_http(isolated, monkeypatch):
    c = _client(isolated, monkeypatch)
    cid = c.post("/api/chat", json={"text": "turn on my hands"}).json()["confirmation"]["id"]
    out = c.post(f"/api/confirmations/{cid}", json={"approve": False}).json()
    assert out["status"] == "denied" and c.session.started == []


def test_the_count_warns_but_never_blocks_and_local_still_works(isolated, monkeypatch):
    c = _client(isolated, monkeypatch, limit=1)
    assert c.post("/api/chat", json={"text": "hello"}).status_code == 200
    second = c.post("/api/chat", json={"text": "hello again"})
    assert second.status_code == 200                      # the count only warns
    assert second.json()["source"] == "gemini"
    assert c.post("/api/chat", json={"text": "status"}).status_code == 200
    assert len(c.models.calls) == 2


def test_a_real_429_goes_offline_and_the_chat_keeps_answering(isolated, monkeypatch):
    c = _client(isolated, monkeypatch)
    c.budget.mark_exhausted()                # Google's own 429 — not this app's count
    body = c.post("/api/chat", json={"text": "hello"}).json()
    assert body["source"] == "local" and body["intent"] == "offline.quota"
    assert "offline" in body["reply"] and "midnight" in body["reply"]
    assert c.budget.snapshot()["used"] == 0   # offline answers are never counted
    # The status endpoint says so without any secret.
    snap = c.get("/api/status").json()["gemini_budget"]
    assert snap["offline"] is True and snap["used"] == 0


def test_status_and_diagnostics_show_the_budget_without_secrets(isolated, monkeypatch):
    c = _client(isolated, monkeypatch, limit=7)
    c.post("/api/chat", json={"text": "hello"})
    status = c.get("/api/status").json()
    diag = c.get("/api/diagnostics").json()
    assert status["gemini_budget"]["used"] == 1 and status["gemini_budget"]["limit"] == 7
    assert diag["gemini_budget"]["remaining"] == 6
    assert SECRET not in str(status) + str(diag)
    assert "gemini_api_key" not in str(diag)


def test_diagnostics_lists_the_permission_tiers(isolated, monkeypatch):
    perms = _client(isolated, monkeypatch).get("/api/diagnostics").json()["permissions"]
    tiers = {row["action"]: row["tier"] for row in perms}
    assert tiers["myhands.start"] == "confirm"
    assert tiers["shell.run"] == "blocked"
    assert tiers["code.self_modify"] == "blocked"


def test_confirmation_endpoints_refuse_a_foreign_host(isolated, monkeypatch):
    c = _client(isolated, monkeypatch)
    r = c.get("/api/confirmations", headers={"host": "evil.example"})
    assert r.status_code == 403


def test_a_cross_site_page_cannot_approve_a_confirmation(isolated, monkeypatch):
    c = _client(isolated, monkeypatch)
    cid = c.post("/api/chat", json={"text": "turn on my hands"}).json()["confirmation"]["id"]
    r = c.post(f"/api/confirmations/{cid}", json={"approve": True},
               headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    assert c.session.started == []
    assert [p["id"] for p in c.get("/api/confirmations").json()["pending"]] == [cid]
