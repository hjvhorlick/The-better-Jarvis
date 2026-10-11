"""Voice doctor: check the speaker, the microphone and the speech engines, without the app.

Run it from the project folder, with the project's own Python:

  Windows:  .venv\\Scripts\\python tools\\check_voice.py
  Linux:    .venv/bin/python tools/check_voice.py
  macOS:    .venv/bin/python tools/check_voice.py

What it does, in order — everything stays on this computer:
  1. sound system   is the audio package there, and which devices are the system default
  2. speaker        plays a one-second beep (you must actually hear it)
  3. microphone     listens for a few seconds — speak normally — and measures the level
  4. speech to text, spoken replies, wake word: are the engines installed and ready

Exit code 0 when every check passes, 1 otherwise. No network use, nothing is recorded.

Provenance: written for this project. Uses backend/voice/doctor.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    from backend.devices import DeviceRegistry
    from backend.events import EventBus
    from backend.voice import doctor
    from backend.voice.audio import Microphone, Speaker
    from backend.voice.factory import _device_setting

    devices = DeviceRegistry(EventBus())
    mic = Microphone(device=_device_setting("SUPPER_MIC_DEVICE"))
    speaker = Speaker(device=_device_setting("SUPPER_SPEAKER_DEVICE"))
    devices.register("microphone", mic)
    devices.register("speaker", speaker)

    print("JARVIS voice doctor. A beep plays first; then speak normally for a few seconds.\n")
    result = doctor.run(devices, mic, speaker)
    for check in result["checks"]:
        mark = "OK " if check["ok"] else "FAIL"
        print(f"  [{mark}] {check['name']}: {check['detail']}")
    print()
    if result["ok"]:
        print("Everything works. If voice still seems quiet in the app, run the audio test")
        print("there too (the 'Test audio' button next to the chat).")
        return 0
    print("Fix the FAIL lines above, then run this again.")
    print("Most common causes: the voice packages are not installed (backend/requirements-voice.txt")
    print("and backend/requirements-local-voice.txt), the wrong microphone is the system default,")
    print("or the system's microphone permission for Python is off.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
