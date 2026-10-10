"""What self-repair may and may not change. Essential sections are refused outright, not just warned about.

Owner decisions (2026-10-09, docs/SELF_REPAIR.md): ask first; keep snapshots; keep the essential
sections out of reach. Protected means refused: a proposal that names one is never trialled or applied.
"""
from __future__ import annotations

from pathlib import PurePosixPath

# Where self-repair may write. Everything else in the project is out of reach.
ALLOWED_ROOTS = ("backend/", "web/", "tests/", "tools/", "myhands/")

# Essential sections. Self-repair never changes these.
PROTECTED_EXACT = frozenset({
    "core/prompt.txt",          # the personality, which the owner is reworking
    "backend/permissions.py",   # confirmations and the permission tiers
    "backend/config.py",        # where keys and settings are read
    "backend/chat.py",          # the Gemini client and key handling
    "backend/quota.py",         # the daily budget
    "update_mechanic.py",       # legacy: overwrites the prompt (disabled)
    "main.py", "ui.py",         # legacy app (frozen)
})
PROTECTED_PREFIXES = (
    "memory/",       # persistent memory and its code
    "config/",       # saved settings and keys
    "backend/repair/",  # this package: the rules, the snapshots and the rollback
    "runtime/",      # snapshots, logs and counters
    ".git/",
)

# Allowed, but a change here needs a warning that says why.
HIGH_RISK_EXACT = frozenset({"backend/agent.py", "backend/app.py", "backend/router.py"})
HIGH_RISK_PREFIXES = ("backend/voice/", "myhands/")

MAX_FILES = 20
MAX_TOTAL_BYTES = 300_000


class RepairRefused(ValueError):
    """The proposal breaks a rule. Nothing is trialled or changed."""


def check_path(path: str) -> str:
    if not isinstance(path, str) or not path:
        raise RepairRefused("a file name is missing")
    if path.startswith("/") or "\\" in path or ":" in path.split("/")[0]:
        raise RepairRefused(f"{path!r} is not a path inside the project")
    parts = PurePosixPath(path).parts
    if not parts or any(part in ("..", ".", "") for part in parts) or str(PurePosixPath(*parts)) != path:
        raise RepairRefused(f"{path!r} is not a plain path inside the project")
    if path in PROTECTED_EXACT or path.startswith(PROTECTED_PREFIXES):
        raise RepairRefused(f"{path} is an essential section. Self-repair does not change it.")
    if "__pycache__" in parts:
        raise RepairRefused(f"{path} is a generated file, not source")
    if not path.startswith(ALLOWED_ROOTS):
        raise RepairRefused(f"{path} is outside the areas self-repair may change")
    return path


def validate(files) -> dict[str, str]:
    """Check a proposal of {path: new full text}. Returns a clean copy or raises RepairRefused."""
    if not isinstance(files, dict) or not files:
        raise RepairRefused("the proposal has no files")
    if len(files) > MAX_FILES:
        raise RepairRefused(f"too many files in one proposal (limit {MAX_FILES})")
    clean: dict[str, str] = {}
    total = 0
    for path, text in files.items():
        check_path(path)
        if not isinstance(text, str):
            raise RepairRefused(f"the new text for {path} must be text")
        total += len(text.encode("utf-8"))
        clean[path] = text
    if total > MAX_TOTAL_BYTES:
        raise RepairRefused(f"the proposal is too large (limit {MAX_TOTAL_BYTES} bytes)")
    return clean


def classify(paths: list[str], existing: set[str]) -> tuple[str, list[str]]:
    """Return (level, warnings). Levels: low, medium, high."""
    level = "low"
    warnings: list[str] = []
    high = [p for p in paths if p in HIGH_RISK_EXACT or p.startswith(HIGH_RISK_PREFIXES)]
    if high:
        level = "high"
        warnings.append("This touches the core of the assistant (" + ", ".join(high) + "). "
                        "A mistake here can stop the app from starting. A snapshot is taken first.")
    deps = [p for p in paths if PurePosixPath(p).name.startswith("requirements")]
    if deps:
        if level == "low":
            level = "medium"
        warnings.append("This changes the list of libraries (" + ", ".join(deps) + "). "
                        "A new library is code you have not reviewed.")
    new = [p for p in paths if p not in existing]
    if new:
        if level == "low":
            level = "medium"
        warnings.append("This adds new file(s): " + ", ".join(new) + ".")
    if len(paths) > 3 and level == "low":
        level = "medium"
        warnings.append(f"This changes {len(paths)} files at once.")
    return level, warnings
