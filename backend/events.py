"""Shared event bus: one sequenced, bounded, replayable stream for the whole app.

Every module publishes here instead of talking to the others directly. The browser
(via /ws/events) and the agent read the same stream, so both see the same state.

  publish(source, event) -> seq          events are copied; `source` is added
  since(seq, source=None) -> [(seq, ev)] everything after `seq`, oldest first

Each event carries "at" (wall-clock seconds, set by the bus). A module may also set
its own "t" in its own time base; the bus never rewrites it.
"""
from __future__ import annotations

import collections
import threading
import time
from typing import Callable


class EventBus:
    def __init__(self, capacity: int = 2000, clock: Callable[[], float] = time.time) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._capacity = capacity
        self._clock = clock
        self._lock = threading.Lock()
        self._events: collections.deque = collections.deque(maxlen=capacity)
        self._seq = 0

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq

    @property
    def oldest_seq(self) -> int | None:
        """Oldest sequence number still held. Older events have been dropped."""
        with self._lock:
            return self._events[0][0] if self._events else None

    def publish(self, source: str, event: dict) -> int:
        if not isinstance(source, str) or not source:
            raise ValueError("source must be a non-empty string")
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise ValueError("event must be a dict with a string 'type'")
        item = dict(event)
        item["source"] = source
        item["at"] = round(self._clock(), 3)
        with self._lock:
            self._seq += 1
            self._events.append((self._seq, item))
            return self._seq

    def since(self, seq: int = 0, source: str | None = None) -> list[tuple[int, dict]]:
        with self._lock:
            out = [(s, dict(e)) for (s, e) in self._events if s > seq]
        if source is not None:
            out = [(s, e) for (s, e) in out if e["source"] == source]
        return out
