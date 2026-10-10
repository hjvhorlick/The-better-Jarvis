"""Stage B baseline (audit §13, item 3): the legacy memory and config code, on temporary copies.

Nothing here touches the owner's real memory or config. Every path is pointed at a temp folder.

Two kinds of test are in this file:
  * behaviour the owner needs (round-trips, pop, remember/forget, dialogue) must keep working in V2-4;
  * tests named `current_...` record what the legacy code does TODAY where that behaviour
    removes or overwrites data. They are not endorsements. If V2-4 changes that behaviour, the
    matching test must be changed on purpose, and the change reviewed. The master prompt says
    persistent memory is never cleared, reset, overwritten or reinitialised.
"""
import json

import pytest

import memory.config_manager as cm
import memory.memory_manager as mm


@pytest.fixture
def legacy(isolated, monkeypatch):
    """`isolated` from conftest, plus the legacy config file (memory/config_manager.py)."""
    cfg_dir = isolated / "config"
    monkeypatch.setattr(cm, "CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(cm, "CONFIG_FILE", cfg_dir / "api_keys.json")
    return isolated


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


# ----- config (api_keys.json) -----

def test_voice_round_trip_and_default(legacy):
    assert cm.get_voice() == cm.DEFAULT_VOICE
    cm.save_voice("Puck")
    assert cm.get_voice() == "Puck"


def test_unknown_voice_name_falls_back_to_default(legacy):
    cm.save_voice("NotAVoice")
    assert cm.get_voice() == cm.DEFAULT_VOICE


def test_saving_one_setting_keeps_the_others(legacy):
    cm.save_voice("Puck")
    cm.save_api_keys("test-key-123")
    data = _read(cm.CONFIG_FILE)
    assert data["voice_name"] == "Puck" and data["gemini_api_key"] == "test-key-123"


def test_unreadable_config_is_never_overwritten(legacy):
    """Owner decision (audit §15 finding 3): a bad api_keys.json is kept as it is. A copy is saved
    beside it, and the save is refused. Before this change, the next save replaced the file."""
    bad = '{"gemini_api_key": "old", "voice_name": "Puck",'
    cm.CONFIG_FILE.write_text(bad, encoding="utf-8")
    with pytest.raises(cm.ConfigUnreadable):
        cm.save_api_keys("new-key")
    assert cm.CONFIG_FILE.read_text(encoding="utf-8") == bad          # untouched
    copies = list(cm.CONFIG_FILE.parent.glob("api_keys.json.corrupt-*"))
    assert len(copies) == 1 and copies[0].read_text(encoding="utf-8") == bad


@pytest.mark.parametrize("setter", [
    lambda: cm.save_voice("Puck"),
    lambda: cm.save_wake_word_enabled(True),
    lambda: cm.save_input_device("Mic"),
])
def test_every_setter_refuses_an_unreadable_file(legacy, setter):
    cm.CONFIG_FILE.write_text("[1, 2", encoding="utf-8")
    with pytest.raises(cm.ConfigUnreadable):
        setter()
    assert cm.CONFIG_FILE.read_text(encoding="utf-8") == "[1, 2"


def test_a_json_list_is_treated_as_unreadable_not_as_empty(legacy):
    cm.CONFIG_FILE.write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(cm.ConfigUnreadable):
        cm.save_voice("Puck")
    assert cm.CONFIG_FILE.read_text(encoding="utf-8") == "[1, 2]"


# ----- long-term memory -----

def test_load_save_round_trip_keeps_unicode_and_every_record(legacy):
    mm.update_memory({"notes": {"café": "naïve résumé ✓"}})
    saved = _read(mm.MEMORY_PATH)
    assert saved["notes"]["café"]["value"] == "naïve résumé ✓"
    assert saved["relationships"]["sister"]["value"] == "Ayse"
    assert saved["preferences"]["tea"]["value"] == "earl grey"


def test_prompt_formatting_includes_remembered_facts(legacy):
    text = mm.format_memory_for_prompt(mm.load_memory())
    assert "Ayse" in text and "earl grey" in text


def test_remember_then_forget_is_user_requested_removal(legacy):
    mm.remember("dog", "Rex", category="relationships")
    assert _read(mm.MEMORY_PATH)["relationships"]["dog"]["value"] == "Rex"
    mm.forget("dog", category="relationships")
    assert "dog" not in _read(mm.MEMORY_PATH)["relationships"]


def test_pop_last_session_marks_briefed_and_keeps_history(legacy):
    mm.save_session_summary("First chat about tea.")
    mm.save_session_summary("Second chat about projects.")
    first = mm.pop_last_session()
    second = mm.pop_last_session()
    assert first["summary"].startswith("Second chat")      # most recent unbriefed first
    assert second["summary"].startswith("First chat")
    assert mm.pop_last_session() is None
    sessions = _read(mm.MEMORY_PATH)["sessions"]
    assert len(sessions) == 2 and all(s["briefed"] for s in sessions)


def test_sessions_beyond_fifteen_are_archived_not_deleted(legacy):
    """Owner decision (audit §15 finding 2): the 16th summary moves the oldest into the archive."""
    for i in range(16):
        mm.save_session_summary(f"session {i:02d}")
    active = _read(mm.MEMORY_PATH)["sessions"]
    assert len(active) == mm._SESSION_MAX == 15
    assert active[0]["summary"] == "session 01"
    archive = _read(mm._archive_path())
    assert [r["record"]["summary"] for r in archive] == ["session 00"]
    assert archive[0]["kind"] == "session" and "archived" in archive[0]


def test_oldest_entries_are_archived_not_deleted_when_over_the_limit(legacy, monkeypatch):
    """Owner decision (audit §15 finding 1): over MEMORY_MAX_CHARS, the least recently updated
    entries move to memory_archive.json. The active file keeps only what fits. Nothing is lost."""
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", 900)
    for i in range(12):
        mm.update_memory({"notes": {f"n{i:02d}": f"value number {i} " * 3}})
    saved = _read(mm.MEMORY_PATH)
    assert len(json.dumps(saved, ensure_ascii=False)) <= 900
    assert "n00" not in saved["notes"]                    # moved out of the active file
    assert "n11" in saved["notes"]                        # newest stays active
    archive = _read(mm._archive_path())
    archived_keys = {r["key"] for r in archive if r["kind"] == "entry"}
    assert "n00" in archived_keys and "n11" not in archived_keys
    n00 = next(r for r in archive if r["key"] == "n00")
    assert n00["record"]["value"].startswith("value number 0")   # full record kept


def test_nothing_is_removed_when_the_archive_is_unreadable(legacy, monkeypatch):
    """If the archive cannot be read, the save is refused and long_term.json is unchanged."""
    monkeypatch.setattr(mm, "MEMORY_MAX_CHARS", 300)
    mm._archive_path().write_text("{not a list", encoding="utf-8")
    before = mm.MEMORY_PATH.read_text(encoding="utf-8")
    with pytest.raises(ValueError):                       # json.JSONDecodeError is a ValueError
        mm.update_memory({"notes": {"big": "x" * 500}})
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == before
    assert mm._archive_path().read_text(encoding="utf-8") == "{not a list"


# ----- live dialogue -----

def test_dialogue_round_trip_keeps_order(legacy):
    mm.append_dialogue_turn("user", "hello")
    mm.append_dialogue_turn("assistant", "hi there")
    turns = mm.get_recent_dialogue(limit=10)
    assert [t["text"] for t in turns] == ["hello", "hi there"]


def _archived_turns(path):
    return [json.loads(line)["turn"] for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_dialogue_beyond_sixty_turns_is_archived_not_deleted(legacy):
    """Owner decision (2026-10-09): dropped dialogue turns move to dialogue_archive.jsonl."""
    for i in range(65):
        mm.append_dialogue_turn("user", f"turn {i}")
    turns = _read(mm.DIALOGUE_PATH)
    assert len(turns) == mm.MAX_DIALOGUE_TURNS == 60
    assert turns[0]["text"] == "turn 5"
    archived = _archived_turns(mm._dialogue_archive_path())
    assert [t["text"] for t in archived] == [f"turn {i}" for i in range(5)]


def test_dialogue_is_kept_when_the_archive_cannot_be_written(legacy):
    """If the archive cannot be written, no turn is dropped. The log grows instead."""
    for i in range(60):
        mm.append_dialogue_turn("user", f"turn {i}")
    mm._dialogue_archive_path().mkdir()                  # a directory: appending to it fails
    mm.append_dialogue_turn("user", "turn 60")
    assert len(_read(mm.DIALOGUE_PATH)) == 61
    assert _read(mm.DIALOGUE_PATH)[0]["text"] == "turn 0"


def test_clear_recent_dialogue_archives_before_removing(legacy):
    """Owner decision (2026-10-09): clearing the log keeps every turn in dialogue_archive.jsonl."""
    mm.append_dialogue_turn("user", "to be archived")
    mm.append_dialogue_turn("assistant", "and this one")
    mm.clear_recent_dialogue()
    assert not mm.DIALOGUE_PATH.exists()
    assert [t["text"] for t in _archived_turns(mm._dialogue_archive_path())] == [
        "to be archived", "and this one"]


def test_clear_keeps_the_live_log_when_the_archive_fails(legacy):
    mm.append_dialogue_turn("user", "must survive")
    mm._dialogue_archive_path().mkdir()
    with pytest.raises(OSError):
        mm.clear_recent_dialogue()
    assert [t["text"] for t in _read(mm.DIALOGUE_PATH)] == ["must survive"]


def test_an_unreadable_dialogue_log_is_copied_aside_not_overwritten(legacy):
    bad = '[{"speaker": "user", "text": "half a line'
    mm.DIALOGUE_PATH.write_text(bad, encoding="utf-8")
    mm.append_dialogue_turn("user", "fresh start")
    copies = list(mm.DIALOGUE_PATH.parent.glob("recent_dialogue.json.corrupt-*"))
    assert len(copies) == 1 and copies[0].read_text(encoding="utf-8") == bad
    assert [t["text"] for t in _read(mm.DIALOGUE_PATH)] == ["fresh start"]
