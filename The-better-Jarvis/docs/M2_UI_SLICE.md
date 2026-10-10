# M2 — Glass UI slice, M1 fixes, and what is and is not built

Status: **first slice built and tested in a headless browser. Not yet tested in a real
browser on the owner's PC, and the Gemini reply is still unverified.** Nothing is committed or pushed.
Branch `arena/6e171ee4-the-better-jarvis`.

## What the owner asked for, and where each part stands

| Request | State |
|---|---|
| Bring barehands into JARVIS, one application, no two-way gap | **Foundation only.** One backend now serves the UI, and the UI and the agent share one process. My Hands is now built as original code (see the My Hands section at the end and `docs/MYHANDS_CLEAN_ROOM.md`). It is not verified with a real camera. |
| Use the barehands glass interface as the JARVIS UI | **Approximation.** The look (dark translucent cards, glow, grab feedback) follows the same idea. The barehands code itself is **not copied** yet. See "Licence" below. |
| Several panels that slide in from the side, one per interface (coding, marketing, design …) | **Built:** Coding, Marketing, Design, Files. Each one sets the workspace context for the assistant. |
| More interfaces | **Not added yet.** Candidates: Writing, Research, Finance, Study, Inbox/admin, Planning. Adding one is a single entry in `backend/workspaces.py` and one panel in `web/index.html`. |
| Folders and files easy to grab, move and open | **Built:** drag to move (positions saved per item), double-click or Enter to open, folders open into a list, text files preview in the Files panel. |
| Voice that gives easy file methods | **Not built.** Depends on voice (M3) and file write actions with confirmation (M6). Design is in "Voice file commands" below. |
| Icons that really are the desktop's icons | **Not built.** This UI shows the folders you allow, not the OS desktop. Real desktop icons need the native integration (M6/M7). |

## M1 fixes made in this pass

- **Verified** the Gemini SDK call format against the installed `google-genai` 2.29.0: the config dictionary is accepted. The live network call is still unverified.
- **Added a local-only guard** (`backend/security.py`). It rejects requests whose Host header is not this machine (blocks DNS-rebinding) and requests from a non-local Origin (blocks ordinary web pages on other sites). Covered by 24 tests (`tests/test_security.py`) and by live `curl` checks that returned 403.
- **Fixed the IPv6 host parsing** (`::1` without brackets was refused).
- **File access is limited to chosen folders** (`backend/files.py`): `..` tricks, symlinks pointing outside, hidden entries, and binary previews are refused. The boundary is checked **before** existence, so the API cannot be used to see whether files exist outside the allowed folders.
- **Dependencies** are pinned: `backend/requirements.lock.txt` holds the exact versions that were tested. `requirements.txt` ranges now match the desktop app's `google-genai>=2.8.0`.
- **Workspace context** is added to the assistant's system instruction (one short line), without changing the personality file.

## What was verified

| Check | Result |
|---|---|
| `pytest` (67 tests: persona, memory isolation, chat, API, files, security) | **67 passed** |
| Live backend: UI served at `/`, `app.js` served | 200 / 200 |
| Live backend: list and preview of an allowed folder | works |
| Live backend: binary file preview | refused with a clear message |
| Live backend: file outside allowed folders | 403 |
| Live backend: `Host: evil.example` | 403 |
| Live backend: cross-site `Origin` on chat | 403 |
| Live backend: chat without a key | 503 with a clear message |
| **Headless browser (jsdom) against the live backend** — 22 checks: roots shown, folders open, sorting, breadcrumbs, text preview, binary refusal, up navigation, panels open/close one at a time, Escape, drag saves position, click does not move, chat error shown, HTML in a file name shown as text | **22 of 22 passed** |

## What was NOT verified (honest list)

- **Real browser layout and look.** jsdom has no layout engine and no CSS rendering. Visual
  appearance, animation timing and touch behaviour have not been seen. Open `http://127.0.0.1:8765` on your PC and check.
- **A real Gemini reply** (no key and no network to the Gemini host in this sandbox).
- **Camera, microphone, speakers and My Hands** — none of these are in M2.
- **Windows and macOS.** Everything was run on Linux only.
- **Keyboard and screen-reader use** beyond basic focus and Enter.

## How to run it on your PC

```bash
cd ~/The-better-Jarvis
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.lock.txt -r backend/requirements-dev.txt
python -m pytest -q
export GEMINI_API_KEY=your_key_here           # in the shell; never written to a file
export SUPPER_FILE_ROOTS=~/Documents:~/Desktop  # folders you allow (os.pathsep-separated)
python -m backend
# open http://127.0.0.1:8765 in Chrome
```

Without `SUPPER_FILE_ROOTS`, the default is Desktop, Documents and Downloads under your home folder, where they exist.

## Licence (must be settled before the barehands code is copied in)

- The barehands code is **AGPL-3.0**. JARVIS is **CC BY-NC 4.0**. The new UI in `web/` is written from scratch and does not copy barehands code. That keeps the licence question open for this slice only.
- Superseded for My Hands: the owner chose an original rewrite, and no barehands code is copied (`docs/MYHANDS_CLEAN_ROOM.md`). The whole app is still under the JARVIS base licence, CC BY-NC 4.0. Not legal advice; a lawyer should check before distribution.

## Voice file commands (design, not built)

Voice would call the same file tools the UI uses, so there is one code path:

- "What's in Projects?" → `list` on an allowed folder, then read the names back.
- "Open the notes file" → find by name inside allowed roots, then preview.
- "Move this to Documents" / "Delete that" → **always** a confirmation step, spoken and shown, and a trash/undo path. Nothing is permanent.
- Anything outside the allowed roots is refused, as in the UI.

## Known limitations and technical debt

- `memory/memory_manager.py` defines `format_dialogue_for_prompt` twice; the second definition is used. Not changed, because the file is off-limits until the owner backup (M0) is done.
- Persona assembly is a copy of the logic in `main.py`; merging them should wait until both are tested.
- Chat history is in process memory only and is lost on restart. Writing it to the persistent store waits for M0.
- The backend has no login. It only accepts local requests (see the guard). Any LAN exposure needs authentication first.
- The UI is plain JavaScript with no build step. That is a deliberate choice for this slice. It is worth revisiting when the number of panels grows; this changes ADR-001's "Vite" line.
- Tile icons are a folder/file emoji only; no file-type icons yet.
- No file writes (move, rename, delete) exist yet. Writes wait for M6.

## Files added in this pass

`backend/` — `security.py`, `files.py`, `workspaces.py`, updated `app.py`, `chat.py`, `config.py`, `persona.py`, `requirements.lock.txt`, `requirements-dev.txt`.
`web/` — `index.html`, `styles.css`, `app.js`.
`tests/` — `test_files.py`, `test_security.py`, updated `test_api.py`, `test_persona.py`.
`docs/` — `M2_UI_SLICE.md` (this file).

## My Hands (added after M2)

Built as original code from `docs/MYHANDS_SPEC.md`. Nothing is committed or pushed yet.

- Backend: `myhands/` (gesture engine, One Euro filter, camera service, MediaPipe adapter, session), `backend/myhands_api.py` (`POST /api/myhands/start`, `POST /api/myhands/stop`, `GET /api/myhands/status`, `PUT /api/myhands/scene`, `WS /ws/myhands?since=N`). The camera is opened only after a start request. Frames never leave the process; the browser receives events only.
- Browser: My Hands button and status chip in the top bar; cursor overlay; tiles move on gesture events; stop request sent when the page closes.
- Privacy: session stops on user request, on 10 minutes without a hand, on camera failure, and on page close. Every stop releases any grab first.
- Dependencies: `backend/requirements-myhands.txt` (mediapipe 0.10.14, opencv-python-headless 4.10.0.84). Install recipe is in that file. Notices in `THIRD_PARTY_NOTICES.md`.
- Tests: 210 pytest tests pass (My Hands: engine, filter, camera states, session, API and WebSocket guard). 33 browser checks pass (jsdom, stubbed backend). The M2 browser smoke still passes 22/22.

Not verified (must be checked on the owner's PC):
- A real camera, real hands, lighting, and the gesture thresholds (starting values, untuned).
- Reconnect behaviour after a real unplug, and the Windows and macOS camera paths (only Linux was tested here).
- Voice and Gemini replies are unchanged by this work and were not re-tested.

Known gaps and interpretations:
- `object_dragged` is throttled; the final position is sent on `object_released`, not as an extra drag event.
- `cursor_moved` and `object_dragged` are each limited to 30 per second.
- The camera's reconnect counter resets after 10 seconds of stable frames.
- Calibration rectangle is supported in the engine config, but there is no UI for it yet.
- The browser's tile list is capped at 50 objects, which matches the backend limit.
