from datetime import datetime
from types import SimpleNamespace

import pytest

from backend.agent import Agent, BudgetExhausted
from backend.chat import BackendNotConfigured, ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from tests.test_chat import FakeClient, FakeModels

NOW = datetime(2026, 10, 9, 14, 5)
ROOTS = [{"name": "Demo", "path": "/srv/demo"}]


class FakeSession:
    def __init__(self):
        self.started = []
        self.stopped = []
        self.running = False

    def start(self, mode="my_hands"):
        self.started.append(mode)
        self.running = True

    def stop(self, reason="user"):
        self.stopped.append(reason)
        self.running = False

    def status(self):
        return {"running": self.running}


def _agent(tmp_path, *, models=None, limit=20, key=None, monkeypatch=None):
    if key and monkeypatch is not None:
        monkeypatch.setenv("GEMINI_API_KEY", key)
    models = models or FakeModels(reply="Gemini says hello.")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    bus = EventBus()
    budget = DailyBudget(limit, path=tmp_path / "q.json", clock=lambda: NOW)
    session = FakeSession()
    agent = Agent(chat, budget, default_policy(), ConfirmationStore(bus=bus), bus=bus,
                  session=session, roots=lambda: ROOTS, clock=lambda: NOW)
    return SimpleNamespace(agent=agent, models=models, budget=budget, session=session, bus=bus,
                           confirmations=agent._confirmations)


def test_time_is_answered_locally_without_a_key_or_budget(isolated):
    a = _agent(isolated)
    out = a.agent.handle("what time is it")
    assert out["source"] == "local" and out["intent"] == "time.now"
    assert out["reply"] == "It is 14:05."
    assert a.models.calls == [] and a.budget.snapshot()["used"] == 0


def test_date_is_answered_locally(isolated):
    out = _agent(isolated).agent.handle("what's the date")
    assert out["reply"] == "Today is Friday, 9 October 2026."


def test_status_reports_without_secrets(isolated, monkeypatch):
    a = _agent(isolated, key="super-secret-key-999", monkeypatch=monkeypatch)
    out = a.agent.handle("system status")
    # The count is a tally, not a ceiling: the status names the warning level and
    # the connection, and says plainly that nothing is blocked.
    assert "set" in out["reply"] and "warning level 20" in out["reply"]
    assert "Connection: online" in out["reply"]
    assert "super-secret-key-999" not in out["reply"]


def test_open_known_folder_returns_a_path_for_the_ui(isolated):
    out = _agent(isolated).agent.handle("open demo")
    assert out["source"] == "local" and out["open_path"] == "/srv/demo"


def test_open_unknown_folder_falls_through_to_gemini(isolated, monkeypatch):
    a = _agent(isolated, key="k", monkeypatch=monkeypatch)
    out = a.agent.handle("open nowhere")
    assert out["source"] == "gemini" and a.budget.snapshot()["used"] == 1


def test_unmatched_text_goes_to_gemini_and_takes_one_unit(isolated, monkeypatch):
    a = _agent(isolated, key="k", monkeypatch=monkeypatch)
    out = a.agent.handle("write me a haiku about rain")
    assert out == {"reply": "Gemini says hello.", "source": "gemini", "intent": None,
                   "confirmation": None, "open_path": None}
    assert len(a.models.calls) == 1 and a.budget.snapshot()["used"] == 1


def test_no_key_answers_locally_instead_of_failing(isolated):
    """No key is an offline MODE, not a dead end: the chat answers from here."""
    a = _agent(isolated)
    out = a.agent.handle("write me a haiku")
    assert out["source"] == "local" and out["intent"] == "offline.no-key"
    assert "offline" in out["reply"] and "nothing from the internet" in out["reply"].replace(
        "fetched nothing from the internet", "nothing from the internet")
    assert "api_keys.json" in out["reply"]              # it says where a key is read from
    assert a.budget.snapshot()["used"] == 0             # nothing was counted


def test_the_count_never_stops_a_call_it_only_warns(isolated, monkeypatch):
    """Past the warning level the app says so; the call still goes out."""
    a = _agent(isolated, key="k", limit=1, monkeypatch=monkeypatch)
    a.agent.handle("write me a haiku")
    second = a.agent.handle("tell me a joke")
    assert len(a.models.calls) == 2                       # the second call DID go out
    assert second["source"] == "gemini"
    assert a.budget.snapshot()["past_warn"] is True
    assert "never blocks" in a.budget.warn()
    assert a.agent.handle("what time is it")["source"] == "local"


def test_a_real_429_goes_offline_and_the_chat_carries_on(isolated, monkeypatch):
    """Google's 429 is a warning, not a block: the app goes offline and keeps talking."""
    class Limited(Exception):
        code = 429

    models = FakeModels(error=Limited("quota"))
    a = _agent(isolated, models=models, key="k", monkeypatch=monkeypatch)
    first = a.agent.handle("tell me a joke")
    assert first["source"] == "local" and first["intent"] == "offline.quota"
    assert "offline" in first["reply"] and "429" in first["reply"]
    assert a.budget.offline is True
    # The count is NOT pretended to be used up — it was Google, not this app.
    assert a.budget.snapshot()["used"] == 1
    second = a.agent.handle("tell me another joke")
    # The reply promises GOOGLE's reset — midnight Pacific — not the app's local midnight.
    assert second["source"] == "local" and "midnight Pacific" in second["reply"]
    assert len(models.calls) == 1                         # no further call was sent
    # …and local work carries on regardless.
    assert a.agent.handle("what time is it")["source"] == "local"


def test_start_my_hands_waits_for_the_owner(isolated):
    a = _agent(isolated)
    out = a.agent.handle("turn on my hands")
    assert out["source"] == "confirmation" and out["intent"] == "myhands.start"
    assert out["confirmation"]["id"]
    assert a.session.started == []                        # nothing happened yet
    done = a.confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert done["status"] == "approved"
    assert a.session.started == ["my_hands"]


def test_start_my_hands_denied_leaves_the_camera_alone(isolated):
    a = _agent(isolated)
    out = a.agent.handle("turn on my hands")
    a.confirmations.resolve(out["confirmation"]["id"], approve=False)
    assert a.session.started == []


def test_stop_my_hands_needs_no_confirmation(isolated):
    a = _agent(isolated)
    a.session.running = True
    out = a.agent.handle("stop my hands")
    assert out["source"] == "local" and a.session.stopped == ["user"]


def test_chat_turns_are_published_to_the_bus(isolated):
    a = _agent(isolated)
    a.agent.handle("what time is it")
    turns = [e for _, e in a.bus.since(0, source="chat")]
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[1]["via"] == "local" and turns[1]["text"] == "It is 14:05."


def test_empty_message_is_refused(isolated):
    with pytest.raises(ValueError):
        _agent(isolated).agent.handle("   ")
