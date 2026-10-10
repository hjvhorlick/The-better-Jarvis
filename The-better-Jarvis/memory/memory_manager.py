import copy
import json
import os
import shutil
import re
from datetime import datetime
from threading import Lock
from pathlib import Path
import sys


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR         = get_base_dir()
MEMORY_PATH      = BASE_DIR / "memory" / "long_term.json"
_lock            = Lock()
MAX_VALUE_LENGTH = 1200

# ── Why there are two very different numbers here ────────────────────────────
#
# There used to be one: MEMORY_MAX_CHARS = 2200, applied to the whole store. It
# was a *storage* limit, and it existed only because the entire memory was
# pasted into the system prompt on every connect — so growing the memory grew
# every single request. When it filled, _trim_to_limit() deleted the oldest
# entries and printed one line to a console nobody reads. A memory described as
# "deeply remembers projects, preferences and personal context" was in practice
# two pages long, and quietly forgot your sister's name after a few weeks.
#
# Storage and prompt budget are now separate concerns:
#
#   MEMORY_MAX_CHARS  — a runaway guard, not a feature limit. Nothing normal
#                       reaches it; a bug writing in a loop does.
#   PROMPT_CORE_CHARS — what actually rides in the system prompt every session.
#                       Smaller than the old whole-memory dump, so sessions
#                       start *faster* than before, not slower.
#
# Everything above the core stays on disk and is fetched on demand by the
# recall_memory tool — see search_memory() and format_memory_for_prompt().
MEMORY_MAX_CHARS  = 200_000
PROMPT_CORE_CHARS = 2500
PROMPT_INDEX_CHARS = 1000
# Most entries any one category may contribute to the core block, so a person
# with forty stored preferences still gets their sister into the prompt.
PROMPT_MAX_PER_CATEGORY = 25

DIALOGUE_PATH = BASE_DIR / "memory" / "recent_dialogue.json"
MAX_DIALOGUE_TURNS = 60

def _empty_memory() -> dict:
    return {
        "identity":      {},
        "preferences":   {},
        "projects":      {},
        "relationships": {},
        "wishes":        {},
        "notes":         {},
    }

def load_memory() -> dict:
    if not MEMORY_PATH.exists():
        return _empty_memory()
    with _lock:
        try:
            data = json.loads(MEMORY_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                base = _empty_memory()
                for key in base:
                    if key not in data:
                        data[key] = {}
                return data
            return _empty_memory()
        except Exception as e:
            print(f"[Memory] ⚠️ Load error: {e}")
            return _empty_memory()

def _all_entries(memory: dict) -> list[tuple]:
    entries = []
    for cat, items in memory.items():
        if not isinstance(items, dict):
            continue
        for key, entry in items.items():
            if isinstance(entry, dict) and "value" in entry:
                entries.append((cat, key, entry))
    return entries


# Set by main.py so a trim can reach the activity log. Deleting something a
# person told you and mentioning it only on stdout is how a memory loses trust.
_trim_notifier = None


def set_trim_notifier(fn) -> None:
    """Register a callable(str) that surfaces trims to the user."""
    global _trim_notifier
    _trim_notifier = fn


ARCHIVE_NAME = "memory_archive.json"


def _archive_path() -> Path:
    return MEMORY_PATH.with_name(ARCHIVE_NAME)


def _archive(records: list[dict]) -> None:
    """Append records to memory_archive.json (append-only, written atomically).

    Raises if the existing archive cannot be read as a list, or the write fails. The caller then
    leaves long_term.json unchanged, so nothing is removed without a copy."""
    if not records:
        return
    path = _archive_path()
    current: list = []
    if path.exists():
        current = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(current, list):
            raise ValueError("memory_archive.json is not a list; nothing was archived")
    stamp = datetime.now().isoformat(timespec="seconds")
    current.extend({"archived": stamp, **r} for r in records)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _trim_to_limit(memory: dict) -> dict:
    """If long_term.json is over MEMORY_MAX_CHARS, move the least recently updated entries to the
    archive. Nothing is deleted. The active file only keeps what fits."""
    if len(json.dumps(memory, ensure_ascii=False)) <= MEMORY_MAX_CHARS:
        return memory
    memory = copy.deepcopy(memory)
    entries = _all_entries(memory)
    entries.sort(key=lambda t: t[2].get("updated", "0000-00-00"))
    moved = []
    for cat, key, rec in entries:
        if len(json.dumps(memory, ensure_ascii=False)) <= MEMORY_MAX_CHARS:
            break
        del memory[cat][key]
        moved.append({"kind": "entry", "category": cat, "key": key, "record": rec})
    if moved:
        _archive(moved)                       # raises before anything is written if it fails
        names = [f"{m['category']}/{m['key']}" for m in moved]
        print(f"[Memory] 📦 Moved {len(moved)} oldest entries to {ARCHIVE_NAME}: {', '.join(names[:5])}")
        if _trim_notifier:
            try:
                _trim_notifier(
                    f"SYS: Memory is full. Moved {len(moved)} oldest entries to the archive "
                    f"({', '.join(names[:3])}{'…' if len(names) > 3 else ''}). Nothing was deleted."
                )
            except Exception:
                pass
    return memory

def save_memory(memory: dict) -> None:
    if not isinstance(memory, dict):
        return
    memory = _trim_to_limit(memory)
    MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        MEMORY_PATH.write_text(
            json.dumps(memory, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def _truncate_value(val: str) -> str:
    if isinstance(val, str) and len(val) > MAX_VALUE_LENGTH:
        return val[:MAX_VALUE_LENGTH].rstrip() + "…"
    return val


def _recursive_update(target: dict, updates: dict) -> bool:
    changed = False
    for key, value in updates.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, dict) and "value" not in value:
            if key not in target or not isinstance(target[key], dict):
                target[key] = {}
                changed = True
            if _recursive_update(target[key], value):
                changed = True
        else:
            new_val  = _truncate_value(str(value["value"] if isinstance(value, dict) else value))
            entry    = {"value": new_val, "updated": datetime.now().strftime("%Y-%m-%d")}
            existing = target.get(key, {})
            if not isinstance(existing, dict) or existing.get("value") != new_val:
                target[key] = entry
                changed = True
    return changed


def update_memory(memory_update: dict) -> dict:
    if not isinstance(memory_update, dict) or not memory_update:
        return load_memory()
    memory = load_memory()
    if _recursive_update(memory, memory_update):
        save_memory(memory)
        print(f"[Memory] 💾 Saved: {list(memory_update.keys())}")
    return memory

def _entry_value(entry) -> str:
    """Accept both the {'value': ..., 'updated': ...} shape and a bare string,
    because early versions of the store wrote plain strings."""
    if isinstance(entry, dict):
        return str(entry.get("value", "") or "").strip()
    return str(entry or "").strip()


def _pretty(key: str) -> str:
    return key.replace("_", " ").strip()


# Identity is always in the prompt; these categories compete for the remaining
# budget by recency.
_CATEGORY_LABELS = {
    "preferences":   "Preferences",
    "projects":      "Active projects / goals",
    "relationships": "People in their life",
    "wishes":        "Wishes / plans",
    "notes":         "Notes",
}

_IDENTITY_FIELDS = ["name", "age", "birthday", "city", "job",
                    "language", "school", "nationality"]


def format_memory_for_prompt(memory: dict | None) -> str:
    """Build the memory block that goes into the system prompt.

    This used to dump everything. It now sends three things:

      1. IDENTITY  - always, in full. It is small, and it is wrong for the
         assistant to have to look up your name.
      2. RECENT    - the most recently updated entries from every other
         category, up to PROMPT_CORE_CHARS. Recency is the cheapest useful
         relevance signal available without embeddings.
      3. AN INDEX  - the *keys* of everything else, values omitted.

    Point 3 is what makes recall work at all. A model cannot decide to look
    something up if it does not know the thing exists: with only points 1 and 2,
    "who is Ayse?" would get "I don't know" while ayse_sister sat on disk
    unread. The index costs a few hundred characters and turns recall from a
    gamble into a lookup.

    Net effect on latency: this block is SMALLER than the old full dump, so
    every session connects with fewer tokens. Occasionally the model spends one
    extra round trip on recall_memory - covered by the acknowledgment it
    already speaks before any slow step."""
    if not memory:
        return ""

    core_lines: list[str] = []

    # 1. Identity - always, in full
    identity = memory.get("identity", {}) or {}
    for field in _IDENTITY_FIELDS:
        val = _entry_value(identity.get(field))
        if not val:
            continue
        if field == "language":
            # Labelled as an observation, not a setting. A bare "Language:
            # English" line written months ago reads like a standing order and
            # was one of the reasons a Turkish question came back in English.
            core_lines.append(
                f"Has spoken to you in: {val} (an observation about the past — "
                f"always answer in the language of their CURRENT message)")
        else:
            core_lines.append(f"{field.title()}: {val}")
    for key, entry in identity.items():
        if key in _IDENTITY_FIELDS:
            continue
        val = _entry_value(entry)
        if val:
            core_lines.append(f"{_pretty(key).title()}: {val}")

    # 2. Everything else, most recently updated first
    rest: list[tuple[str, str, str, str]] = []   # (updated, cat, key, value)
    for cat in _CATEGORY_LABELS:
        for key, entry in (memory.get(cat, {}) or {}).items():
            val = _entry_value(entry)
            if not val:
                continue
            updated = (entry.get("updated", "") if isinstance(entry, dict) else "") or "0000-00-00"
            rest.append((updated, cat, key, val))
    rest.sort(key=lambda t: t[0], reverse=True)

    used    = sum(len(l) + 1 for l in core_lines)
    shown: dict[str, list[str]] = {}
    overflow: dict[str, list[str]] = {}

    # Recency decides order, but no single category may take the whole budget.
    # Without the cap, someone with forty stored preferences gets a prompt that
    # is forty preferences and not one person's name — the categories that
    # matter most in conversation are also the ones that change least often, so
    # pure recency systematically buries them.
    per_cat_used: dict[str, int] = {}
    for _updated, cat, key, val in rest:
        line = f"  - {_pretty(key).title()}: {val}"
        if (per_cat_used.get(cat, 0) < PROMPT_MAX_PER_CATEGORY
                and used + len(line) + 1 <= PROMPT_CORE_CHARS):
            shown.setdefault(cat, []).append(line)
            per_cat_used[cat] = per_cat_used.get(cat, 0) + 1
            used += len(line) + 1
        else:
            overflow.setdefault(cat, []).append(_pretty(key))

    # The index is a table of contents, so it is interleaved across categories
    # rather than continuing in recency order. Sorted by recency it would list
    # twenty-four preferences before the first relationship, and the one entry
    # the index exists for — the old fact the model has no other way to know
    # about — would fall off the end.
    indexed: list[str] = []
    if overflow:
        cats  = [c for c in _CATEGORY_LABELS if overflow.get(c)]
        cursor = {c: 0 for c in cats}
        while cats:
            for cat in list(cats):
                i = cursor[cat]
                if i >= len(overflow[cat]):
                    cats.remove(cat)
                    continue
                indexed.append(overflow[cat][i])
                cursor[cat] = i + 1

    for cat, label in _CATEGORY_LABELS.items():
        if shown.get(cat):
            core_lines.append("")
            core_lines.append(f"{label}:")
            core_lines.extend(shown[cat])

    if not core_lines and not indexed:
        return ""

    out = [
        "[WHAT YOU KNOW ABOUT THIS PERSON — use naturally, never recite like a list]",
        *core_lines,
    ]

    # 3. The index of what is on disk but not in this prompt
    if indexed:
        budget, names = PROMPT_INDEX_CHARS, []
        for n in indexed:
            if budget - len(n) - 2 < 0:
                break
            names.append(n)
            budget -= len(n) + 2
        if names:
            out.append("")
            out.append(
                "[ALSO REMEMBERED — values not shown here. Call recall_memory "
                "with a keyword to read any of these before saying you do not know]"
            )
            out.append(", ".join(names)
                       + (f" (+{len(indexed) - len(names)} more)"
                          if len(indexed) > len(names) else ""))

    return "\n".join(out) + "\n"


# ── Recall ────────────────────────────────────────────────────────────────────

def _score(query_words: list[str], cat: str, key: str, value: str) -> int:
    """Cheap lexical relevance. No embeddings, no network, no model call - this
    runs in well under a millisecond, which is the entire point: recall must
    cost one model round trip, never two."""
    hay_key = _pretty(key).lower()
    hay_val = value.lower()
    score   = 0
    for w in query_words:
        if not w:
            continue
        if w == hay_key:
            score += 10
        elif w in hay_key:
            score += 6
        if w in hay_val:
            score += 3
        if w in cat:
            score += 1
    return score


def search_memory(query: str, limit: int = 20) -> str:
    """Find stored facts matching `query`. Backs the recall_memory tool.

    An empty query is treated as "show me everything you know", capped - the
    model asks that when the user says "what do you remember about me?"."""
    memory = load_memory()
    words  = [w for w in re.split(r"[^\w]+", (query or "").lower()) if len(w) > 1]

    rows: list[tuple[int, str, str, str]] = []
    for cat, items in memory.items():
        if not isinstance(items, dict):
            continue                     # skip 'sessions', which is a list
        for key, entry in items.items():
            val = _entry_value(entry)
            if not val:
                continue
            s = _score(words, cat, key, val) if words else 1
            if s > 0:
                rows.append((s, cat, key, val))

    if not rows:
        return (f"Nothing stored about '{query}'." if query
                else "I have not stored anything about this person yet.")

    rows.sort(key=lambda r: (-r[0], r[2]))
    lines = [f"{cat}/{_pretty(key)}: {val}" for _s, cat, key, val in rows[:max(1, limit)]]
    head  = (f"Stored facts matching '{query}':" if query
             else "Everything currently stored:")
    more  = (f"\n(+{len(rows) - len(lines)} more — search with a narrower keyword)"
             if len(rows) > len(lines) else "")
    return head + "\n" + "\n".join(lines) + more


def all_entries_for_ui() -> list[dict]:
    """Flat list for the memory panel: what JARVIS knows, and when it learned it.
    Sorted newest first so the panel opens on what changed most recently."""
    memory = load_memory()
    rows = []
    for cat, items in memory.items():
        if not isinstance(items, dict):
            continue
        for key, entry in items.items():
            val = _entry_value(entry)
            if not val:
                continue
            rows.append({
                "category": cat,
                "key":      key,
                "value":    val,
                "updated":  (entry.get("updated", "") if isinstance(entry, dict) else ""),
            })
    rows.sort(key=lambda r: (r["updated"] or "0000-00-00"), reverse=True)
    return rows

def remember(key: str, value: str, category: str = "notes") -> str:
    valid = {"identity", "preferences", "projects", "relationships", "wishes", "notes"}
    if category not in valid:
        category = "notes"
    update_memory({category: {key: {"value": value}}})
    return f"Remembered: {category}/{key} = {value}"


def forget(key: str, category: str = "notes") -> str:
    memory = load_memory()
    cat    = memory.get(category, {})
    if key in cat:
        del cat[key]
        memory[category] = cat
        save_memory(memory)
        return f"Forgotten: {category}/{key}"
    return f"Not found: {category}/{key}"


forget_memory = forget


# ── Session memory ─────────────────────────────────────────────────────────────

_SESSION_MAX = 15   # keep the newest 15 in long_term.json; older ones go to the archive


def save_session_summary(summary: str, language: str = "") -> None:
    """Append a 1-2 sentence session summary to long_term.json['sessions']."""
    summary = (summary or "").strip()
    if not summary:
        return
    memory   = load_memory()
    sessions = memory.get("sessions", [])
    if not isinstance(sessions, list):
        sessions = []
    entry: dict = {
        "date":    datetime.now().strftime("%Y-%m-%d"),
        "time":    datetime.now().strftime("%H:%M:%S"),
        "summary": summary[:1200],
        "briefed": False,
    }
    if language:
        entry["language"] = language
    sessions.append(entry)
    if len(sessions) > _SESSION_MAX:
        _archive([{"kind": "session", "record": r} for r in sessions[:-_SESSION_MAX]])
    memory["sessions"] = sessions[-_SESSION_MAX:]
    with _lock:
        MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        MEMORY_PATH.write_text(
            json.dumps(memory, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    print(f"[Memory] 📝 Session saved ({entry['date']}): {summary[:60]}…")


def pop_last_session() -> dict | None:
    """
    Return the most recent unbriefed session entry and mark it as briefed.
    Preserves the entry in history rather than destructively deleting it.
    """
    with _lock:
        if not MEMORY_PATH.exists():
            return None
        try:
            memory   = json.loads(MEMORY_PATH.read_text(encoding="utf-8"))
            sessions = memory.get("sessions", [])
            if not isinstance(sessions, list) or not sessions:
                return None
            for entry in reversed(sessions):
                if not entry.get("briefed", False):
                    entry["briefed"] = True
                    memory["sessions"] = sessions
                    MEMORY_PATH.write_text(
                        json.dumps(memory, indent=2, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    return entry
            return None
        except Exception as e:
            print(f"[Memory] ⚠️ pop_last_session error: {e}")
            return None


def get_last_session() -> dict | None:
    """Return the most recent session entry without marking or consuming it."""
    with _lock:
        if not MEMORY_PATH.exists():
            return None
        try:
            memory = json.loads(MEMORY_PATH.read_text(encoding="utf-8"))
            sessions = memory.get("sessions", [])
            if isinstance(sessions, list) and sessions:
                return sessions[-1]
            return None
        except Exception:
            return None


# --- Live Dialogue Persistence ---
DIALOGUE_PATH = BASE_DIR / "memory" / "recent_dialogue.json"
MAX_DIALOGUE_TURNS = 60

def _dialogue_archive_path() -> Path:
    return DIALOGUE_PATH.with_name("dialogue_archive.jsonl")


def _append_dialogue_archive(turns: list) -> None:
    """Append turns to dialogue_archive.jsonl, one JSON line each. Raises if the write fails, so the
    caller keeps the turns where they are. Append-only, so each turn costs one line, not a rewrite."""
    if not turns:
        return
    path = _dialogue_archive_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    with path.open("a", encoding="utf-8") as f:
        for t in turns:
            f.write(json.dumps({"archived": stamp, "turn": t}, ensure_ascii=False) + "\n")
        f.flush()


def _read_dialogue_for_append() -> list:
    """Read the live dialogue log. A log that cannot be read is copied aside (never overwritten)
    and a fresh log is started."""
    if not DIALOGUE_PATH.exists():
        return []
    try:
        turns = json.loads(DIALOGUE_PATH.read_text(encoding="utf-8"))
        if not isinstance(turns, list):
            raise ValueError("top level is not a list")
        return turns
    except Exception as e:
        aside = DIALOGUE_PATH.with_name(f"{DIALOGUE_PATH.name}.corrupt-{datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(DIALOGUE_PATH, aside)
        print(f"[Memory] recent_dialogue.json could not be read ({e}); a copy is at {aside.name}")
        return []


def append_dialogue_turn(speaker: str, text: str) -> None:
    """Save a turn now. Turns beyond MAX_DIALOGUE_TURNS move to dialogue_archive.jsonl. If the
    archive cannot be written, nothing is dropped and the log keeps every turn."""
    text = (text or "").strip()
    if not text:
        return
    with _lock:
        try:
            turns = _read_dialogue_for_append()
            turns.append({
                "speaker": speaker,
                "text": text,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
            if len(turns) > MAX_DIALOGUE_TURNS:
                overflow = turns[:-MAX_DIALOGUE_TURNS]
                try:
                    _append_dialogue_archive(overflow)
                    turns = turns[-MAX_DIALOGUE_TURNS:]
                except Exception as e:
                    print(f"[Memory] dialogue archive unavailable, keeping all turns: {e}")
            DIALOGUE_PATH.parent.mkdir(parents=True, exist_ok=True)
            DIALOGUE_PATH.write_text(json.dumps(turns, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            print(f"[Memory] Error saving dialogue turn: {e}")

def get_recent_dialogue(limit: int = 12) -> list:
    with _lock:
        if not DIALOGUE_PATH.exists():
            return []
        try:
            turns = json.loads(DIALOGUE_PATH.read_text(encoding="utf-8"))
            return turns[-max(1, limit):] if isinstance(turns, list) else []
        except Exception:
            return []

def format_dialogue_for_prompt(limit: int = 8) -> str:
    turns = get_recent_dialogue(limit)
    if not turns:
        return ""
    lines = [f"{t.get('speaker', 'Unknown')}: {t.get('text', '')}" for t in turns if t.get('text')]
    if not lines:
        return ""
    return "[RECENT DIALOGUE CONTEXT]\n" + "\n".join(lines) + "\n"

def clear_recent_dialogue() -> None:
    """Clear the live dialogue log. Every turn is written to dialogue_archive.jsonl first. If that
    write fails, the live log is left as it is."""
    with _lock:
        if not DIALOGUE_PATH.exists():
            return
        turns = _read_dialogue_for_append()
        _append_dialogue_archive(turns)          # raises before the live log is removed
        DIALOGUE_PATH.unlink(missing_ok=True)


# ----- archive search and restore (owner request, 2026-10-09) -----
# Read-only search over both archives. Restore copies one archived memory fact back into
# long_term.json. It never overwrites a current entry, and it refuses if there is no room, so the
# size trim cannot archive the restored fact again. The archive keeps its copy. Only memory facts
# can be restored. Session summaries and dialogue turns can be searched but not restored.


class ArchiveUnreadable(RuntimeError):
    """memory_archive.json exists but is not a JSON list. It is never rewritten by search or restore."""


def _read_memory_archive() -> list:
    path = _archive_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        raise ArchiveUnreadable(f"memory_archive.json is not valid JSON ({e})") from e
    if not isinstance(data, list):
        raise ArchiveUnreadable("memory_archive.json is not a list")
    return data


def _read_dialogue_archive() -> list:
    """(line_number, turn) pairs. An unreadable line is skipped and the file is left alone."""
    path = _dialogue_archive_path()
    if not path.exists():
        return []
    out = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            out.append((n, json.loads(line)["turn"]))
        except Exception:
            continue
    return out


def _is_active(category: str, key: str, value) -> bool:
    cur = load_memory().get(category, {})
    return isinstance(cur, dict) and isinstance(cur.get(key), dict) and cur[key].get("value") == value


def search_archive(query: str, limit: int = 10) -> dict:
    """Case-insensitive search. Returns {"total": n, "matches": [...]}, newest matches last.

    Memory-fact matches carry an `id` (their position in memory_archive.json, which only grows).
    Other matches have `id` None and cannot be restored."""
    q = (query or "").strip().lower()
    if not q:
        raise ValueError("search text is empty")
    hits: list[dict] = []
    for idx, rec in enumerate(_read_memory_archive()):
        if not isinstance(rec, dict):
            continue
        body = rec.get("record") or {}
        if rec.get("kind") == "entry":
            cat, key, value = rec.get("category", ""), rec.get("key", ""), body.get("value")
            text = f"{cat}/{key}: {value}"
            if q in text.lower():
                hits.append({"id": idx, "source": "memory", "text": text,
                             "archived": rec.get("archived", ""),
                             "active_now": _is_active(cat, key, value)})
        elif rec.get("kind") == "session":
            summary = str(body.get("summary", ""))
            if q in summary.lower():
                hits.append({"id": None, "source": "session", "text": summary,
                             "archived": rec.get("archived", ""), "active_now": False})
    for n, turn in _read_dialogue_archive():
        text = f"{turn.get('speaker', '?')}: {turn.get('text', '')}"
        if q in text.lower():
            hits.append({"id": None, "source": "dialogue", "text": text, "line": n,
                         "archived": turn.get("time", ""), "active_now": False})
    return {"total": len(hits), "matches": hits[-max(1, limit):]}


def describe_archive_entry(archive_id: int) -> str | None:
    """Short text for a restorable memory-fact archive entry, or None if there is none."""
    try:
        archive = _read_memory_archive()
    except Exception:
        return None
    if 0 <= archive_id < len(archive) and isinstance(archive[archive_id], dict) \
            and archive[archive_id].get("kind") == "entry":
        r = archive[archive_id]
        return f"{r.get('category')}/{r.get('key')} = {(r.get('record') or {}).get('value')}"
    return None


def restore_archive_entry(archive_id: int) -> str:
    """Copy archived memory fact `archive_id` back into long_term.json. Returns a message.

    Raises LookupError (no such memory fact), FileExistsError (the key already has a value; nothing
    is changed) or ValueError (no room under MEMORY_MAX_CHARS; nothing is changed)."""
    archive = _read_memory_archive()
    if not (0 <= archive_id < len(archive)) or not isinstance(archive[archive_id], dict) \
            or archive[archive_id].get("kind") != "entry":
        raise LookupError(f"There is no archived memory fact number {archive_id}.")
    rec = archive[archive_id]
    cat, key, record = rec["category"], rec["key"], dict(rec["record"])
    memory = load_memory()
    bucket = memory.setdefault(cat, {})
    if not isinstance(bucket, dict):
        raise ValueError(f"the '{cat}' category is not a list of facts")
    if key in bucket:
        raise FileExistsError(f"{cat}/{key} already has a value. Change or forget it first, then restore.")
    candidate = copy.deepcopy(memory)
    candidate[cat][key] = record
    if len(json.dumps(candidate, ensure_ascii=False)) > MEMORY_MAX_CHARS:
        raise ValueError("memory is full. Forget or change something first, then restore.")
    bucket[key] = record
    save_memory(memory)
    return f"Restored {cat}/{key}. The archive still has its copy."

