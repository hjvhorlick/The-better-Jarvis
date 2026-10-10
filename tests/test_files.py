import os

import pytest

from backend import files


@pytest.fixture
def root(tmp_path, monkeypatch):
    r = tmp_path / "allowed"
    (r / "sub").mkdir(parents=True)
    (r / "a.txt").write_text("alpha", encoding="utf-8")
    (r / "sub" / "b.md").write_text("# beta", encoding="utf-8")
    (r / ".hidden").write_text("secret", encoding="utf-8")
    monkeypatch.setenv("SUPPER_FILE_ROOTS", str(r))
    return r


def test_dotdot_escape_is_refused(root, tmp_path):
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(root / ".." / "outside.txt"))


def test_outside_path_is_refused(root, tmp_path):
    other = tmp_path / "other.txt"
    other.write_text("x", encoding="utf-8")
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(other))


def test_symlink_pointing_outside_is_refused(root, tmp_path):
    target = tmp_path / "outside-target"
    target.write_text("classified", encoding="utf-8")
    link = root / "link"
    os.symlink(target, link)
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(link))


def test_hidden_entries_are_refused_and_not_listed(root):
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(root / ".hidden"))
    names = [e["name"] for e in files.list_dir(str(root))["entries"]]
    assert ".hidden" not in names


def test_relative_path_is_rejected(root):
    with pytest.raises(files.BadRequest):
        files.resolve_allowed("a.txt")


def test_missing_path_is_not_found(root):
    with pytest.raises(files.NotFound):
        files.resolve_allowed(str(root / "nope.txt"))


def test_root_itself_is_allowed_and_parent_is_hidden_from_listing(root):
    listing = files.list_dir(str(root))
    assert listing["parent"] is None  # cannot climb above the allowed root
    sub = files.list_dir(str(root / "sub"))
    assert sub["parent"] == str(root)


def test_binary_file_has_no_preview(root):
    (root / "image.bin").write_bytes(b"\x89PNG\x00\x00binary")
    with pytest.raises(files.BadRequest):
        files.read_preview(str(root / "image.bin"))


def test_large_text_is_truncated_not_refused(root):
    big = root / "big.txt"
    big.write_text("x" * (files.MAX_PREVIEW_BYTES + 500), encoding="utf-8")
    result = files.read_preview(str(big))
    assert result["truncated"] is True
    assert len(result["text"]) == files.MAX_PREVIEW_BYTES


def test_folder_cannot_be_previewed_as_file(root):
    with pytest.raises(files.BadRequest):
        files.read_preview(str(root / "sub"))


def test_no_roots_configured_means_no_access(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPPER_FILE_ROOTS", str(tmp_path / "does-not-exist"))
    assert files.get_roots() == []
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(tmp_path))


def test_nonexistent_outside_path_is_forbidden_not_not_found(root, tmp_path):
    """Existence must not leak: a missing file outside the roots is refused like a present one."""
    with pytest.raises(files.Forbidden):
        files.resolve_allowed(str(tmp_path / "definitely-missing.txt"))
