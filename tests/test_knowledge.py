"""Local knowledge: answers kept on this computer, so the same question does not need Gemini.

Checks: a stored answer is used with no Gemini call and no budget unit; a question with no stored
answer goes to Gemini once and is kept; time-sensitive, personal and expired answers are never
reused; forgetting archives instead of deleting; a damaged file is kept aside, not overwritten.
Memory (long_term.json) is never touched by this module.
"""
import hashlib
import json
import shutil
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


# ----- which model made a stored answer, and when it must not answer -----
#
# The store keeps the model that produced each Gemini answer. An entry from a different
# model — or from before the app recorded the model at all (every entry written under
# schema 1) — is STALE: it must not answer in place of the model in use. The model is
# asked first; the stored words are used only if it cannot be reached, said plainly to be
# out of date. Replacing one archives it. Nothing is deleted, and the owner's own answers
# are never touched.

def test_a_kept_gemini_answer_records_the_model_that_made_it(isolated, tmp_path):
    store = _store(tmp_path)
    entry = store.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    assert entry["provenance"] == {"schema": kn.PROVENANCE_SCHEMA, "source": "gemini",
                                   "model": "gemini-3.8-flash", "recorded": "2026-10-09T14:05:00"}
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    assert data["version"] == kn.KNOWLEDGE_VERSION == 2


def test_how_staleness_is_decided(isolated, tmp_path):
    store = _store(tmp_path)
    fresh = store.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    taught = store.teach("how do I brew tea", "Steep it for three minutes.")
    starter = next(e for e in store.list_entries() if e["kind"] == "starter")
    unrecorded = dict(fresh, id=999, provenance={})

    assert store.is_stale(fresh, "gemini-3.8-flash") is False      # the model in use made it
    assert store.is_stale(fresh, "gemini-3.9-flash") is True       # a different model made it
    assert store.is_stale(unrecorded, "gemini-3.8-flash") is True  # no record of its model
    assert store.is_stale(taught, "gemini-3.8-flash") is False     # the owner's own words
    assert store.is_stale(starter, "gemini-3.8-flash") is False    # the assistant's own words
    assert store.is_stale(fresh, "") is False                      # nothing to compare against


def test_the_same_models_answer_is_not_kept_twice(isolated, tmp_path):
    store = _store(tmp_path)
    assert store.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    assert store.learn("what is a bloom filter", "A different wording.", model="gemini-3.8-flash") is None
    assert len([e for e in store.list_entries() if e["kind"] == "gemini"]) == 1


def test_a_current_answer_archives_the_stale_one_it_replaces(isolated, tmp_path):
    store = _store(tmp_path)
    store.learn("what is a bloom filter", "An answer from an older model.", model="gemini-2.5-flash")
    fresh = store.learn("what is a bloom filter", "The current answer.", model="gemini-3.8-flash")
    assert fresh is not None and fresh["provenance"]["model"] == "gemini-3.8-flash"
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    active = [e["answer"] for e in data["entries"] if e["kind"] == "gemini"]
    assert active == ["The current answer."]
    assert len(data["archive"]) == 1
    assert data["archive"][0]["answer"] == "An answer from an older model."
    assert data["archive"][0]["archive_reason"] == "superseded by gemini-3.8-flash"


def test_an_answer_the_owner_taught_is_never_replaced_by_a_model(isolated, tmp_path):
    store = _store(tmp_path)
    store.teach("how do I brew tea", "Steep it for three minutes.")
    assert store.learn("how do I brew tea", "The model says something else.", model="gemini-3.8-flash") is None
    assert store.lookup("how do I brew tea")["answer"] == "Steep it for three minutes."


def test_a_version_1_file_is_read_whole_and_its_answers_are_stale(isolated, tmp_path):
    """Every entry written before provenance existed: usable, but never silently current."""
    path = tmp_path / "knowledge.json"
    path.write_text(json.dumps({
        "version": 1, "next_id": 2,
        "entries": [{"id": 1, "kind": "gemini", "key": "", "question": "what is a bloom filter",
                     "keywords": ["bloom", "filter"], "answer": "An old answer.",
                     "created": "2026-01-01T00:00:00", "last_used": "", "uses": 0, "expires": ""}],
        "archive": [],
    }), encoding="utf-8")
    store = _store(tmp_path)
    hit = store.lookup("what is a bloom filter")
    assert hit is not None and hit["answer"] == "An old answer."
    assert store.is_stale(hit, "gemini-3.8-flash") is True


def test_the_stale_wording_names_the_date_the_model_and_what_was_not_done(isolated, tmp_path):
    store = _store(tmp_path)
    entry = store.learn("what is a bloom filter", "An answer from an older model.", model="gemini-2.5-flash")
    text = store.describe_stale(entry, "gemini-3.8-flash")
    assert text.startswith("An answer from an older model.")
    assert "saved from an earlier Gemini answer on 2026-10-09" in text
    assert "made by gemini-2.5-flash" in text
    assert "not re-checked with gemini-3.8-flash" in text
    assert "could not be reached just now" in text


def test_a_stored_answer_from_another_model_does_not_answer_for_the_current_one(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.learn("what is a bloom filter", "An answer from an older model.", model="gemini-2.5-flash")
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch)      # chat model: "test-model"
    out = a.agent.handle("what is a bloom filter")
    assert out["source"] == "gemini" and out["reply"] == "Gemini says hello."
    assert len(a.models.calls) == 1                                 # the model was asked, not skipped
    fresh = [e for e in store.list_entries() if e["kind"] == "gemini"]
    assert len(fresh) == 1 and fresh[0]["provenance"]["model"] == "test-model"
    assert fresh[0]["answer"] == "Gemini says hello."
    assert store.is_stale(fresh[0], "test-model") is False


def test_with_no_key_the_stored_answer_is_used_and_labelled_out_of_date(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.learn("what is a bloom filter", "An answer from an older model.", model="gemini-2.5-flash")
    a = _agent(tmp_path, store=store, key=None)
    out = a.agent.handle("what is a bloom filter")
    assert out["source"] == "knowledge" and out["intent"] == "knowledge.lookup.stale"
    assert "An answer from an older model." in out["reply"]
    assert "gemini-2.5-flash" in out["reply"] and "could not be reached just now" in out["reply"]
    assert a.models.calls == []                                     # nothing was spent


def test_a_spent_budget_still_gives_the_stored_answer_labelled(isolated, tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.learn("what is a bloom filter", "An answer from an older model.", model="gemini-2.5-flash")
    a = _agent(tmp_path, store=store, monkeypatch=monkeypatch, limit=0)
    out = a.agent.handle("what is a bloom filter")
    assert out["source"] == "knowledge" and "could not be reached just now" in out["reply"]
    assert a.models.calls == []


# ----- the two halves share one file -----

def test_an_answer_written_by_the_other_half_appears_without_a_restart(isolated, tmp_path):
    """The desktop app and the dashboard are two stores on one file (runtime/knowledge.json).

    Each picks up what the other wrote — no restart, no lost entry — because an answer
    taught in either has to be known to both.
    """
    desktop = _store(tmp_path)
    dashboard = _store(tmp_path)
    dashboard.list_entries()                      # loaded, and it saw an empty store
    desktop.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    hit = dashboard.lookup("what is a bloom filter")
    assert hit is not None and hit["answer"] == "A space-saving set test."
    assert dashboard.is_stale(hit, "gemini-3.8-flash") is False


def test_a_save_does_not_erase_what_the_other_half_added(isolated, tmp_path):
    desktop = _store(tmp_path)
    dashboard = _store(tmp_path)
    dashboard.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    desktop.teach("how do I brew tea", "Steep it for three minutes.")
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    questions = [e["question"] for e in data["entries"]]
    assert "what is a bloom filter" in questions, "the desktop store erased the dashboard's answer"
    assert "how do I brew tea" in questions


def test_the_other_halves_archive_is_kept_too(isolated, tmp_path):
    desktop = _store(tmp_path)
    dashboard = _store(tmp_path)
    dashboard.forget(dashboard.teach("how do I brew tea", "Steep it for three minutes.")["id"])
    desktop.list_entries()
    desktop.teach("what is a bloom filter", "A space-saving set test.")
    data = json.loads((tmp_path / "knowledge.json").read_text(encoding="utf-8"))
    assert "how do I brew tea" in [a["question"] for a in data["archive"]]
    kept = [e["question"] for e in data["entries"] if e["kind"] != "starter"]
    assert kept == ["what is a bloom filter"]           # and nothing archived came back


# ----- the backup before the first version 2 write -----

def test_a_verified_backup_is_taken_before_the_first_version_2_write(isolated, tmp_path):
    """The Brain's rule, applied to the knowledge file: verify a copy, then upgrade.

    The upgrade only adds a field — the checked copy is there so "nothing was lost" is a
    verifiable claim, not a promise.
    """
    path = tmp_path / "knowledge.json"
    original = json.dumps({
        "version": 1, "next_id": 3,
        "entries": [{"id": 1, "kind": "owner", "key": "", "question": "how do I brew tea",
                     "keywords": ["brew", "tea"], "answer": "Steep it for three minutes.",
                     "created": "2026-01-01T00:00:00", "last_used": "", "uses": 0, "expires": ""}],
        "archive": [{"id": 2, "kind": "gemini", "answer": "Gone but kept.", "archived_at": "2026-02-01T00:00:00",
                     "archive_reason": "expired", "keywords": ["old"], "question": "old question"}],
    }, indent=2)
    path.write_text(original, encoding="utf-8")

    store = _store(tmp_path)
    store.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")

    def copies() -> list:
        return sorted(p for p in (tmp_path / "backups").glob("knowledge.v1-*.json")
                      if ".manifest." not in p.name)

    backups = copies()
    assert len(backups) == 1, "no verified backup was taken before the version 2 write"
    assert backups[0].read_text(encoding="utf-8") == original       # byte-for-byte the old file
    manifest = next((tmp_path / "backups").glob("knowledge.v1-*.manifest.json"))
    recorded = json.loads(manifest.read_text(encoding="utf-8"))
    assert recorded["backup"] == backups[0].name and recorded["source"] == "knowledge.json"
    assert recorded["sha256"] == hashlib.sha256(original.encode("utf-8")).hexdigest()
    assert recorded["size_bytes"] == len(original.encode("utf-8"))
    assert store.last_backup == str(backups[0]) and store.last_problem == ""

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["version"] == kn.KNOWLEDGE_VERSION
    assert "Steep it for three minutes." in [e["answer"] for e in on_disk["entries"]]
    assert [a["answer"] for a in on_disk["archive"]] == ["Gone but kept."]


def test_only_one_backup_is_taken_however_often_the_store_saves(isolated, tmp_path):
    path = tmp_path / "knowledge.json"
    path.write_text(json.dumps({"entries": [], "archive": [], "next_id": 1}), encoding="utf-8")
    store = _store(tmp_path)
    store.teach("how do I brew tea", "Steep it for three minutes.")
    store.learn("what is a bloom filter", "A space-saving set test.", model="gemini-3.8-flash")
    store.teach("how do I clean a keyboard", "Warm water, barely damp.")
    copies = [p for p in (tmp_path / "backups").glob("knowledge.v1-*.json") if ".manifest." not in p.name]
    assert len(copies) == 1


def test_a_complete_version_1_file_is_not_rewritten_just_by_being_read(isolated, tmp_path):
    """A read that has nothing to add must not touch the file at all.

    (A read that DOES have something to add — the 32 starter answers on first run — is a
    write, and takes the verified backup first; that is the case the other tests cover.)
    """
    path = tmp_path / "knowledge.json"
    path.write_text(json.dumps({"version": 1, "next_id": 2, "entries": [], "archive": []}), encoding="utf-8")
    _store(tmp_path).list_entries()                       # writes the starters in, as version 2
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = 1                                   # put it back the way an older app left it
    for entry in data["entries"] + data["archive"]:
        entry.pop("provenance", None)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    before = path.read_bytes()
    shutil.rmtree(tmp_path / "backups")

    again = _store(tmp_path)
    again.list_entries()
    assert path.read_bytes() == before, "reading rewrote the file"
    assert not (tmp_path / "backups").exists()
