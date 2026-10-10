"""Check the "Hey Jarvis" wake-word model files that ship with the project.

The model files are bundled in backend/voice/wake_models/ (owner decision 7, 2026-10-10).
This tool does not download anything. It shows the licence, checks each file against its
SHA-256 checksum, and says whether wake word can start.

Usage, from the project folder with the virtual environment active:
    python tools/check_wake_model.py

Exit code 0 means ready. Exit code 1 means something is missing or does not match.
Licence: the model files are CC BY-NC-SA 4.0 (non-commercial, share-alike, attribution).
See backend/voice/wake_models/NOTICE.md. This is not legal advice.

Provenance: written for this project. It uses the checks in backend/voice/wake.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

NOTICE = """\
Wake word model: "Hey Jarvis" (openWakeWord v0.5.1, files hey_jarvis_v0.1, melspectrogram, embedding)

  * The model files are licensed CC BY-NC-SA 4.0: non-commercial use only, share-alike,
    attribution required. Upstream states that this covers all pre-trained openWakeWord models.
  * openWakeWord's code is Apache-2.0. The project's own licence (CC BY-NC 4.0) does not change
    the terms of these files. See backend/voice/wake_models/NOTICE.md.
"""


def main(wake=None) -> int:
    if wake is None:
        from backend.voice import wake as wake_module
        wake = wake_module

    print(NOTICE)
    problems = 0
    for name in (wake.WAKE_MODEL_FILE, *wake.FEATURE_MODELS):
        path = wake.MODEL_DIR / name
        if not path.is_file():
            print(f"  MISSING  {name}")
            problems += 1
            continue
        if wake._sha256(path) != wake.BUNDLED_SHA256[name]:
            print(f"  BAD      {name} (checksum does not match; copy the folder from the project again)")
            problems += 1
            continue
        print(f"  OK       {name}")

    ready, reason = wake.availability()
    if ready:
        print("\nWake word is ready. The app listens for \"Hey Jarvis\" when it starts.")
        return 0
    print(f"\nWake word is not ready: {reason}.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
