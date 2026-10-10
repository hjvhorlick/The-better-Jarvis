"""Local knowledge: answers the assistant can give without Gemini.

Four kinds of entry, all in one file (runtime/knowledge.json, git-ignored):
  starter  written by the assistant for common tasks in coding, marketing, design and
           everyday life (knowledge/starter.json). Marked "please check" in the reply.
           Never expires. Loaded once; if the owner forgets one it stays forgotten.
  owner    taught by the owner with "learn: <question> = <answer>". Never expires.
  gemini   an answer Gemini gave earlier, kept so the same question is not paid for twice.
           Set SUPPER_KNOWLEDGE_LEARN=off to stop keeping them (existing entries still work).
           Expires after KNOWLEDGE_DAYS (default 30). Time-sensitive questions are never kept,
           and neither are questions about the owner ("my ...") or very long ones.

Matching: the meaningful words of the question must mostly appear in a stored question
(Jaccard overlap of at least 0.75, and at least two words unless the stored question is the
same single word). The best match wins; ties prefer the workspace the question came from.
Any entry that expires or is forgotten moves to an archive list in the same file. Nothing
is deleted. Memory (memory/long_term.json) is never read or written here.

Provenance: written for this project from the owner's request (2026-10-10). No code or text
taken from other projects. The starter answers were written by the assistant, not copied.
"""
from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from . import config
from .recall import _STOP, _stem, _words

KNOWLEDGE_DAYS = 30
MAX_QUESTION_CHARS = 200
MAX_ANSWER_CHARS = 2000
MIN_OVERLAP = 0.75
STARTER_PATH = config.REPO_ROOT / "knowledge" / "starter.json"

# Filler words that do not change what a question is about.
_FILLER = frozenset({"how", "can", "could", "should", "would", "i", "we", "you", "does", "with", "from",
                     "into", "need", "want", "way", "there", "where", "when", "which", "who", "best",
                     "but", "please", "tell", "explain", "define", "mean", "meaning", "just", "also",
                     "really", "convert", "give", "show"})

# Anything that changes over time, or depends on today. Such answers are never kept.
_TIME_SENSITIVE = re.compile(
    r"\b(today|tonight|tomorrow|yesterday|now|right now|currently|current|latest|recent|newest|news|"
    r"price|prices|weather|forecast|score|scores|stock|stocks|exchange rate|this week|this month|"
    r"this year|next week|breaking|who won|as of|live)\b|\b20[2-9]\d\b", re.IGNORECASE)
# Questions about the owner. Their answers belong to the owner, not to everyone who asks.
_PERSONAL = re.compile(r"\b(my|mine|me|our|ours)\b", re.IGNORECASE)
# Answers that admit they may be out of date, or that Gemini could not look anything up.
_UNSURE_ANSWER = re.compile(r"as of my|real[- ]time|up[- ]to[- ]date|knowledge cutoff|i (?:can't|cannot|don't have access)",
                            re.IGNORECASE)

_STARTER_NOTE = " [starter answer written by the assistant: please check]"


def keywords(text: str) -> list[str]:
    """Meaningful words of a question: recall's rules plus the filler words above, checked before stemming."""
    return [_stem(w) for w in _words(text) if len(w) > 1 and w not in _STOP and w not in _FILLER]


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def may_keep_answer(question: str, answer: str) -> bool:
    """True if a Gemini answer may be stored: not time-sensitive, not personal, not too long."""
    if len(question) > MAX_QUESTION_CHARS or len(answer) > MAX_ANSWER_CHARS:
        return False
    if _TIME_SENSITIVE.search(question) or _PERSONAL.search(question):
        return False
    if _UNSURE_ANSWER.search(answer):
        return False
    return bool(keywords(question))


class KnowledgeStore:
    def __init__(self, path: Path | None = None, *, starter_path: Path | None = None,
                 clock: Callable[[], datetime] = datetime.now, days: int | None = None) -> None:
        self._path = Path(path) if path is not None else config.RUNTIME_DIR / "knowledge.json"
        self._starter_path = starter_path if starter_path is not None else STARTER_PATH
        self._clock = clock
        self._days = int(days if days is not None else _env_days())
        self._lock = threading.RLock()
        self._entries: list[dict] = []
        self._archive: list[dict] = []
        self._next_id = 1
        self._loaded = False
        self.last_problem = ""

    # ----- reading -----

    def lookup(self, question: str) -> dict | None:
        """The best stored entry for this question, or None. Counts a use when one is found."""
        words = set(keywords(question))
        if not words:
            return None
        with self._lock:
            self._ensure_loaded()
            self._expire()
            best, best_score = None, 0.0
            for entry in self._entries:
                stored = set(entry["keywords"])
                score = _jaccard(words, stored)
                if score < MIN_OVERLAP:
                    continue
                if len(words | stored) < 2 and words != stored:
                    continue
                if best is None or score > best_score:
                    best, best_score = entry, score
            if best is None:
                return None
            best["uses"] = int(best.get("uses", 0)) + 1
            best["last_used"] = self._now_iso()
            self._save()
            return dict(best)

    def list_entries(self) -> list[dict]:
        with self._lock:
            self._ensure_loaded()
            self._expire()
            return [dict(e) for e in self._entries]

    def describe(self, entry: dict) -> str:
        """The reply text for a stored entry."""
        if entry["kind"] == "starter":
            return entry["answer"] + _STARTER_NOTE
        if entry["kind"] == "gemini":
            return entry["answer"] + f" (saved from an earlier Gemini answer, {entry['created'][:10]})"
        return entry["answer"]

    # ----- writing -----

    def learn(self, question: str, answer: str) -> dict | None:
        """Keep a Gemini answer for the same question later. Returns None if it should not be kept.
        Off when SUPPER_KNOWLEDGE_LEARN=off: then Gemini answers are used once and not stored."""
        if not learning_enabled():
            return None
        question, answer = (question or "").strip(), (answer or "").strip()
        if not question or not answer or not may_keep_answer(question, answer):
            return None
        with self._lock:
            self._ensure_loaded()
            if self._find_exact(question):
                return None
            expires = (self._clock() + timedelta(days=self._days)).isoformat(timespec="seconds")
            return self._add("gemini", question, answer, expires=expires)

    def teach(self, question: str, answer: str) -> dict:
        question, answer = (question or "").strip(), (answer or "").strip()
        if not question or not answer:
            raise ValueError("a question and an answer are both needed")
        if len(question) > MAX_QUESTION_CHARS or len(answer) > MAX_ANSWER_CHARS:
            raise ValueError("that is too long to keep as one answer")
        if not keywords(question):
            raise ValueError("the question has no meaningful words to match on")
        with self._lock:
            self._ensure_loaded()
            return self._add("owner", question, answer, expires="")

    def forget(self, entry_id: int) -> dict | None:
        """Move an entry to the archive. Nothing is deleted. Returns the entry, or None if absent."""
        with self._lock:
            self._ensure_loaded()
            for i, entry in enumerate(self._entries):
                if entry["id"] == entry_id:
                    moved = self._entries.pop(i)
                    moved["archived_at"] = self._now_iso()
                    moved["archive_reason"] = "forgotten by owner"
                    self._archive.append(moved)
                    self._save()
                    return dict(moved)
            return None

    # ----- internals -----

    def _add(self, kind: str, question: str, answer: str, *, expires: str, key: str = "") -> dict:
        entry = {
            "id": self._next_id, "kind": kind, "key": key,
            "question": question, "keywords": keywords(question), "answer": answer,
            "created": self._now_iso(), "last_used": "", "uses": 0, "expires": expires,
        }
        self._next_id += 1
        self._entries.append(entry)
        self._save()
        return dict(entry)

    def _find_exact(self, question: str) -> dict | None:
        wanted = set(keywords(question))
        for entry in self._entries:
            if set(entry["keywords"]) == wanted:
                return entry
        return None

    def _expire(self) -> None:
        now = self._clock()
        kept, moved = [], []
        for entry in self._entries:
            expires = entry.get("expires") or ""
            if expires and datetime.fromisoformat(expires) <= now:
                entry["archived_at"] = now.isoformat(timespec="seconds")
                entry["archive_reason"] = "expired"
                moved.append(entry)
            else:
                kept.append(entry)
        if moved:
            self._entries = kept
            self._archive.extend(moved)
            self._save()

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        data = self._read_file()
        if data is not None:
            self._entries = list(data.get("entries", []))
            self._archive = list(data.get("archive", []))
            self._next_id = int(data.get("next_id", 1))
        self._add_missing_starters()

    def _add_missing_starters(self) -> None:
        known = {e.get("key") for e in self._entries + self._archive if e.get("key")}
        added = False
        for item in self._read_starters():
            key = "starter:" + str(item.get("key", ""))
            if not item.get("key") or not item.get("question") or not item.get("answer") or key in known:
                continue
            self._entries.append({
                "id": self._next_id, "kind": "starter", "key": key,
                "question": item["question"], "keywords": keywords(item["question"]),
                "answer": item["answer"], "created": self._now_iso(), "last_used": "",
                "uses": 0, "expires": "",
            })
            self._next_id += 1
            added = True
        if added:
            self._save()

    def _read_starters(self) -> list[dict]:
        try:
            items = json.loads(Path(self._starter_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    def _read_file(self) -> dict | None:
        if not self._path.exists():
            return None
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not an object")
            return data
        except (OSError, ValueError):
            # Keep the bad file as a copy, so nothing is lost, and start again.
            stamp = self._clock().strftime("%Y%m%d-%H%M%S")
            copy = self._path.with_name(f"{self._path.name}.bad-{stamp}")
            try:
                os.replace(self._path, copy)
                self.last_problem = f"knowledge file was unreadable; kept as {copy.name}"
            except OSError:
                self.last_problem = "knowledge file was unreadable and could not be moved aside"
            return None

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "next_id": self._next_id,
                   "entries": self._entries, "archive": self._archive}
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)

    def _now_iso(self) -> str:
        return self._clock().isoformat(timespec="seconds")


def learning_enabled() -> bool:
    return os.environ.get("SUPPER_KNOWLEDGE_LEARN", "on").strip().lower() not in ("off", "0", "no", "false")


def _env_days() -> int:
    raw = os.environ.get("SUPPER_KNOWLEDGE_DAYS", "").strip()
    try:
        return max(1, int(raw)) if raw else KNOWLEDGE_DAYS
    except ValueError:
        return KNOWLEDGE_DAYS
