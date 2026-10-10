import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend import config  # noqa: E402
import memory.memory_manager as mm  # noqa: E402


SAMPLE_MEMORY = {
    "identity": {"name": {"value": "Test Person", "updated": "2026-01-01"}},
    "preferences": {"tea": {"value": "earl grey", "updated": "2026-01-02"}},
    "projects": {},
    "relationships": {"sister": {"value": "Ayse", "updated": "2026-01-03"}},
    "wishes": {},
    "notes": {},
}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """Point every persistence path at a temp directory. Never touches the real store."""
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir()
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    long_term = mem_dir / "long_term.json"
    long_term.write_text(json.dumps(SAMPLE_MEMORY), encoding="utf-8")
    monkeypatch.setattr(mm, "MEMORY_PATH", long_term)
    monkeypatch.setattr(mm, "DIALOGUE_PATH", mem_dir / "recent_dialogue.json")
    monkeypatch.setattr(config, "API_CONFIG_PATH", cfg_dir / "api_keys.json")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")     # quota counter lives here
    monkeypatch.delenv("SUPPER_GEMINI_DAILY_BUDGET", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    return tmp_path
