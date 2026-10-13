"""The app's own count WARNS and never blocks; only Google's 429 goes offline.

These are the owner's rules, and they are the opposite of what this module used
to do (a hard daily budget that refused calls Google would still have answered):

  * the count never refuses a call — past the warning level it only says so;
  * a real 429 from Google puts the app OFFLINE for the rest of the local day,
    and offline means "no internet calls", never "no chat";
  * SUPPER_OFFLINE=1 asks for the same offline mode by hand;
  * a damaged counter file is left alone and blocks nothing.
"""
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


def test_the_count_never_blocks_a_call_it_only_warns(tmp_path):
    b = DailyBudget(3, path=tmp_path / "q.json", clock=Day())
    # Four calls against a warning level of three: every one is allowed.
    assert [b.try_spend() for _ in range(4)] == [True, True, True, True]
    snap = b.snapshot()
    assert (snap["used"], snap["warn_at"], snap["past_warn"]) == (4, 3, True)
    assert snap["enabled"] is True                     # the count never turns calls off
    assert "never blocks" in b.warn()                  # …it says so instead


def test_under_the_warning_level_there_is_no_warning(tmp_path):
    b = DailyBudget(20, path=tmp_path / "q.json", clock=Day())
    b.try_spend()
    assert b.snapshot()["past_warn"] is False
    assert b.warn() == ""


def test_a_zero_warning_level_means_never_warn_but_still_count(tmp_path):
    b = DailyBudget(0, path=tmp_path / "q.json", clock=Day())
    assert b.try_spend() is True                       # 0 is "never warn", not "no calls"
    assert b.snapshot()["past_warn"] is False
    assert b.warn() == ""


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
    assert b.try_spend() is True and b.try_spend() is True    # the level only warns
    clock.day = 10
    assert b.snapshot()["used"] == 0
    assert b.snapshot()["day"] == "2026-10-10"


def test_an_unreadable_file_blocks_nothing_and_is_never_overwritten(tmp_path):
    path = tmp_path / "q.json"
    path.write_text("{not json", encoding="utf-8")
    clock = Day(9)
    b = DailyBudget(20, path=path, clock=clock)
    assert b.try_spend() is True                       # a damaged file is not a reason to stop
    assert b.snapshot()["unreadable"] is True
    assert path.read_text(encoding="utf-8") == "{not json"   # never overwritten
    clock.day = 10
    assert b.try_spend() is True


def test_a_real_429_puts_the_app_offline_for_the_day(tmp_path):
    path = tmp_path / "q.json"
    b = DailyBudget(20, path=path, clock=Day())
    b.mark_exhausted()
    assert b.offline is True
    assert b.try_spend() is False                      # no internet call is made while offline
    assert "429" in b.offline_reason()
    # …and the count is NOT pretended to be used up: it is Google, not this app.
    assert b.snapshot()["used"] == 0
    # The stop is written in the shape the dashboard reads, so both sides agree.
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["google_stopped"]["1"]["reason"] == "quota"


def test_offline_ends_on_a_new_local_day(tmp_path):
    clock = Day(9)
    b = DailyBudget(20, path=tmp_path / "q.json", clock=clock)
    b.mark_exhausted()
    assert b.offline is True
    clock.day = 10
    assert b.offline is False                          # the keys are tried again
    assert b.try_spend() is True


def test_offline_survives_a_restart(tmp_path):
    path = tmp_path / "q.json"
    first = DailyBudget(20, path=path, clock=Day())
    first.mark_exhausted()
    again = DailyBudget(20, path=path, clock=Day())
    assert again.offline is True and again.try_spend() is False


def test_a_new_key_can_clear_the_stop(tmp_path):
    b = DailyBudget(20, path=tmp_path / "q.json", clock=Day())
    b.mark_exhausted()
    b.clear_exhausted()
    assert b.offline is False and b.try_spend() is True


def test_the_owner_can_switch_offline_by_hand(tmp_path, monkeypatch):
    b = DailyBudget(20, path=tmp_path / "q.json", clock=Day())
    monkeypatch.setenv("SUPPER_OFFLINE", "1")
    assert b.offline is True and b.try_spend() is False
    assert "SUPPER_OFFLINE" in b.offline_reason()
    monkeypatch.setenv("SUPPER_OFFLINE", "0")
    assert b.offline is False and b.try_spend() is True


def test_a_failed_save_does_not_stop_counting(tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    b = DailyBudget(5, path=blocker / "q.json", clock=Day())
    assert b.try_spend() is True
    assert b.snapshot()["saved"] is False
