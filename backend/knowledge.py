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
           Each new gemini entry records WHICH MODEL produced it, in `provenance`
           ({schema, source, model, recorded}). An entry written before that field existed
           has no record of its model, so it can never silently stand in for an answer from
           the current model: it is STALE. A stale entry does not answer on its own — the
           app asks the current model first, and only if the model cannot be reached does it
           fall back to the stored words, said plainly to be out of date. When a fresh answer
           replaces a stale one, the old entry moves to the archive with the reason; nothing
           is deleted, and the same model's existing answer is never paid for twice.

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
# The file's schema version. 1 = entries as first written; 2 = gemini entries may
# carry `provenance` (which model produced the answer). Readers accept both, and an
# entry with no provenance is treated as stale rather than trusted.
KNOWLEDGE_VERSION = 2
PROVENANCE_SCHEMA = 2
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


def _newer_of(mine: dict, theirs: dict) -> dict:
    """Which of two copies of the same entry is the one to keep: the one used most recently."""
    return mine if str(mine.get("last_used") or mine.get("created") or "") >= \
        str(theirs.get("last_used") or theirs.get("created") or "") else theirs


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
        self._stamp = ""            # mtime_ns:size of the file as this copy last saw it
        self.last_problem = ""
        self.last_backup = ""       # the verified copy made before the version 2 upgrade

    # ----- reading -----

    def lookup(self, question: str) -> dict | None:
        """The best stored entry for this question, or None. Counts a use when one is found."""
        words = set(keywords(question))
        if not words:
            return None
        with self._lock:
            self._ensure_loaded()
            self._reload_if_changed()
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
            self._reload_if_changed()
            self._expire()
            return [dict(e) for e in self._entries]

    def describe(self, entry: dict) -> str:
        """The reply text for a stored entry that may be answered directly."""
        if entry["kind"] == "starter":
            return entry["answer"] + _STARTER_NOTE
        if entry["kind"] == "gemini":
            return entry["answer"] + f" (saved from an earlier Gemini answer, {entry['created'][:10]})"
        return entry["answer"]

    # ----- provenance -----

    @staticmethod
    def provenance_of(entry: dict) -> dict:
        """The recorded model information for an entry, or {} when there is none."""
        provenance = entry.get("provenance") if isinstance(entry, dict) else None
        return provenance if isinstance(provenance, dict) else {}

    def is_stale(self, entry: dict, current_model: str) -> bool:
        """True when a stored GEMINI answer must not answer in place of the current model.

        Starter and taught answers are the owner's (or the assistant's) own words and are
        never stale — no model made them. A Gemini answer is stale when it does not record
        which model produced it (every entry written before provenance existed) or when it
        records a different model from the one this app now uses.
        """
        if entry.get("kind") != "gemini":
            return False
        made_by = str(self.provenance_of(entry).get("model") or "").strip()
        if not made_by:
            return True                        # no record of its model: never trusted silently
        now = (current_model or "").strip()
        if not now:
            return False                       # nothing to compare with; cannot call it out of date
        return made_by != now

    def describe_stale(self, entry: dict, current_model: str = "") -> str:
        """The reply for a stored Gemini answer used only because the model could not be reached.

        It says exactly what it is: an answer from an earlier model (or from a time when the
        app did not record the model), not re-checked just now, so possibly out of date.
        """
        provenance = self.provenance_of(entry)
        made_by = str(provenance.get("model") or "").strip() or "a model this app no longer records"
        made_on = str(entry.get("created") or "")[:10]
        now = (current_model or "").strip()
        rechecked = f"not re-checked with {now}" if now else "not re-checked"
        return (f"{entry['answer']} (saved from an earlier Gemini answer on {made_on}, made by "
                f"{made_by}; {rechecked} — the AI could not be reached just now, so please check "
                f"anything that may have changed since)")

    # ----- writing -----

    def learn(self, question: str, answer: str, model: str = "") -> dict | None:
        """Keep a Gemini answer for the same question later. Returns None if it should not be kept.

        `model` is the model that produced the answer; it is recorded with the entry so a
        later question can tell whether the stored answer came from the model in use now.
        Off when SUPPER_KNOWLEDGE_LEARN=off: then Gemini answers are used once and not stored.

        Nothing is overwritten blindly: an entry the owner taught, or a starter answer, is
        never replaced; the same model's existing answer is not paid for twice; and a STALE
        Gemini entry is moved to the archive (with the reason) as the fresh answer takes its
        place.
        """
        if not learning_enabled():
            return None
        question, answer = (question or "").strip(), (answer or "").strip()
        if not question or not answer or not may_keep_answer(question, answer):
            return None
        with self._lock:
            self._ensure_loaded()
            existing = self._find_exact(question)
            if existing is not None:
                if existing.get("kind") != "gemini":
                    return None                       # the owner's or the assistant's own answer wins
                if not self._must_supersede(existing, model):
                    return None                       # already kept from this model
                self._move_to_archive(existing, f"superseded by {model or 'a newer Gemini answer'}")
            expires = (self._clock() + timedelta(days=self._days)).isoformat(timespec="seconds")
            return self._add("gemini", question, answer, expires=expires, model=model)

    def _must_supersede(self, entry: dict, model: str) -> bool:
        """True when the stored Gemini answer must give way to the one just received."""
        if not (model or "").strip():
            return False                              # no model named: nothing says the new answer is newer
        return self.is_stale(entry, model)

    def _move_to_archive(self, entry: dict, reason: str) -> None:
        """Move one entry to the archive. Nothing is ever deleted."""
        self._entries.remove(entry)
        entry["archived_at"] = self._now_iso()
        entry["archive_reason"] = reason
        self._archive.append(entry)

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

    def _add(self, kind: str, question: str, answer: str, *, expires: str, key: str = "",
             model: str = "") -> dict:
        entry = {
            "id": self._next_id, "kind": kind, "key": key,
            "question": question, "keywords": keywords(question), "answer": answer,
            "created": self._now_iso(), "last_used": "", "uses": 0, "expires": expires,
        }
        if kind == "gemini":
            # Which model produced this answer. An empty name is recorded honestly: the
            # entry is then treated as stale next time rather than trusted silently.
            entry["provenance"] = {
                "schema": PROVENANCE_SCHEMA, "source": "gemini",
                "model": (model or "").strip(), "recorded": self._now_iso(),
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
        self._stamp = self._file_stamp()
        self._add_missing_starters()

    def _file_stamp(self) -> str:
        """mtime_ns and size of the store on disk, or '' when there is no readable file."""
        try:
            stat = self._path.stat()
        except OSError:
            return ""
        return f"{stat.st_mtime_ns}:{stat.st_size}"

    def _reload_if_changed(self) -> None:
        """Pick up entries the other half wrote, without needing a restart.

        The dashboard's Node store does the same (mtime+size, merge by id). Only the
        entries are picked up: what this half has archived is not brought back, and
        the numbering moves past the highest id on disk.
        """
        stamp = self._file_stamp()
        if stamp == self._stamp:
            return
        self._stamp = stamp
        self._merge_with_disk(self._quiet_read())

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
        """Write the store, first picking up anything written since this copy was loaded.

        Two halves of JARVIS share this one file: this desktop app and the dashboard's
        Node store. A plain overwrite would silently drop an answer the other half added
        (or an archive it made). Before writing, the file is read again and merged:
        entries this half does not know about are kept, entries it has archived are not
        brought back, and the numbering moves past the highest id either half has used.
        An unreadable file is left exactly as it is — the question of a damaged store is
        answered by _read_file at load time, not by a save.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        on_disk = self._quiet_read()
        if on_disk is not None and int(on_disk.get("version", 1) or 1) < KNOWLEDGE_VERSION:
            self._backup_before_upgrade()          # the Brain store's rule: verify, then write
        self._merge_with_disk(on_disk)
        payload = {"version": KNOWLEDGE_VERSION, "next_id": self._next_id,
                   "entries": self._entries, "archive": self._archive}
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
        self._stamp = self._file_stamp()

    def _backup_before_upgrade(self) -> None:
        """A hash-verified copy of the older file, taken before the first version 2 write.

        This is the Persistent Brain's rule applied to the knowledge file: before a file
        is rewritten in a newer shape, a copy is made, its sha256 is checked against the
        source, and a manifest records what was copied and why. The upgrade itself only
        ADDS a field — every entry and archive row is carried over exactly as it was — so
        a backup that cannot be made is recorded in `last_problem` and the save continues
        rather than leaving the owner without an answer.
        """
        try:
            import hashlib
            import shutil
            import uuid
            stamp = self._clock().strftime("%Y%m%dT%H%M%SZ")
            backup_dir = self._path.parent / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            before = hashlib.sha256(self._path.read_bytes()).hexdigest()
            name = f"{self._path.stem}.v1-{stamp}-{uuid.uuid4().hex[:8]}{self._path.suffix}"
            copy = backup_dir / name
            shutil.copy2(self._path, copy)
            copied = hashlib.sha256(copy.read_bytes()).hexdigest()
            after = hashlib.sha256(self._path.read_bytes()).hexdigest()
            if before != copied or before != after:
                copy.unlink(missing_ok=True)
                self.last_problem = ("the knowledge file changed while its backup was being checked; "
                                     "the backup was removed and nothing was thrown away")
                return
            manifest = backup_dir / f"{self._path.stem}.v1-{stamp}.manifest.json"
            manifest.write_text(json.dumps({
                "created": stamp, "source": self._path.name, "backup": name, "sha256": copied,
                "size_bytes": copy.stat().st_size,
                "reason": "taken before the knowledge file was first written in schema version 2",
            }, indent=2), encoding="utf-8")
            self.last_backup = str(copy)
        except Exception as exc:                    # the upgrade is additive; do not block the answer
            self.last_problem = f"could not make a verified backup before the version 2 upgrade: {exc}"

    def _quiet_read(self) -> dict | None:
        """The file on disk, or None. Never moves a damaged file aside (that is load-time work)."""
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _merge_with_disk(self, data: dict | None) -> None:
        """Fold the other half's entries, numbering and archive into this copy."""
        if not data:
            return
        theirs = [e for e in data.get("entries", []) if isinstance(e, dict) and "id" in e]
        if theirs:
            ours = {e.get("id"): e for e in self._entries}
            archived = {e.get("id") for e in self._archive}
            merged: list[dict] = []
            for entry in theirs:
                if entry.get("id") in archived:
                    continue                       # superseded here: never re-activated
                mine = ours.pop(entry.get("id"), None)
                if mine is None:
                    merged.append(entry)           # written by the other half: keep it
                else:
                    merged.append(_newer_of(mine, entry))
            merged.extend(ours.values())           # anything written here that is not on disk yet
            self._entries = merged
        self._next_id = max(self._next_id, int(data.get("next_id", 1) or 1))
        seen = {(e.get("id"), e.get("archived_at", "")) for e in self._archive}
        for entry in data.get("archive", []):
            if isinstance(entry, dict) and (entry.get("id"), entry.get("archived_at", "")) not in seen:
                self._archive.append(entry)

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
