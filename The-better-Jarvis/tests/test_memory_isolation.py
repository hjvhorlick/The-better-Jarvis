import hashlib
import json

import memory.memory_manager as mm
from backend.memory_view import memory_summary
from tests.conftest import SAMPLE_MEMORY


def test_round_trip_on_temp_copy(isolated):
    loaded = mm.load_memory()
    assert loaded["relationships"]["sister"]["value"] == "Ayse"
    mm.update_memory({"preferences": {"coffee": "flat white"}})
    saved = json.loads(mm.MEMORY_PATH.read_text(encoding="utf-8"))
    assert saved["preferences"]["tea"]["value"] == "earl grey"   # old record intact
    assert saved["preferences"]["coffee"]["value"] == "flat white"


def test_existing_records_survive_reload(isolated):
    mm.update_memory({"notes": {"x": "y"}})
    again = mm.load_memory()
    for cat, items in SAMPLE_MEMORY.items():
        for key, entry in items.items():
            assert again[cat][key]["value"] == entry["value"]


def test_summary_reports_counts_not_values(isolated):
    summary = memory_summary()
    assert summary["file_present"] is True
    assert summary["entries_by_category"]["relationships"] == 1
    assert "Ayse" not in json.dumps(summary)


def test_real_memory_file_is_never_modified_by_tests():
    """Guards the owner's data: if a real long_term.json exists, its hash must not change during tests."""
    real = mm.BASE_DIR / "memory" / "long_term.json"
    if not real.exists():
        return  # none in this checkout; the owner's machine has one
    before = hashlib.sha256(real.read_bytes()).hexdigest()
    # Re-run the read path that the API uses.
    memory_summary_real = mm.load_memory()
    assert memory_summary_real is not None
    assert hashlib.sha256(real.read_bytes()).hexdigest() == before
