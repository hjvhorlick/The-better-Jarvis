# Upgrade roadmap — what is left to complete the application

Status: written 2026-10-10 after a full check of the repository on the `arena/72298ebd` branch.
This lists only what is **not finished yet**. Everything else (V2-0 … V2-6 as described in
`docs/V2_REDESIGN.md`) is built and its tests pass.

## How the check was done

- Installed `backend/requirements.txt` + `backend/requirements-dev.txt` in a clean venv.
- Ran the whole suite: **867 passed, 4 skipped, 6 failed** — and all 6 failures are only
  missing *optional* extras in the test machine, not bugs:
  - 3 × `test_myhands_preview.py` → need `backend/requirements-myhands.txt` (cv2). They pass
    after installing `opencv-python-headless`.
  - 3 × `test_wake_default.py` → need the `openwakeword` package
    (`backend/requirements-local-voice.txt`). The bundled model checksums themselves are correct.
- Booted the app (`python -m backend`): starts clean, serves the glass UI, `/api/diagnostics`
  reports devices, bus, budget and permissions correctly, Host/Origin guard works
  (`SUPPER_EXTRA_HOSTS` honoured for a hosted preview).

---

## 1. Finish V2-5 — skills still to port (the biggest block of work)

`backend/skills/` has the pattern (manifest, tier, test each) but only **weather** lives there;
web search and reminders are wired through the router. Still to port from the legacy `actions/`:

| Skill | Legacy source | Suggested tier | Notes |
|---|---|---|---|
| News | `actions/web_search.py` (news part) | SAFE | counts against the Gemini budget |
| Files (upload, move, delete) | `actions/file_controller.py` | CONFIRM | needs the path-allowlist security review first |
| Flights | `actions/flight_finder.py` | SAFE | not inspected yet (audit feature 32) |
| YouTube | `actions/youtube_video.py` | SAFE/CONFIRM | not inspected yet |
| Open apps / computer control | `actions/open_app.py`, `computer_control.py`, `computer_settings.py` | CONFIRM, desktop-only | hidden in the browser |
| Undo | `core/undo.py` | CONFIRM | audit feature 35, not inspected |
| Screen capture | — | CONFIRM | browser `getDisplayMedia` with consent (feature 13) |
| Smart home (Tuya) | legacy | CONFIRM | feature 24, later |
| Browser automation | `actions/browser_control.py` | owner decision | security review first (feature 30) |
| Messaging send | `actions/send_message.py` | owner decision | credentials review first (feature 31) |

## 2. Model-callable tools (voice and chat still cannot *act*)

The single most important functional gap:

- **Voice has no tools yet** (`docs/V2_REDESIGN.md` §13 known gaps). The legacy app's voice can
  call actions; V2 voice cannot. Until this is built, the legacy app must stay runnable.
- The memory archive tools and the self-repair tools are **chat commands only** — Gemini cannot
  call them as model tools (`docs/AUDIT_STAGE_A.md` §15, `docs/SELF_REPAIR.md` §5b known gaps).
- Plan: a tool-calling layer in `backend/agent.py` that exposes each ported skill through the
  permission policy (SAFE runs, CONFIRM asks in the UI), for both text chat and the Live relay.

> **Update 2026-10-10:** an audio self-test was built for exactly this step (owner reported mic
> and sound not working, with no visible error). "Test audio" button, `POST /api/voice/test`,
> chat command "test the sound", and `tools/check_voice.py`. A wake word that cannot start now
> says why in the status chip and diagnostics instead of failing silently.
> See `docs/LOCAL_VOICE.md` ("If voice does not work").

## 3. Prove V2-3 live (real hardware)

Built and fake-tested, never run on real audio. The 8-step × 3-OS checklist is in
`docs/V2_REDESIGN.md` §13 and still stands:

- Gemini Live round-trip with a real microphone and speaker.
- Barge-in on real speakers — the thresholds (1500 start / 900 stop) are unmeasured guesses.
- Wake word ("Hey Jarvis") on a real microphone; `tools/check_wake_model.py` must say ready.
- Mute, idle stop (60 s), and budget-exhausted refusal, per OS (Linux, Windows, macOS).

## 4. Finish V2-4 — memory migration

- The owner's backup of `memory/long_term.json` / `recent_dialogue.json` is **claimed but not
  verified in the workspace**. Verify it, then run the migration with the byte-identical check
  and the tested rollback.
- After migration: decide when memory moves from read-only to writable for V2.

## 5. V2-6 leftovers — packaging

- `Start JARVIS.bat` (Windows) and `Start JARVIS.command` (macOS) have **never been run** —
  only the Linux starter was tested end to end.
- The phone pairing page has not been tried on a real phone.
- No installer packages (.exe, .dmg) — needs code signing; optional.

## 6. Security cleanup and legacy retirement

From `docs/AUDIT_STAGE_A.md` §8 — these are still present in the tree:

1. `server.ts` still has `DEFAULT_PIN = 'JARVIS'`, the hardcoded
   `jarvis-live-session-token`, and the constant `AES_SALT`. It is a removal candidate
   (feature 40, owner decision pending) — **either retire it or fix it; do not leave it**.
2. `dashboard/server.py` runs plain HTTP on all interfaces and changes OS firewall rules.
   Same decision: retire with the legacy app, or fix.
3. `memory/command_log.txt` is **still tracked by git** and contains the owner's home paths —
   `git rm --cached` it and add it to `.gitignore`.
4. Unpinned dependencies: `"@google/genai": "latest"` in `package.json`; the root
   `requirements.txt` is unpinned (the backend has `requirements.lock.txt`, the legacy side does not).
5. Owner decisions still open on features **33 and 34** (shell commands,
   `update_mechanic.py` / `dev_agent.py` self-modification) for desktop use. They are blocked
   in the browser already; decide for desktop, then remove or gate the legacy paths.
6. Once V2 reaches voice-tool parity: retire `main.py`, `ui.py`, `server.ts`, `dashboard/`
   (phase 4 of `docs/WEBAPP_PLAN.md`).

## 7. Self-repair follow-ups (`docs/SELF_REPAIR.md` §5d)

- Errors in **background threads** (for example the voice relay) are not noticed by the
  error-notice system; connect them.
- Run the notice-and-fix flow as one live drill through the chat commands, end to end.

## 8. Small open items

- README.md is stale: it describes the old desktop app (`~/Jarvis/run.sh`, PyQt settings
  dialog). Update it for the V2 starters and the browser UI.
- Open decisions recorded in V2_REDESIGN §14: teach/forget tier (currently SAFE) and the
  **Kokoro-82M licence check** for local TTS.
- The wake model stays CC BY-NC-SA 4.0 (share-alike) — fine for personal use, revisit before
  any distribution.
- Local LLM provider (feature 41, Ollama / LM Studio) behind the provider interface —
  optional; `core/llm_client.py` is still unused.
- Developer convenience: `tests/test_myhands_preview.py` hard-imports numpy/cv2 — either add
  a skip-if-missing guard (like the wake tests should also get for `openwakeword`) or document
  that the full suite needs the myhands and voice extras.

## Suggested order

1. **Model-callable tools + remaining V2-5 skills** (items 1–2) — this is what makes V2 replace
   the legacy app.
2. **Live hardware proof of V2-3** (item 3) — needed before trusting voice day to day.
3. **Memory migration** (item 4) — after 1–2, with the verified backup.
4. **Security cleanup / legacy retirement** (item 6) — once parity is reached.
5. Packaging leftovers, self-repair follow-ups, small items (5, 7, 8) — any time, low risk.
