"""Self-repair (docs/SELF_REPAIR.md): rules, trial, approval, health check, snapshots, rollback.

Every test runs on a small fake project in a temp folder. The real project and the owner's data are
never touched. The fake project's own tests run for real, so a bad change is caught for real.
"""
import hashlib
from datetime import datetime

import pytest

from backend import router
from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from backend.repair import RepairRefused, SelfRepair, SnapshotCorrupt
from backend.repair import policy, trial
from tests.test_chat import FakeClient, FakeModels

NOW = datetime(2026, 10, 9, 14, 5)
GOOD_CALC = "def add(a, b):\n    return a + b  # clearer\n"
BAD_CALC = "def add(a, b):\n    return a - b\n"
ORIGINAL_CALC = "def add(a, b):\n    return a + b\n"


@pytest.fixture
def project(tmp_path):
    repo = tmp_path / "repo"
    files = {
        "backend/__init__.py": "",
        "backend/calc.py": ORIGINAL_CALC,
        "tests/test_calc.py": "from backend.calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        "core/prompt.txt": "PERSONA: calm and exact",
        "memory/long_term.json": '{"preferences": {"tea": {"value": "earl grey"}}}',
        "config/api_keys.json": '{"gemini_api_key": "secret-key"}',
        "web/app.js": "console.log('hi');",
    }
    for rel, text in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return repo


@pytest.fixture
def engine(project, tmp_path):
    conf = ConfirmationStore(bus=EventBus())
    return SelfRepair(project, tmp_path / "runtime", confirmations=conf), conf


def _hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ----- the rules -----

@pytest.mark.parametrize("path", [
    "core/prompt.txt",
    "memory/long_term.json",
    "memory/memory_manager.py",
    "config/api_keys.json",
    "config/__init__.py",
    "backend/repair/engine.py",
    "backend/permissions.py",
    "backend/config.py",
    "backend/chat.py",
    "backend/quota.py",
    "runtime/quota.json",
    "main.py",
    "ui.py",
    "update_mechanic.py",
])
def test_essential_sections_are_refused(path):
    with pytest.raises(RepairRefused, match="essential"):
        policy.check_path(path)


@pytest.mark.parametrize("path", [
    "../outside.py",
    "/etc/passwd",
    "backend/../../outside.py",
    "C:/Windows/x.py",
    "backend\\calc.py",
    "backend//calc.py",
    "docs/anything.md",          # outside the areas self-repair may change
    "barehands/code.js",
])
def test_paths_must_be_plain_and_inside_the_allowed_areas(path):
    with pytest.raises(RepairRefused):
        policy.check_path(path)


def test_a_proposal_has_limits():
    with pytest.raises(RepairRefused):
        policy.validate({})
    with pytest.raises(RepairRefused):
        policy.validate({"backend/calc.py": 42})
    too_many = {f"backend/m{i}.py": "x" for i in range(policy.MAX_FILES + 1)}
    with pytest.raises(RepairRefused):
        policy.validate(too_many)


def test_risk_levels():
    assert policy.classify(["backend/calc.py"], {"backend/calc.py"})[0] == "low"
    assert policy.classify(["backend/requirements.txt"], {"backend/requirements.txt"})[0] == "medium"
    assert policy.classify(["backend/new_thing.py"], set())[0] == "medium"
    assert policy.classify(["backend/agent.py"], {"backend/agent.py"})[0] == "high"
    level, warnings = policy.classify(["backend/voice/live.py"], {"backend/voice/live.py"})
    assert level == "high" and any("core of the assistant" in w for w in warnings)


# ----- trial, approval and apply -----

def test_a_good_change_waits_for_approval_and_changes_nothing_until_then(engine, project):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    assert out["status"] == "waiting" and out["tests"] == "passed on a copy"
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC
    assert out["confirmation"]["action"] == "repair.apply"


def test_approval_applies_the_change_and_keeps_a_snapshot(engine, project):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    done = conf.resolve(out["confirmation"]["id"], approve=True)
    assert done["status"] == "approved" and "Applied 1 file" in done["result"]
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == GOOD_CALC
    snaps = eng.list_snapshots()
    assert snaps and snaps[0]["reason"].startswith("before apply") and snaps[0]["files"] == 1
    assert '"event": "applied"' in eng.log_path.read_text(encoding="utf-8")


def test_a_change_that_fails_the_tests_is_rejected_and_not_offered(engine, project):
    eng, conf = engine
    out = eng.propose("break add", {"backend/calc.py": BAD_CALC})
    assert out["status"] == "rejected" and "failed on a copy" in out["why"]
    assert "assert" in out["test_output"]
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC
    assert conf._items == {}                       # nothing waiting for the owner


def test_failed_health_check_rolls_back_at_once_and_says_so(project, tmp_path):
    results = iter([True, False])                  # trial passes, then the real check fails
    eng = SelfRepair(project, tmp_path / "runtime", confirmations=ConfirmationStore(bus=EventBus()),
                     suite=lambda root: (next(results), "boom"))
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    done = eng._confirmations.resolve(out["confirmation"]["id"], approve=True)
    assert "rolled back automatically" in done["result"]
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC
    assert "rolled_back_after_check" in eng.log_path.read_text(encoding="utf-8")


def test_a_new_file_is_removed_again_by_rollback(engine, project):
    eng, conf = engine
    out = eng.propose("add a helper", {"backend/helper.py": "def hi():\n    return 'hi'\n"})
    conf.resolve(out["confirmation"]["id"], approve=True)
    assert (project / "backend/helper.py").exists()
    eng.rollback_last()
    assert not (project / "backend/helper.py").exists()


# ----- rollback -----

def test_rollback_last_undoes_the_last_change_and_then_there_is_nothing_left(engine, project):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    msg = eng.rollback_last()
    assert "Rolled back" in msg
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC
    assert eng.rollback_last() == "There is no self-repair change to roll back."


def test_a_rollback_can_itself_be_undone(engine, project):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    msg = eng.rollback_last()
    before_id = msg.split("saved as ")[1].split(",")[0].rstrip(".")
    eng.snapshots.restore(before_id, project)
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == GOOD_CALC


def test_a_damaged_snapshot_is_refused_and_the_project_is_left_alone(engine, project):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    sid = eng.last_apply_id()
    (eng.snapshots.root / sid / "files" / "backend" / "calc.py").write_text("tampered", encoding="utf-8")
    with pytest.raises(SnapshotCorrupt):
        eng.rollback(sid)
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == GOOD_CALC


def test_owner_data_is_never_changed_by_a_repair(engine, project):
    eng, conf = engine
    before = {p: _hash(project / p) for p in ["core/prompt.txt", "memory/long_term.json",
                                              "config/api_keys.json"]}
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    eng.rollback_last()
    assert {p: _hash(project / p) for p in before} == before


def test_trial_copy_leaves_out_the_owners_data(project, tmp_path):
    dest = tmp_path / "trial"
    trial.copy_for_trial(project, dest)
    assert (dest / "backend/calc.py").exists()
    assert (dest / "core/prompt.txt").exists()     # read by tests, never written back
    assert not (dest / "memory/long_term.json").exists()
    assert not (dest / "config/api_keys.json").exists()


# ----- the chat path -----

def _agent(tmp_path, eng, conf):
    bus = EventBus()
    models = FakeModels(reply="Gemini says hello.")
    chat = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    budget = DailyBudget(20, path=tmp_path / "q.json", clock=lambda: NOW)
    return Agent(chat, budget, default_policy(), conf, bus=bus, roots=lambda: [],
                 clock=lambda: NOW, repair=eng)


def test_chat_rollback_asks_first_then_rolls_back(engine, project, tmp_path):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    agent = _agent(tmp_path, eng, conf)
    asked = agent.handle("roll back the last change")
    assert asked["source"] == "confirmation" and asked["intent"] == "repair.rollback_last"
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == GOOD_CALC
    done = conf.resolve(asked["confirmation"]["id"], approve=True)
    assert "Rolled back" in done["result"]
    assert (project / "backend/calc.py").read_text(encoding="utf-8") == ORIGINAL_CALC


def test_chat_lists_snapshots_without_asking(engine, project, tmp_path):
    eng, conf = engine
    out = eng.propose("make add clearer", {"backend/calc.py": GOOD_CALC})
    conf.resolve(out["confirmation"]["id"], approve=True)
    agent = _agent(tmp_path, eng, conf)
    res = agent.handle("show my backups")
    assert res["source"] == "local" and res["intent"] == "repair.list"
    assert eng.last_apply_id() in res["reply"]


@pytest.mark.parametrize("text", ["roll back the last change", "undo", "rollback", "undo the last repair",
                                  "roll back my last update"])
def test_rollback_phrases(text):
    assert router.match(text).action == "repair.rollback_last"


@pytest.mark.parametrize("text", ["list snapshots", "show my backups", "show the restore points"])
def test_list_phrases(text):
    assert router.match(text).action == "repair.list"


def test_tiers_listing_is_safe_and_rollback_asks():
    p = default_policy()
    assert p.decide("repair.list").allowed and not p.decide("repair.list").needs_confirmation
    assert p.decide("repair.rollback_last").needs_confirmation
