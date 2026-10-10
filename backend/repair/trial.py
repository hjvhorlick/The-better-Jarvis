"""Trial: try a change on a copy of the project and run the tests there. The real project is not touched.

The copy leaves out the owner's data (memory, saved keys, runtime state). Code is copied, so the tests
can run. The personality prompt is copied for reading only; the trial never writes back.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

SKIP_DIRS = {".git", ".venv", "runtime", "__pycache__", "node_modules", ".pytest_cache"}
DATA_SUFFIXES = (".json", ".jsonl", ".txt")


def _is_owner_data(rel: str) -> bool:
    if rel == "config/api_keys.json":
        return True
    if rel.startswith("memory/") and rel.endswith(DATA_SUFFIXES):
        return True
    if rel.startswith("config/") and rel.endswith(".json"):
        return True
    return False


def copy_for_trial(repo_root: Path, dest: Path) -> None:
    repo_root = Path(repo_root)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            src = Path(dirpath) / name
            rel = src.relative_to(repo_root).as_posix()
            if _is_owner_data(rel) or src.is_symlink():
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)


def apply_files(root: Path, files: dict[str, str]) -> None:
    root = Path(root)
    for rel, text in files.items():
        target = root / rel
        if target.is_symlink():
            raise RuntimeError(f"{rel} is a link, not a file. Nothing was changed.")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".repair-tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)


def run_suite(root: Path, timeout: int = 900) -> tuple[bool, str]:
    """Run the project's test suite in `root`. Returns (passed, last lines of output)."""
    proc = subprocess.run([sys.executable, "-m", "pytest", "-q", "tests"], cwd=str(root),
                          capture_output=True, text=True, timeout=timeout)
    lines = (proc.stdout + proc.stderr).strip().splitlines()
    return proc.returncode == 0, "\n".join(lines[-15:])
