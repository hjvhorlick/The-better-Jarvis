"""Reminders (V2-5). Ported from the legacy `actions/reminder.py` (feature: reminders at a set time).

Legacy behaviour kept: the owner asks for a reminder at a time, and it shows up when the time comes.
What changed, and why:
  * The legacy code asked the operating system to run a notification at the time (Windows Task Scheduler,
    macOS and Linux schedulers). That is three platform-specific code paths, and it does not work the same
    way on each. This version keeps the reminders in a file in the runtime folder, and a timer inside the
    app shows each one in the chat when it is due. It works the same on Windows, Linux and macOS.
  * Limit: a reminder fires only while the app is running. If the app was off when a reminder was due, it
    fires on the next start and says that it was late.
  * Reminders live in `runtime/reminders.json`, not in the memory files. Nothing here touches memory.

Tiers (backend/permissions.py): adding and listing are SAFE (local, reversible, the owner asked for it).
Cancelling is CONFIRM, because it removes something the owner set.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

MAX_PENDING = 50
MAX_TEXT_CHARS = 200
MAX_MINUTES = 7 * 24 * 60
POLL_S = 5.0

_IN = re.compile(r"^remind me in (?P<n>\d{1,6}) (?P<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?) to (?P<text>.+)$",
                 re.IGNORECASE | re.DOTALL)
_AT = re.compile(r"^remind me (?P<day>tomorrow )?at (?P<h>\d{1,2})(?:[:.](?P<m>\d{2}))?\s*(?P<ap>am|pm)? to (?P<text>.+)$",
                 re.IGNORECASE | re.DOTALL)
_CANCEL = re.compile(r"^(cancel|delete|remove) reminder (?P<id>[a-z0-9]{1,12})$", re.IGNORECASE)


class BadReminder(ValueError):
    """The reminder request could not be understood or is not allowed. The text is safe to show."""


def clean_text(raw: str) -> str:
    text = " ".join((raw or "").split())
    if not text:
        raise BadReminder("Sir, what should I remind you about?")
    if len(text) > MAX_TEXT_CHARS:
        raise BadReminder("Sir, that reminder is too long. Keep it under 200 characters.")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in text):
        raise BadReminder("Sir, that reminder contains characters I cannot use.")
    return text


def parse(raw: str, now: datetime) -> tuple[datetime, str]:
    """Return (when it is due, what to say). Raises BadReminder if the text is not a supported form."""
    s = " ".join((raw or "").split())
    m = _IN.match(s)
    if m:
        n, unit = int(m.group("n")), m.group("unit").lower()
        seconds = n * (1 if unit.startswith("sec") else 60 if unit.startswith("min") else 3600)
        if n <= 0:
            raise BadReminder("Sir, a reminder needs a time at least one unit ahead.")
        if seconds > MAX_MINUTES * 60:
            raise BadReminder("Sir, I can set reminders up to seven days ahead.")
        return now + timedelta(seconds=seconds), clean_text(m.group("text"))
    m = _AT.match(s)
    if m:
        hour, minute = int(m.group("h")), int(m.group("m") or 0)
        ap = (m.group("ap") or "").lower()
        if ap:
            if not 1 <= hour <= 12:
                raise BadReminder("Sir, that is not a valid time.")
            hour = hour % 12 + (12 if ap == "pm" else 0)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise BadReminder("Sir, that is not a valid time.")
        due = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if m.group("day"):
            due += timedelta(days=1)
        elif due <= now:
            due += timedelta(days=1)                      # "at 9" after 9 means tomorrow
        return due, clean_text(m.group("text"))
    raise BadReminder("Sir, I can set a reminder in N minutes, at a time (for example 'at 15:30'), "
                      "or tomorrow at a time, like: remind me at 15:30 to call the bank.")


def cancel_id(raw: str) -> str:
    m = _CANCEL.match(" ".join((raw or "").split()))
    if not m:
        raise BadReminder("Sir, say: cancel reminder <number>.")
    return m.group("id").lower()


class Reminders:
    def __init__(self, path: Path, bus=None, clock=datetime.now) -> None:
        self._path = Path(path)
        self._bus = bus
        self._clock = clock
        self._lock = threading.Lock()
        self._items: list[dict] | None = None             # loaded lazily
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ----- store -----

    def _load(self) -> list[dict]:
        if self._items is None:
            if self._path.exists():
                try:
                    data = json.loads(self._path.read_text(encoding="utf-8"))
                    self._items = [i for i in data if isinstance(i, dict)] if isinstance(data, list) else []
                except (OSError, ValueError):
                    # Unreadable: keep the file as a copy, and start empty. Nothing is lost silently.
                    self._path.rename(self._path.with_name(f"{self._path.name}.corrupt-{int(time.time())}"))
                    self._items = []
            else:
                self._items = []
        return self._items

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(self._items, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)

    # ----- owner actions -----

    def add(self, raw: str) -> dict:
        now = self._clock()
        due, text = parse(raw, now)
        with self._lock:
            items = self._load()
            if len(items) >= MAX_PENDING:
                raise BadReminder(f"Sir, there are already {MAX_PENDING} reminders waiting. Cancel some first.")
            item = {"id": uuid.uuid4().hex[:6], "text": text,
                    "due": due.isoformat(timespec="seconds"), "created": now.isoformat(timespec="seconds")}
            items.append(item)
            self._save()
        return item

    def pending(self) -> list[dict]:
        with self._lock:
            return sorted((dict(i) for i in self._load()), key=lambda i: i["due"])

    def cancel(self, rid: str) -> dict:
        with self._lock:
            items = self._load()
            for i, item in enumerate(items):
                if item.get("id") == rid:
                    removed = items.pop(i)
                    self._save()
                    return removed
        raise BadReminder(f"Sir, there is no reminder with number {rid}.")

    # ----- firing -----

    def due_now(self) -> list[dict]:
        """Remove and return the reminders that are due. Each fires once."""
        now = self._clock()
        with self._lock:
            items = self._load()
            fired = [i for i in items if datetime.fromisoformat(i["due"]) <= now]
            if fired:
                self._items = [i for i in items if i not in fired]
                self._save()
        return sorted(fired, key=lambda i: i["due"])

    def tick(self) -> int:
        fired = self.due_now()
        now = self._clock()
        for item in fired:
            due = datetime.fromisoformat(item["due"])
            late = now - due > timedelta(minutes=1)
            when = due.strftime("%H:%M")
            text = f"Reminder: {item['text']}" + (f" (this was due at {when}; the app was not running)" if late else "")
            if self._bus is not None:
                try:
                    self._bus.publish("assistant", {"type": "notice", "kind": "reminder", "text": text,
                                                    "tag": "reminder", "id": item["id"]})
                except Exception:
                    pass
        return len(fired)

    def start(self) -> None:
        """Start the timer thread (once). Called at app start-up, not at import."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="reminders", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                pass                                       # a bad file must not stop the timer; it is retried
            self._stop.wait(POLL_S)


def describe(items: list[dict]) -> str:
    if not items:
        return "You have no reminders waiting, sir."
    parts = []
    for i in items[:10]:
        when = datetime.fromisoformat(i["due"]).strftime("%a %d %b %H:%M")
        parts.append(f"#{i['id']} {when}: {i['text']}")
    more = f" (and {len(items) - 10} more)" if len(items) > 10 else ""
    return "Reminders waiting: " + " | ".join(parts) + more + "."
