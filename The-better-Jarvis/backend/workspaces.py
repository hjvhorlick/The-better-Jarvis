"""Workspaces: named working contexts the glass UI can switch between.

A workspace does not change the personality or the memory. It adds one short
context line to the system instruction, so the assistant knows what the owner
is working on at the moment.
"""
from __future__ import annotations

WORKSPACES: dict[str, dict[str, str]] = {
    "general": {
        "label": "General",
        "hint": "The owner is on the main desktop. No specific project is in focus.",
    },
    "coding": {
        "label": "Coding",
        "hint": "The owner is working on code. Prefer precise, correct technical answers.",
    },
    "marketing": {
        "label": "Marketing",
        "hint": "The owner is working on marketing: copy, campaigns, audience and messaging.",
    },
    "design": {
        "label": "Design",
        "hint": "The owner is working on visual design: layout, colour, typography and assets.",
    },
    "files": {
        "label": "Files",
        "hint": "The owner is organising files and folders. Describe changes before making them.",
    },
}

DEFAULT_WORKSPACE = "general"


def is_known(name: str) -> bool:
    return name in WORKSPACES


def workspace_block(name: str) -> str:
    ws = WORKSPACES.get(name) or WORKSPACES[DEFAULT_WORKSPACE]
    return f"[WORKSPACE]\n{ws['label']}: {ws['hint']}\n\n"
