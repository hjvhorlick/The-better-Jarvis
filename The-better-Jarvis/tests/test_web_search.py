"""Web search (V2-5). Ported from the legacy `actions/web_search.py` (Gemini with Google Search).

Behaviour kept: one Gemini request with Google Search turned on, and a short answer. Changed: it counts
against the daily budget, and the key stays on the server. Tests use a recording fake, so no real call is made.
"""
from datetime import datetime
from types import SimpleNamespace

from backend import router
from backend.agent import WEB_SYSTEM, Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from backend.repair import Notices, SelfRepair
from backend.reminders import Reminders

NOW = datetime(2026, 10, 9, 14, 5)


class Recording:
    def __init__(self, reply=None, error=None):
        self.reply, self.error, self.calls = reply, error, []

    def generate_content(self, model, contents, config):
        self.calls.append({"contents": contents, "config": config})
        if self.error is not None:
            raise self.error
        return SimpleNamespace(text=self.reply)


class QuotaError(Exception):
    code = 429


def _agent(tmp_path, models, monkeypatch, key="test-key", limit=5):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    if key:
        monkeypatch.setenv("GEMINI_API_KEY", key)
    bus = EventBus()
    conf = ConfirmationStore(bus=bus)
    budget = DailyBudget(limit, path=tmp_path / "q.json", clock=lambda: NOW)
    svc = ChatService(client_factory=lambda k: SimpleNamespace(models=models), model="m")
    agent = Agent(svc, budget, default_policy(), conf, bus=bus, roots=lambda: [],
                  repair=SelfRepair(tmp_path, tmp_path / "runtime", confirmations=conf),
                  notices=Notices(tmp_path, bus=bus),
                  reminders=Reminders(tmp_path / "reminders.json", bus=bus, clock=lambda: NOW))
    return agent, budget


def test_the_phrases_route_to_web_search_and_keep_the_capitals():
    m = router.match("Search the web for Mandela Day 2026")
    assert m.action == "web.search"
    assert router.WEB_PREFIX.sub("", m.args["raw"], count=1) == "Mandela Day 2026"
    assert router.match("search online for tea in Benoni").action == "web.search"


def test_the_archive_search_still_routes_to_the_archive():
    assert router.match("search the archive for tea").action == "memory.search_archive"


def test_a_search_asks_google_for_this_request_only(tmp_path, isolated, monkeypatch):
    models = Recording(reply="The festival is on 18 July.")
    agent, budget = _agent(tmp_path, models, monkeypatch)
    out = agent.handle("Search the web for Mandela Day 2026")
    assert out["intent"] == "web.search" and out["source"] == "local"
    assert out["reply"] == "Web search, sir: The festival is on 18 July."
    call = models.calls[0]
    assert call["config"]["tools"] == [{"google_search": {}}]
    assert call["config"]["system_instruction"] == WEB_SYSTEM
    assert "Mandela Day 2026" in str(call["contents"])
    assert budget.snapshot()["used"] == 1


def test_a_plain_chat_request_does_not_turn_on_search(tmp_path, isolated, monkeypatch):
    models = Recording(reply="pong")
    svc = ChatService(client_factory=lambda k: SimpleNamespace(models=models), model="m")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    svc.complete("hello", "sys")
    assert "tools" not in models.calls[0]["config"]


def test_an_empty_search_asks_what_to_search_for_and_spends_nothing(tmp_path, isolated, monkeypatch):
    models = Recording(reply="x")
    agent, budget = _agent(tmp_path, models, monkeypatch)
    out = agent.handle("search the web for")
    assert out["intent"] == "web.search" and "what should I search the web for" in out["reply"]
    assert models.calls == []                               # nothing sent, nothing spent
    assert budget.snapshot()["used"] == 0


def test_no_budget_means_no_search(tmp_path, isolated, monkeypatch):
    models = Recording(reply="x")
    agent, budget = _agent(tmp_path, models, monkeypatch, limit=0)
    out = agent.handle("search the web for tea prices")
    assert "budget is used up" in out["reply"] and models.calls == []


def test_no_key_means_no_search(tmp_path, isolated, monkeypatch):
    models = Recording(reply="x")
    agent, budget = _agent(tmp_path, models, monkeypatch, key=None)
    out = agent.handle("search the web for tea prices")
    assert "No Gemini API key" in out["reply"] and models.calls == []


def test_a_quota_error_stops_further_searches_today(tmp_path, isolated, monkeypatch):
    models = Recording(error=QuotaError("limit"))
    agent, budget = _agent(tmp_path, models, monkeypatch)
    out = agent.handle("search the web for tea prices")
    assert "limit is reached" in out["reply"]
    assert budget.snapshot()["used"] == budget.snapshot()["limit"]


def test_other_errors_are_reported_without_their_message(tmp_path, isolated, monkeypatch):
    models = Recording(error=RuntimeError("secret-key-abc in the message"))
    agent, budget = _agent(tmp_path, models, monkeypatch)
    out = agent.handle("search the web for tea prices")
    assert "did not complete" in out["reply"] and "secret" not in out["reply"]


def test_a_long_answer_is_shortened(tmp_path, isolated, monkeypatch):
    models = Recording(reply="word " * 500)
    agent, budget = _agent(tmp_path, models, monkeypatch)
    out = agent.handle("search the web for something long")
    assert len(out["reply"]) < 1300 and out["reply"].endswith("…")
