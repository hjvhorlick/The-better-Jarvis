"""Email room tests: safe local draft preparation, not provider sending."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROOM = ROOT / "web" / "environments" / "email.js"
REGISTER = ROOT / "web" / "environments" / "register.js"
CSS = ROOT / "web" / "styles.css"


def test_email_room_is_registered_and_loaded_lazily():
    assert 'id: "email"' in REGISTER
    assert 'import(`./environments/${id}.js`)' in (ROOT / "web" / "shell.js").read_text()
    assert ROOM.exists()


def test_email_room_saves_only_local_drafts_and_never_sends_directly():
    text = ROOM.read_text()
    assert "localStorage" in text
    assert "mailto:" in text
    assert "does not" in text
    assert "fetch(" not in text
    assert "innerHTML" not in text


def test_email_room_has_review_copy_save_and_delete_controls():
    text = ROOM.read_text()
    for label in ("Save draft", "Copy email", "Open in mail app", "New draft", "Delete"):
        assert label in text


def test_email_room_has_responsive_layout():
    assert ".email-room" in CSS.read_text()
