# My Hands — clean-room provenance record

Status: **written, reviewed by the implementer only.** An independent review and a
lawyer's check are still required before any distribution (see §6).

## 1. What this record covers

My Hands is the hand-gesture desktop control inside the Supper AI Agent (JARVIS base).
The owner asked for a rebuild that carries no rights risk and allowed improvements over
the original. This file records where the new code came from, what was and was not used,
and which third-party components it depends on.

The original is `barehands/` (AGPL-3.0), vendored in this repository. It stays
untouched and is not imported by any new code. Its licence is kept in `barehands/LICENSE`.

## 2. Honest statement of the clean-room

This is **not a strict clean-room**. The implementer read `barehands/stage.html` and
`barehands/server.py` during the Stage A audit (`docs/AUDIT_STAGE_A.md`) before writing
the new code. Reading the original is recorded here so nobody has to guess.

What was done to keep the new code independent:

1. The behaviour was written down first, from requirements, in `docs/MYHANDS_SPEC.md`.
   The spec is the only input for the new code. It holds thresholds, state rules, event
   names and camera rules as starting values, with reasons. It does not copy any text
   or structure from barehands.
2. No code, text, comments, images, icons, sounds or model files from `barehands/` are
   copied into `myhands/`, `backend/myhands_api.py`, `web/myhands.js` or the My Hands
   tests. Names were chosen for this code (for example `GestureEngine`,
   `CameraService`, `MyHandsSession`). Barehands identifiers were not reused.
3. The design differs from the original where the spec says so: One Euro smoothing,
   pinch hysteresis, hold times, a loss grace period, a single camera owner with explicit
   states and bounded retries, an idle auto-off, a calibration rectangle, and a local
   event stream instead of page-to-page state.

## 3. Checks run (2026-10-09)

| Check | Method | Result |
|---|---|---|
| Identical long lines | Every line of 30+ characters in the new My Hands files compared with barehands `server.py`, `stage.html` and its Markdown docs, after whitespace normalisation | 0 matches |
| Shared prose | 8-word sequences compared with barehands text and docs | 5 matches, all CSS property syntax (`margin px px border radius`). Not copied prose. |
| Shared identifiers | Identifiers of 6+ characters compared | 134 shared. Almost all are standard browser or Python API names (`addEventListener`, `clientHeight`, `ValueError`) or ordinary English (`because`, `through`). Domain terms (`gesture`, `landmarks`, `mediapipe`, `tracker`) appear as public API vocabulary. |
| Shared string literals | Quoted strings of 8+ characters | Only `Content-Type` and `application/json` |

The identifier overlap is reviewed here rather than hidden. A second, independent reviewer
should repeat these checks (§6).

## 4. Files and their inputs

| File | Written from | Third-party code used | Tests |
|---|---|---|---|
| `myhands/filters.py` | One Euro filter, published formula (Casiez, Roussel, Vogel, CHI 2012) | none | `test_myhands_gestures.py` (jitter, lag) |
| `myhands/gestures.py` | `MYHANDS_SPEC.md` §4–6, §8–9 | none (no camera or MediaPipe imports) | `test_myhands_gestures.py` (20 tests, covering each rule in §4–6) |
| `myhands/camera.py` | `MYHANDS_SPEC.md` §7 | OpenCV (`cv2`), imported only when a session starts | `test_myhands_camera.py` (fake device) |
| `myhands/tracker.py` | `MYHANDS_SPEC.md` §3 | MediaPipe Hands 0.10.14, imported only when a session starts | offline blank-frame run (see §5) |
| `myhands/session.py` | `MYHANDS_SPEC.md` §6, §8 | none | `test_myhands_session.py` (fakes, real threads) |
| `backend/myhands_api.py` | `MYHANDS_SPEC.md` §8 and the routes in `docs/ADR-001-browser-first.md` | FastAPI, Pydantic (MIT) | `test_myhands_api.py` |
| `web/myhands.js` | `MYHANDS_SPEC.md` §6 (events) and the M2 tile layout | none (no libraries) | jsdom check (see §5) |

Dependencies are listed in `THIRD_PARTY_NOTICES.md`. The licences were read from the
installed package metadata, not from memory.

## 5. Verification

- `pytest tests`: 210 passed in the project venv. The suite passed six times in a row at 120 tests (Track A), five times at 145 (V2-1), and five times at 210 (V2-2).
- `pyflakes myhands backend tests`: clean.
- Offline tracker run: `MediaPipeHandTracker().process(blank 640x480 frame)` returns no hands and runs without network access. Run in the project venv and in a clean venv built with the recipe in `backend/requirements-myhands.txt`.
- Browser check (jsdom, stubbed backend and WebSocket): 33 checks on start, events, grab, drag, release, failure paths, idle auto-off, stop, page close and reload. Harness: `tests/ui/myhands_ui.cjs` (run instructions in the file header).
- Existing M2 browser smoke: 22/22 still passes.
- **Not verified:** a real camera, real hands, lighting, or any reading of the owner's hands. These can only be checked on the owner's machine.

## 6. Open items before any distribution

1. Independent review of the code against barehands by someone who has not read barehands.
   Ask them to repeat §3 and to say whether the design (not just the code) is independent.
2. A lawyer's check on the combined work. The JARVIS base is **CC BY-NC 4.0**, which is
   non-commercial. The My Hands rewrite does not change that. This is a licence question,
   not legal advice.
3. The MediaPipe hand models ship inside the Apache-2.0 wheel. The package LICENSE covers them. Model-level terms were not checked separately.
4. Gesture thresholds in `MYHANDS_SPEC.md` §4 are starting values, not tuned.

## 7. Change log

- 2026-10-09: spec written (`docs/MYHANDS_SPEC.md`); engine, filter, camera, tracker, session, API, UI and tests written from the spec; provenance checks in §3 run; dependencies pinned in `backend/requirements-myhands.txt`.
