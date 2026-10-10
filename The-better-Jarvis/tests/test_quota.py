import json
from datetime import datetime

import pytest

from backend.quota import DailyBudget


class Day:
    """A clock the test can move between days."""

    def __init__(self, day=9):
        self.day = day

    def __call__(self):
        return datetime(2026, 10, self.day, 12, 0, 0)


def test_budget_is_spent_one_call_at_a_time(tmp_path):
    b = DailyBudget(3, path=tmp_path / "q.json", clock=Day())
    assert [b.try_spend() for _ in range(4)] == [True, True, True, False]
    snap = b.snapshot()
    assert (snap["used"], snap["limit"], snap["remaining"]) == (3, 3, 0)


def test_zero_budget_turns_gemini_calls_off(tmp_path):
    b = DailyBudget(0, path=tmp_path / "q.json", clock=Day())
    assert b.try_spend() is False
    assert b.snapshot()["enabled"] is False


def test_negative_budget_is_refused():
    with pytest.raises(ValueError):
        DailyBudget(-1)


def test_count_survives_a_restart(tmp_path):
    path = tmp_path / "q.json"
    DailyBudget(5, path=path, clock=Day()).try_spend()
    DailyBudget(5, path=path, clock=Day()).try_spend()
    again = DailyBudget(5, path=path, clock=Day())
    assert again.snapshot()["used"] == 2


def test_count_resets_on_a_new_local_day(tmp_path):
    clock = Day(9)
    b = DailyBudget(1, path=tmp_path / "q.json", clock=clock)
    assert b.try_spend() is True and b.try_spend() is False
    clock.day = 10
    assert b.try_spend() is True
    assert b.snapshot()["day"] == "2026-10-10"


def test_unreadable_file_fails_closed_until_midnight(tmp_path):
    path = tmp_path / "q.json"
    path.write_text("{not json", encoding="utf-8")
    clock = Day(9)
    b = DailyBudget(20, path=path, clock=clock)
    assert b.try_spend() is False
    snap = b.snapshot()
    assert snap["unreadable"] is True and snap["remaining"] == 0
    assert path.read_text(encoding="utf-8") == "{not json"   # never overwritten
    clock.day = 10
    assert b.try_spend() is True                              # next day: counting resumes


def test_provider_limit_closes_the_budget_for_the_day(tmp_path):
    path = tmp_path / "q.json"
    b = DailyBudget(20, path=path, clock=Day())
    b.mark_exhausted()
    assert b.try_spend() is False
    assert json.loads(path.read_text(encoding="utf-8"))["used"] == 20


def test_a_failed_save_does_not_stop_counting(tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    b = DailyBudget(5, path=blocker / "q.json", clock=Day())
    assert b.try_spend() is True
    assert b.snapshot()["saved"] is False
