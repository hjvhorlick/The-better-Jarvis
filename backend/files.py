"""Read-only file access, limited to the folders the owner allows.

Rules:
  * Only paths inside an allowed root are visible. Anything else is refused.
  * Paths are resolved first, so "../" tricks and symlinks that point outside
    a root are refused.
  * Hidden entries (names starting with ".") are not listed or read.
  * Binary files are refused for preview; text previews are size-limited.

Roots come from SUPPER_FILE_ROOTS (os.pathsep-separated) or the "file_roots"
list in config/api_keys.json. The default is Desktop, Documents and Downloads
under the home folder, whichever exist.
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from . import config

MAX_LIST_ENTRIES = 500
MAX_PREVIEW_BYTES = 64 * 1024


class FileAccessError(Exception):
    status = 400


class Forbidden(FileAccessError):
    status = 403


class NotFound(FileAccessError):
    status = 404


class BadRequest(FileAccessError):
    status = 400


def _configured_roots() -> list[str]:
    env = os.environ.get("SUPPER_FILE_ROOTS", "").strip()
    if env:
        return [p for p in env.split(os.pathsep) if p.strip()]
    cfg = config.load_config_file().get("file_roots")
    if isinstance(cfg, list) and cfg:
        return [str(p) for p in cfg if str(p).strip()]
    home = Path.home()
    return [str(home / name) for name in ("Desktop", "Documents", "Downloads")]


def get_roots() -> list[Path]:
    roots: list[Path] = []
    for raw in _configured_roots():
        try:
            p = Path(raw).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if p.is_dir() and p not in roots:
            roots.append(p)
    return roots


def _root_containing(path: Path, roots: list[Path]) -> Path | None:
    for r in roots:
        if path == r or path.is_relative_to(r):
            return r
    return None


def resolve_allowed(raw: str) -> Path:
    """Return the resolved path if it is inside an allowed root; otherwise raise."""
    if not raw or not raw.strip():
        raise BadRequest("path is required")
    candidate = Path(raw.strip()).expanduser()
    if not candidate.is_absolute():
        raise BadRequest("path must be absolute")
    # Check the boundary BEFORE checking existence, so a caller cannot probe
    # whether files exist outside the allowed folders.
    try:
        resolved = candidate.resolve(strict=False)   # follows symlinks too
    except (OSError, RuntimeError):
        raise BadRequest("path could not be resolved") from None
    root = _root_containing(resolved, get_roots())
    if root is None:
        raise Forbidden("path is outside the allowed folders")
    try:
        resolved = resolved.resolve(strict=True)
    except FileNotFoundError:
        raise NotFound("not found") from None
    except (OSError, RuntimeError):
        raise BadRequest("path could not be resolved") from None
    # Re-check after resolving strictly: the file may be a symlink to elsewhere.
    root = _root_containing(resolved, get_roots())
    if root is None:
        raise Forbidden("path is outside the allowed folders")
    if any(part.startswith(".") for part in resolved.relative_to(root).parts):
        raise Forbidden("hidden entries are not available")
    return resolved


def list_roots() -> list[dict]:
    return [{"name": r.name or str(r), "path": str(r)} for r in get_roots()]


def list_dir(raw: str) -> dict:
    path = resolve_allowed(raw)
    if not path.is_dir():
        raise BadRequest("not a folder")
    entries = []
    for child in path.iterdir():
        if child.name.startswith("."):
            continue
        try:
            st = child.stat()
        except OSError:
            continue
        is_dir = child.is_dir()
        entries.append({
            "name": child.name,
            "path": str(child),
            "kind": "folder" if is_dir else "file",
            "size": None if is_dir else st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    entries.sort(key=lambda e: (e["kind"] != "folder", e["name"].lower()))
    parent = None
    if _root_containing(path.parent, get_roots()) is not None and path.parent != path:
        parent = str(path.parent)
    return {
        "path": str(path),
        "parent": parent,
        "entries": entries[:MAX_LIST_ENTRIES],
        "truncated": len(entries) > MAX_LIST_ENTRIES,
    }


def read_preview(raw: str) -> dict:
    path = resolve_allowed(raw)
    if not path.is_file():
        raise BadRequest("not a file")
    size = path.stat().st_size
    with path.open("rb") as fh:
        data = fh.read(MAX_PREVIEW_BYTES)
    if b"\x00" in data[:4096]:
        raise BadRequest("binary file: no text preview")
    return {
        "path": str(path),
        "name": path.name,
        "size": size,
        "truncated": size > MAX_PREVIEW_BYTES,
        "text": data.decode("utf-8", errors="replace"),
    }
