"""The skill record. Kept in its own module so skill modules can import it without a cycle."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..permissions import Tier


@dataclass(frozen=True)
class Skill:
    action: str                            # policy and router name, e.g. "skill.weather"
    tier: Tier                             # SAFE, CONFIRM or BLOCKED
    summary: Callable[[dict], str]         # one line for the confirmation card
    handler: Callable[[dict, object], dict]  # (args, opener) -> {"reply": str}
