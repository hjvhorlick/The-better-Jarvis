"""Snapshots: a saved copy of the files a change is about to touch, so the change can be undone.

Layout: runtime/snapshots/<id>/manifest.json and runtime/snapshots/<id>/files/<path>.
The manifest records a checksum for each file. A file that did not exist before the change is
recorded as None, so a rollback removes it. Nothing is deleted automatically.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import datetime
from pathlib import Path


class SnapshotCorrupt(RuntimeError):
    """A saved copy does not match its checksum. Nothing is restored when this is raised."""


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class SnapshotStore:
    def __init__(self, root: Path):
        self.root = Path(root)

    def create(self, repo_root: Path, paths: list[str], reason: str) -> str:
        sid = f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"
        folder = self.root / sid
        manifest = {"id": sid, "created": datetime.now().isoformat(timespec="seconds"),
                    "reason": reason, "files": {}, "rolled_back": False}
        for rel in paths:
            src = Path(repo_root) / rel
            if src.is_file():
                data = src.read_bytes()
                _write_atomic(folder / "files" / rel, data)
                manifest["files"][rel] = _digest(data)
            else:
                manifest["files"][rel] = None
        _write_atomic(folder / "manifest.json",
                      json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"))
        return sid

    def load(self, sid: str) -> dict:
        path = self.root / sid / "manifest.json"
        if not sid or "/" in sid or ".." in sid or not path.is_file():
            raise LookupError(f"There is no snapshot called {sid!r}.")
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, limit: int = 20) -> list[dict]:
        if not self.root.is_dir():
            return []
        out = []
        for folder in sorted(self.root.iterdir(), reverse=True):
            try:
                m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            except Exception:
                continue
            out.append({"id": m.get("id", folder.name), "created": m.get("created", ""),
                        "reason": m.get("reason", ""), "files": len(m.get("files", {})),
                        "rolled_back": bool(m.get("rolled_back"))})
            if len(out) >= limit:
                break
        return out

    def restore(self, sid: str, repo_root: Path) -> list[str]:
        """Put the snapshot's files back. Every saved copy is checked first; if one is damaged,
        nothing is written."""
        manifest = self.load(sid)
        plan = []
        for rel, digest in manifest["files"].items():
            if digest is None:
                plan.append((rel, None))
                continue
            data = (self.root / sid / "files" / rel).read_bytes() if (self.root / sid / "files" / rel).is_file() else None
            if data is None or _digest(data) != digest:
                raise SnapshotCorrupt(f"the saved copy of {rel} in snapshot {sid} is damaged")
            plan.append((rel, data))
        for rel, data in plan:
            target = Path(repo_root) / rel
            if data is None:
                target.unlink(missing_ok=True)
            else:
                _write_atomic(target, data)
        return [rel for rel, _ in plan]

    def mark_rolled_back(self, sid: str) -> None:
        manifest = self.load(sid)
        manifest["rolled_back"] = True
        _write_atomic(self.root / sid / "manifest.json",
                      json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"))
