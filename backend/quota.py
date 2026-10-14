"""Daily count of Gemini calls made by this app — it WARNS, it never BLOCKS.

This is the app's own counter. It is NOT Google's quota. Google's free-tier
limits differ by model and project and can change, so the owner sets the level
at which the app should start warning (SUPPER_GEMINI_DAILY_WARN; the old
SUPPER_GEMINI_DAILY_BUDGET is honoured as that same warning level — it used to
be a hard limit, which refused calls Google would still have answered).

Rules, and they are the owner's rules:
  * Each call that reaches Gemini takes one unit before it is sent. Failed calls
    count too, because the provider may still have counted them.
  * The COUNT NEVER REFUSES A CALL. Past the warning level the app says so; the
    call still goes out. The only thing that stops an outbound call is Google
    itself: a real 429 marks the app OFFLINE until Google's own daily quota
    resets — midnight Pacific.
  * OFFLINE IS A MODE, NOT A DEAD END. While offline nothing is fetched from the
    internet and no unit is counted, but the chat and every local feature keep
    working — the caller answers from this computer instead of stopping.
  * SUPPER_OFFLINE=1 forces the same offline mode by hand (no internet at all).
  * The count resets at local midnight. A Google 429 stop ends at midnight
    Pacific (America/Los_Angeles) — Google's own quota boundary, the same one
    the dashboard (config.ts) uses. The two differ by hours (nine for a clock
    in UTC+2): the stop follows Google's day, not ours.
  * The count is kept in runtime/quota.json (git-ignored), in the {day, used}
    shape the dashboard writes and reads. A file that exists but cannot be read
    is left alone and the count continues in memory; it never blocks anything.

Provenance: written for this project. No code taken from other projects.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

try:
    _PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:                                # noqa: BLE001 - a machine with no tz database
    from datetime import timedelta, timezone
    # Fixed PST offset: close enough to keep the promise honest (the real
    # boundary is midnight Pacific; only the DST hour shifts).
    _PACIFIC = timezone(timedelta(hours=-8))


def offline_requested() -> bool:
    """True when the owner asked for no internet at all (SUPPER_OFFLINE)."""
    return (os.environ.get("SUPPER_OFFLINE", "") or "").strip().lower() in {"1", "true", "yes", "on"}


class DailyBudget:
    """Counts the day's Gemini calls, warns past the level, and knows when Google stopped us.

    `limit` is the WARNING level (0 means "never warn"). It never blocks a call:
    the only refusal is `offline`, which is Google's own 429 (or the owner's
    SUPPER_OFFLINE switch).
    """

    def __init__(self, limit: int, path: Path | None = None,
                 clock: Callable[[], datetime] | None = None) -> None:
        if limit < 0:
            raise ValueError("limit must be zero or more")
        self._limit = int(limit)
        self._path = path
        self._clock = clock or datetime.now
        self._lock = threading.RLock()   # re-entrant: snapshot() reads helpers that take the lock
        self._day = ""
        self._used = 0
        self._unreadable = False
        self._save_failed = False
        self._stopped_at: datetime | None = None   # Google's 429: offline until midnight Pacific
        self._load()

    # ----- public -----

    @property
    def offline(self) -> bool:
        """True when no call may go to the internet (Google's 429, or the owner's switch)."""
        with self._lock:
            self._roll_locked()
            return offline_requested() or bool(self._stopped_at)

    def offline_reason(self) -> str:
        with self._lock:
            return self._offline_reason_locked()

    def _offline_reason_locked(self) -> str:
        """The reason in plain words. Callers must already hold the lock."""
        self._roll_locked()
        if offline_requested():
            return "you switched the app offline yourself (SUPPER_OFFLINE)"
        if self._stopped_at:
            return f"Google answered 429 at {self._stopped_at:%H:%M} — its own quota, not this app's count"
        return ""

    def try_spend(self) -> bool:
        """Count one unit for a call that is about to reach Gemini.

        False ONLY when the app is offline — Google refused every key today, or
        the owner asked for no internet. The count itself never refuses: it warns.
        Nothing is counted for a call that is not made.
        """
        with self._lock:
            self._roll_locked()
            if offline_requested() or self._stopped_at:
                return False
            self._used += 1
            self._save_locked()
            return True

    @property
    def past_warn(self) -> bool:
        with self._lock:
            self._roll_locked()
            return self._limit > 0 and self._used >= self._limit

    def warn(self) -> str:
        """The warning line for the terminal / diagnostics. Empty when under the level."""
        with self._lock:
            self._roll_locked()
            if self._limit <= 0 or self._used < self._limit:
                return ""
            return (f"⚠ {self._used} Gemini call{'s' if self._used != 1 else ''} today — at or past your "
                    f"warning level of {self._limit}. The call still goes through: this count never blocks, "
                    f"only Google can.")

    def mark_exhausted(self) -> None:
        """Google answered 429: offline until midnight Pacific. The chat carries on locally."""
        with self._lock:
            self._roll_locked()
            if not self._stopped_at:
                self._stopped_at = self._clock()
            self._save_locked()

    def clear_exhausted(self) -> None:
        """A new key was added (or the owner says try again): give the internet another go."""
        with self._lock:
            self._roll_locked()
            self._stopped_at = None
            self._save_locked()

    def snapshot(self) -> dict:
        with self._lock:
            self._roll_locked()
            offline = offline_requested() or bool(self._stopped_at)
            return {
                "day": self._day,
                "used": self._used,
                # `limit`/`remaining` keep their old names for the UI, but the
                # number is now the WARNING level, not a ceiling on calls.
                "limit": self._limit,
                "remaining": max(0, self._limit - self._used),
                "enabled": True,                     # the count never turns calls off
                "warn_at": self._limit,
                "past_warn": self._limit > 0 and self._used >= self._limit,
                "unreadable": self._unreadable,
                "saved": not self._save_failed,
                "offline": offline,
                "offline_reason": self._offline_reason_locked(),
                "resets": "local midnight",
                "note": ("This app's own count. It warns and never blocks; only a real 429 from Google "
                         "puts the app offline, and offline only stops internet calls — never the chat. "
                         "Google's real limit differs by model; check AI Studio."),
            }

    # ----- internals -----

    def _today(self) -> str:
        return self._clock().date().isoformat()

    def _load(self) -> None:
        self._day = self._today()
        self._used = 0
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            day = str(data["day"])
            used = int(data["used"])
        except Exception:
            self._unreadable = True          # counting continues in memory; nothing is blocked
            return
        if day == self._day:
            self._used = max(0, used)
        # Google's stop is read REGARDLESS of the count's local day: it ends at
        # midnight Pacific, which is hours after our own midnight — dropping it
        # at a local-day change is exactly the nine-hours-early bug.
        stopped = data.get("google_stopped")
        if isinstance(stopped, dict):
            # The dashboard's per-key shape: {1: {...}, 2: {...}} — offline when
            # every key it holds was refused. A bare ISO string is accepted too.
            entries = [v for v in stopped.values() if v]
            if entries and all(entries):
                first = entries[0]
                at = first.get("at") if isinstance(first, dict) else str(first)
                self._stopped_at = self._parse_stamp(at) or self._clock()
        elif isinstance(stopped, str) and stopped:
            self._stopped_at = self._parse_stamp(stopped) or self._clock()
        if self._stopped_at and not self._stop_live_locked():
            self._stopped_at = None

    @staticmethod
    def _parse_stamp(value) -> datetime | None:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None

    def _roll_locked(self) -> None:
        today = self._today()
        if today != self._day:
            self._day = today                # the COUNT is this computer's day
            self._used = 0
            self._unreadable = False
        # The STOP is Google's day: it ends at midnight Pacific — which for the
        # owner (UTC+2) is nine hours AFTER this computer's midnight. Carrying
        # it across the local day is the whole point of the fix.
        if self._stopped_at and not self._stop_live_locked():
            self._stopped_at = None

    @staticmethod
    def _pacific_day(dt: datetime) -> str:
        """The calendar date in Pacific time — the day Google's quota runs on."""
        if dt.tzinfo is None:
            dt = dt.astimezone()              # a naive stamp means this computer's clock
        return dt.astimezone(_PACIFIC).date().isoformat()

    def _stop_live_locked(self) -> bool:
        """True while the recorded 429 belongs to the current Pacific day."""
        if not self._stopped_at:
            return False
        return self._pacific_day(self._stopped_at) == self._pacific_day(self._clock())

    def _save_locked(self) -> None:
        if self._path is None or self._unreadable:
            return                            # never overwrite a file we could not read
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            payload: dict = {"day": self._day, "used": self._used}
            if self._stopped_at:
                # Written in the shape the dashboard reads, so both sides of the
                # app agree that Google stopped us today.
                payload["google_stopped"] = {"1": {"at": self._stopped_at.isoformat(),
                                                   "reason": "quota", "detail": ""}}
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            os.replace(tmp, self._path)
            self._save_failed = False
        except OSError:
            self._save_failed = True          # counting continues in memory; diagnostics shows it
