"""Backend configuration.

Secrets are read from the environment first (GEMINI_API_KEY), then from
config/api_keys.json (the same file the desktop app uses). Secret values are
never returned by any API and never logged.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
API_CONFIG_PATH = REPO_ROOT / "config" / "api_keys.json"
PROMPT_PATH = REPO_ROOT / "core" / "prompt.txt"
WEB_DIR = REPO_ROOT / "web"
RUNTIME_DIR = REPO_ROOT / "runtime"            # git-ignored: quota counter and other small state

# Text model used by the browser chat. The desktop app uses a Live model for voice;
# text chat uses a standard model. Override with SUPPER_TEXT_MODEL.
DEFAULT_TEXT_MODEL = "gemini-flash-latest"

# Live (voice) model. Same model the desktop app uses (main.py LIVE_MODEL).
LIVE_MODEL = "models/gemini-3.1-flash-live-preview"

HOST = os.environ.get("SUPPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SUPPER_PORT", "8765"))


def load_config_file() -> dict:
    try:
        data = json.loads(API_CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_gemini_api_key() -> str | None:
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if key:
        return key
    key = str(load_config_file().get("gemini_api_key") or "").strip()
    return key or None


def get_assistant_name() -> str:
    return (load_config_file().get("assistant_name") or "JARVIS").strip() or "JARVIS"


def get_user_name() -> str:
    return (load_config_file().get("user_name") or "").strip()


def get_text_model() -> str:
    return os.environ.get("SUPPER_TEXT_MODEL", "").strip() or DEFAULT_TEXT_MODEL


DEFAULT_DAILY_BUDGET = 20


def get_daily_budget() -> int:
    """Gemini calls per local day this app may make (SUPPER_GEMINI_DAILY_BUDGET). 0 turns them off."""
    raw = os.environ.get("SUPPER_GEMINI_DAILY_BUDGET", "").strip()
    if not raw:
        return DEFAULT_DAILY_BUDGET
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DAILY_BUDGET
    return value if value >= 0 else DEFAULT_DAILY_BUDGET
