"""Local knowledge: answers kept on this computer, so the same question does not need Gemini.

Checks: a stored answer is used with no Gemini call and no budget unit; a question with no stored
answer goes to Gemini once and is kept; time-sensitive, personal and expired answers are never
reused; forgetting archives instead of deleting; a damaged file is kept aside, not overwritten.
Memory (long_term.json) is never touched by this module.
"""
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from backend import knowledge as kn
from backend import router
from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from tests.test_agent import NOW, ROOTS
from tests.test_chat import FakeClient, FakeModels


class Clock:
    def __init__(self, when=NOW):
        self.when = when

    def __call__(self):
        return self.when


def _store(tmp_path, clock=None, days=30):
    return kn.KnowledgeStore(tmp_path / "knowledge.json", starter_path=kn.STARTER_PATH,
                             clock=clock or Clock(), days=days)


def _agent(tmp_path, *, store, models=None, key="test-key", monkeypatch=None, limit=20):
    if key and monkeypatch is not None:
        monkeypatch.setenv("GEMINI_API_KEY", key)
    models = models or FakeModels(reply="Gemini says hello.")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    bus = EventBus()
    budget = DailyBudget(limit, path=tmp_path / "q.json", clock=lambda: NOW)
    agent = Agent(chat, budget, default_policy(), ConfirmationStore(bus=bus), bus=bus,
                  session=None, roots=lambda: ROOTS, clock=lambda: NOW, knowledge=store)
    return SimpleNamespace(agent=agent, models=models, budget=budget, bus=bus, store=store)


# ----- the starter answers -----

def test_starter_answers_load_once_and_are_marked_for_checking(isolated, tmp_path):
    store = _store(tmp_path)
    entries = store.list_entries()
    starters = [e for e in entries if e["kind"] == "starter"]
    assert len(starters) == len(json.loads(kn.STARTER_PATH.read_text(encoding="utf-8")))
    again = _store(tmp_path).list_entries()
    assert len([e for e in again if e["kind"] == "starter"]) == len(starters)     # no duplicates


def test_starter_entries_cover_coding_marketing_and_design(isolated, tmp_path):
    keys = {e["key"] for e in _store(tmp_path).list_entries()}
    assert any(k.startswith("starter:git-") for k in keys)
    assert any(k.startswith("starter:utm") or k.startswith("starter:roas") for k in keys)
    assert any(k.startswith("starter:wcag") for k in keys)


def test_a_starter_answer_is_used_with_no_gemini_call_and_no_budget(isolated, tmp_path, monkeypatch):
    a = _agent(tmp_path, store=_store(tmp_path), monkeypatch=monkeypatch)
    out = a.agent.handle("how do I undo my last git commit?")
    assert out["source"] == "knowledge"
    assert "git reset --soft" in out["reply"]
    assert "please check" in out["reply"]
    assert a.models.calls == [] and a.budget.snapshot()["used"] == 0


def test_a_question_with_extra_unrelated_words_still_goes_to_gemini(isolated, tmp_path, monkeypatch):
    a = _agent(tmp_path, store=_store(tmp_path), monkeypatch=monkeypatch)
    out = a.agent.handle("which is the best laptop for video editing")
    assert out["source"] == "gemini"
    assert len(a.models.calls) == 1 and a.budget.snapshot()["used"] == 1


# ----- learning from Gemini -----

def test_a_gemini_answer_is_kept_and_reused_for_the_same_question(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    first = a.agent.handle("what is a sprint retrospective")
    assert first["source"] == "gemini" and len(a.models.calls) == 1

    second = a.agent.handle("what is a sprint retrospective")
    assert second["source"] == "knowledge"
    assert "Gemini says hello." in second["reply"]
    assert "saved from an earlier Gemini answer" in second["reply"]
    assert len(a.models.calls) == 1                       # still one call in total
    assert a.budget.snapshot()["used"] == 1               # the second answer cost nothing


def test_the_kept_answer_survives_a_restart(isolated, tmp_path, monkeypatch):
    a = _agent(tmp_path, store=_store(tmp_path), monkeypatch=monkeypatch)
    a.agent.handle("what is a sprint retrospective")
    b = _agent(tmp_path, store=_store(tmp_path), monkeypatch=monkeypatch)
    out = b.agent.handle("what is a sprint retrospective")
    assert out["source"] == "knowledge" and b.models.calls == []


@pytest.mark.parametrize("question", [
    "what is the latest python version",
    "what is the price of bitcoin today",
    "who won the match last night",
    "what is happening in the news",
])
def test_time_sensitive_answers_are_never_kept(isolated, tmp_path, monkeypatch, question):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    a.agent.handle(question)
    assert store.learn(question, "A current answer.") is None
    assert [e for e in store.list_entries() if e["question"] == question] == []
    a.agent.handle(question)
    assert len(a.models.calls) == 2                       # asked again, not reused


def test_answers_about_the_owner_are_not_shared_with_others(isolated, tmp_path):
    store = _store(tmp_path)
    assert store.learn("summarise my plan for the garden", "Plant in spring.") is None


def test_an_answer_that_admits_it_may_be_out_of_date_is_not_kept(isolated, tmp_path):
    store = _store(tmp_path)
    assert store.learn("what is a bloom filter", "As of my knowledge cutoff, it is a data structure.") is None


def test_very_long_questions_and_answers_are_not_kept(isolated, tmp_path):
    store = _store(tmp_path)
    assert store.learn("explain " + "word " * 80, "A short answer.") is None
    assert store.learn("what is a bloom filter", "x" * (kn.MAX_ANSWER_CHARS + 1)) is None


def test_a_gemini_answer_expires_after_thirty_days_and_is_archived_not_deleted(isolated, tmp_path):
    clock = Clock()
    store = _store(tmp_path, clock=clock, days=30)
    store.learn("what is a bloom filter", "A space-saving set test.")
    assert store.lookup("what is a bloom filter") is not None
    clock.when = NOW + timedelta(days=31)
    assert store.lookup("what is a bloom filter") is None
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    archived = [e for e in data["archive"] if e["question"] == "what is a bloom filter"]
    assert len(archived) == 1 and archived[0]["archive_reason"] == "expired"


def test_starter_and_owner_answers_do_not_expire(isolated, tmp_path):
    clock = Clock()
    store = _store(tmp_path, clock=clock, days=30)
    store.teach("bloom filter", "A space-saving set test.")
    clock.when = NOW + timedelta(days=400)
    assert store.lookup("bloom filter") is not None
    assert store.lookup("undo last git commit") is not None


# ----- the owner's own entries -----

def test_the_owner_can_teach_an_answer_and_it_is_used(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    reply = a.agent.handle("learn: what is our office wifi password = Use the blue sticker on the router.")
    assert reply["source"] == "local" and reply["intent"] == "knowledge.teach"
    assert "Saved as answer" in reply["reply"]
    out = a.agent.handle("what is the office wifi password")
    assert out["source"] == "knowledge" and "blue sticker" in out["reply"]


def test_teach_keeps_capitals_and_punctuation_in_the_answer(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    a.agent.handle("learn that Kubernetes pod restart = Run kubectl rollout restart deployment/app.")
    entries = [e for e in store.list_entries() if e["kind"] == "owner"]
    assert entries[0]["answer"] == "Run kubectl rollout restart deployment/app."


def test_teach_refuses_an_empty_answer_and_saves_nothing(isolated, tmp_path):
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.teach("what is a bloom filter", "   ")
    with pytest.raises(ValueError):
        store.teach("   ", "a set test")
    assert [e for e in store.list_entries() if e["kind"] == "owner"] == []


def test_forget_archives_the_entry_and_it_is_no_longer_used(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    a.agent.handle("learn: what is our wifi name = Office-5G.")
    entry = [e for e in store.list_entries() if e["kind"] == "owner"][0]
    out = a.agent.handle(f"forget {entry['id']}")
    assert "Nothing was deleted" in out["reply"]
    assert a.agent.handle("what is our wifi name")["source"] == "gemini"
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    assert any(e["id"] == entry["id"] and e["archive_reason"] == "forgotten by owner" for e in data["archive"])


def test_a_forgotten_starter_is_not_added_back_on_restart(isolated, tmp_path):
    store = _store(tmp_path)
    starter = [e for e in store.list_entries() if e["kind"] == "starter"][0]
    store.forget(starter["id"])
    again = _store(tmp_path).list_entries()
    assert starter["key"] not in {e["key"] for e in again}


def test_list_says_how_many_and_shows_the_ids(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    out = a.agent.handle("what have you learned")
    assert out["intent"] == "knowledge.list" and "starter" in out["reply"] and "#1 (starter)" in out["reply"]


# ----- routing and safety -----

def test_knowledge_commands_are_recognised_by_the_router():
    assert router.match("learn: what is a loop = a repeated step").action == "knowledge.teach"
    assert router.match("what have you learned?").action == "knowledge.list"
    m = router.match("forget answer 12")
    assert m.action == "knowledge.forget" and m.args["id"] == "12"


def test_the_teach_command_keeps_the_raw_text_for_the_handler():
    m = router.match("Learn: What is A Loop = A Repeated Step.")
    assert m.args["raw"] == "Learn: What is A Loop = A Repeated Step."


def test_quiet_mode_publishes_no_chat_events(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    a.agent.handle("how do I undo my last git commit", quiet=True)
    assert a.bus.since(0, source="chat") == []
    a.agent.handle("how do I undo my last git commit")
    chat = [e for _, e in a.bus.since(0, source="chat")]
    assert [e["role"] for e in chat] == ["user", "assistant"]


def test_a_damaged_file_is_kept_aside_and_the_store_starts_again(isolated, tmp_path):
    path = tmp_path / "knowledge.json"
    path.write_text("{not json", encoding="utf-8")
    store = _store(tmp_path)
    assert store.lookup("undo last git commit") is not None         # starter answers still work
    kept = list(tmp_path.glob("knowledge.json.bad-*"))
    assert len(kept) == 1 and kept[0].read_text(encoding="utf-8") == "{not json"
    assert "kept as" in store.last_problem


def test_nothing_is_written_to_memory(isolated, tmp_path, monkeypatch):
    from memory import memory_manager as mm
    before = mm.MEMORY_PATH.read_text(encoding="utf-8")
    store = _store(tmp_path)
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)
    a.agent.handle("what is a sprint retrospective")
    a.agent.handle("learn: what is a loop = a repeated step")
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == before


def test_the_keyword_rules_ignore_filler_but_keep_meaning():
    assert kn.keywords("how do I undo my last git commit") == ["undo", "last", "git", "commit"]
    assert kn.keywords("what does http 404 mean") == ["http", "404"]


def test_learning_can_be_switched_off_and_nothing_is_kept(isolated, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPPER_KNOWLEDGE_LEARN", "off")
    store = _store(tmp_path)
    assert store.learn("what is a sprint retrospective", "A review meeting.") is None
    assert [e for e in store.list_entries() if e["kind"] == "gemini"] == []
    monkeypatch.delenv("SUPPER_KNOWLEDGE_LEARN")
    assert store.learn("what is a sprint retrospective", "A review meeting.") is not None
