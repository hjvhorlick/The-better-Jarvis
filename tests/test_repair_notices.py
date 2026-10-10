"""Errors the assistant notices in its own code (docs/SELF_REPAIR.md §5c). Nothing is changed by noticing."""
import importlib.util
from datetime import datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend import router
from backend.agent import Agent
from backend.app import create_app
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from backend.repair import Notices, SelfRepair
from tests.test_chat import FakeClient, FakeModels

pytest_plugins = ["tests.test_repair"]   # shares the fake-project fixture


def _module(root, rel, source, name="mod"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _raised(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - the test needs the exception object
        return e
    raise AssertionError("expected an error")


BOOM = "def go():\n    raise ValueError('secret-key-123')\n"


def test_an_error_in_an_allowed_file_is_noticed_without_its_message(tmp_path):
    mod = _module(tmp_path, "backend/boom.py", BOOM)
    notices = Notices(tmp_path)
    item = notices.record(_raised(mod.go))
    assert item["file"] == "backend/boom.py" and item["line"] == 2 and item["error"] == "ValueError"
    assert "secret" not in str(item) and "secret" not in notices.message(item)
    assert "propose a fix for backend/boom.py" in notices.message(item)


def test_an_error_in_protected_code_is_not_offered(tmp_path):
    notices = Notices(tmp_path)
    assert notices.record(_raised(_module(tmp_path, "backend/repair/bad.py", BOOM).go)) is None
    assert notices.record(_raised(_module(tmp_path, "memory/bad.py", BOOM).go)) is None
    assert notices.recent() == []


def test_an_error_from_outside_the_project_is_ignored(tmp_path):
    notices = Notices(tmp_path)
    assert notices.record(_raised(lambda: 1 / 0)) is None     # raised in this test file, not in tmp_path


def test_an_error_inside_a_library_is_reported_at_our_own_code(tmp_path):
    lib = _module(tmp_path, ".venv/lib/lib.py", BOOM, name="lib")
    caller = _module(tmp_path, "backend/caller.py",
                     "def run(f):\n    return f()\n", name="caller")
    notices = Notices(tmp_path)
    item = notices.record(_raised(lambda: caller.run(lib.go)))
    assert item is not None and item["file"] == "backend/caller.py"


def test_a_repeat_within_the_window_is_not_shown_again(tmp_path):
    mod = _module(tmp_path, "backend/boom.py", BOOM)
    now = [1000.0]
    notices = Notices(tmp_path, clock=lambda: now[0], repeat_window_s=300)
    assert notices.record(_raised(mod.go)) is not None
    now[0] += 60
    assert notices.record(_raised(mod.go)) is None
    now[0] += 400
    assert notices.record(_raised(mod.go)) is not None


def test_the_notice_is_published_on_the_bus(tmp_path):
    mod = _module(tmp_path, "backend/boom.py", BOOM)
    bus = EventBus()
    Notices(tmp_path, bus=bus).record(_raised(mod.go))
    events = [e for _, e in bus.since(0, source="assistant")]
    assert len(events) == 1 and events[0]["type"] == "notice" and "backend/boom.py" in events[0]["text"]


def test_only_the_newest_notices_are_kept(tmp_path):
    notices = Notices(tmp_path, keep=3, repeat_window_s=0)
    for i in range(5):
        mod = _module(tmp_path, f"backend/m{i}.py", BOOM, name=f"m{i}")
        notices.record(_raised(mod.go))
    assert [n["file"] for n in notices.recent()] == ["backend/m2.py", "backend/m3.py", "backend/m4.py"]


def test_the_chat_phrases_list_the_notices():
    for text in ["what errors have you noticed", "show me the errors you noticed", "list recent errors"]:
        assert router.match(text).action == "repair.notices", text


def test_listing_in_chat_says_so_when_there_is_nothing(tmp_path, monkeypatch):
    agent = _agent(tmp_path)
    out = agent.handle("what errors have you noticed")
    assert out["intent"] == "repair.notices" and "not noticed any errors" in out["reply"]


def test_listing_in_chat_shows_the_notice_and_changes_nothing(tmp_path):
    agent = _agent(tmp_path)
    mod = _module(tmp_path, "backend/boom.py", BOOM)
    agent._notices.record(_raised(mod.go))
    out = agent.handle("what errors have you noticed")
    assert "backend/boom.py line 2 (ValueError)" in out["reply"]
    assert "Nothing has been changed" in out["reply"]


def test_an_unhandled_error_in_app_code_is_noticed_and_answered_with_500(tmp_path, monkeypatch):
    bus = EventBus()
    models = FakeModels(reply="pong")
    svc = ChatService(client_factory=lambda k: FakeClient(models), model="test-model")
    app = create_app(svc, serve_ui=False, bus=bus)

    def broken():                         # defined in tests/, which self-repair may change
        raise KeyError("private-value")

    app.add_api_route("/api/broken-for-test", broken, methods=["GET"])
    client = TestClient(app, base_url="http://127.0.0.1:8765", raise_server_exceptions=False)
    r = client.get("/api/broken-for-test")
    assert r.status_code == 500 and "private-value" not in r.text
    texts = [e["text"] for _, e in bus.since(0, source="assistant") if e.get("type") == "notice"]
    assert any("tests/test_repair_notices.py" in t and "KeyError" in t for t in texts)


def _agent(tmp_path):
    repo = tmp_path                       # the project root is the temp folder the test writes into
    budget = DailyBudget(5, path=tmp_path / "q.json", clock=lambda: datetime(2026, 10, 9))
    bus = EventBus()
    conf = ConfirmationStore(bus=bus)
    svc = ChatService(client_factory=lambda k: SimpleNamespace(models=FakeModels(reply="x")), model="m")
    notices = Notices(repo, bus=bus)
    return Agent(svc, budget, default_policy(), conf, bus=bus, roots=lambda: [],
                 repair=SelfRepair(repo, tmp_path / "runtime", confirmations=conf), notices=notices)
