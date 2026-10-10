"""Diagnostics: what is running, what is using which device, and recent problems.

Never returns secret values or file paths. The Gemini key is reported only as a
yes/no flag. Problem events are the last few events whose type signals a fault.
"""
from __future__ import annotations

from . import __version__, config, files
from .events import EventBus

PROBLEM_TYPES = {"tracking_unavailable", "error", "device_error", "voice_error"}
# A session that stopped because of a fault, not because the user or idle timer stopped it.
FAULT_STOP_REASONS = {"camera_failed", "tracker_failed"}


def _is_problem(e: dict) -> bool:
    if e["type"] in PROBLEM_TYPES:
        return True
    return e["type"] == "session_stopped" and e.get("reason") in FAULT_STOP_REASONS


def build(bus: EventBus, devices, myhands_session, chat, myhands_available: bool,
          budget=None, confirmations=None, policy=None, voice=None) -> dict:
    problems = [
        {
            "seq": s,
            "source": e["source"],
            "type": e["type"],
            "message": e.get("reason") or e.get("message", ""),
        }
        for s, e in bus.since(0)
        if _is_problem(e)
    ][-10:]
    return {
        "version": __version__,
        "api_key_configured": config.get_gemini_api_key() is not None,
        "text_model": chat.model,
        "file_roots_available": len(files.get_roots()),
        "bus": {"last_seq": bus.last_seq, "oldest_seq": bus.oldest_seq, "capacity": bus.capacity},
        "devices": devices.snapshot(),
        "myhands": {**myhands_session.status(), "tracker_available": myhands_available},
        "gemini_budget": budget.snapshot() if budget is not None else None,
        "confirmations_pending": len(confirmations.pending()) if confirmations is not None else 0,
        "permissions": policy.table() if policy is not None else [],
        "voice": voice.status() if voice is not None else None,
        "recent_problems": problems,
    }
