"""The starter (tools/start_jarvis.py): the pure parts. Nothing is installed and no server is started.

The Linux starter was also run end to end in the build sandbox (install, health check, phone mode).
These tests keep the rules that run on every machine: Python range, the venv path per OS, the
--phone settings, when to reinstall, and the OpenCV fix.
"""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def starter():
    spec = importlib.util.spec_from_file_location("start_jarvis", ROOT / "tools" / "start_jarvis.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("version", [(3, 10, 0), (3, 11, 9), (3, 12, 4)])
def test_supported_pythons_pass(starter, version):
    assert starter.check_python(version) is None


@pytest.mark.parametrize("version", [(3, 9, 18), (2, 7, 18)])
def test_too_old_python_is_refused_in_plain_words(starter, version):
    message = starter.check_python(version)
    assert message and "3.10" in message and "python.org" in message


@pytest.mark.parametrize("version", [(3, 13, 0), (3, 14, 1)])
def test_too_new_python_is_refused_because_of_my_hands(starter, version):
    message = starter.check_python(version)
    assert message and "3.12" in message and "My Hands" in message


def test_the_venv_python_path_depends_on_the_system(starter, tmp_path):
    assert starter.venv_python("nt", tmp_path) == tmp_path / "Scripts" / "python.exe"
    assert starter.venv_python("posix", tmp_path) == tmp_path / "bin" / "python"


def test_phone_mode_opens_the_home_network_and_turns_pairing_on(starter):
    env = starter.build_env({"KEEP": "1"}, phone=True, port=8800)
    assert env["SUPPER_HOST"] == "0.0.0.0"
    assert env["SUPPER_PAIRING"] == "on"
    assert env["SUPPER_PORT"] == "8800"
    assert env["KEEP"] == "1"


def test_normal_mode_stays_on_this_computer_with_pairing_off(starter):
    env = starter.build_env({}, phone=False)
    assert env["SUPPER_HOST"] == "127.0.0.1"
    assert "SUPPER_PAIRING" not in env
    assert env["SUPPER_PORT"] == str(starter.DEFAULT_PORT)


def test_normal_mode_keeps_an_owner_host_setting(starter):
    env = starter.build_env({"SUPPER_HOST": "0.0.0.0"}, phone=False)
    assert env["SUPPER_HOST"] == "0.0.0.0"


def test_reinstall_when_the_stamp_is_missing_or_different(starter, tmp_path):
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "python").write_text("")
    assert starter.needs_install("abc", "posix", tmp_path) is True          # no stamp yet
    (tmp_path / "jarvis-requirements.sha256").write_text("old")
    assert starter.needs_install("abc", "posix", tmp_path) is True          # lists changed
    (tmp_path / "jarvis-requirements.sha256").write_text("abc\n")
    assert starter.needs_install("abc", "posix", tmp_path) is False         # up to date


def test_no_install_without_a_venv(starter, tmp_path):
    assert starter.needs_install("abc", "posix", tmp_path) is True


def test_the_stamp_changes_when_a_requirement_file_changes(starter, tmp_path):
    for rel in starter.REQUIREMENTS:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("pkg==1\n")
    before = starter.requirements_stamp(tmp_path)
    assert before == starter.requirements_stamp(tmp_path)                   # stable
    (tmp_path / starter.REQUIREMENTS[-1]).write_text("pkg==2\n")
    assert starter.requirements_stamp(tmp_path) != before


def test_the_opencv_fix_keeps_only_the_headless_build(starter, monkeypatch):
    calls = []

    class Done:
        returncode = 0

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return Done()

    monkeypatch.setattr(starter.subprocess, "run", fake_run)
    assert starter._keep_one_opencv("/venv/python") is True
    uninstall, reinstall = calls
    assert "opencv-contrib-python" in uninstall and "opencv-python-headless" in uninstall
    assert "--force-reinstall" in reinstall and "opencv-python-headless==4.10.0.84" in reinstall


def test_the_opencv_fix_reports_a_failure(starter, monkeypatch):
    class Failed:
        returncode = 1

    monkeypatch.setattr(starter.subprocess, "run", lambda cmd, **kw: Failed())
    assert starter._keep_one_opencv("/venv/python") is False


def test_phone_instructions_give_the_pairing_page(starter, monkeypatch):
    monkeypatch.setattr(starter, "lan_address", lambda: "192.168.1.20")
    text = starter.phone_instructions(8765)
    assert "http://192.168.1.20:8765/pair" in text
    assert "pair my phone" in text
    monkeypatch.setattr(starter, "lan_address", lambda: None)
    assert "<this computer's address>" in starter.phone_instructions(8765)
