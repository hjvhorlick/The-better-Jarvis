"""Daily budget for Gemini calls made by this app.

This is the app's own counter. It is NOT Google's quota. Google's free-tier limits
differ by model and project and can change, so the owner sets the budget
(SUPPER_GEMINI_DAILY_BUDGET, default 20: the lowest free-tier daily figure reported
for current Flash models when this was written). Check the real limit in Google AI
Studio and set the budget to match.

Rules:
  * Each call that will reach Gemini takes one unit before it is sent. Failed calls
    count too, because the provider may still have counted them.
  * The count resets at local midnight. Google resets its own daily quota at midnight
    Pacific time, so the two can differ by a few hours.
  * The count is kept in runtime/quota.json (git-ignored). If that file exists but
    cannot be read, the budget is treated as used up until local midnight (fail closed),
    so a damaged file can never allow unlimited calls.
  * A 429 from Gemini marks the budget as used up for the day.

Provenance: written for this project. No code taken from other projects.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable


class DailyBudget:
    def __init__(self, limit: int, path: Path | None = None,
                 clock: Callable[[], datetime] | None = None) -> None:
        if limit < 0:
            raise ValueError("limit must be zero or more")
        self._limit = int(limit)
        self._path = path
        self._clock = clock or datetime.now
        self._lock = threading.Lock()
        self._day = ""
        self._used = 0
        self._unreadable = False
        self._save_failed = False
        self._load()

    # ----- public -----

    def try_spend(self) -> bool:
        """Take one unit for a call that is about to reach Gemini. False if none is left."""
        with self._lock:
            self._roll_locked()
            if self._limit == 0 or self._used >= self._limit or self._unreadable:
                return False
            self._used += 1
            self._save_locked()
            return True

    def mark_exhausted(self) -> None:
        """Gemini reported its limit is reached: no more calls today."""
        with self._lock:
            self._roll_locked()
            self._used = self._limit
            self._save_locked()

    def snapshot(self) -> dict:
        with self._lock:
            self._roll_locked()
            return {
                "day": self._day,
                "used": self._used,
                "limit": self._limit,
                "remaining": max(0, self._limit - self._used) if not self._unreadable else 0,
                "enabled": self._limit > 0,
                "unreadable": self._unreadable,
                "saved": not self._save_failed,
                "resets": "local midnight",
                "note": "This app's own count. Google's real limit differs by model; check AI Studio.",
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
            self._unreadable = True          # fail closed until the next local day
            return
        if day == self._day:
            self._used = max(0, used)

    def _roll_locked(self) -> None:
        today = self._today()
        if today != self._day:
            self._day = today
            self._used = 0
            self._unreadable = False

    def _save_locked(self) -> None:
        if self._path is None or self._unreadable:
            return                            # never overwrite a file we could not read
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"day": self._day, "used": self._used}), encoding="utf-8")
            os.replace(tmp, self._path)
            self._save_failed = False
        except OSError:
            self._save_failed = True          # counting continues in memory; diagnostics shows it
