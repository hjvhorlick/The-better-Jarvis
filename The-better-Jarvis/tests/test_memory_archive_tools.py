"""Archive search and restore (owner request, 2026-10-09).

Search is read-only. Restore changes long_term.json, so it always asks first. Nothing here touches
the owner's real files: the `isolated` fixture points every path at a temp folder.
"""
import json
from datetime import datetime

import pytest

import memory.memory_manager as mm
from backend import router
from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from tests.test_chat import FakeClient, FakeModels

NOW = datetime(2026, 10, 9, 14, 5)
BIG = 200_000


def _archive_notes(monkeypatch, n=12, word="heron"):
    """Fill memory past a small limit so the oldest notes move to the archive."""
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", 900)
    for i in range(n):
        mm.update_memory({"notes": {f"n{i:02d}": f"{word} fact {i} " * 3}})
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", BIG)


def _id_of(query, key):
    return next(h["id"] for h in mm.search_archive(query)["matches"] if h["id"] is not None
                and key in h["text"])


def _agent(tmp_path, opener=None):
    bus = EventBus()
    models = FakeModels(reply="Gemini says hello.")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    budget = DailyBudget(20, path=tmp_path / "q.json", clock=lambda: NOW)
    confirmations = ConfirmationStore(bus=bus)
    agent = Agent(chat, budget, default_policy(), confirmations, bus=bus,
                  roots=lambda: [], clock=lambda: NOW)
    return agent, confirmations


# ----- search -----

def test_search_finds_archived_facts_and_archived_dialogue(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    mm._append_dialogue_archive([{"speaker": "user", "text": "Tell me about HERON birds",
                                  "time": "2026-10-01 10:00:00"}])
    found = mm.search_archive("Heron")
    sources = {h["source"] for h in found["matches"]}
    assert {"memory", "dialogue"} <= sources
    memory_hits = [h for h in found["matches"] if h["source"] == "memory"]
    assert all(isinstance(h["id"], int) for h in memory_hits)
    dialogue = next(h for h in found["matches"] if h["source"] == "dialogue")
    assert dialogue["id"] is None and dialogue["line"] == 1


def test_search_does_not_match_the_active_file_only(isolated):
    """Sister is in the active file, not the archive, so the archive search must not return her."""
    assert mm.search_archive("Ayse")["total"] == 0


def test_search_rejects_empty_text(isolated):
    with pytest.raises(ValueError):
        mm.search_archive("   ")


def test_search_shows_a_restored_fact_as_active_again(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    mm.restore_archive_entry(aid)
    hit = next(h for h in mm.search_archive("heron")["matches"] if h["id"] == aid)
    assert hit["active_now"] is True


# ----- restore -----

def test_restore_brings_a_fact_back_and_keeps_the_archive_copy(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    before_archive = mm._archive_path().read_text(encoding="utf-8")
    msg = mm.restore_archive_entry(aid)
    assert "Restored notes/n00" in msg
    active = json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))
    assert active["notes"]["n00"]["value"].startswith("heron fact 0")
    assert mm._archive_path().read_text(encoding="utf-8") == before_archive   # nothing removed


def test_restore_never_overwrites_a_current_value(isolated, monkeypatch):
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", 900)
    mm._archive_path().write_text(json.dumps([{
        "archived": "2026-01-01T00:00:00", "kind": "entry", "category": "preferences",
        "key": "tea", "record": {"value": "old tea", "updated": "2025-01-01"}}]), encoding="utf-8")
    with pytest.raises(FileExistsError):
        mm.restore_archive_entry(0)
    active = json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))
    assert active["preferences"]["tea"]["value"] == "earl grey"


def test_restore_refuses_when_memory_has_no_room(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    full = len(json.dumps(mm.load_memory(), ensure_ascii=False))
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", full)          # exactly full
    active_before = mm.MEMORY_PATH.read_text(encoding="utf-8")
    archive_before = mm._archive_path().read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="full"):
        mm.restore_archive_entry(aid)
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == active_before
    assert mm._archive_path().read_text(encoding="utf-8") == archive_before


def test_restore_refuses_numbers_that_are_not_restorable_facts(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    with pytest.raises(LookupError):
        mm.restore_archive_entry(999)
    mm._archive_path().write_text(json.dumps([{
        "archived": "x", "kind": "session", "record": {"summary": "a chat"}}]), encoding="utf-8")
    with pytest.raises(LookupError):
        mm.restore_archive_entry(0)


def test_describe_returns_text_only_for_restorable_facts(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    assert mm.describe_archive_entry(aid).startswith("notes/n00 = heron fact 0")
    assert mm.describe_archive_entry(999) is None


# ----- router -----

@pytest.mark.parametrize("text, query", [
    ("search the archive for Heron", "heron"),
    ("search archive for tea please", "tea"),
    ("look up archive for sister", "sister"),
])
def test_archive_search_phrases(text, query):
    m = router.match(text)
    assert m is not None and m.action == "memory.search_archive"
    assert m.args == {"query": query}


@pytest.mark.parametrize("text, number", [
    ("restore memory 12", "12"),
    ("restore #3", "3"),
    ("restore archive entry 4", "4"),
    ("restore 7", "7"),
])
def test_restore_phrases(text, number):
    m = router.match(text)
    assert m is not None and m.action == "memory.restore" and m.args == {"id": number}


@pytest.mark.parametrize("text", ["restore", "restore the file", "search archive"])
def test_incomplete_phrases_go_to_gemini(text):
    m = router.match(text)
    assert m is None or m.action not in ("memory.restore", "memory.search_archive")


def test_tiers_search_is_safe_and_restore_asks():
    p = default_policy()
    assert p.decide("memory.search_archive").allowed
    assert not p.decide("memory.search_archive").needs_confirmation
    assert p.decide("memory.restore").needs_confirmation


# ----- the chat path -----

def test_search_in_chat_lists_matches_locally(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    agent, _ = _agent(isolated)
    out = agent.handle("search the archive for heron")
    assert out["source"] == "local" and out["intent"] == "memory.search_archive"
    assert "archive match" in out["reply"] and "#" in out["reply"] and "heron" in out["reply"]


def test_search_with_no_match_says_so(isolated):
    agent, _ = _agent(isolated)
    out = agent.handle("search the archive for zebra")
    assert "Nothing in the archive matches" in out["reply"]


def test_restore_in_chat_waits_for_approval_then_restores(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    agent, confirmations = _agent(isolated)
    out = agent.handle(f"restore memory {aid}")
    assert out["source"] == "confirmation" and out["intent"] == "memory.restore"
    assert "heron fact 0" in out["confirmation"]["summary"]
    assert "n00" not in json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))["notes"]
    done = confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert done["status"] == "approved" and "Restored notes/n00" in done["result"]
    assert "n00" in json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))["notes"]


def test_restore_denied_changes_nothing(isolated, monkeypatch):
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    agent, confirmations = _agent(isolated)
    out = agent.handle(f"restore memory {aid}")
    confirmations.resolve(out["confirmation"]["id"], approve=False)
    assert "n00" not in json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))["notes"]


def test_restore_conflict_is_reported_after_approval(isolated, monkeypatch):
    mm._archive_path().write_text(json.dumps([{
        "archived": "x", "kind": "entry", "category": "preferences",
        "key": "tea", "record": {"value": "old tea", "updated": "2025-01-01"}}]), encoding="utf-8")
    agent, confirmations = _agent(isolated)
    out = agent.handle("restore memory 0")
    done = confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert "nothing was restored" in done["result"].lower()
    assert json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))["preferences"]["tea"]["value"] == "earl grey"


def test_corrupt_archive_is_reported_and_left_alone(isolated):
    mm._archive_path().write_text("{not json", encoding="utf-8")
    agent, confirmations = _agent(isolated)
    out = agent.handle("search the archive for tea")
    assert "could not be read" in out["reply"]
    restore = agent.handle("restore memory 0")
    assert "not found or the archive is unreadable" in restore["confirmation"]["summary"]
    done = confirmations.resolve(restore["confirmation"]["id"], approve=True)
    assert "could not be read" in done["result"]
    assert mm._archive_path().read_text(encoding="utf-8") == "{not json"


def test_a_restored_fact_is_not_moved_back_to_the_archive_by_the_size_trim(isolated, monkeypatch):
    """Acceptance: the size trim must not undo a restore. Later saves keep the restored fact active."""
    _archive_notes(monkeypatch)
    aid = _id_of("heron", "n00")
    archive_before = mm._archive_path().read_text(encoding="utf-8")
    mm.restore_archive_entry(aid)
    restored = json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))
    mm.save_memory(restored)                       # a later save of the same memory
    mm.save_memory(mm.load_memory())
    assert "n00" in json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))["notes"]
    assert mm._archive_path().read_text(encoding="utf-8") == archive_before
