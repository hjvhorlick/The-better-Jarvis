"""Set up JARVIS once, then start it. Works on Windows, macOS and Linux.

You normally do not run this by hand. Use the starter for your system:
  * Windows:  double-click "Start JARVIS.bat"
  * macOS:    double-click "Start JARVIS.command"
  * Linux:    ./start_jarvis.sh

By hand, from the project folder:
    python tools/start_jarvis.py            set up if needed, start, open the browser
    python tools/start_jarvis.py --phone    also allow your phone to pair (home network only)
    python tools/start_jarvis.py --check    only report what is set up and what is missing
    python tools/start_jarvis.py --no-browser

What it does: makes a private Python environment in .venv (once), installs the packages the
project lists (again only when those lists change), then runs the app on this computer at
http://127.0.0.1:8765. With --phone it also listens on the home network, so a paired phone can
connect. Nothing is sent anywhere by this script.

Needs Python 3.10, 3.11 or 3.12. The vision package has no build for 3.13 yet.

Provenance: written for this project. Uses only the Python standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENV_DIR = REPO_ROOT / ".venv"
STAMP = VENV_DIR / "jarvis-requirements.sha256"
REQUIREMENTS = (
    "backend/requirements.lock.txt",        # the core app, pinned
    "backend/requirements-myhands.txt",     # My Hands (camera and hand tracking)
    "backend/requirements-voice.txt",       # microphone and speaker
    "backend/requirements-local-voice.txt", # speech on this computer and the wake word
)
MIN_PYTHON = (3, 10)
MAX_PYTHON = (3, 12)        # mediapipe (My Hands) publishes builds up to 3.12
DEFAULT_PORT = 8765


def check_python(version: tuple) -> str | None:
    """None when this Python can run the app; otherwise a plain-language reason."""
    if version[:2] < MIN_PYTHON:
        return (f"This is Python {version[0]}.{version[1]}. JARVIS needs Python "
                f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]} to {MAX_PYTHON[0]}.{MAX_PYTHON[1]}. "
                "Install one from python.org and run this again.")
    if version[:2] > MAX_PYTHON:
        return (f"This is Python {version[0]}.{version[1]}. The vision package for My Hands does not "
                f"support it yet. Install Python {MAX_PYTHON[0]}.{MAX_PYTHON[1]} from python.org and run this again.")
    return None


def is_windows(os_name: str | None = None) -> bool:
    return (os_name or os.name) == "nt"


def venv_python(os_name: str | None = None, venv: Path = VENV_DIR) -> Path:
    return venv / ("Scripts/python.exe" if is_windows(os_name) else "bin/python")


def requirements_stamp(root: Path = REPO_ROOT) -> str:
    """A fingerprint of the requirement lists. When it changes, the packages are installed again."""
    h = hashlib.sha256()
    for rel in REQUIREMENTS:
        h.update(rel.encode("utf-8"))
        h.update((root / rel).read_bytes())
    return h.hexdigest()


def needs_install(stamp: str, os_name: str | None = None, venv: Path = VENV_DIR) -> bool:
    if not venv_python(os_name, venv).exists():
        return True
    stamp_file = venv / "jarvis-requirements.sha256"
    try:
        return stamp_file.read_text(encoding="utf-8").strip() != stamp
    except OSError:
        return True


def build_env(base: dict, phone: bool, port: int = DEFAULT_PORT) -> dict:
    """The environment for the app. --phone opens the app to the home network and allows pairing."""
    env = dict(base)
    env["SUPPER_PORT"] = str(port)
    if phone:
        env["SUPPER_HOST"] = "0.0.0.0"
        env["SUPPER_PAIRING"] = "on"
    else:
        env.setdefault("SUPPER_HOST", "127.0.0.1")
    return env


def lan_address() -> str | None:
    """This computer's home-network address, for the phone instructions. No packets are sent."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        if s is not None:
            s.close()
    return None if not ip or ip.startswith("127.") else ip


def phone_instructions(port: int = DEFAULT_PORT) -> str:
    ip = lan_address()
    where = f"http://{ip}:{port}/pair" if ip else f"http://<this computer's address>:{port}/pair"
    return ("Phone pairing is on for this home network only. Ask JARVIS in the chat: \"pair my phone\" "
            f"(it asks you first). Then open {where} on your phone and type the code shown here. "
            "Do not use this on public Wi-Fi.")


def _say(text: str) -> None:
    print(text, flush=True)


def _create_venv() -> bool:
    _say("Setting up a private Python environment (one time)...")
    try:
        subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)
    except (subprocess.CalledProcessError, OSError):
        _say("Could not create the environment. On Linux, install the venv package first, for example: "
             "sudo apt install python3-venv. Then run this again.")
        return False
    return True


def _install() -> bool:
    py = str(venv_python())
    _say("Installing the packages JARVIS needs. This can take several minutes the first time.")
    for rel in REQUIREMENTS:
        result = subprocess.run([py, "-m", "pip", "install", "-r", str(REPO_ROOT / rel)],
                                cwd=str(REPO_ROOT))
        if result.returncode != 0:
            _say(f"Installing {rel} did not finish. Check the internet connection and run this again. "
                 "Messages above say what failed.")
            return False
    if not _keep_one_opencv(py):
        return False
    VENV_DIR.mkdir(exist_ok=True)
    STAMP.write_text(requirements_stamp(), encoding="utf-8")
    return True


def _keep_one_opencv(py: str) -> bool:
    """mediapipe asks for the full OpenCV build, which needs system graphics libraries on Linux and
    clashes with the headless build the project pins. Keep only the headless one (4.10.0.84)."""
    subprocess.run([py, "-m", "pip", "uninstall", "-y", "opencv-contrib-python", "opencv-python-headless"],
                   capture_output=True)
    result = subprocess.run([py, "-m", "pip", "install", "--force-reinstall", "--no-deps",
                             "opencv-python-headless==4.10.0.84"], capture_output=True, text=True)
    if result.returncode != 0:
        _say("Could not set up the camera library (OpenCV). Messages above say what failed.")
        return False
    return True


def _open_browser_later(url: str) -> None:
    timer = threading.Timer(2.0, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set up and start JARVIS.")
    parser.add_argument("--check", action="store_true", help="only report what is set up")
    parser.add_argument("--phone", action="store_true", help="allow phone pairing on the home network")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args(argv)

    problem = check_python(sys.version_info)
    if problem:
        _say(problem)
        return 1
    port = int(os.environ.get("SUPPER_PORT", DEFAULT_PORT))

    if args.check:
        _say(f"Python {sys.version_info[0]}.{sys.version_info[1]}: fine")
        if venv_python().exists():
            _say("Private environment (.venv): present")
        else:
            _say("Private environment (.venv): not made yet (the starter makes it)")
        if needs_install(requirements_stamp()):
            _say("Packages: not installed yet, or the lists changed (the starter installs them)")
        else:
            _say("Packages: installed and up to date")
        return 0

    if not venv_python().exists() and not _create_venv():
        return 1
    if needs_install(requirements_stamp()) and not _install():
        return 1

    env = build_env(os.environ, phone=args.phone, port=port)
    url = f"http://127.0.0.1:{port}"
    if args.phone:
        _say(phone_instructions(port))
    _say(f"Starting JARVIS. Open {url} in your browser. Press Ctrl+C here to stop it.")
    if not args.no_browser:
        _open_browser_later(url)
    try:
        return subprocess.call([str(venv_python()), "-m", "backend"], cwd=str(REPO_ROOT), env=env)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
