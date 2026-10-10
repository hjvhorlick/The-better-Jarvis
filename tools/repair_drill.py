"""Live drill for self-repair (docs/SELF_REPAIR.md).

Runs on a COPY of the project in a temporary folder outside the project. The real project is never
written to. It shows three things, in plain steps:

  A. A broken change offered through the normal proposal path is stopped by the tests on the copy.
  B. A broken change pushed straight to the apply step (this skips the copy-test ON PURPOSE, to test
     the safety net) is caught by the health check, and is rolled back automatically.
  C. A good change is proposed, approved (the drill plays the owner's "yes"), applied, and then rolled
     back with the undo.

Run from the project folder:   python tools/repair_drill.py
Each suite run takes about 15-20 seconds, so the whole drill takes a few minutes.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from backend.events import EventBus  # noqa: E402
from backend.permissions import ConfirmationStore  # noqa: E402
from backend.repair import SelfRepair  # noqa: E402
from backend.repair import trial  # noqa: E402

TARGET = "backend/devices.py"
BROKEN_SUFFIX = "\ndef drill_broken(:\n    pass\n"            # a syntax error: the code cannot load
GOOD_SUFFIX = "# drill: harmless comment added by the self-repair drill\n"

failures: list[str] = []


def say(text: str = "") -> None:
    print(text, flush=True)


def check(ok: bool, what: str) -> None:
    say(("   PASS  " if ok else "   FAIL  ") + what)
    if not ok:
        failures.append(what)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def real_project_state() -> str:
    """Git status plus the personality prompt checksum. Must be the same before and after the drill."""
    status = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True)
    prompt = REPO / "core" / "prompt.txt"
    return status.stdout + "|" + (digest(prompt) if prompt.exists() else "no prompt")


def main() -> int:
    before_real = real_project_state()
    work = Path(tempfile.mkdtemp(prefix="jarvis-drill-"))
    root = work / "project"
    say("Preparing a copy of the project in a temporary folder (not the real project).")
    trial.copy_for_trial(REPO, root)
    say(f"   Copy made at: {root}")
    say(f"   Drill target: {TARGET} (the camera device registry used by My Hands)")

    original = (root / TARGET).read_text(encoding="utf-8")
    original_hash = digest(root / TARGET)
    broken = original + BROKEN_SUFFIX
    good = original + GOOD_SUFFIX

    bus = EventBus()
    conf = ConfirmationStore(bus=bus)
    repair = SelfRepair(root, work / "runtime", confirmations=conf)

    # ----- Drill A -----
    say("\nDRILL A - a broken change, offered the normal way")
    say("   The assistant drafts a change that will not even load. It goes to the tests on a copy first.")
    out = repair.propose("drill: deliberately broken change", {TARGET: broken})
    say(f"   Result: {out['status']}. {out.get('why', '')}")
    if out.get("test_output"):
        say(f"   Last line from the tests: {out['test_output'].splitlines()[-1]}")
    check(out["status"] == "rejected", "the broken change was rejected before the owner was asked")
    check(digest(root / TARGET) == original_hash, "the file on the copy is still the original")

    # ----- Drill B -----
    say("\nDRILL B - a broken change that gets past the trial (the safety net must catch it)")
    say("   This step skips the copy-test on purpose, to show the health check and automatic rollback.")
    msg = repair._apply("drill: broken change, skipping the trial", {TARGET: broken}, "low", [])
    say(f"   App says: {msg}")
    check("rolled back automatically" in msg, "the failed health check rolled back automatically and said so")
    check(digest(root / TARGET) == original_hash, "the file is back to exactly its original contents")
    check(repair.last_apply_id() is None, "the failed change is not left as something to roll back")

    # ----- Drill C -----
    say("\nDRILL C - a good change: proposed, approved by the owner, applied, then undone")
    out = repair.propose("drill: harmless comment", {TARGET: good})
    say(f"   Proposal status: {out['status']}. Risk: {out.get('risk')}. Tests on a copy: {out.get('tests')}")
    check(out["status"] == "waiting", "the good change waited for the owner's approval")
    check(digest(root / TARGET) == original_hash, "nothing changed before the owner approved")
    done = conf.resolve(out["confirmation"]["id"], approve=True)
    say(f"   Owner approves (played by the drill). App says: {done['result']}")
    check(done["status"] == "approved" and "Applied" in done["result"], "the approved change was applied")
    check(digest(root / TARGET) == digest_text(good), "the file now holds the approved change")
    undo = repair.rollback_last()
    say(f"   Undo pressed. App says: {undo}")
    check(digest(root / TARGET) == original_hash, "the undo put the file back to its original contents")
    check(repair.rollback_last().startswith("There is no self-repair change"),
          "after the undo there is nothing left to roll back")

    # ----- Summary -----
    say("\nWhat the app wrote down while the drill ran (runtime/repair_log.jsonl on the copy):")
    log = work / "runtime" / "repair_log.jsonl"
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            entry = json.loads(line)
            say(f"   {entry['time']}  {entry['event']}")

    after_real = real_project_state()
    check(before_real == after_real, "the real project was not changed by the drill")
    say("\nResult: " + ("ALL CHECKS PASSED" if not failures else f"{len(failures)} CHECK(S) FAILED"))
    say(f"The copy is kept for inspection at {work} and can be deleted.")
    return 0 if not failures else 1


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
