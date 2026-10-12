"""Supper Brain: topic-aware orchestration on top of the existing memory stores.

Canonical sources remain memory/long_term.json (structured facts, topic state, tasks and
research) plus the existing recent_dialogue.json/dialogue_archive.jsonl conversation log. The
knowledge cache remains backend/knowledge.py; this module does not create a second database.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from memory import memory_manager as mm

OWNER_ID = "local-owner"                 # Supper is currently a single-owner local service.
MAX_CONTEXT_CHARS = 5200
MAX_HISTORY_TURNS = 12
MAX_SOURCES = 12

_STOP_WORDS = frozenset({
    "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
    "be", "because", "been", "before", "being", "between", "but", "by", "can", "could", "did", "do",
    "does", "doing", "done", "for", "from", "get", "go", "going", "got", "had", "has", "have",
    "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its",
    "just", "me", "my", "of", "on", "or", "our", "ours", "please", "she", "so", "some", "that",
    "the", "their", "them", "then", "there", "they", "this", "those", "to", "up", "us", "was", "we",
    "were", "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
})

_MEMORY_CATEGORIES = frozenset({
    "identity", "preferences", "projects", "relationships", "wishes", "notes",
})
_INTERNAL_CATEGORIES = frozenset({"topics", "conversations", "decisions", "corrections", "tasks", "research"})
_SEARCH_CATEGORIES = _MEMORY_CATEGORIES | _INTERNAL_CATEGORIES
_TOPIC_STATUSES = frozenset({"active", "paused", "complete", "archived"})
_TASK_STATUSES = frozenset({"open", "done", "cancelled"})


class BrainStorageError(RuntimeError):
    """Persistent memory is unreadable or could not safely be saved."""


@dataclass
class BrainTurn:
    conversation_id: str
    topic_id: str | None
    topic_title: str | None
    history: list[dict]
    context_block: str
    owner_id: str
    channel: str = "text"
    clarification: str = ""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(value: datetime | None = None) -> str:
    return (value or _now()).isoformat(timespec="seconds")


def _clean(value: Any, limit: int = 1200) -> str:
    text = " ".join(str(value or "").replace("\x00", " ").split())
    return text[:limit].rstrip()


def _terms(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", (text or "").casefold())
    return {word[:-1] if len(word) > 4 and word.endswith("s") else word
            for word in words if len(word) > 1 and word not in _STOP_WORDS}


def _slug(text: str, limit: int = 54) -> str:
    words = re.findall(r"[a-z0-9]+", (text or "").casefold())
    return "_".join(words[:8])[:limit].strip("_") or "note"


def _valid_url(value: str) -> bool:
    if not value or len(value) > 1800 or any(ch.isspace() or ch in "<>\"'" for ch in value):
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme.casefold() in {"http", "https"} and bool(parsed.hostname) \
        and parsed.username is None and parsed.password is None


class BrainStore:
    """Coordinates the repository's existing JSON memory and dialogue archive.

    Memory is local, single-owner, and never accepted from a request-supplied owner ID. A
    verified, timestamped copy of an existing long_term.json is made before the first Brain
    write in each process. Corrupt legacy JSON is never overwritten.
    """

    def __init__(self, owner_id: str = OWNER_ID, *, clock=_now) -> None:
        self.owner_id = _clean(owner_id, 80) or OWNER_ID
        self._clock = clock
        self._lock = threading.RLock()
        self._backup_made = False
        self._last_storage_error = ""

    @property
    def memory_path(self) -> Path:
        return Path(mm.MEMORY_PATH)

    def _validate_existing_file(self) -> dict:
        path = self.memory_path
        if not path.exists():
            return mm._empty_memory()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raise BrainStorageError(
                "The existing memory file cannot be read as JSON. It was left untouched; "
                "make a verified backup or repair it before saving new Brain data.") from None
        if not isinstance(data, dict):
            raise BrainStorageError(
                "The existing memory file has an unsupported format. It was left untouched.")
        return data

    def _backup_sources(self) -> list[Path]:
        paths = [self.memory_path, Path(mm.DIALOGUE_PATH)]
        for helper_name in ("_archive_path", "_dialogue_archive_path"):
            helper = getattr(mm, helper_name, None)
            if callable(helper):
                paths.append(Path(helper()))
        return list(dict.fromkeys(path for path in paths if path.exists()))

    def _create_verified_backup_set(self, label: str) -> dict:
        sources = self._backup_sources()
        if not sources:
            return {"created": False, "reason": "No persistent Brain files exist yet.", "files": []}
        backup_dir = self.memory_path.parent / "backups"
        created_at = _stamp(self._clock())
        tag = f"{label}-{self._clock().strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
        created: list[Path] = []
        rows = []
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            for source in sources:
                before = hashlib.sha256(source.read_bytes()).hexdigest()
                name = f"{source.stem}.{tag}{source.suffix}"
                backup = backup_dir / name
                shutil.copy2(source, backup)
                created.append(backup)
                try:
                    backup.chmod(0o600)
                except OSError:
                    pass
                copied = hashlib.sha256(backup.read_bytes()).hexdigest()
                after = hashlib.sha256(source.read_bytes()).hexdigest()
                if before != copied or before != after:
                    raise BrainStorageError("A persistent file changed while its backup was being verified; nothing was saved.")
                rows.append({"source": source.name, "backup": backup.name,
                             "sha256": copied, "size_bytes": backup.stat().st_size})
            manifest = backup_dir / f"brain.{tag}.manifest.json"
            mm._atomic_json_write(manifest, {"created_at": created_at, "files": rows})
            created.append(manifest)
            return {"created": True, "created_at": created_at, "files": rows,
                    "manifest": manifest.name}
        except BrainStorageError:
            for path in created:
                path.unlink(missing_ok=True)
            raise
        except Exception:
            for path in created:
                path.unlink(missing_ok=True)
            raise BrainStorageError("A verified backup of the existing Brain files could not be created; nothing was saved.") from None

    def _backup_before_write(self) -> None:
        with self._lock:
            if self._backup_made:
                return
            self._validate_existing_file()
            self._create_verified_backup_set("before-brain")
            self._backup_made = True

    def _backup_before_change(self, label: str) -> None:
        """Take a fresh verified restore point before a user-requested overwrite or removal."""
        with self._lock:
            self._validate_existing_file()
            self._create_verified_backup_set(label)

    def _put(self, category: str, key: str, value: str, **metadata) -> dict:
        with self._lock:
            self._validate_existing_file()
            self._backup_before_write()
            try:
                return mm.put_record(category, key, value, metadata)
            except Exception as exc:
                self._last_storage_error = type(exc).__name__
                raise BrainStorageError(f"Memory could not be saved ({type(exc).__name__}).") from None

    def _put_many(self, records: list[dict]) -> list[dict]:
        with self._lock:
            self._validate_existing_file()
            self._backup_before_write()
            try:
                return mm.put_records(records)
            except Exception as exc:
                self._last_storage_error = type(exc).__name__
                raise BrainStorageError(f"Memory could not be saved ({type(exc).__name__}).") from None

    def _delete(self, category: str, key: str) -> bool:
        with self._lock:
            self._validate_existing_file()
            self._backup_before_write()
            try:
                return mm.delete_record(category, key)
            except Exception as exc:
                self._last_storage_error = type(exc).__name__
                raise BrainStorageError(f"Memory could not be updated ({type(exc).__name__}).") from None

    def _record(self, category: str, key: str) -> dict | None:
        try:
            record = mm.get_record(category, key)
        except Exception:
            return None
        if not record:
            return None
        record.setdefault("key", key)
        record.setdefault("category", category)
        if record.get("owner_id") not in (None, "", self.owner_id):
            return None
        if category in _INTERNAL_CATEGORIES and record.get("owner_id") != self.owner_id:
            return None
        return record

    def _items(self, category: str) -> list[dict]:
        try:
            memory = mm.load_memory()
        except Exception:
            return []
        bucket = memory.get(category, {}) if isinstance(memory, dict) else {}
        if not isinstance(bucket, dict):
            return []
        rows = []
        for key, raw in bucket.items():
            if isinstance(raw, dict):
                record = dict(raw)
            elif raw is not None:
                record = {"value": str(raw)}
            else:
                continue
            if record.get("owner_id") not in (None, "", self.owner_id):
                continue
            if category in _INTERNAL_CATEGORIES and record.get("owner_id") != self.owner_id:
                continue
            storage_key = str(key)
            record.update({"key": _clean(record.get("memory_key") or storage_key, 160),
                           "storage_key": storage_key, "category": category})
            rows.append(record)
        return rows

    @staticmethod
    def _scoped_memory_key(scope: str, key: str) -> str:
        digest = hashlib.sha256(f"{scope}\0{key}".encode("utf-8")).hexdigest()[:20]
        return f"brain_{digest}_{_slug(key, 100)}"[:160]

    def _memory_locator(self, category: str, key: str, topic_id: str = "") -> tuple[str, dict] | None:
        for row in self._items(category):
            if row.get("key") == key and str(row.get("topic_id") or "") == topic_id:
                return str(row.get("storage_key") or key), row
        return None

    def list_memories(self, query: str = "", *, category: str = "", topic_id: str = "",
                      limit: int = 100) -> list[dict]:
        categories = [category] if category else sorted(_MEMORY_CATEGORIES)
        rows = [row for name in categories if name in _MEMORY_CATEGORIES for row in self._items(name)]
        if topic_id:
            rows = [r for r in rows if not r.get("topic_id") or r.get("topic_id") == topic_id]
        if query.strip():
            scored = self.search(query, limit=max(limit, 100), topic_id=topic_id)
            wanted = {(r["category"], r["key"], r.get("topic_id") or "") for r in scored}
            rows = [r for r in rows if (r["category"], r["key"], r.get("topic_id") or "") in wanted]
            rank = {(r["category"], r["key"], r.get("topic_id") or ""): i
                    for i, r in enumerate(scored)}
            rows.sort(key=lambda r: rank.get((r["category"], r["key"], r.get("topic_id") or ""), 9999))
        else:
            rows.sort(key=lambda r: str(r.get("updated", "")), reverse=True)
        return [self._public_memory(r) for r in rows[:max(1, min(int(limit), 500))]]

    @staticmethod
    def _public_memory(record: dict) -> dict:
        return {k: record.get(k) for k in (
            "category", "key", "value", "updated", "created_at", "source", "confidence",
            "topic_id", "status", "provenance", "query", "reason", "target_category",
            "target_key", "corrected_at", "retrieved_at", "verification", "sources", "goal",
            "summary", "next_step", "open_questions", "title", "due_at") if k in record}

    def search(self, query: str, *, topic_id: str = "", limit: int = 10) -> list[dict]:
        """Ranked local full-text search over canonical memory records (no stale side index)."""
        query = _clean(query, 400)
        terms = _terms(query)
        if not terms:
            return []
        rows: list[tuple[float, dict]] = []
        categories = sorted(_SEARCH_CATEGORIES)
        for category in categories:
            for row in self._items(category):
                scoped_topic = str(row.get("topic_id") or "")
                if topic_id and scoped_topic and scoped_topic != topic_id:
                    continue
                body_parts = [row.get("key", ""), row.get("value", "")]
                for field in ("title", "goal", "summary", "next_step", "reason", "query", "status"):
                    body_parts.append(row.get(field, ""))
                if category == "topics":
                    body_parts.extend((row.get("title", ""), row.get("goal", ""), row.get("summary", "")))
                body = " ".join(str(part or "") for part in body_parts).casefold()
                key = str(row.get("key", "")).casefold().replace("_", " ")
                hits = {term for term in terms if term in body}
                if not hits:
                    continue
                coverage = len(hits) / len(terms)
                if len(terms) > 2 and coverage < 0.25:
                    continue
                key_hits = sum(1 for term in terms if term in key)
                phrase_bonus = 1.5 if query.casefold() in body else 0.0
                score = coverage * 4.0 + key_hits * 1.5 + phrase_bonus
                if row.get("topic_id") == topic_id and topic_id:
                    score += 0.35
                rows.append((score, row))
        rows.sort(key=lambda item: (item[0], str(item[1].get("updated", ""))), reverse=True)
        return [self._public_memory(row) for _score, row in rows[:max(1, min(int(limit), 50))]]

    def _topics(self) -> list[dict]:
        rows = []
        for row in self._items("topics"):
            topic = dict(row)
            topic["id"] = str(topic.get("key", ""))
            topic["title"] = _clean(topic.get("title") or topic.get("value") or "Untitled topic", 160)
            topic["summary"] = _clean(topic.get("summary", ""), 1600)
            topic["goal"] = _clean(topic.get("goal", ""), 800)
            topic["next_step"] = _clean(topic.get("next_step", ""), 800)
            topic["status"] = topic.get("status") if topic.get("status") in _TOPIC_STATUSES else "paused"
            rows.append(topic)
        rows.sort(key=lambda row: str(row.get("last_active") or row.get("updated") or ""), reverse=True)
        return rows

    def get_topic(self, topic_id: str) -> dict | None:
        topic_id = self._valid_id(topic_id)
        row = self._record("topics", topic_id)
        if not row:
            return None
        row.update({"id": topic_id, "title": _clean(row.get("title") or row.get("value"), 160)})
        return row

    def _latest_topic(self, exclude: str = "") -> dict | None:
        rows = [t for t in self._topics() if t["id"] != exclude and t.get("status") != "complete"
                and t.get("status") != "archived"]
        return rows[0] if rows else None

    def _active_conversation(self) -> str:
        topic = next((t for t in self._topics() if t.get("status") == "active"), None)
        if topic and topic.get("last_conversation_id"):
            return str(topic["last_conversation_id"])
        rows = self._items("conversations")
        rows.sort(key=lambda r: str(r.get("updated_at") or r.get("updated") or ""), reverse=True)
        return str(rows[0].get("key", "")) if rows else ""

    def _conversation(self, conversation_id: str) -> dict | None:
        row = self._record("conversations", conversation_id)
        return row if row else None

    @staticmethod
    def _valid_id(value: str | None) -> str:
        raw = str(value or "").strip()
        if not raw or len(raw) > 64 or not re.fullmatch(r"[a-fA-F0-9-]{16,64}", raw):
            return ""
        return raw

    @staticmethod
    def _new_title(text: str) -> str:
        text = re.sub(r"^(?:please\s+)?(?:let'?s\s+)?(?:start|create|begin)(?:\s+a)?\s+(?:new\s+)?(?:topic|project|thread)(?:\s+(?:about|for))?\s*[:,-]?\s*",
                      "", _clean(text, 240), flags=re.IGNORECASE)
        first = re.split(r"[.!?\n]", text, maxsplit=1)[0].strip()
        return (first[:96].rstrip() or "General conversation")

    @staticmethod
    def _is_new_topic(text: str) -> bool:
        return bool(re.search(r"\b(?:start|create|begin|open)\s+(?:a\s+)?new\s+(?:topic|project|thread)\b", text, re.I))

    @staticmethod
    def _is_resume(text: str) -> bool:
        return bool(re.search(r"\b(?:continue|resume|where did we get to|what did we decide|do the next step|"
                              r"finish what we started|pick up where we left off|go back to the other project)\b", text, re.I))

    @staticmethod
    def _switch_target(text: str) -> str:
        if re.search(r"\b(?:other|previous|last)\s+project\b", text, re.I):
            return "__other__"
        match = re.search(r"\b(?:go back to|switch to|return to|resume|continue with|continue the|open)\s+(?:the\s+)?(.+)$",
                          text, re.I)
        target = _clean(match.group(1), 120) if match else ""
        if re.fullmatch(r"(?:the )?(?:next step|work|project|conversation|thing|it|that|where we left off)", target, re.I):
            return ""
        return target

    def _match_topic(self, target: str, current_id: str = "") -> dict | None:
        if target == "__other__":
            active = next((t for t in self._topics() if t.get("status") == "active"), None)
            return self._latest_topic(exclude=current_id or (active["id"] if active else ""))
        target_terms = _terms(target)
        if not target_terms:
            return None
        ranked = []
        for topic in self._topics():
            text = " ".join((str(topic.get("title", "")), str(topic.get("goal", "")),
                             str(topic.get("summary", "")), str(topic.get("next_step", ""))))
            terms = _terms(text)
            common = len(target_terms & terms)
            overlap = common / max(1, len(target_terms | terms))
            exact = 1.0 if target.casefold() in str(topic.get("title", "")).casefold() else 0.0
            ranked.append((exact, overlap, common, topic))
        if not ranked:
            return None
        ranked.sort(key=lambda item: (item[0], item[1], item[2], str(item[3].get("last_active", ""))), reverse=True)
        exact, overlap, common, winner = ranked[0]
        return winner if exact or (common >= 1 and overlap >= 0.28) else None

    def _create_topic(self, title: str, *, goal: str = "") -> dict:
        topic_id = uuid.uuid4().hex
        now = _stamp(self._clock())
        title = _clean(title, 160) or "General conversation"
        self._put("topics", topic_id, title, id=topic_id, title=title, summary="", goal=_clean(goal, 800),
                  status="active", next_step="", open_questions=[], created_at=now, updated_at=now,
                  last_active=now, last_conversation_id="", owner_id=self.owner_id,
                  source="user_conversation", confidence=1.0)
        return self.get_topic(topic_id) or {"id": topic_id, "title": title, "status": "active"}

    def _activate_topic(self, selected: dict, *, conversation_id: str = "") -> dict:
        now = _stamp(self._clock())
        topic_id = selected["id"]
        for topic in self._topics():
            if topic["id"] != topic_id and topic.get("status") == "active":
                self._put("topics", topic["id"], str(topic.get("value") or topic["title"]),
                          status="paused", updated_at=now)
        self._put("topics", topic_id, selected["title"], status="active", last_active=now,
                  last_conversation_id=conversation_id or selected.get("last_conversation_id", ""),
                  updated_at=now)
        return self.get_topic(topic_id) or selected

    def _history(self, topic_id: str | None, conversation_id: str) -> list[dict]:
        try:
            if topic_id:
                turns = mm.get_dialogue_history(topic_id=topic_id, owner_id=self.owner_id,
                                                limit=MAX_HISTORY_TURNS)
            else:
                turns = mm.get_dialogue_history(conversation_id=conversation_id,
                                                owner_id=self.owner_id, limit=MAX_HISTORY_TURNS)
        except Exception:
            turns = []
        out = []
        for turn in turns:
            text = _clean(turn.get("text", ""), 4000)
            if not text:
                continue
            role = "user" if str(turn.get("speaker", "")).casefold() in ("user", "owner", "human") else "model"
            out.append({"role": role, "parts": [{"text": text}]})
        return out[-MAX_HISTORY_TURNS:]

    def _context_block(self, topic_id: str | None, query: str = "") -> str:
        sections: list[str] = []
        topic = self.get_topic(topic_id) if topic_id else None
        if topic:
            lines = [f"Topic: {topic['title']}", f"Status: {topic.get('status', 'active')}"]
            for label, field in (("Goal", "goal"), ("Summary", "summary"), ("Next step", "next_step")):
                value = _clean(topic.get(field, ""), 800)
                if value:
                    lines.append(f"{label}: {value}")
            sections.append("[ACTIVE TOPIC]\n" + "\n".join(lines))
            topic_id = topic["id"]

        relevant = self.search(query, topic_id=topic_id or "", limit=8) if query.strip() else []
        if relevant:
            lines = []
            for row in relevant:
                if row.get("category") in ("topics", "conversations"):
                    continue
                category, key = row.get("category", "memory"), row.get("key", "")
                value = _clean(row.get("value", ""), 500)
                if not value:
                    continue
                confidence = row.get("confidence")
                source = row.get("source") or "legacy"
                qualifier = "" if confidence is None else f"; confidence={confidence}"
                lines.append(f"- {category}/{key}: {value} (source={source}{qualifier})")
            if lines:
                sections.append("[RELEVANT SAVED RECORDS]\n" + "\n".join(lines))

        if topic_id:
            decisions = [r for r in self._items("decisions") if r.get("topic_id") == topic_id]
            decisions.sort(key=lambda r: str(r.get("created_at") or r.get("updated", "")), reverse=True)
            if decisions:
                sections.append("[OWNER-STATED DECISIONS]\n" + "\n".join(
                    f"- { _clean(r.get('value'), 700) }" +
                    (f" — reason: {_clean(r.get('reason'), 300)}" if r.get("reason") else "")
                    for r in decisions[:8]))
            tasks = [r for r in self._items("tasks") if r.get("topic_id") == topic_id and r.get("status", "open") == "open"]
            tasks.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            if tasks:
                sections.append("[OPEN TASKS]\n" + "\n".join(f"- {_clean(r.get('value'), 500)}" for r in tasks[:8]))
            research = [r for r in self._items("research") if r.get("topic_id") == topic_id]
            research.sort(key=lambda r: str(r.get("retrieved_at") or ""), reverse=True)
            if research:
                sections.append("[RECENT SOURCED RESEARCH]\n" + "\n".join(
                    f"- {_clean(r.get('query') or r.get('value'), 300)}; sources: " +
                    ", ".join(_clean(s.get("title") or s.get("url"), 120)
                               for s in (r.get("sources") or [])[:3])
                    for r in research[:3]))

        if not sections:
            return ""
        body = "\n\n".join(sections)
        if len(body) > MAX_CONTEXT_CHARS:
            body = body[:MAX_CONTEXT_CHARS - 1].rstrip() + "…"
        return body

    def begin_turn(self, text: str, *, conversation_id: str | None = None,
                   topic_id: str | None = None, channel: str = "text",
                   create_topic: bool = True) -> BrainTurn:
        """Resolve the persistent topic, then fetch only its context and recent turns."""
        text = _clean(text, 4000)
        now = _stamp(self._clock())
        requested_conversation = self._valid_id(conversation_id)
        requested_topic = self._valid_id(topic_id)
        with self._lock:
            existing_conversation = self._conversation(requested_conversation) if requested_conversation else None
            if requested_conversation and existing_conversation is None:
                # A caller cannot use another owner's ID to read history. Start a fresh conversation.
                requested_conversation = ""

            if not requested_conversation and channel in ("voice", "voice-live"):
                requested_conversation = self._valid_id(self._active_conversation())
                existing_conversation = self._conversation(requested_conversation) if requested_conversation else None

            current_id = str((existing_conversation or {}).get("topic_id") or "")
            if requested_topic:
                selected = self.get_topic(requested_topic)
                if selected is None:
                    raise ValueError("That saved topic is not available in this local profile.")
            else:
                current = self.get_topic(current_id) if current_id else None
                target = self._switch_target(text)
                if target:
                    selected = self._match_topic(target, current_id=current_id)
                    if selected is None:
                        requested = "the other saved project" if target == "__other__" else repr(target)
                        clarification = f"I couldn't identify {requested}. Which saved topic should I resume?"
                        selected = current
                    else:
                        clarification = ""
                else:
                    clarification = ""
                    selected = None if self._is_new_topic(text) else current
                if not selected and create_topic:
                    if self._is_resume(text) and not self._is_new_topic(text):
                        selected = self._latest_topic()
                    elif not self._is_new_topic(text):
                        selected = self._match_topic(text)
                if not selected and not clarification and create_topic:
                    selected = self._create_topic(self._new_title(text))

            if current_id and selected and selected["id"] != current_id:
                # A topic switch begins a separate browser/voice conversation so turns from two
                # projects are never mixed in the restored transcript.
                requested_conversation = ""
                existing_conversation = None
            if not requested_conversation:
                requested_conversation = uuid.uuid4().hex
            if selected:
                selected = self._activate_topic(selected, conversation_id=requested_conversation)
                topic_id_out = selected["id"]
                topic_title = selected["title"]
            else:
                topic_id_out = None
                topic_title = None

            title = topic_title or self._new_title(text)
            self._put("conversations", requested_conversation, title, id=requested_conversation,
                      title=title, topic_id=topic_id_out or "", owner_id=self.owner_id,
                      created_at=(existing_conversation or {}).get("created_at", now),
                      updated_at=now, channel=channel, source="local_conversation")
            history = self._history(topic_id_out, requested_conversation)
            context = self._context_block(topic_id_out, text)
            return BrainTurn(requested_conversation, topic_id_out, topic_title, history, context,
                             self.owner_id, channel, locals().get("clarification", ""))

    def record_user_turn(self, turn: BrainTurn, text: str) -> None:
        self._append_turn(turn, "user", text, status="complete")

    def complete_turn(self, turn: BrainTurn, text: str, *, source: str = "assistant",
                      status: str = "complete", sources: list[dict] | None = None) -> None:
        safe_sources = []
        for item in (sources or [])[:MAX_SOURCES]:
            if not isinstance(item, dict):
                continue
            url = _clean(item.get("url"), 1800)
            if _valid_url(url):
                safe_sources.append({"url": url, "title": _clean(item.get("title"), 240)})
        self._append_turn(turn, "assistant", text, source=source, status=status,
                          sources=safe_sources)
        now = _stamp(self._clock())
        conversation = self._conversation(turn.conversation_id) or {}
        title = turn.topic_title or conversation.get("title") or "General conversation"
        self._put("conversations", turn.conversation_id, title,
                  id=turn.conversation_id, title=title, topic_id=turn.topic_id or "",
                  owner_id=turn.owner_id, created_at=conversation.get("created_at", now),
                  updated_at=now, channel=turn.channel, source="local_conversation")
        if turn.topic_id:
            topic = self.get_topic(turn.topic_id)
            if topic:
                self._put("topics", turn.topic_id, topic["title"], status=topic.get("status", "active"),
                          last_active=now, last_conversation_id=turn.conversation_id,
                          updated_at=now)

    def _append_turn(self, turn: BrainTurn, speaker: str, text: str, *, source: str = "",
                     status: str = "complete", sources: list[dict] | None = None) -> None:
        text = _clean(text, 4000)
        if not text:
            return
        self._backup_before_write()
        try:
            mm.append_dialogue_turn(speaker, text, conversation_id=turn.conversation_id,
                                    topic_id=turn.topic_id or "", owner_id=turn.owner_id,
                                    source=source or turn.channel, status=status,
                                    sources=sources, strict=True)
        except Exception:
            self._last_storage_error = "conversation_save_failed"
            raise BrainStorageError("Conversation history could not be saved.") from None

    def record_live_turn(self, user_text: str, assistant_text: str) -> None:
        """Persist transcripts from the optional Gemini Live path in the same topic store."""
        user_text, assistant_text = _clean(user_text, 4000), _clean(assistant_text, 4000)
        if not user_text:
            return
        turn = self.begin_turn(user_text, channel="voice-live")
        self.record_user_turn(turn, user_text)
        if assistant_text:
            self.complete_turn(turn, assistant_text, source="gemini-live")

    def create_topic(self, title: str, *, goal: str = "") -> dict:
        """Create and activate a named topic from an explicit owner action."""
        title = _clean(title, 160)
        if not title:
            raise ValueError("A topic title is required.")
        topic = self._create_topic(title, goal=_clean(goal, 800))
        conversation = self.start_conversation(topic_id=topic["id"])
        return {**{k: topic.get(k) for k in ("id", "title", "summary", "goal", "status", "next_step")},
                **conversation}

    def start_conversation(self, *, topic_id: str = "") -> dict:
        """Start a UI conversation, optionally resuming an existing topic."""
        selected = self.get_topic(topic_id) if topic_id else None
        if topic_id and selected is None:
            raise ValueError("That saved topic is not available in this local profile.")
        conversation_id = uuid.uuid4().hex
        if selected:
            selected = self._activate_topic(selected, conversation_id=conversation_id)
        title = selected["title"] if selected else "General conversation"
        self._put("conversations", conversation_id, title, id=conversation_id, title=title,
                  topic_id=selected["id"] if selected else "", owner_id=self.owner_id,
                  created_at=_stamp(self._clock()), updated_at=_stamp(self._clock()),
                  channel="text", source="local_conversation")
        return {"conversation_id": conversation_id,
                "topic_id": selected["id"] if selected else None,
                "topic_title": selected["title"] if selected else None}

    def conversation_history(self, conversation_id: str, *, limit: int = 100) -> dict:
        conversation_id = self._valid_id(conversation_id)
        record = self._conversation(conversation_id) if conversation_id else None
        if not record:
            raise LookupError("That conversation is not available in this local profile.")
        topic_id = str(record.get("topic_id") or "")
        try:
            turns = mm.get_dialogue_history(conversation_id=conversation_id,
                                            topic_id=topic_id, owner_id=self.owner_id,
                                            limit=max(1, min(int(limit), 500)))
        except Exception:
            turns = []
        return {"conversation_id": conversation_id, "topic_id": topic_id or None,
                "topic_title": record.get("title") or None,
                "turns": [{"role": "user" if t.get("speaker") == "user" else "assistant",
                           "text": _clean(t.get("text"), 4000),
                           "source": t.get("source", ""), "sources": t.get("sources", []),
                           "status": t.get("status", "complete"),
                           "time": t.get("created_at") or t.get("time", "")}
                          for t in turns[-max(1, min(int(limit), 500)):]]}

    def list_topics(self) -> list[dict]:
        return [{k: row.get(k) for k in ("id", "title", "summary", "goal", "status", "next_step",
                                         "open_questions", "created_at", "updated", "last_active")}
                for row in self._topics()]

    def update_topic(self, topic_id: str, updates: dict) -> dict:
        topic = self.get_topic(topic_id)
        if not topic:
            raise LookupError("That saved topic is not available in this local profile.")
        allowed = {"title", "summary", "goal", "status", "next_step", "open_questions"}
        clean_updates = {k: v for k, v in updates.items() if k in allowed}
        if not clean_updates:
            raise ValueError("No editable topic fields were supplied.")
        if "status" in clean_updates and clean_updates["status"] not in _TOPIC_STATUSES:
            raise ValueError("Topic status must be active, paused, complete or archived.")
        for field in ("title", "summary", "goal", "next_step"):
            if field in clean_updates:
                clean_updates[field] = _clean(clean_updates[field], 160 if field == "title" else 1600)
        if "open_questions" in clean_updates:
            values = clean_updates["open_questions"]
            if not isinstance(values, list):
                raise ValueError("Open questions must be a list of text.")
            clean_updates["open_questions"] = [_clean(v, 300) for v in values[:20] if _clean(v, 300)]
        if any(topic.get(field) != value for field, value in clean_updates.items()):
            self._backup_before_change("before-topic-update")
        if clean_updates.get("status") == "active":
            topic = self._activate_topic(topic)
        now = _stamp(self._clock())
        self._put("topics", topic["id"], clean_updates.get("title", topic["title"]),
                  **clean_updates, updated_at=now,
                  last_active=now if clean_updates.get("status") == "active" else topic.get("last_active", now))
        updated = self.get_topic(topic["id"])
        return {k: updated.get(k) for k in ("id", "title", "summary", "goal", "status", "next_step",
                                            "open_questions", "created_at", "updated", "last_active")}

    def add_memory(self, category: str, key: str, value: str, *, source: str = "explicit",
                   confidence: float = 1.0, topic_id: str = "", provenance: str = "") -> dict:
        category = _clean(category, 40).casefold()
        key = _clean(key, 160)
        value = _clean(value, 1200)
        if category not in _MEMORY_CATEGORIES:
            raise ValueError("Choose a supported memory category.")
        if not key or not value or "/" in key:
            raise ValueError("A memory name and value are both needed; memory names cannot contain '/'.")
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            raise ValueError("Confidence must be between 0 and 1.") from None
        if not 0 <= confidence <= 1:
            raise ValueError("Confidence must be between 0 and 1.")
        raw_topic_id = topic_id
        topic_id = self._valid_id(topic_id) if topic_id else ""
        with self._lock:
            if raw_topic_id and (not topic_id or not self.get_topic(topic_id)):
                raise ValueError("That saved topic is not available in this local profile.")
            located = self._memory_locator(category, key, topic_id)
            if located:
                storage_key, existing = located
            else:
                existing = {}
                raw_collision = mm.get_record(category, key)
                storage_key = (self._scoped_memory_key(topic_id, key) if topic_id else
                               key if raw_collision is None else self._scoped_memory_key("global", key))
            if existing and existing.get("value") != value:
                self._backup_before_change("before-memory-overwrite")
            meta = {"owner_id": self.owner_id, "source": _clean(source, 80) or "explicit",
                    "confidence": confidence, "topic_id": topic_id,
                    "memory_key": key, "provenance": _clean(provenance, 400),
                    "created_at": existing.get("created_at") or _stamp(self._clock()),
                    "updated": _stamp(self._clock())}
            return self._public_memory({**self._put(category, storage_key, value, **meta),
                                        "category": category, "key": key})

    def correct_memory(self, category: str, key: str, value: str, *, reason: str = "",
                       topic_id: str = "") -> dict | None:
        category, key = _clean(category, 40).casefold(), _clean(key, 160)
        raw_topic_id = topic_id
        topic_id = self._valid_id(topic_id) if topic_id else ""
        value = _clean(value, 1200)
        if category not in _MEMORY_CATEGORIES:
            raise ValueError("Choose a supported memory category.")
        if raw_topic_id and (not topic_id or not self.get_topic(topic_id)):
            raise ValueError("That saved topic is not available in this local profile.")
        if not value:
            raise ValueError("A corrected memory value is required.")
        with self._lock:
            located = self._memory_locator(category, key, topic_id)
            if not located:
                return None
            storage_key, old = located
            if old.get("value") != value:
                self._backup_before_change("before-memory-correction")
            corrected_at = _stamp(self._clock())
            try:
                count = int(old.get("correction_count", 0) or 0) + 1
            except (TypeError, ValueError):
                count = 1
            correction_id = uuid.uuid4().hex
            rows = self._put_many([
                {"category": category, "key": storage_key, "value": value,
                 "metadata": {"source": "user_correction", "confidence": 1.0,
                              "corrected_at": corrected_at, "correction_count": count,
                              "correction_reason": _clean(reason, 300), "owner_id": self.owner_id,
                              "created_at": old.get("created_at") or corrected_at,
                              "topic_id": topic_id, "memory_key": key,
                              "provenance": "explicit user correction"}},
                {"category": "corrections", "key": correction_id,
                 "value": f"Corrected {category}/{key}.",
                 "metadata": {"owner_id": self.owner_id, "target_category": category,
                              "target_key": key, "corrected_at": corrected_at,
                              "source": "user_correction", "confidence": 1.0,
                              "topic_id": topic_id,
                              "reason": _clean(reason, 300), "new_value": value,
                              "created_at": corrected_at}},
            ])
            return self._public_memory({**rows[0], "category": category, "key": key})

    def forget_memory(self, category: str, key: str, *, topic_id: str = "") -> bool:
        category, key = _clean(category, 40).casefold(), _clean(key, 160)
        raw_topic_id = topic_id
        topic_id = self._valid_id(topic_id) if topic_id else ""
        if category not in _MEMORY_CATEGORIES:
            raise ValueError("Choose a supported memory category.")
        if raw_topic_id and (not topic_id or not self.get_topic(topic_id)):
            raise ValueError("That saved topic is not available in this local profile.")
        with self._lock:
            located = self._memory_locator(category, key, topic_id)
            if not located:
                return False
            storage_key, _record = located
            self._backup_before_change("before-memory-forget")
            return self._delete(category, storage_key)

    def add_decision(self, text: str, *, topic_id: str = "", reason: str = "") -> dict:
        text = _clean(text, 1200)
        if not text:
            raise ValueError("The decision text is empty.")
        if topic_id and not self.get_topic(topic_id):
            raise ValueError("The active topic is no longer available.")
        key = uuid.uuid4().hex
        created = _stamp(self._clock())
        self._put("decisions", key, text, id=key, owner_id=self.owner_id, topic_id=topic_id,
                  source="owner_stated", confidence=1.0, reason=_clean(reason, 600),
                  created_at=created, updated=created)
        return {"id": key, "value": text, "topic_id": topic_id, "reason": _clean(reason, 600),
                "created_at": created}

    def add_task(self, title: str, *, topic_id: str = "", due_at: str = "") -> dict:
        title = _clean(title, 800)
        if not title:
            raise ValueError("The task text is empty.")
        if topic_id and not self.get_topic(topic_id):
            raise ValueError("The active topic is no longer available.")
        key, created = uuid.uuid4().hex, _stamp(self._clock())
        self._put("tasks", key, title, id=key, owner_id=self.owner_id, topic_id=topic_id,
                  status="open", source="owner_stated", confidence=1.0,
                  due_at=_clean(due_at, 80), created_at=created, updated=created)
        return {"id": key, "value": title, "topic_id": topic_id, "status": "open",
                "due_at": _clean(due_at, 80), "created_at": created}

    def update_task(self, task_id: str, status: str) -> dict:
        if status not in _TASK_STATUSES:
            raise ValueError("Task status must be open, done or cancelled.")
        row = self._record("tasks", self._valid_id(task_id))
        if not row:
            raise LookupError("That task is not available in this local profile.")
        now = _stamp(self._clock())
        self._put("tasks", row["key"], row.get("value", ""), status=status, updated=now,
                  owner_id=self.owner_id)
        return {"id": row["key"], "value": row.get("value", ""), "status": status,
                "topic_id": row.get("topic_id", "")}

    def list_tasks(self, *, topic_id: str = "", status: str = "") -> list[dict]:
        rows = self._items("tasks")
        if topic_id:
            rows = [r for r in rows if r.get("topic_id") == topic_id]
        if status:
            rows = [r for r in rows if r.get("status", "open") == status]
        rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        return [{"id": r.get("key"), "value": r.get("value", ""), "topic_id": r.get("topic_id", ""),
                 "status": r.get("status", "open"), "due_at": r.get("due_at", ""),
                 "created_at": r.get("created_at", ""), "updated": r.get("updated", "")}
                for r in rows[:200]]

    def add_research(self, query: str, answer: str, sources: list[dict], *, topic_id: str = "",
                     model: str = "") -> dict | None:
        safe_sources = []
        for source in (sources or [])[:MAX_SOURCES]:
            if not isinstance(source, dict):
                continue
            url = _clean(source.get("url"), 1800)
            if not _valid_url(url):
                continue
            safe_sources.append({"url": url, "title": _clean(source.get("title"), 240)})
        if not safe_sources:
            return None
        key, retrieved = uuid.uuid4().hex, _stamp(self._clock())
        self._put("research", key, _clean(answer, 1200), id=key, owner_id=self.owner_id,
                  topic_id=topic_id or "", query=_clean(query, 400), sources=safe_sources,
                  retrieved_at=retrieved, model=_clean(model, 120), source="google_search_grounding",
                  confidence=0.75, verification="provider-grounded; sources not independently audited",
                  created_at=retrieved, updated=retrieved)
        return {"id": key, "query": _clean(query, 400), "answer": _clean(answer, 1200),
                "sources": safe_sources, "retrieved_at": retrieved,
                "verification": "provider-grounded; sources not independently audited",
                "topic_id": topic_id or ""}

    def list_research(self, *, topic_id: str = "", query: str = "", limit: int = 50) -> list[dict]:
        rows = self._items("research")
        if topic_id:
            rows = [r for r in rows if r.get("topic_id") == topic_id]
        if query.strip():
            allowed = {(r.get("category"), r.get("key")) for r in self.search(query, topic_id=topic_id, limit=100)}
            rows = [r for r in rows if ("research", r.get("key")) in allowed]
        rows.sort(key=lambda r: str(r.get("retrieved_at") or ""), reverse=True)
        return [{"id": r.get("key"), "query": r.get("query", ""), "answer": r.get("value", ""),
                 "sources": r.get("sources", []), "retrieved_at": r.get("retrieved_at", ""),
                 "verification": r.get("verification", ""), "topic_id": r.get("topic_id", "")}
                for r in rows[:max(1, min(int(limit), 200))]]

    def create_backup(self) -> dict:
        self._validate_existing_file()
        with self._lock:
            result = self._create_verified_backup_set("manual")
        result["backups"] = self.backup_status()["count"]
        return result

    def backup_status(self) -> dict:
        folder = self.memory_path.parent / "backups"
        manifests = list(folder.glob("brain.*.manifest.json")) if folder.exists() else []
        legacy = list(folder.glob("long_term.*.json")) if folder.exists() else []
        managed_files = set()
        for manifest in manifests:
            try:
                payload = json.loads(manifest.read_text(encoding="utf-8"))
                managed_files.update(row.get("backup", "") for row in payload.get("files", [])
                                     if isinstance(row, dict))
            except Exception:
                continue
        legacy = [path for path in legacy if path.name not in managed_files]
        items = manifests + legacy
        latest = max(items, key=lambda path: path.stat().st_mtime) if items else None
        return {"count": len(items),
                "latest_at": datetime.fromtimestamp(latest.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
                if latest else None, "latest_size_bytes": latest.stat().st_size if latest else None}

    def status(self) -> dict:
        path = self.memory_path
        error = ""
        if path.exists():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(value, dict):
                    error = "unsupported_format"
            except Exception:
                error = "unreadable"
        try:
            memory = mm.load_memory()
            counts = {str(category): len(items) for category, items in memory.items() if isinstance(items, dict)}
        except Exception:
            counts = {}
            error = error or "unavailable"
        return {"available": not bool(error), "file_present": path.exists(), "storage_error": error,
                "entries_by_category": counts, "topic_count": len(self._topics()),
                "open_task_count": len(self.list_tasks(status="open")),
                "research_count": len(self._items("research")), "backup": self.backup_status(),
                "owner_scope": "single local profile"}

    def live_context(self) -> str:
        """Bounded context for the optional Gemini Live instruction at connection time."""
        topic = next((t for t in self._topics() if t.get("status") == "active"), None)
        topic_id = topic.get("id") if topic else None
        sections = [self._context_block(topic_id, "")]
        if topic_id:
            scoped = [row for category in sorted(_MEMORY_CATEGORIES) for row in self._items(category)
                      if row.get("topic_id") == topic_id]
            scoped.sort(key=lambda row: str(row.get("updated", "")), reverse=True)
            if scoped:
                sections.append("[ACTIVE TOPIC-SCOPED RECORDS]\n" + "\n".join(
                    f"- {row['category']}/{row['key']}: {_clean(row.get('value'), 400)}"
                    for row in scoped[:8] if _clean(row.get("value"), 400)))
        body = "\n\n".join(section for section in sections if section)
        return body[:MAX_CONTEXT_CHARS - 1].rstrip() + "…" if len(body) > MAX_CONTEXT_CHARS else body

    def capture_explicit_memory(self, raw_text: str, *, topic_id: str = "") -> dict:
        statement = re.sub(r"^(?:please\s+)?(?:remember|save to memory)(?:\s+(?:that|this))?\s*[:,]?\s*",
                           "", _clean(raw_text, 1600), flags=re.IGNORECASE)
        parsed = self._parse_memory_statement(statement)
        if topic_id and parsed[0] == "projects":
            scope = topic_id
        else:
            scope = ""
        return self.add_memory(parsed[0], parsed[1], parsed[2], source="explicit", confidence=1.0,
                               topic_id=scope, provenance="user explicitly requested memory")

    def _parse_memory_statement(self, statement: str) -> tuple[str, str, str]:
        statement = _clean(statement, 1600)
        match = re.fullmatch(r"(?P<cat>[a-z_]{2,24})/(?P<key>[^=:\n]{1,160})\s*(?:=|:)\s*(?P<value>.+)", statement, re.I)
        if match:
            category = match.group("cat").casefold()
            if category not in _MEMORY_CATEGORIES:
                raise ValueError("Use a supported category such as identity, preferences, projects or notes.")
            return category, _clean(match.group("key"), 160), _clean(match.group("value"), 1200)
        match = re.fullmatch(r"my\s+name\s+is\s+(.+)", statement, re.I)
        if match:
            return "identity", "name", _clean(match.group(1))
        match = re.fullmatch(r"(?:i\s+live\s+in|my\s+city\s+is)\s+(.+)", statement, re.I)
        if match:
            return "identity", "city", _clean(match.group(1))
        match = re.fullmatch(r"my\s+(?:favorite|favourite)\s+(.+?)\s+is\s+(.+)", statement, re.I)
        if match:
            return "preferences", "favorite_" + _slug(match.group(1)), _clean(match.group(2))
        match = re.fullmatch(r"i\s+(?:prefer|like|love)\s+(.+)", statement, re.I)
        if match:
            return "preferences", "general_preference", _clean(match.group(1))
        match = re.fullmatch(r"my\s+(?P<key>name|age|birthday|city|job|language|school|nationality)\s+is\s+(.+)",
                            statement, re.I)
        if match:
            return "identity", match.group("key").casefold(), _clean(match.group(2))
        key = _slug(statement)
        return "notes", key, statement

    def correct_explicit_memory(self, raw_text: str, *, topic_id: str = "") -> dict | None:
        statement = re.sub(r"^(?:please\s+)?(?:correction|correct)(?:\s+that)?\s*[:,]?\s*",
                           "", _clean(raw_text, 1600), flags=re.IGNORECASE)
        match = re.fullmatch(r"(?P<cat>[a-z_]{2,24})/(?P<key>[^=:\n]{1,160})\s*(?:=|:|\bto\b|\bis\b)\s*(?P<value>.+)",
                             statement, re.I)
        if match:
            category = match.group("cat").casefold()
            key, value = _clean(match.group("key"), 160), _clean(match.group("value"), 1200)
        else:
            try:
                category, key, value = self._parse_memory_statement(statement)
            except ValueError:
                return None
        scope = topic_id if category == "projects" else ""
        return self.correct_memory(category, key, value, reason="explicit user correction",
                                   topic_id=scope)

    def record_decision_statement(self, statement: str, *, topic_id: str = "") -> dict:
        text = re.sub(r"^(?:we\s+decided|the\s+decision\s+is)(?:\s+that)?\s*[:,]?\s*", "",
                      _clean(statement, 1500), flags=re.IGNORECASE)
        return self.add_decision(text, topic_id=topic_id)

    def set_topic_field_from_statement(self, field: str, value: str, *, topic_id: str = "") -> dict | None:
        topic = self.get_topic(topic_id) if topic_id else None
        if not topic:
            return None
        value = _clean(value, 800)
        if not value:
            return None
        return self.update_topic(topic_id, {field: value})

    def explicit_goal(self, statement: str, *, topic_id: str = "") -> dict | None:
        value = re.sub(r"^(?:the\s+)?(?:project\s+)?goal(?:\s+is)?\s*[:=]?\s*", "", statement,
                       flags=re.IGNORECASE).strip()
        return self.set_topic_field_from_statement("goal", value, topic_id=topic_id)

    def explicit_next_step(self, statement: str, *, topic_id: str = "") -> dict | None:
        value = re.sub(r"^(?:the\s+)?next\s+step(?:\s+is)?\s*[:=]?\s*", "", statement,
                       flags=re.IGNORECASE).strip()
        return self.set_topic_field_from_statement("next_step", value, topic_id=topic_id)

    def explicit_task(self, statement: str, *, topic_id: str = "") -> dict:
        value = re.sub(r"^(?:task|todo)(?:\s+is)?\s*[:=]?\s*", "", statement,
                       flags=re.IGNORECASE).strip()
        return self.add_task(value, topic_id=topic_id)
