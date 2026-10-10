"""Self-repair engine: propose, trial, ask the owner, apply, check, roll back.

The owner's rules (docs/SELF_REPAIR.md):
  * nothing changes the real project until the owner approves that exact change;
  * a snapshot is taken before any change, and a rollback is always available;
  * if the health check fails after a change, the app rolls back at once and says so;
  * a rollback is itself snapshotted first, so it can be undone;
  * every step is written to runtime/repair_log.jsonl. Nothing is deleted from it.

A change is applied with the server running. Python loads code at start-up, so the change takes
effect after the app is restarted. The health check runs the tests in a fresh process, so it
checks the new code.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import policy, trial
from .snapshots import SnapshotStore

APPLY_PREFIX = "before apply"


class SelfRepair:
    def __init__(self, repo_root: Path, runtime_dir: Path, confirmations=None,
                 suite: Callable[[Path], tuple[bool, str]] | None = None):
        self.repo = Path(repo_root)
        self.runtime = Path(runtime_dir)
        self.snapshots = SnapshotStore(self.runtime / "snapshots")
        self.log_path = self.runtime / "repair_log.jsonl"
        self._confirmations = confirmations
        self._suite = suite or trial.run_suite

    # ----- proposing -----

    def propose(self, reason: str, files: dict) -> dict:
        """Check a proposed change, try it on a copy, then ask the owner. Never changes the real files.

        Returns {"status": "rejected", ...} if a rule or the tests stop it, or {"status": "waiting",
        "confirmation": ...} when the owner must approve."""
        reason = (reason or "").strip()
        if not reason:
            raise policy.RepairRefused("say why this change is needed")
        clean = policy.validate(files)
        existing = {p for p in clean if (self.repo / p).is_file()}
        level, warnings = policy.classify(sorted(clean), existing)
        with _tempdir() as tmp:
            root = Path(tmp) / "trial"
            trial.copy_for_trial(self.repo, root)
            trial.apply_files(root, clean)
            ok, tail = self._suite(root)
        if not ok:
            self._log("rejected", reason=reason, files=sorted(clean), risk=level, test_output=tail)
            return {"status": "rejected", "risk": level, "warnings": warnings,
                    "why": "the tests failed on a copy, so nothing was changed", "test_output": tail}
        self._log("trialled", reason=reason, files=sorted(clean), risk=level)
        summary = self._apply_summary(reason, sorted(clean), level, warnings)
        view = self._confirmations.request(
            "repair.apply", summary, run=lambda: self._apply(reason, clean, level, warnings))
        return {"status": "waiting", "risk": level, "warnings": warnings,
                "files": sorted(clean), "tests": "passed on a copy", "confirmation": view}

    def _apply_summary(self, reason, files, level, warnings) -> str:
        parts = [f"Self-repair: {reason}.",
                 f"Changes {len(files)} file(s): {', '.join(files)[:240]}.",
                 f"Risk: {level}."]
        parts += warnings
        parts.append("The tests passed on a copy. A snapshot is taken first, and the change is checked "
                     "after it is applied. It takes effect after the app restarts.")
        return " ".join(parts)

    # ----- applying (runs only after the owner approves) -----

    def _apply(self, reason, files, level, warnings) -> str:
        sid = self.snapshots.create(self.repo, list(files), reason=f"{APPLY_PREFIX}: {reason}")
        self._log("snapshot", snapshot=sid, reason=reason)
        try:
            trial.apply_files(self.repo, files)
        except Exception as e:
            self.snapshots.restore(sid, self.repo)
            self.snapshots.mark_rolled_back(sid)
            self._log("apply_failed", snapshot=sid, error=str(e))
            return f"Not applied: {e}. The files were put back as they were."
        ok, tail = self._suite(self.repo)
        if not ok:
            self.snapshots.restore(sid, self.repo)
            self.snapshots.mark_rolled_back(sid)
            self._log("rolled_back_after_check", snapshot=sid, test_output=tail)
            return (f"The change was applied but the app failed its checks, so it was rolled back "
                    f"automatically to snapshot {sid}. Nothing was lost.")
        self._log("applied", snapshot=sid, files=sorted(files), risk=level)
        return (f"Applied {len(files)} file(s). The app passed its checks. Restart the app to use the "
                f"new code. Snapshot {sid} is kept, so you can roll back.")

    # ----- rollback -----

    def last_apply_id(self) -> str | None:
        for item in self.snapshots.list(limit=500):
            if item["reason"].startswith(APPLY_PREFIX) and not item["rolled_back"]:
                return item["id"]
        return None

    def rollback(self, sid: str) -> str:
        manifest = self.snapshots.load(sid)
        before = self.snapshots.create(self.repo, list(manifest["files"]),
                                       reason=f"before rollback to {sid}")
        restored = self.snapshots.restore(sid, self.repo)
        self.snapshots.mark_rolled_back(sid)
        self._log("rolled_back", snapshot=sid, files=restored, state_before=before)
        return (f"Rolled back to snapshot {sid}: {len(restored)} file(s) put back. "
                f"The state before the rollback is saved as {before}, so this can be undone.")

    def rollback_last(self) -> str:
        sid = self.last_apply_id()
        if sid is None:
            return "There is no self-repair change to roll back."
        return self.rollback(sid)

    def describe_last(self) -> str:
        sid = self.last_apply_id()
        return f"roll back snapshot {sid}" if sid else "no change to roll back"

    def list_snapshots(self, limit: int = 10) -> list[dict]:
        return self.snapshots.list(limit=limit)

    # ----- log -----

    def _log(self, event: str, **detail) -> None:
        self.runtime.mkdir(parents=True, exist_ok=True)
        entry = {"time": datetime.now().isoformat(timespec="seconds"), "event": event, **detail}
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _tempdir():
    import tempfile
    return tempfile.TemporaryDirectory(prefix="jarvis-trial-")
