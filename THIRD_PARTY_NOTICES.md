# Third-party notices

This file lists third-party components used by the Supper AI Agent and the licences that
apply to them. Licence texts are in the packages named below, or in `LICENSE` for the
project itself.

## Project licence

- The Supper AI Agent (JARVIS base) is licensed under **CC BY-NC 4.0**, see `LICENSE`.
  Copyright (c) 2026 FatihMakes (original project, per `LICENSE`). Derived from Mark LIII by
  FatihMakes. See `CREDITS.md`.

## Vendored component

- **barehands** (`barehands/`), **AGPL-3.0**, see `barehands/LICENSE`. It is run as a
  separate process. The My Hands code (`myhands/`, `backend/myhands_api.py`,
  `web/myhands.js`) does not import, copy or reuse barehands code, text or assets (see
  `docs/MYHANDS_CLEAN_ROOM.md`).

## My Hands runtime dependencies (optional, loaded when My Hands starts)

| Component | Version | Licence | Where the licence text is | Use |
|---|---|---|---|---|
| MediaPipe | 0.10.14 | Apache-2.0 | `mediapipe-0.10.14.dist-info/LICENSE` (in the wheel); bundled hand models ship in the same package | Hand landmark detection |
| OpenCV (opencv-python-headless) | 4.10.0.84 | Apache-2.0 for the OpenCV binary | `cv2/LICENSE.txt` and `cv2/LICENSE-3RD-PARTY.txt` (in the wheel) | Camera capture |

Notes:
- MediaPipe depends on `opencv-contrib-python`. The project uses the headless build instead
  (see `backend/requirements-myhands.txt` for the install recipe).
- The OpenCV wheel bundles third-party components with their own licences. They are listed in `cv2/LICENSE-3RD-PARTY.txt`.
- The One Euro filter is implemented from the published algorithm (Casiez, Roussel and Vogel,
  "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems",
  CHI 2012). No third-party code is copied.

## Voice dependencies (optional, V2-3; loaded only when voice is used)

| Component | Version | Licence | Where the licence was checked | Use |
|---|---|---|---|---|
| sounddevice | 0.5.6 | MIT | Package metadata of the `sounddevice-0.5.6` wheel (`License-Expression: MIT`) | Server microphone and speaker |
| openWakeWord (code) | 0.6.0 (installed with `backend/requirements-local-voice.txt`) | Apache-2.0 | Package metadata (`pip show`) and the wheel's licence file | Wake word detector (`backend/voice/wake.py`) |
| "Hey Jarvis" model (`hey_jarvis_v0.1`) | **bundled** in `backend/voice/wake_models/` (upstream openWakeWord v0.5.1; SHA-256 checked) | CC BY-NC-SA 4.0 (non-commercial, share-alike, attribution), per openWakeWord's README (all its pre-trained models) and the model's Hugging Face page. Its licence is separate from the project's CC BY-NC 4.0 | openWakeWord README (v0.5.1, "License" section) and `wake_models/NOTICE.md` | Wake word, on the owner's computer only |
| openWakeWord feature models (`melspectrogram`, `embedding`) | **bundled** in `backend/voice/wake_models/` | CC BY-NC-SA 4.0 per openWakeWord's README (all its pre-trained models), so the same as the model above. The embedding model came from Google's Apache-2.0 TF Hub module, re-implemented by openWakeWord; the file itself is listed under openWakeWord's CC BY-NC-SA statement | openWakeWord v0.5.1 README; `wake_models/NOTICE.md` | Audio features for the wake word |
| faster-whisper | 1.2.1 | MIT | GitHub licence API for SYSTRAN/faster-whisper (`spdx_id: MIT`) | Speech to text on this computer (`backend/voice/stt.py`) |
| Whisper model weights (for example `Systran/faster-whisper-base`, a conversion of `openai/whisper-base`) | downloaded on first use | MIT, as stated on OpenAI's original model card (the Hugging Face page did not show the licence field when checked) | Hugging Face model page | Speech recognition model, cached on the owner's computer |
| pyttsx3 | 2.99 | MPL-2.0 (file-level copyleft: changes to its own files must be shared under MPL; the project uses it unmodified) | GitHub licence API for nateshmbhat/pyttsx3 (`spdx_id: MPL-2.0`) | The computer's own voice for spoken replies (`backend/voice/tts.py`) |
| kokoro-onnx | 0.6.1 | MIT | GitHub licence API for thewh1teagle/kokoro-onnx (`spdx_id: MIT`) | Runs the Kokoro voice (`backend/voice/tts.py`) |
| Kokoro-82M model (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) | not in the repository; the owner downloads it into `models/kokoro/` | Apache-2.0 for the weights, as stated on the model card (`hexgrad/Kokoro-82M`). Its training data notes list CC BY audio (Koniwa, SIWIS); see the model card | Hugging Face model card | Natural spoken replies, optional |

Notes:
- The local voice models are loaded only if the owner downloads them (see `docs/LOCAL_VOICE.md`).
- MPL-2.0 does not change the project's CC BY-NC 4.0 licence for the project's own code. Its file-level terms apply to pyttsx3's own files only.
- pyttsx3 depends on platform packages (pywin32 and comtypes on Windows; pyobjc on macOS). Their licences are not checked here; check them before installing on those systems.
- Starter knowledge (`knowledge/starter.json`) was written for this project. It is not copied from any source.

Notes:
- sounddevice needs the PortAudio system library. On Linux, install `libportaudio2`.
- **openWakeWord's pretrained models are not covered by its Apache-2.0 licence.** Its README says all of
  them are CC BY-NC-SA 4.0. The `hey_jarvis` model and the two feature models it needs are **bundled** in
  `backend/voice/wake_models/` (owner decision 7, 2026-10-10). Those files keep CC BY-NC-SA 4.0, and the
  notice is in `wake_models/NOTICE.md`. The wheel itself bundles no model files. Check the bundled files with
  `tools/check_wake_model.py`. This is not legal advice.
- openWakeWord depends on onnxruntime and other packages. Their licences are not checked here. Check them
  before installing wake word support.

## Backend dependencies (core)

| Component | Licence |
|---|---|
| FastAPI 0.143.0 | MIT |
| Starlette 1.7.0 | BSD-3-Clause |
| Uvicorn 0.54.0 | BSD-3-Clause |
| Pydantic 2.14.0 | MIT |
| HTTPX 0.28.1 | BSD-3-Clause |
| google-genai 2.29.0 | Apache-2.0 |
| NumPy 2.4.6 | BSD-3-Clause (and other permissive components listed in its metadata) |
| pytest 9.1.1 (dev only) | MIT |

Licence values were read from the installed package metadata. Check the package for the full text before redistribution.
