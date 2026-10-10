"""Local first: Gemini is the last resort.

A question about the owner's own stored facts is answered from memory when a stored fact clearly
holds the answer. Only then is no Gemini call made and no budget unit spent. Otherwise the
question goes to Gemini, as before. Nothing in this path writes to memory.
"""
import json

from backend import router
from backend.recall import describe, find_facts, keywords
from memory import memory_manager as mm
from tests.test_agent import _agent


# ----- matching -----

def test_keywords_drop_filler_and_keep_meaning():
    assert keywords("my favourite colour") == ["favourite", "colour"]
    assert keywords("the name") == ["name"]
    assert keywords("my sister's name") == ["sister", "name"]     # the one-letter "s" is dropped


def test_a_stored_fact_is_found_by_its_key(isolated):
    assert find_facts("name") == [("identity", "name", "Test Person")]


def test_plurals_match_the_singular_key(isolated):
    assert find_facts("teas") == [("preferences", "tea", "earl grey")]


def test_every_keyword_must_match_or_nothing_is_returned(isolated):
    # "sister" matches a key, but no stored fact has "name" as well, so nothing is answered.
    assert find_facts("sister name") == []
    assert find_facts("favourite colour") == []


def test_questions_with_no_meaningful_words_match_nothing(isolated):
    assert find_facts("the") == []
    assert find_facts("") == []


def test_only_the_stored_values_are_described(isolated):
    text = describe(find_facts("sister"))
    assert text == "sister: Ayse"


def test_list_sections_and_empty_values_are_skipped(isolated, tmp_path):
    mm.MEMORY_PATH.write_text(json.dumps({
        "sessions": [{"summary": "name in a session list"}],
        "notes": {"blank": {"value": "   "}, "name": {"value": "Kept"}},
    }), encoding="utf-8")
    assert find_facts("name") == [("notes", "name", "Kept")]


# ----- the router -----

def test_what_is_my_question_is_a_memory_question():
    m = router.match("What is my favourite colour?")
    assert m is not None and m.action == "memory.recall"
    assert m.args["query"] == "favourite colour"


def test_what_do_you_know_about_is_a_memory_question():
    m = router.match("what do you know about my sister")
    assert m is not None and m.action == "memory.recall" and m.args["query"] == "my sister"


def test_existing_local_commands_keep_their_meaning():
    assert router.match("what time is it").action == "time.now"
    assert router.match("what is the weather in Cape Town").action == "skill.weather"
    assert router.match("what is the capital of France") is None       # goes to Gemini


# ----- the agent -----

def test_a_stored_answer_costs_no_gemini_call_and_no_budget(isolated):
    a = _agent(isolated)
    out = a.agent.handle("what is my name")
    assert out["source"] == "local" and out["intent"] == "memory.recall"
    assert "Test Person" in out["reply"]
    assert a.models.calls == []
    assert a.budget.snapshot()["used"] == 0


def test_a_question_memory_cannot_answer_goes_to_gemini(isolated, monkeypatch):
    a = _agent(isolated, key="test-key", monkeypatch=monkeypatch)
    out = a.agent.handle("what is my favourite colour")
    assert out["source"] == "gemini"
    assert len(a.models.calls) == 1
    assert a.budget.snapshot()["used"] == 1


def test_the_stored_answer_path_writes_nothing(isolated):
    before = mm.MEMORY_PATH.read_text(encoding="utf-8")
    _agent(isolated).agent.handle("what is my tea")
    assert mm.MEMORY_PATH.read_text(encoding="utf-8") == before


def test_help_mentions_the_memory_question(isolated):
    out = _agent(isolated).agent.handle("help")
    assert "what is my" in out["reply"]
