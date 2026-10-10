"""Architecture rules (docs/ARCHITECTURE.md). These keep the features woven together, so new ones can be
added without breaking the rest. Each test names the rule it checks."""
import ast
import re
from pathlib import Path

from backend import router
from backend.permissions import default_policy
from backend.skills import ALL_SKILLS

REPO = Path(__file__).resolve().parent.parent
DOC = (REPO / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")

# Rule 3: only these modules may import a hardware library.
# Speech engines (faster-whisper, pyttsx3, kokoro-onnx) count as hardware for this rule: they are
# heavy, and their owners are the only modules that load them.
HARDWARE = {"cv2", "sounddevice", "mediapipe", "openwakeword", "faster_whisper", "pyttsx3", "kokoro_onnx"}
HARDWARE_OWNERS = {
    "backend/voice/audio.py", "backend/voice/wake.py", "myhands/camera.py", "myhands/tracker.py",
    "backend/voice/stt.py", "backend/voice/tts.py",
}


def _rel(p: Path) -> str:
    return p.relative_to(REPO).as_posix()


def _python_files():
    for folder in ("backend", "myhands"):
        for p in sorted((REPO / folder).rglob("*.py")):
            if "__pycache__" not in p.parts:
                yield p


def _web_files():
    for p in sorted((REPO / "web").glob("*")):
        if p.is_file():
            yield p


def _absolute_imports(path: Path):
    """Top-level names of absolute imports (import cv2, from cv2 import x)."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                yield a.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split(".")[0]


def _relative_names(path: Path):
    """Names this file imports from its own package: `from .x import y` gives x, `from . import x` gives x."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level >= 1:
            if node.module:
                yield node.module.split(".")[0]
            else:
                for a in node.names:
                    yield a.name


def _map_rows():
    """Feature-map rows keyed by each file path in the File column (a row may list several files)."""
    rows = {}
    for line in DOC.splitlines():
        m = re.match(r"\| (`[^|]+`) \| (.*) \| (.*) \|$", line)
        if m:
            for name in re.findall(r"`([^`]+)`", m.group(1)):
                rows[name] = m.group(3)
    return rows


# Module and package names in the backend tree; filters out attributes such as __version__.
MODULE_NAMES = {p.stem for p in (REPO / "backend").rglob("*.py")} | {
    d.name for d in (REPO / "backend").rglob("*") if d.is_dir() and d.name != "__pycache__"}


# Rule 4: every action the router can produce, and every skill, has a tier.
def test_every_routed_action_and_skill_is_in_the_policy():
    policy_actions = {row["action"] for row in default_policy().table()}
    assert {a for a in router.all_actions() if a not in policy_actions} == set()
    assert {s.action for s in ALL_SKILLS if s.action not in policy_actions} == set()


# Rule 3: hardware is touched only by its owner modules.
def test_only_the_owner_modules_import_hardware_libraries():
    offenders = [f"{_rel(p)} imports {top}"
                 for p in _python_files()
                 for top in _absolute_imports(p)
                 if top in HARDWARE and _rel(p) not in HARDWARE_OWNERS]
    assert offenders == []


# Rules 1 and 6: the browser holds no key and assumes no fixed address (it may later run in a window).
def test_the_browser_code_has_no_keys_and_no_fixed_addresses():
    bad = []
    for p in _web_files():
        if p.suffix not in {".js", ".html", ".css"}:
            continue
        text = p.read_text(encoding="utf-8")
        for token in ("localhost", "127.0.0.1"):
            if token in text:
                bad.append(f"{_rel(p)} mentions {token}")
        if re.search(r"AIza[0-9A-Za-z_-]{20,}", text):             # a real Google/Gemini key looks like this
            bad.append(f"{_rel(p)} contains what looks like an API key")
    assert bad == []


# Rule 9: every file is in the feature map, so the map cannot fall behind.
def test_every_file_is_in_the_feature_map():
    rows = _map_rows()
    globs = [k for k in rows if "*" in k]
    missing = [_rel(p) for p in list(_python_files()) + list(_web_files())
               if p.suffix != ".pyc" and _rel(p) not in rows
               and not any(_rel(p).startswith(g[:-4]) for g in globs)]
    assert missing == [], f"add these to the feature map in docs/ARCHITECTURE.md: {missing}"


# Rule 2: the map's "Uses" column names every backend module a file really imports from.
def test_the_feature_map_lists_the_real_dependencies():
    rows = _map_rows()
    problems = []
    for p in _python_files():
        rel = _rel(p)
        if not rel.startswith("backend/") or p.name == "__init__.py":
            continue
        uses = rows.get(rel)
        if uses is None:
            for key, text in rows.items():            # a row can cover a folder: `backend/repair/*.py`
                if key.endswith("/*.py") and rel.startswith(key[:-4]):
                    uses = text
                    break
        if uses is None:
            problems.append(f"{rel} has no row")
            continue
        for name in set(_relative_names(p)):
            if name not in MODULE_NAMES:
                continue
            if not re.search(rf"\b{re.escape(name)}\b", uses):
                problems.append(f"{rel} imports {name}, which its Uses column does not name")
    assert problems == [], problems
