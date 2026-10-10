"""Self-repair (owner decisions in docs/SELF_REPAIR.md): propose, trial on a copy, ask, apply, roll back."""
from .engine import SelfRepair
from .policy import RepairRefused
from .notices import Notices
from .snapshots import SnapshotCorrupt

__all__ = ["SelfRepair", "RepairRefused", "SnapshotCorrupt", "Notices"]
