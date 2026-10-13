"""The assistant proposes its own fixes (docs/SELF_REPAIR.md). Every proposal still goes through the rules,
the trial on a copy, and the owner's approval. The model is a recording fake, so no real request is made.
"""
from datetime import datetime
from types import SimpleNamespace

import pytest

from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from backend.repair import SelfRepair, proposer
from tests.test_repair import GOOD_CALC, ORIGINAL_CALC

pytest_plugins = ["tests.test_repair"]  # shares the fake-project fixture

NOW = datetime(2026, 10, 9, 14, 5)
REQUEST = "Propose a fix for backend/calc.py: make add clearer"


class Recording:
    def __init__(self, reply):
        self.reply, self.calls = reply, []

    def generate_content(self, model, contents, config):
        self.calls.append({"contents": contents, "config": config})
        return SimpleNamespace(text=self.reply)


def _json(reason, files):
    import json
    return json.dumps({"reason": reason, "files": files})


def _agent(tmp_path, project, reply, key="test-key", budget_limit=20):
    if key:
        import os
        os.environ["GEMINI_API_KEY"] = key
    models = Recording(reply)
    chat = ChatService(client_factory=lambda k: SimpleNamespace(models=models), model="test-model")
    bus = EventBus()
    conf = ConfirmationStore(bus=bus)
    budget = DailyBudget(budget_limit, path=tmp_path / "q.json", clock=lambda: NOW)
    repair = SelfRepair(project, tmp_path / "runtime", confirmations=conf)
    agent = Agent(chat, budget, default_policy(), conf, bus=bus, roots=lambda: [], clock=lambda: NOW,
                  repair=repair)
    return agent, conf, models, budget, repair


@pytest.fixture(autouse=True)
def _no_real_key(isolated, monkeypatch):
    """Use the temp config from `isolated`, so a real key on the owner's machine is never read."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)


# ----- what the model sees -----

def test_only_named_allowed_files_are_sent(project):
    text = ("Propose a fix for backend/calc.py and memory/long_term.json and config/api_keys.json "
            "and core/prompt.txt and backend/permissions.py and nothing.py")
    files = proposer.context_files(project, text)
    assert list(files) == ["backend/calc.py"]
    assert files["backend/calc.py"] == ORIGINAL_CALC


def test_names_keep_their_capitals_and_dots(project):
    (project / "backend" / "Calc.py").write_text("X = 1\n", encoding="utf-8")
    assert list(proposer.context_files(project, "fix Backend/Calc.py please")) == []   # case is exact
    assert list(proposer.context_files(project, "fix backend/Calc.py please")) == ["backend/Calc.py"]


def test_the_prompt_has_the_request_and_the_file_text_only(project):
    prompt = proposer.build_prompt("make it clearer", {"backend/calc.py": ORIGINAL_CALC})
    assert "make it clearer" in prompt and ORIGINAL_CALC in prompt
    assert "earl grey" not in prompt and "secret-key" not in prompt and "PERSONA" not in prompt


# ----- reading the answer -----

def test_a_plain_json_answer_is_read():
    reason, files = proposer.parse('{"reason": "r", "files": {"backend/x.py": "y"}}')
    assert reason == "r" and files == {"backend/x.py": "y"}


def test_a_fenced_json_answer_is_read():
    reason, files = proposer.parse('```json\n{"reason": "r", "files": {}}\n```')
    assert reason == "r" and files == {}


@pytest.mark.parametrize("bad", ["not json at all", '["a", "list"]', '{"reason": 3, "files": {}}',
                                 '{"reason": "r"}'])
def test_a_bad_answer_is_refused(bad):
    with pytest.raises(proposer.ProposalError):
        proposer.parse(bad)


# ----- the chat path (drafting asks first, then the draft asks again before it changes anything) -----

def _ask_then_answer(agent, conf, text=REQUEST, approve=True):
    """The owner's request, then the owner's answer to the drafting question."""
    out = agent.handle(text)
    assert out["source"] == "confirmation" and out["intent"] == "repair.propose"
    return conf.resolve(out["confirmation"]["id"], approve=approve), out


def test_drafting_asks_first_and_sends_nothing_before_the_owner_says_yes(project, tmp_path):
    agent, conf, models, budget, _ = _agent(tmp_path, project, _json("x", {"backend/calc.py": GOOD_CALC}))
    out = agent.handle(REQUEST)
    assert out["source"] == "confirmation"
    assert "sent to Gemini" in out["confirmation"]["summary"]
    assert models.calls == [] and budget.snapshot()["used"] == 0
    assert conf.pending()[0]["action"] == "repair.propose"


def test_declining_the_drafting_question_sends_nothing(project, tmp_path):
    agent, conf, models, budget, _ = _agent(tmp_path, project, _json("x", {"backend/calc.py": GOOD_CALC}))
    done, _ = _ask_then_answer(agent, conf, approve=False)
    assert done["status"] == "denied"
    assert models.calls == [] and budget.snapshot()["used"] == 0


def test_a_good_draft_waits_for_a_second_approval_then_applies(project, tmp_path):
    agent, conf, models, budget, _ = _agent(
        tmp_path, project, _json("make add clearer", {"backend/calc.py": GOOD_CALC}))
    done, _ = _ask_then_answer(agent, conf)
    assert done["status"] == "approved" and "Here is my proposed change" in done["result"]
    # The model saw only the fixed instruction and the named file, never the persona or memory.
    call = models.calls[0]
    assert call["config"]["system_instruction"] == proposer.SYSTEM
    assert "earl grey" not in str(call["contents"]) and "secret-key" not in str(call["contents"])
    assert budget.snapshot()["used"] == 1
    # The draft is still unapplied and waits for its own approval.
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC
    apply_view = conf.pending()[0]
    assert apply_view["action"] == "repair.apply"
    applied = conf.resolve(apply_view["id"], approve=True)
    assert "Applied 1 file" in applied["result"]
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == GOOD_CALC


def test_a_broken_draft_is_rejected_by_the_tests_and_not_offered(project, tmp_path):
    broken = "def add(a, b)\n    return a + b\n"          # missing colon: the tests fail
    agent, conf, _, _, _ = _agent(tmp_path, project, _json("break it", {"backend/calc.py": broken}))
    done, _ = _ask_then_answer(agent, conf)
    assert "failed the tests on a copy" in done["result"]
    assert conf.pending() == []
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC


def test_a_draft_that_touches_owner_data_is_refused(project, tmp_path):
    agent, conf, _, _, _ = _agent(
        tmp_path, project, _json("edit memory", {"memory/long_term.json": "{}"}))
    done, _ = _ask_then_answer(agent, conf, "Propose a fix for memory/long_term.json: clear it")
    assert "cannot make that change" in done["result"] and "essential section" in done["result"]
    assert conf.pending() == []
    assert '"tea"' in (project / "memory/long_term.json").read_text(encoding="utf-8")


def test_an_unreadable_answer_changes_nothing_and_still_counts_one_unit(project, tmp_path):
    agent, conf, _, budget, _ = _agent(tmp_path, project, "Sure! Here is my fix: ...")
    done, _ = _ask_then_answer(agent, conf)
    assert "could not form a safe proposal" in done["result"]
    assert conf.pending() == [] and budget.snapshot()["used"] == 1


def test_a_model_that_declines_is_reported(project, tmp_path):
    agent, conf, _, _, _ = _agent(tmp_path, project, _json("this needs a human", {}))
    done, _ = _ask_then_answer(agent, conf)
    assert "do not propose a change" in done["result"] and "this needs a human" in done["result"]


def test_offline_means_no_request(project, tmp_path):
    # A zero WARNING level no longer blocks anything; being offline does.
    agent, conf, models, budget, _ = _agent(tmp_path, project, _json("x", {"backend/calc.py": GOOD_CALC}))
    budget.mark_exhausted()
    done, _ = _ask_then_answer(agent, conf)
    assert "offline" in done["result"] and "needs the internet" in done["result"]
    assert models.calls == []


def test_no_key_means_no_request(project, tmp_path):
    agent, conf, models, _, _ = _agent(tmp_path, project, _json("x", {"backend/calc.py": GOOD_CALC}),
                                       key=None)
    done, _ = _ask_then_answer(agent, conf)
    assert "No Gemini API key" in done["result"] and models.calls == []


def test_a_request_with_nothing_after_the_phrase_goes_to_chat_not_to_repair(project, tmp_path):
    agent, conf, models, _, _ = _agent(tmp_path, project, _json("x", {}))
    out = agent.handle("propose a fix for")
    assert out["intent"] != "repair.propose"
    assert conf.pending() == []
