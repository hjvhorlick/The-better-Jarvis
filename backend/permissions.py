"""Permission tiers for actions, and the confirmation queue behind CONFIRM actions.

  SAFE      runs without asking
  CONFIRM   runs only when the owner approves this specific request
  BLOCKED   never runs from the browser interface

Unknown actions are denied (default deny). A confirmation request holds the action
until the owner answers it, and expires if they do not (default 120 seconds).

Desktop-only actions (owner decision, 2026-10-09) will get their own policy when they
are ported. Autonomous self-modification is not an action at all: it is blocked.

Provenance: written for this project from the audit's permission requirements
(docs/AUDIT_STAGE_A.md §8, feature 36). No code taken from other projects.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable


class Tier(str, Enum):
    SAFE = "safe"
    CONFIRM = "confirm"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    needs_confirmation: bool
    reason: str


class PermissionPolicy:
    def __init__(self) -> None:
        self._tiers: dict[str, Tier] = {}

    def register(self, action: str, tier: Tier) -> None:
        if not action or not isinstance(action, str):
            raise ValueError("action name is required")
        if action in self._tiers:
            raise ValueError(f"action already registered: {action}")
        self._tiers[action] = Tier(tier)

    def tier_of(self, action: str) -> Tier:
        return self._tiers.get(action, Tier.BLOCKED)

    def decide(self, action: str, confirmed: bool = False) -> Decision:
        tier = self.tier_of(action)
        if tier is Tier.BLOCKED:
            if action in self._tiers:
                return Decision(False, False, "blocked by policy")
            return Decision(False, False, "unknown action")
        if tier is Tier.CONFIRM and not confirmed:
            return Decision(False, True, "needs confirmation")
        return Decision(True, False, "allowed")

    def table(self) -> list[dict]:
        """Read-only view for the permissions panel. Sorted by tier, then name."""
        order = {Tier.SAFE: 0, Tier.CONFIRM: 1, Tier.BLOCKED: 2}
        rows = sorted(self._tiers.items(), key=lambda kv: (order[kv[1]], kv[0]))
        return [{"action": a, "tier": t.value} for a, t in rows]


def default_policy() -> PermissionPolicy:
    """Browser policy: the router's actions, plus the two explicit prohibitions."""
    p = PermissionPolicy()
    # Local, read-only or self-limiting actions (the router's rules use these).
    p.register("time.now", Tier.SAFE)
    p.register("time.date", Tier.SAFE)
    p.register("status.read", Tier.SAFE)
    p.register("files.roots", Tier.SAFE)
    p.register("files.open_root", Tier.SAFE)
    p.register("help.list", Tier.SAFE)
    p.register("myhands.stop", Tier.SAFE)          # turning the camera off is always allowed
    p.register("myhands.start", Tier.CONFIRM)      # turning the camera on needs the owner's OK
    # Voice (V2-3). Turning the microphone or the wake listener on needs the owner's OK.
    # Stopping, muting and unmuting are always allowed.
    p.register("voice.stop", Tier.SAFE)
    p.register("voice.mute", Tier.SAFE)
    p.register("voice.unmute", Tier.SAFE)
    p.register("voice.wake_off", Tier.SAFE)
    # The audio self-test plays a beep and listens on this computer only; nothing leaves it.
    p.register("voice.test", Tier.SAFE)
    p.register("memory.search_archive", Tier.SAFE)   # read-only, local
    p.register("memory.restore", Tier.CONFIRM)       # changes long_term.json, so it asks each time
    p.register("repair.list", Tier.SAFE)             # read-only list of snapshots
    # A web search is one Gemini request with only the owner's query, the same as a chat message.
    p.register("web.search", Tier.SAFE)
    p.register("memory.recall", Tier.SAFE)           # read-only: answers from stored facts, no network
    p.register("brain.remember", Tier.SAFE)          # explicit owner request, local memory only
    p.register("brain.correct", Tier.SAFE)           # explicit owner correction, local memory only
    p.register("brain.forget", Tier.CONFIRM)         # removal from active memory needs approval
    p.register("brain.decision", Tier.SAFE)          # explicit owner-stated project decision
    p.register("brain.goal", Tier.SAFE)              # explicit owner-stated topic goal
    p.register("brain.next_step", Tier.SAFE)         # explicit owner-stated next step
    p.register("brain.task", Tier.SAFE)              # explicit local task creation
    p.register("knowledge.list", Tier.SAFE)         # read-only list of local answers
    p.register("knowledge.teach", Tier.SAFE)        # the owner asked for it directly; can be forgotten
    p.register("knowledge.forget", Tier.SAFE)       # moves the entry to the archive; nothing is deleted
    p.register("reminder.add", Tier.SAFE)            # local, reversible: a note shown when due
    p.register("reminder.list", Tier.SAFE)
    p.register("reminder.cancel", Tier.CONFIRM)      # removes something the owner set
    p.register("repair.notices", Tier.SAFE)          # read-only list of errors the assistant noticed
    # Drafting a fix sends the text of the named project files to Gemini, so it asks first.
    # The draft itself still needs the owner's approval before anything changes.
    p.register("repair.propose", Tier.CONFIRM)
    p.register("repair.rollback_last", Tier.CONFIRM) # restores files from a snapshot
    # Labels used by the confirmation queue for self-repair (never reached from the browser):
    p.register("repair.apply", Tier.CONFIRM)
    p.register("repair.rollback", Tier.CONFIRM)
    p.register("voice.start", Tier.CONFIRM)
    # Phone pairing (V2-6). Letting a phone in asks first. Listing and forgetting are safe.
    p.register("pairing.start", Tier.CONFIRM)
    p.register("pairing.list", Tier.SAFE)
    p.register("pairing.revoke", Tier.SAFE)      # taking a phone's access away is always allowed
    p.register("pairing.approve", Tier.CONFIRM)  # letting a phone approve actions: asks here, on the computer
    p.register("pairing.unapprove", Tier.SAFE)   # taking that permission away is always allowed
    p.register("voice.wake", Tier.CONFIRM)
    # Ported skills (V2-5). Each skill declares its own tier in backend/skills/.
    from .skills import ALL_SKILLS
    for skill in ALL_SKILLS:
        p.register(skill.action, skill.tier)
    # Explicit prohibitions (master prompt; audit §8).
    p.register("shell.run", Tier.BLOCKED)          # unrestricted execution: never from the browser
    p.register("code.self_modify", Tier.BLOCKED)   # no autonomous self-modification
    return p


class ConfirmationError(LookupError):
    """No pending confirmation with that id: unknown, expired, or already answered."""


class TooManyPending(RuntimeError):
    pass


@dataclass
class _Pending:
    id: str
    action: str
    summary: str
    expires_at: float
    run: Callable[[], str]


class ConfirmationStore:
    """Holds CONFIRM actions until the owner approves or denies them.

    `run` is called only on approval, and only once. The result text is what the
    owner sees. Events go on the bus with source "permissions":
    confirm_requested, confirm_resolved (status: approved, denied, failed or expired).
    """

    def __init__(self, bus=None, ttl_s: float = 120.0, max_pending: int = 10,
                 clock: Callable[[], float] = time.time) -> None:
        self._bus = bus
        self._ttl = float(ttl_s)
        self._max = int(max_pending)
        self._clock = clock
        self._items: dict[str, _Pending] = {}
        self._lock = threading.Lock()

    def request(self, action: str, summary: str, run: Callable[[], str]) -> dict:
        if not action or not summary or not callable(run):
            raise ValueError("action, summary and run are required")
        with self._lock:
            self._purge_locked()
            if len(self._items) >= self._max:
                raise TooManyPending("too many confirmations waiting; answer some first")
            item = _Pending(secrets.token_urlsafe(9), action, summary,
                            self._clock() + self._ttl, run)
            self._items[item.id] = item
        view = self._view(item)
        self._publish("confirm_requested", view)
        return view

    def pending(self) -> list[dict]:
        with self._lock:
            self._purge_locked()
            return [self._view(p) for p in self._items.values()]

    def resolve(self, cid: str, approve: bool) -> dict:
        with self._lock:
            self._purge_locked()
            item = self._items.pop(cid, None)
        if item is None:
            raise ConfirmationError("no such pending confirmation")
        if not approve:
            self._publish("confirm_resolved", {"id": cid, "action": item.action, "status": "denied"})
            return {"id": cid, "action": item.action, "status": "denied", "result": "Cancelled."}
        try:
            result = str(item.run())
            status = "approved"
        except Exception as e:  # report the kind of failure, not the message
            result = f"The action failed ({type(e).__name__})."
            status = "failed"
        self._publish("confirm_resolved", {"id": cid, "action": item.action, "status": status})
        return {"id": cid, "action": item.action, "status": status, "result": result}

    # ----- internals -----

    def _purge_locked(self) -> None:
        now = self._clock()
        for cid in [c for c, p in self._items.items() if p.expires_at <= now]:
            item = self._items.pop(cid)
            self._publish("confirm_resolved", {"id": cid, "action": item.action, "status": "expired"})

    def _view(self, p: _Pending) -> dict:
        return {"id": p.id, "action": p.action, "summary": p.summary, "expires_at": p.expires_at}

    def _publish(self, kind: str, data: dict) -> None:
        if self._bus is not None:
            self._bus.publish("permissions", {"type": kind, **data})
