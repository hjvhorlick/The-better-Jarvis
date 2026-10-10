"""Errors the assistant notices in its own code (owner decision: repair starts from errors it notices,
always with approval). See docs/SELF_REPAIR.md §5c.

What is kept, and why:
  * the kind of error, the project file and the line where it happened. Nothing else;
  * NOT the error message. Messages can contain private text or keys.

A notice is raised only for a file the self-repair rules allow the assistant to change. An error in
protected code (for example the repair code itself) is not offered, because a fix would be refused.
Repeats of the same error within a few minutes are not shown again, so a loop cannot flood the chat.
Nothing is changed by noticing. The owner must still ask for a fix, and approve it.
"""
from __future__ import annotations

import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from . import policy

KEEP = 20
LIBRARY_DIRS = {".venv", "venv", "node_modules", ".git"}
REPEAT_WINDOW_S = 300.0


class Notices:
    def __init__(self, repo_root: Path, bus=None, clock=time.time,
                 repeat_window_s: float = REPEAT_WINDOW_S, keep: int = KEEP) -> None:
        self.repo = Path(repo_root).resolve()
        self._bus = bus
        self._clock = clock
        self._window = repeat_window_s
        self._keep = keep
        self._items: list[dict] = []
        self._last_seen: dict[tuple, float] = {}
        self._next_id = 1
        self._lock = threading.Lock()

    def record(self, exc: BaseException) -> dict | None:
        """Note an error if it happened in a project file the assistant may change. Returns the notice or None."""
        spot = self._project_spot(exc)
        if spot is None:
            return None
        rel, line, where = spot
        kind = type(exc).__name__
        key = (rel, line, kind)
        now = self._clock()
        with self._lock:
            last = self._last_seen.get(key)
            if last is not None and now - last < self._window:
                return None
            self._last_seen[key] = now
            item = {"id": self._next_id, "file": rel, "line": line, "where": where, "error": kind,
                    "time": datetime.fromtimestamp(now).isoformat(timespec="seconds")}
            self._next_id += 1
            self._items.append(item)
            del self._items[:-self._keep]
        self._publish(item)
        return item

    def recent(self) -> list[dict]:
        with self._lock:
            return list(self._items)

    def message(self, item: dict) -> str:
        return (f"Sir, I noticed an error in {item['file']} (line {item['line']}, {item['error']}). "
                f"Nothing has been changed. If you want it fixed, say: "
                f"propose a fix for {item['file']}: <what to change>. I will ask before anything is sent or changed.")

    def _project_spot(self, exc: BaseException):
        """The innermost frame that is the project's own code, or None.

        Libraries (the virtual environment, the standard library) are skipped, so an error inside a library
        called by our code is reported at our code. If that project frame is protected, nothing is noted."""
        frames = traceback.extract_tb(exc.__traceback__)
        for frame in reversed(frames):
            try:
                rel = Path(frame.filename).resolve().relative_to(self.repo).as_posix()
            except (ValueError, OSError):
                continue                                    # outside the project folder
            if rel.split("/", 1)[0] in LIBRARY_DIRS:
                continue
            try:
                policy.check_path(rel)
            except policy.RepairRefused:
                return None                                 # protected or outside the allowed areas
            return rel, frame.lineno, frame.name
        return None

    def _publish(self, item: dict) -> None:
        if self._bus is not None:
            try:
                self._bus.publish("assistant", {"type": "notice", "kind": "error",
                                                "text": self.message(item), "tag": "repair", "notice": item})
            except Exception:
                pass                                        # a broken bus must not hide the notice
