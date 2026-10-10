"""Reminders (V2-5). See backend/reminders.py for what was ported from the legacy app and what changed."""
import json
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from backend import reminders as rm
from backend import router
from backend.agent import Agent
from backend.chat import ChatService
from backend.events import EventBus
from backend.permissions import ConfirmationStore, default_policy
from backend.quota import DailyBudget
from backend.repair import Notices, SelfRepair
from backend.reminders import BadReminder, Reminders, cancel_id, parse
from tests.test_chat import FakeModels

NOW = datetime(2026, 10, 9, 14, 5)


# ----- understanding the time -----

def test_in_minutes_hours_and_seconds():
    assert parse("remind me in 10 minutes to stretch", NOW) == (NOW + timedelta(minutes=10), "stretch")
    assert parse("Remind me in 2 hours to call Ayse", NOW) == (NOW + timedelta(hours=2), "call Ayse")
    assert parse("remind me in 30 seconds to check the oven", NOW) == (NOW + timedelta(seconds=30), "check the oven")


def test_at_a_time_today_or_tomorrow_if_it_has_passed():
    assert parse("Remind me at 15:30 to call the bank", NOW)[0] == datetime(2026, 10, 9, 15, 30)
    assert parse("remind me at 9 to take tablets", NOW)[0] == datetime(2026, 10, 10, 9, 0)   # 9 has passed today
    assert parse("remind me at 9 pm to lock up", NOW)[0] == datetime(2026, 10, 9, 21, 0)
    assert parse("remind me at 12 am to sleep", NOW)[0] == datetime(2026, 10, 10, 0, 0)


def test_tomorrow_at_a_time():
    assert parse("remind me tomorrow at 9 to pay rent", NOW) == (datetime(2026, 10, 10, 9, 0), "pay rent")


@pytest.mark.parametrize("text", [
    "remind me in 0 minutes to x",
    "remind me in 8 days to x",
    "remind me at 25:00 to x",
    "remind me at 13 pm to x",
    "remind me at 15:30 to",
    "remind me when it suits you",
    "remind me in 10 minutes to " + "x" * 300,
    "remind me in 10 minutes to hi\x07there",
])
def test_unsupported_or_unsafe_reminders_are_refused(text):
    with pytest.raises(BadReminder):
        parse(text, NOW)


def test_cancel_needs_a_number():
    assert cancel_id("cancel reminder 3F9A2C") == "3f9a2c"
    with pytest.raises(BadReminder):
        cancel_id("cancel the reminder please")


# ----- the store -----

def _store(tmp_path, clock=None, bus=None):
    return Reminders(tmp_path / "reminders.json", bus=bus, clock=clock or (lambda: NOW))


def test_added_reminders_are_saved_and_listed_in_time_order(tmp_path):
    s = _store(tmp_path)
    s.add("remind me at 16:00 to second")
    s.add("remind me at 15:00 to first")
    assert [i["text"] for i in s.pending()] == ["first", "second"]
    again = _store(tmp_path)                                  # a new process reads the same file
    assert [i["text"] for i in again.pending()] == ["first", "second"]


def test_due_reminders_fire_once(tmp_path):
    now = [NOW]
    s = _store(tmp_path, clock=lambda: now[0])
    s.add("remind me in 5 minutes to stretch")
    assert s.due_now() == []
    now[0] = NOW + timedelta(minutes=5)
    fired = s.due_now()
    assert [i["text"] for i in fired] == ["stretch"]
    assert s.due_now() == [] and s.pending() == []


def test_a_due_reminder_is_shown_in_chat_and_says_when_it_was_late(tmp_path):
    now = [NOW]
    bus = EventBus()
    s = _store(tmp_path, clock=lambda: now[0], bus=bus)
    s.add("remind me in 1 minute to stretch")
    now[0] = NOW + timedelta(hours=3)                         # the app was off for a while
    assert s.tick() == 1
    events = [e for _, e in bus.since(0, source="assistant")]
    assert len(events) == 1 and events[0]["kind"] == "reminder"
    assert events[0]["text"].startswith("Reminder: stretch") and "the app was not running" in events[0]["text"]


def test_an_on_time_reminder_is_not_marked_late(tmp_path):
    now = [NOW]
    bus = EventBus()
    s = _store(tmp_path, clock=lambda: now[0], bus=bus)
    s.add("remind me in 1 minute to stretch")
    now[0] = NOW + timedelta(minutes=1)
    s.tick()
    assert [e["text"] for _, e in bus.since(0, source="assistant")] == ["Reminder: stretch"]


def test_cancel_removes_one_reminder(tmp_path):
    s = _store(tmp_path)
    keep = s.add("remind me at 15:00 to keep")
    gone = s.add("remind me at 16:00 to drop")
    assert s.cancel(gone["id"])["text"] == "drop"
    assert [i["id"] for i in s.pending()] == [keep["id"]]
    with pytest.raises(BadReminder):
        s.cancel("nope00")


def test_the_list_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(rm, "MAX_PENDING", 2)
    s = _store(tmp_path)
    s.add("remind me at 15:00 to a")
    s.add("remind me at 15:01 to b")
    with pytest.raises(BadReminder):
        s.add("remind me at 15:02 to c")


def test_an_unreadable_store_is_kept_aside_not_overwritten(tmp_path):
    path = tmp_path / "reminders.json"
    path.write_text("{not json", encoding="utf-8")
    s = Reminders(path, clock=lambda: NOW)
    assert s.pending() == []
    copies = list(tmp_path.glob("reminders.json.corrupt-*"))
    assert len(copies) == 1 and copies[0].read_text(encoding="utf-8") == "{not json"


def test_the_timer_starts_once_and_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(rm, "POLL_S", 0.01)
    s = _store(tmp_path)
    s.start()
    first = s._thread
    s.start()
    assert s._thread is first
    s.stop()
    deadline = time.time() + 2
    while first.is_alive() and time.time() < deadline:
        time.sleep(0.01)
    assert not first.is_alive()


def test_describe_is_plain():
    assert rm.describe([]) == "You have no reminders waiting, sir."


# ----- chat -----

def test_the_chat_phrases_route_to_reminders():
    assert router.match("remind me in 10 minutes to stretch").action == "reminder.add"
    assert router.match("Remind me at 15:30 to call the bank").action == "reminder.add"
    assert router.match("list my reminders").action == "reminder.list"
    assert router.match("cancel reminder 3f9a2c").action == "reminder.cancel"


def test_the_raw_text_keeps_times_and_capitals_for_the_reminder():
    m = router.match("Remind me at 15:30 to call Ayse")
    assert m.args["raw"] == "Remind me at 15:30 to call Ayse"


def _agent(tmp_path):
    bus = EventBus()
    conf = ConfirmationStore(bus=bus)
    budget = DailyBudget(5, path=tmp_path / "q.json", clock=lambda: NOW)
    svc = ChatService(client_factory=lambda k: SimpleNamespace(models=FakeModels(reply="x")), model="m")
    store = Reminders(tmp_path / "reminders.json", bus=bus, clock=lambda: NOW)
    agent = Agent(svc, budget, default_policy(), conf, bus=bus, roots=lambda: [],
                  repair=SelfRepair(tmp_path, tmp_path / "runtime", confirmations=conf),
                  notices=Notices(tmp_path, bus=bus), reminders=store)
    return agent, conf, store


def test_a_reminder_set_list_and_cancel_in_chat(tmp_path):
    agent, conf, store = _agent(tmp_path)
    out = agent.handle("remind me at 15:30 to call the bank")
    assert out["intent"] == "reminder.add" and "set for" in out["reply"] and "call the bank" in out["reply"]
    item = store.pending()[0]
    assert item["due"] == "2026-10-09T15:30:00"

    listed = agent.handle("list my reminders")
    assert "call the bank" in listed["reply"]

    ask = agent.handle(f"cancel reminder {item['id']}")
    assert ask["source"] == "confirmation" and ask["intent"] == "reminder.cancel"
    assert store.pending()                                    # nothing removed before the owner says yes
    done = conf.resolve(ask["confirmation"]["id"], approve=True)
    assert "cancelled" in done["result"] and store.pending() == []


def test_a_bad_reminder_in_chat_says_why_and_stores_nothing(tmp_path):
    agent, conf, store = _agent(tmp_path)
    out = agent.handle("remind me in 0 minutes to nothing")
    assert out["intent"] == "reminder.add" and "at least one unit ahead" in out["reply"]
    assert store.pending() == []


def test_cancelling_an_unknown_reminder_says_so(tmp_path):
    agent, conf, store = _agent(tmp_path)
    ask = agent.handle("cancel reminder abc123")
    done = conf.resolve(ask["confirmation"]["id"], approve=True)
    assert "no reminder with number abc123" in done["result"]


def test_a_stored_file_is_plain_json(tmp_path):
    s = _store(tmp_path)
    s.add("remind me at 15:00 to a")
    data = json.loads((tmp_path / "reminders.json").read_text(encoding="utf-8"))
    assert data[0]["text"] == "a"


def test_the_timer_runs_while_the_app_runs_and_stops_with_it(isolated, monkeypatch):
    """The lifespan hook starts the reminder timer when the server starts, and stops it at shutdown."""
    import threading
    from fastapi.testclient import TestClient
    from backend.app import create_app

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    svc = ChatService(client_factory=lambda k: SimpleNamespace(models=FakeModels(reply="x")), model="m")
    app = create_app(svc, serve_ui=False)
    assert not any(t.name == "reminders" for t in threading.enumerate())
    with TestClient(app, base_url="http://127.0.0.1:8765"):
        assert any(t.name == "reminders" and t.is_alive() for t in threading.enumerate())
    deadline = time.time() + 3
    while any(t.name == "reminders" and t.is_alive() for t in threading.enumerate()) and time.time() < deadline:
        time.sleep(0.05)
    assert not any(t.name == "reminders" and t.is_alive() for t in threading.enumerate())
