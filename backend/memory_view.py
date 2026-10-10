"""Read-only memory summary. Returns counts only — never stored values."""
from __future__ import annotations


def memory_summary() -> dict:
    from memory.memory_manager import MEMORY_PATH, load_memory

    present = MEMORY_PATH.exists()
    counts: dict[str, int] = {}
    if present:
        memory = load_memory()
        for category, items in memory.items():
            if isinstance(items, dict):
                counts[category] = len(items)
    return {"file_present": present, "entries_by_category": counts}
