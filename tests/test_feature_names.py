"""The feature is called "My Hands" in the app. "barehands" is another project's name (its folder is
kept in the repo as a reference, with its own licence). The app's own code and screens must not use it.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP_DIRS = ("backend", "web", "myhands", "dashboard")
SUFFIXES = {".py", ".js", ".html", ".css", ".txt", ".json"}
def _rel(p):
    return p.relative_to(ROOT).as_posix()


NAME = re.compile(r"barehand", re.IGNORECASE)
# The app's own screens and servers. The vendored third-party project keeps its
# own folder and name (see THIRD_PARTY_NOTICES.md), so the files that exist only
# to drive or attribute it are excluded.
ROOT_FILES = ("server.ts", "ui.py", "main.py", "index.html")
EXEMPT = {"plugins/barehands.py"}          # the third-party plugin itself

# A handful of lines must still name the vendored project, because they point at
# its folder, its own config file or its module. Those are references to a
# separate project we are told not to rename, not the app calling itself that.
#
# The exemption is matched on the line's own text, not on its number: the files
# grow, and a rule that says "line 721" silently starts exempting the wrong line
# (or fails) the first time anything above it is edited. Each entry is the exact
# snippet that makes the mention legitimate.
EXEMPT_LINES = {
    "server.ts": {
        "path.join(process.cwd(), 'barehands')": "path to the vendored hand-board folder",
        "path.join(HAND_BOARD_DIR, 'barehands.json')": "the board's own config file name",
    },
    "ui.py": {
        'importlib.import_module("plugins.barehands")': "imports the vendored hand-board plugin module",
    },
}


def _app_files():
    for d in APP_DIRS:
        for path in (ROOT / d).rglob("*"):
            if path.is_file() and path.suffix in SUFFIXES and "__pycache__" not in path.parts:
                yield path
    for name in ROOT_FILES:
        path = ROOT / name
        if path.is_file() and _rel(path) not in EXEMPT:
            yield path


def test_the_app_says_my_hands_on_its_screens():
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert ">My Hands<" in html


@pytest.mark.parametrize("path", list(_app_files()), ids=lambda p: str(p.relative_to(ROOT)))
def test_the_app_never_uses_the_other_projects_name(path):
    rel = path.relative_to(ROOT).as_posix()
    allowed = EXEMPT_LINES.get(rel, {})
    hits = []
    for i, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines()):
        if not NAME.search(line):
            continue
        if any(snippet in line for snippet in allowed):
            continue                      # a legitimate pointer at the vendored project
        hits.append(i + 1)
    assert not hits, f"'barehands' found in {rel} on line(s) {hits}; use 'My Hands'"


def test_the_app_never_names_the_mouse_driven_hand_simulator():
    """"Sim Hand" was the old name for the mouse-driven rehearsal mode. The owner
    wants it gone from every screen, so it is checked for directly."""
    bad = []
    for path in _app_files():
        for i, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines()):
            if re.search(r"sim[ _-]?hand", line, re.IGNORECASE):
                bad.append(f"{path.relative_to(ROOT)}:{i + 1}")
    assert bad == [], f"found 'Sim Hand' in {bad}; call it 'Mouse Hand'"
