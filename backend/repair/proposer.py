"""Ask the model for a fix, and read its answer. The answer is only a proposal: it goes through the
same rules, trial and owner approval as any other change (backend/repair/engine.py).

What the model sees: the request, and the current text of the project files the request names (only
files self-repair may change). Never memory, settings, keys, the personality prompt, or the repair code.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import policy

SYSTEM = (
    "You are the repair assistant of a small Python and JavaScript project. You are given a request and "
    "the current text of some project files. Reply with ONLY one JSON object and no other text: "
    '{"reason": "one plain sentence saying what changes and why", '
    '"files": {"<path>": "<the complete new text of that file>"}}. '
    "Rules: change only the files you were given; give the complete new text of every changed file; "
    "keep the change small and explain it plainly; never change memory, settings, keys, or the personality "
    "prompt. If you cannot make a safe change, reply with "
    '{"reason": "<why not>", "files": {}}.'
)

NAMED_FILE = re.compile(r"[A-Za-z0-9_./\-]+\.(?:py|js|cjs|html|css|md|txt|json)")
MAX_CONTEXT_BYTES = 60_000


class ProposalError(ValueError):
    """The model's answer could not be read as a proposal."""


def context_files(repo: Path, request: str, max_bytes: int = MAX_CONTEXT_BYTES) -> dict[str, str]:
    """Current text of the allowed files that the request names. Anything else is left out."""
    named = []
    for token in NAMED_FILE.findall(request or ""):
        rel = token.replace("\\", "/").lstrip("./")
        try:
            policy.check_path(rel)
        except policy.RepairRefused:
            continue
        if (Path(repo) / rel).is_file():
            named.append(rel)
    out: dict[str, str] = {}
    total = 0
    for rel in dict.fromkeys(named):
        text = (Path(repo) / rel).read_text(encoding="utf-8", errors="replace")
        if total + len(text) > max_bytes:
            break
        out[rel] = text
        total += len(text)
    return out


def build_prompt(request: str, files: dict[str, str]) -> str:
    parts = [f"Request: {request}", "", "Current files:"]
    if not files:
        parts.append("(no file named in the request was found in the areas self-repair may change)")
    for rel, text in files.items():
        parts += [f"--- {rel} ---", text, f"--- end of {rel} ---"]
    return "\n".join(parts)


def parse(answer: str) -> tuple[str, dict]:
    text = (answer or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0].strip()
    try:
        obj = json.loads(text)
    except ValueError:
        raise ProposalError("the reply was not valid JSON") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("reason"), str) \
            or not isinstance(obj.get("files"), dict):
        raise ProposalError("the reply did not have the expected reason and files")
    return obj["reason"].strip(), obj["files"]
