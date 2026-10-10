"""Local recall: answer a question from stored facts, but only when they clearly hold the answer.

Runs before Gemini. A stored fact is used only if it contains every meaningful word of the
question (after dropping filler words like "what", "my" and "is"). If nothing matches, this
returns nothing and the question goes on to Gemini, as before. Read-only: memory is never changed.

Provenance: written for this project, from the owner's rule that the AI is used only when nothing
else holds the information (2026-10-10). No code or text taken from other projects.
"""
from __future__ import annotations

import re

MAX_FACTS = 5
MAX_VALUE_CHARS = 300

# Words that carry no meaning for matching. Kept short on purpose.
_STOP = frozenset({
    "what", "whats", "what's", "is", "was", "are", "were", "my", "me", "the", "a", "an", "do", "you",
    "know", "remember", "about", "of", "for", "your", "i", "tell", "did", "say", "anything", "it",
    "that", "to", "in", "on", "and", "or", "this", "please", "has", "have",
})


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def _stem(word: str) -> str:
    # "colours" matches "colour"; plain plurals only. Short words are left alone.
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def keywords(query: str) -> list[str]:
    return [_stem(w) for w in _words(query) if len(w) > 1 and w not in _STOP]


def _value_of(entry) -> str:
    raw = entry.get("value") if isinstance(entry, dict) else entry
    return str(raw).strip() if raw is not None else ""


def find_facts(query: str, limit: int = MAX_FACTS) -> list[tuple[str, str, str]]:
    """Stored facts (category, key, value) that match every keyword of `query`. Empty if none do."""
    words = keywords(query)
    if not words:
        return []
    from memory.memory_manager import load_memory

    memory = load_memory()
    hits: list[tuple[str, str, str]] = []
    for category, items in memory.items():
        if not isinstance(items, dict):          # skip lists such as 'sessions'
            continue
        for key, entry in items.items():
            value = _value_of(entry)
            if not value:
                continue
            key_words = {_stem(w) for w in _words(str(key))}
            value_words = {_stem(w) for w in _words(value)}
            if all(w in key_words or w in value_words for w in words):
                hits.append((category, str(key), value))
    return hits[:max(1, limit)]


def describe(facts: list[tuple[str, str, str]]) -> str:
    """One line per fact, for the chat. The value is cut short if it is very long."""
    parts = []
    for _category, key, value in facts:
        shown = value if len(value) <= MAX_VALUE_CHARS else value[:MAX_VALUE_CHARS].rstrip() + "..."
        parts.append(f"{key.replace('_', ' ')}: {shown}")
    return "; ".join(parts)
