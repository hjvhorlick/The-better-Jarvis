"""Persistent Brain tests. Every test uses the isolated memory paths from conftest."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.agent import Agent
from backend.app import create_app
from backend.brain import BrainStorageError, BrainStore
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from memory import memory_manager as mm
from tests.test_chat import FakeClient, FakeModels

LOCAL = "http://127.0.0.1:8765"


def _brain_agent(tmp_path, monkeypatch, brain=None, models=None):
    monkeypatch.setenv("GEMINI_API_KEY", "brain-test-key")
    bus = EventBus()
    confirmations = ConfirmationStore(bus=bus)
    models = models or FakeModels(reply="A grounded reply.")
    chat = ChatService(client_factory=lambda key: FakeClient(models), model="test-model")
    budget = DailyBudget(20, path=tmp_path / "brain-quota.json")
    store = brain or BrainStore()
    agent = Agent(chat, budget, default_policy(), confirmations, bus=bus, brain=store)
    return agent, store, confirmations, models


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


class GroundedModels:
    def __init__(self):
        self.calls = []

    def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        web = SimpleNamespace(uri="https://example.org/official", title="Official source")
        chunk = SimpleNamespace(web=web)
        metadata = SimpleNamespace(grounding_chunks=[chunk])
        candidate = SimpleNamespace(grounding_metadata=metadata)
        return SimpleNamespace(text="The current result is available.", candidates=[candidate])


def test_grounded_search_saves_verified_citations_to_brain_and_history(isolated, monkeypatch):
    models = GroundedModels()
    agent, brain, _confirmations, _ = _brain_agent(isolated, monkeypatch, models=models)

    answer = agent.handle("Search the web for current Benoni service updates")

    assert answer["source"] == "local" and answer["intent"] == "web.search"
    assert answer["sources"] == [{"url": "https://example.org/official", "title": "Official source"}]
    assert models.calls[0]["config"]["tools"] == [{"google_search": {}}]
    research = brain.list_research(topic_id=answer["topic_id"])
    assert research[0]["sources"] == answer["sources"]
    history = brain.conversation_history(answer["conversation_id"])
    assert history["turns"][-1]["sources"] == answer["sources"]


def test_explicit_memory_is_saved_locally_and_its_value_is_not_copied_into_dialogue(
        isolated, monkeypatch):
    agent, brain, _confirmations, _models = _brain_agent(isolated, monkeypatch)
    result = agent.handle("Remember that my name is Amina Secretvalue")
    assert result["source"] == "local"
    assert mm.get_record("identity", "name")["value"] == "Amina Secretvalue"
    turns = mm.get_recent_dialogue(10)
    assert turns[0]["text"].startswith("[Owner explicitly updated")
    assert "Amina Secretvalue" not in json.dumps(turns)


def test_topics_resume_by_name_and_switching_starts_a_separate_conversation(isolated):
    brain = BrainStore()
    first = brain.create_topic("Garden planner", goal="Plan a local garden")
    second = brain.create_topic("Supper Brain", goal="Improve assistant continuity")
    old_conversation = second["conversation_id"]

    turn = brain.begin_turn("go back to the other project", conversation_id=old_conversation)
    assert turn.topic_id == first["id"]
    assert turn.conversation_id != old_conversation
    assert not turn.clarification

    resumed = brain.begin_turn("continue with the next step", conversation_id=turn.conversation_id)
    assert resumed.topic_id == first["id"]
    assert not resumed.clarification


def test_ambiguous_other_topic_asks_instead_of_guessing(isolated):
    brain = BrainStore()
    topic = brain.create_topic("Only saved project")
    turn = brain.begin_turn("go back to the other project", conversation_id=topic["conversation_id"])
    assert "Which saved topic" in turn.clarification
    assert turn.topic_id == topic["id"]


def test_topic_history_is_scoped_and_citations_survive_restore(isolated):
    brain = BrainStore()
    topic = brain.create_topic("Current information research")
    turn = brain.begin_turn("Find the latest results", conversation_id=topic["conversation_id"])
    brain.record_user_turn(turn, "Find the latest results")
    brain.complete_turn(turn, "The result is listed here.", source="local", sources=[
        {"url": "https://example.org/result", "title": "Official result"},
        {"url": "javascript:alert(1)", "title": "unsafe"},
    ])
    history = brain.conversation_history(turn.conversation_id)
    assert len(history["turns"]) == 2
    assert history["turns"][1]["sources"] == [
        {"url": "https://example.org/result", "title": "Official result"}]
    assert brain.search("current information research", topic_id=topic["id"])


def test_brain_prompt_contains_only_the_selected_topics_scoped_memory(isolated, monkeypatch):
    agent, brain, _confirmations, models = _brain_agent(isolated, monkeypatch)
    current = brain.create_topic("Supper architecture")
    other = brain.create_topic("Scenering project")
    brain.add_memory("projects", "app_architecture", "current-topic-only", topic_id=current["id"])
    brain.add_memory("projects", "app_architecture", "other-topic-only", topic_id=other["id"])
    conversation = brain.start_conversation(topic_id=current["id"])
    mm.append_dialogue_turn("user", "old global dialogue")

    agent.handle("What is the app architecture?", conversation_id=conversation["conversation_id"])

    prompt = models.calls[0]["config"]["system_instruction"]
    assert "current-topic-only" in prompt
    assert "other-topic-only" not in prompt
    assert "old global dialogue" not in prompt


def test_gemini_live_transcripts_join_the_same_local_history(isolated, monkeypatch):
    agent, brain, _confirmations, _models = _brain_agent(isolated, monkeypatch)
    assert agent.record_live_turn("Can you hear me?", "Yes, clearly.") is True
    turns = mm.get_dialogue_history(owner_id=brain.owner_id, limit=10)
    assert [turn["text"] for turn in turns[-2:]] == ["Can you hear me?", "Yes, clearly."]
    assert turns[-1]["source"] == "gemini-live"


def test_first_brain_write_makes_a_verified_backup_set_of_existing_files(isolated):
    dialogue = [{"speaker": "user", "text": "old turn"}]
    mm.DIALOGUE_PATH.write_text(json.dumps(dialogue), encoding="utf-8")
    mm._dialogue_archive_path().write_text(
        json.dumps({"archived": "2026-01-01", "turn": dialogue[0]}) + "\n", encoding="utf-8")
    mm._archive_path().write_text("[]", encoding="utf-8")
    source_bytes = {p.name: p.read_bytes() for p in
                    (mm.MEMORY_PATH, mm.DIALOGUE_PATH, mm._dialogue_archive_path(), mm._archive_path())}

    BrainStore().add_memory("notes", "new fact", "keep this")

    manifests = list((mm.MEMORY_PATH.parent / "backups").glob("brain.*.manifest.json"))
    assert len(manifests) == 1
    manifest = _read(manifests[0])
    assert {row["source"] for row in manifest["files"]} == set(source_bytes)
    for row in manifest["files"]:
        assert (manifests[0].parent / row["backup"]).read_bytes() == source_bytes[row["source"]]
    assert BrainStore().backup_status()["count"] == 1


def test_correction_is_atomic_and_snapshots_the_prior_memory(isolated):
    brain = BrainStore()
    brain.add_memory("preferences", "tea", "earl grey")
    corrected = brain.correct_memory("preferences", "tea", "rooibos", reason="owner correction")
    assert corrected["value"] == "rooibos"
    assert mm.get_record("preferences", "tea")["value"] == "rooibos"
    assert len(brain._items("corrections")) == 1
    manifests = list((mm.MEMORY_PATH.parent / "backups").glob("brain.*.manifest.json"))
    assert len(manifests) == 2
    latest = max(manifests, key=lambda p: p.stat().st_mtime_ns)
    backup = next(row for row in _read(latest)["files"] if row["source"] == "long_term.json")
    assert _read(latest.parent / backup["backup"])["preferences"]["tea"]["value"] == "earl grey"


def test_failed_atomic_correction_leaves_the_original_value(isolated, monkeypatch):
    brain = BrainStore()
    brain.add_memory("preferences", "tea", "earl grey")

    def fail(_memory):
        raise OSError("simulated disk error")

    monkeypatch.setattr(mm, "save_memory", fail)
    with pytest.raises(BrainStorageError):
        brain.correct_memory("preferences", "tea", "rooibos")
    assert mm.get_record("preferences", "tea")["value"] == "earl grey"
    assert brain._items("corrections") == []


def test_corrupt_existing_store_is_never_overwritten(isolated):
    before = "{not valid json"
    mm.MEMORY_PATH.write_text(before, encoding="utf-8")
    with pytest.raises(BrainStorageError):
        BrainStore().add_memory("notes", "x", "y")
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == before


def test_chat_still_works_when_brain_history_is_unavailable(isolated, monkeypatch):
    mm.MEMORY_PATH.write_text("{not valid json", encoding="utf-8")
    agent, _brain, _confirmations, models = _brain_agent(isolated, monkeypatch)
    result = agent.handle("Write a short haiku about rain")
    assert result["source"] == "gemini"
    assert "will not be available for future topic continuity" in result["reply"]
    assert len(models.calls) == 1
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == "{not valid json"


def test_forgetting_memory_waits_for_confirmation_and_creates_a_fresh_backup(
        isolated, monkeypatch):
    brain = BrainStore()
    brain.add_memory("preferences", "tea", "earl grey")
    app = create_app(serve_ui=False, brain_store=brain)
    with TestClient(app, base_url=LOCAL) as client:
        requested = client.post("/api/brain/memory/forget", json={
            "category": "preferences", "key": "tea", "confirmed": True,
        })
        assert requested.status_code == 200
        assert mm.get_record("preferences", "tea")["value"] == "earl grey"
        confirmation = requested.json()["confirmation"]
        pending = client.get("/api/confirmations").json()["pending"]
        assert pending[0]["action"] == "brain.forget"
        completed = client.post(f"/api/confirmations/{confirmation['id']}", json={"approve": True})
        assert completed.status_code == 200
        assert completed.json()["status"] == "approved"
        assert mm.get_record("preferences", "tea") is None
    assert brain.backup_status()["count"] >= 2


def test_same_memory_key_can_exist_globally_and_in_multiple_topics(isolated, monkeypatch):
    brain = BrainStore()
    first = brain.create_topic("First project")
    second = brain.create_topic("Second project")
    brain.add_memory("projects", "plan", "global plan")
    brain.add_memory("projects", "plan", "first topic plan", topic_id=first["id"])
    brain.add_memory("projects", "plan", "second topic plan", topic_id=second["id"])
    assert {row["value"] for row in brain.list_memories(category="projects")} == {
        "global plan", "first topic plan", "second topic plan"}

    app = create_app(serve_ui=False, brain_store=brain)
    with TestClient(app, base_url=LOCAL) as client:
        corrected = client.put("/api/brain/memory", json={
            "category": "projects", "key": "plan", "value": "first correction",
            "topic_id": first["id"],
        })
        assert corrected.status_code == 200
        assert brain.correct_memory("projects", "plan", "third correction", topic_id=second["id"])["value"] == "third correction"
        requested = client.post("/api/brain/memory/forget", json={
            "category": "projects", "key": "plan", "topic_id": first["id"],
        })
        confirmation = requested.json()["confirmation"]
        completed = client.post(f"/api/confirmations/{confirmation['id']}", json={"approve": True})
        assert completed.json()["status"] == "approved"
    values = {(row["topic_id"], row["value"]) for row in brain.list_memories(category="projects")}
    assert ("", "global plan") in values
    assert (first["id"], "first correction") not in values
    assert (second["id"], "third correction") in values


def test_legacy_memory_prompts_hide_topic_scoped_values_but_ui_keeps_logical_key(isolated):
    mm.put_record("projects", "brain_internal_topickey", "scoped secret",
                  {"topic_id": "0123456789abcdef", "memory_key": "plan", "owner_id": "local-owner"})
    assert "scoped secret" not in mm.format_memory_for_prompt(mm.load_memory())
    assert "plan: scoped secret" not in mm.search_memory("scoped secret")
    row = next(row for row in mm.all_entries_for_ui() if row["value"] == "scoped secret")
    assert row["key"] == "plan" and row["topic_id"] == "0123456789abcdef"


def test_search_excludes_other_owner_records(isolated):
    brain = BrainStore()
    mm.put_record("notes", "foreign", "not for this owner", {"owner_id": "somebody-else"})
    assert all(row["key"] != "foreign" for row in brain.search("not for this owner"))
