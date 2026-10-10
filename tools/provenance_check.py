"""Provenance check for new source files (clean-room record, see docs/MYHANDS_CLEAN_ROOM.md §3).

Compares the given files with a reference corpus and reports:
  * identical lines of 30+ characters (whitespace-normalised)
  * shared 8-word sequences
  * shared identifiers of 6+ characters
  * shared quoted string literals of 8+ characters

Default corpus: barehands/ (AGPL-3.0 code and docs) and the legacy app's own files
(main.py, ui.py, core/, actions/, dashboard/, memory/, config/, server.ts).

Usage (from the repo root):
  python tools/provenance_check.py backend/*.py web/control.js myhands/*.py

A match is not proof of copying. Shared identifiers are mostly standard API names;
the report exists so a reviewer can see them. This is a technical check, not legal advice.
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CORPUS_DIRS = ["barehands"]
CORPUS_FILES = ["main.py", "ui.py", "server.ts"]
CORPUS_DIRS_LEGACY = ["core", "actions", "dashboard", "memory", "config"]
TEXT_SUFFIXES = {".py", ".js", ".ts", ".html", ".css", ".md", ".txt", ".json"}
SKIP_NAMES = {"node_modules", ".venv", "__pycache__"}


def _texts(paths):
    for p in paths:
        if p.is_file() and p.suffix in TEXT_SUFFIXES:
            try:
                yield p, p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue


def _walk(dirs):
    for d in dirs:
        root = REPO / d
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if any(part in SKIP_NAMES for part in p.parts):
                continue
            if p.is_file():
                yield p


def corpus_files():
    out = list(_walk(CORPUS_DIRS + CORPUS_DIRS_LEGACY))
    out += [REPO / f for f in CORPUS_FILES if (REPO / f).exists()]
    return out


def norm_lines(text):
    return {re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()
            if len(re.sub(r"\s+", " ", ln).strip()) >= 30}


def words(text):
    return re.findall(r"[a-z]+", text.lower())


def ngrams(ws, n=8):
    return {" ".join(ws[i:i + n]) for i in range(len(ws) - n + 1)}


def idents(text):
    return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]{5,}", text))


def strings(text):
    return {s for s in re.findall(r"[\"']([^\"'\n]{8,})[\"']", text)}


def main(argv):
    targets = [Path(a) if Path(a).is_absolute() else REPO / a for a in argv]
    targets = [t for t in targets if t.is_file()]
    if not targets:
        print("no files given")
        return 2
    ref = list(_texts(corpus_files()))
    ref_lines, ref_ngrams, ref_ids, ref_strings = set(), set(), set(), set()
    for _, t in ref:
        ref_lines |= norm_lines(t)
        ref_ngrams |= ngrams(words(t))
        ref_ids |= idents(t)
        ref_strings |= strings(t)

    print(f"reference files: {len(ref)}")
    for target in targets:
        text = target.read_text(encoding="utf-8")
        rel = target.relative_to(REPO) if target.is_relative_to(REPO) else target
        lines = norm_lines(text) & ref_lines
        grams = ngrams(words(text)) & ref_ngrams
        ids = Counter(i for i in idents(text) if i in ref_ids)
        strs = strings(text) & ref_strings
        print(f"\n{rel}")
        print(f"  identical lines (30+ chars): {len(lines)}")
        print(f"  shared 8-word sequences:     {len(grams)}  e.g. {sorted(grams)[:3]}")
        print(f"  shared identifiers (6+):     {len(ids)}  e.g. {sorted(ids)[:8]}")
        print(f"  shared string literals (8+): {len(strs)}  e.g. {sorted(strs)[:3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
