"""Backend configuration.

Secrets are read from the environment first (GEMINI_API_KEY), then from
config/api_keys.json (the same file the desktop app uses). Secret values are
never returned by any API and never logged.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
API_CONFIG_PATH = REPO_ROOT / "config" / "api_keys.json"
PROMPT_PATH = REPO_ROOT / "core" / "prompt.txt"
WEB_DIR = REPO_ROOT / "web"
RUNTIME_DIR = REPO_ROOT / "runtime"            # git-ignored: quota counter and other small state

# Text model used by the browser chat. The desktop app uses a Live model for voice.
# SUPPER_TEXT_MODEL is the primary override; GEMINI_MODEL is also accepted for
# compatibility with the dashboard. Legacy Gemini 2.5 text values are upgraded
# to the current stable model rather than pinning the app to restricted access.
# gemini-3.8-flash: Google's current stable Flash model (GA 2 September 2026, no
# shutdown announced). It replaced the moving alias `gemini-flash-latest`, which was
# last re-pointed on 19 May 2026 and would quietly leave this app on a superseded
# generation. Source: ai.google.dev/gemini-api/docs/models, read 2026-10-12.
DEFAULT_TEXT_MODEL = "gemini-3.8-flash"

# Live (voice) model. Same model the desktop app uses (main.py LIVE_MODEL).
# gemini-3.8-live: stable, released 15 September 2026, no shutdown announced. The
# previous name, models/gemini-3.1-flash-live-preview, is shut down on 17 November
# 2026 and gemini-3.8-live is Google's recommended replacement.
# Source: ai.google.dev/gemini-api/docs/deprecations (Live API models), read 2026-10-12.
LIVE_MODEL = "models/gemini-3.8-live"

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


_LEGACY_TEXT_MODEL = re.compile(r"^(?:models/)?gemini-2\.5-(?:flash|pro)(?:-|$)", re.IGNORECASE)


def get_text_model() -> str:
    """Resolve the main text model and migrate stale Gemini 2.5 settings."""
    for setting in ("SUPPER_TEXT_MODEL", "GEMINI_MODEL"):
        model = (os.environ.get(setting) or "").strip()
        if not model:
            continue
        if _LEGACY_TEXT_MODEL.match(model):
            return DEFAULT_TEXT_MODEL
        return model
    return DEFAULT_TEXT_MODEL


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
