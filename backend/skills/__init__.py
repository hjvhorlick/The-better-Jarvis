"""Skills (V2-5): capabilities ported from the legacy app, each with its own permission tier.

A skill is a small, testable unit: an action name (the policy and the router use it), a tier,
a one-line summary for the confirmation card, and a handler. A skill is never run from the
browser directly. It runs through the router, the policy and, for CONFIRM tiers, the owner's OK.

Provenance: the skill structure is written for this project. Each ported skill records what it
was ported from, and what was rewritten, in docs/V2_PROVENANCE.md.
"""
from __future__ import annotations

from .base import Skill
from . import weather

ALL_SKILLS: tuple[Skill, ...] = (weather.SKILL,)

__all__ = ["ALL_SKILLS", "Skill"]
