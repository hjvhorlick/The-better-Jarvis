# Supper AI Agent v2 — redesign blueprint

Status: **V2-0 accepted by the owner (2026-10-09); V2-1 built.** See §7 for exactly what
V2-1 contains. Nothing is committed or pushed.

Owner's goal: one application, not several. Camera, microphone, speaker, gestures, chat
and the agent share one process and one event stream. It runs on Windows, Linux and
macOS. It should be better than the current app, and it should be original work that can
be explained and checked, not a patch on someone else's code.

## 1. What v2 is

- **One application.** A FastAPI server owns all hardware and secrets. A browser UI is
  the front end. No Electron, no Tauri (master prompt).
- **One event stream.** Every state change (hand seen, pinch, object moved, camera
  stalled, voice started, reply finished, reminder fired) becomes a sequenced event.
  The agent can read the recent events, so it knows what the owner is doing.
- **One owner per device.** The camera, microphone and speaker each have exactly one
  owner in the server. Other code asks for a lease. This fixes the current problem where
  several places open the camera separately (`ui.py`, `screen_processor`, My Hands).
- **Local first, cloud when needed.** Commands the app can handle itself (open a folder,
  set a timer, read a file preview) run locally. Gemini is called only for what needs it.
  This also protects the free-tier quota.

## 2. What v2 must keep

These come from the master prompt and the audit. They are not negotiable for any stage.

- The personality file `core/prompt.txt`. Not edited until the owner finishes reworking it.
- Persistent memory (`long_term.json`, `recent_dialogue.json`). Never cleared, reset,
  overwritten or reinitialised. Migration waits for the Stage B review and a backup.
- Gemini integration and current configuration (live model `models/gemini-3.8-live` — updated
  2026-10-12 from `models/gemini-3.1-flash-live-preview`, which Google shuts down on
  17 November 2026; key read from the server side only).
- Every feature in the audit table (§8 below), or an explicit owner decision to drop it.
- The original app stays runnable until v2 reaches parity. Backups and rollback are kept.
- The CC BY-NC 4.0 licence and the attribution to FatihMakes / Mark LIII (see §6).

## 3. Architecture

```
Browser (any OS)
  glass UI · chat · desktop tiles · My Hands cursor · settings · diagnostics
        │  HTTP (commands)            │  WebSocket /ws/events (one stream, seq numbers, replay)
        ▼                              ▲
Gateway (FastAPI, local-only guard, Host/Origin checks)
        │
Core
  ├─ Event bus        bounded, sequenced, replayable; the only way modules talk
  ├─ Permission policy  SAFE / CONFIRM / BLOCKED tiers; confirmations shown in the UI
  └─ Diagnostics      device states, event log, quota meter, last errors (no secrets)
        │
Devices (one owner each, leases, release on stop)
  ├─ Camera      CameraService (exists in myhands/camera.py; to generalise)
  ├─ Microphone  owner + VAD (V2-3)
  └─ Speaker     owner + playback queue with barge-in (V2-3)
        │
Perception (publishes events; never opens a device directly)
  ├─ My Hands    gesture engine, session (exists)
  └─ Vision      on-request snapshot through the camera lease (V2-1)
        │
Agent
  ├─ Router      1) local intents  2) Gemini text  3) Gemini Live (voice)
  ├─ Persona     prompt file + memory block + workspace block (exists in backend/persona.py)
  ├─ Memory      read-only in v2 until Stage B review
  └─ Skills      tools with a manifest, permission tier, and a test each
        │
Providers (behind small interfaces, so they can be swapped)
  Gemini text · Gemini Live · STT · TTS · optional local LLM
```

What already exists and fits: the backend gateway and guard, the file browser with path
checks, workspace-aware persona assembly, My Hands with its event model, and the glass UI.
What is new: the shared event bus, the device owners, the router, and the skill manifest.

## 4. Improvements over the current app

Each improvement says why, and where the idea came from. The ideas are concepts from
public projects. No code, text or assets are copied, and each module gets a provenance
note like `docs/MYHANDS_CLEAN_ROOM.md`.

| # | Improvement | Why it matters here | Idea from (concept only) |
|---|---|---|---|
| 1 | One sequenced event stream with replay | The agent and the UI see the same state. This is the core of "one application". | Frame and event pipelines in [Pipecat](https://github.com/pipecat-ai/pipecat) and the Home Assistant Assist pipeline, which both pass typed stages between components |
| 2 | Local intent router before the LLM | Saves Gemini quota and lowers latency. Home Assistant's setup prefers local intents, and its config exposes `prefer_local_intents` ([source](https://www.joekarlsson.com/blog/local-voice-ai-home-assistant-gpu/)). | Home Assistant Assist |
| 3 | Barge-in: the owner can interrupt speech, and pending audio is cancelled | Voice feels natural and does not talk over the owner. | Pipecat's interruption handling ([comparison](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents)) |
| 4 | Device leases with one owner per device | Fixes double camera opens and leaves the camera off when not in use. | Our own audit (§5 and §7). In the live test here, the camera failed to open and the state had to say so, so device state must always be visible |
| 5 | Permission tiers with a confirmation UI; no unrestricted shell in the browser | Safety. A 2026 overview of open-source agents notes real security caveats for autonomous agents that take actions ([overview](https://www.usecarly.com/blog/open-source-ai-assistant/)). | Our audit (§8: shell and self-modification are high risk) |
| 6 | Gesture quality: One Euro smoothing, hysteresis, loss grace, calibration, measured success criteria | A public hand-gesture project notes that smoothing was essential for a usable cursor ([example](https://github.com/santoshnarreddy/hand-gesture-controller)). | Published One Euro filter and standard hysteresis; implemented in `myhands/` |
| 7 | Providers behind interfaces (STT, TTS, LLM) | Avoids lock-in and lets the owner choose local or cloud. | Wyoming-style service boundaries in Home Assistant |
| 8 | Diagnostics page: device states, event log, quota meter, last errors | The brief asks for it, and the audit found none. | Our own audit (feature 38) |
| 9 | Skills with a manifest, tier and tests | Plugins are the extension point; today the plugin loader has no permission model. | Our own audit (feature 37) |
| 10 | Privacy by design: frames stay on the machine, camera indicator, auto-off | Users can see when the camera is on and that frames are not uploaded. | My Hands spec §8 |

Things we are deliberately not claiming: that v2 is "ahead of others". That needs
measurements on the owner's hardware (latency, false pinches per hour, reconnect
behaviour). The success criteria are in `docs/MYHANDS_SPEC.md` §10.

## 5. Feature map (the 41 features in `docs/AUDIT_STAGE_A.md` §6)

Key: **Keep** (same behaviour, moved) · **Improve** (same purpose, new design) ·
**Later** (planned milestone) · **Owner decision** (not decided here).

| # | Feature | v2 treatment | Milestone |
|---|---|---|---|
| 1 | Gemini Live voice | Improve: server relay, browser sends PCM, barge-in | V2-3 |
| 2 | Text chat | Keep: already in M2 | done (M2) |
| 3 | Personality `core/prompt.txt` | Keep unchanged | — |
| 4 | Voice styles and voices | Keep (data only) | V2-3 |
| 5 | Persistent memory | Keep; migrate only after backup and Stage B review | V2-4 |
| 6 | Recall tool and memory index | Keep as-is | V2-4 |
| 7 | Recent dialogue | Keep as-is | V2-4 |
| 8 | Session summaries | Keep as-is | V2-4 |
| 9 | Settings (`api_keys.json`) | Improve: settings UI; secrets never returned | V2-1 |
| 10 | Wake word "Hey Jarvis" (opt-in) | Owner decision (browser or server); not inspected yet | V2-3 |
| 11 | Camera live view | Improve: via camera lease, shown in the UI | V2-1 |
| 12 | Vision on request | Improve: snapshot through the lease, no fresh open | V2-1 |
| 13 | Screen capture | Improve: browser screen share with consent | V2-5 |
| 14 | Microphone | Improve: owner + VAD | V2-3 |
| 15 | Speaker | Improve: owner + playback queue | V2-3 |
| 16 | Device pickers | Improve: enumerate in the browser, backend fallback | V2-1 |
| 17 | Mute | Keep: mutes the owner's track | V2-3 |
| 18 | Remote dashboard / phone pairing | Keep as the web base; pairing later | V2-6 |
| 19 | Dashboard PIN login | **Security fix first**: remove default PIN and hard-coded token | V2-1 |
| 20 | File list, preview, upload | Keep preview (done); upload with path checks | V2-5 |
| 21 | My Hands board | Replaced by original `myhands/` (done in part) | done |
| 22 | Pinch, grab, drag, release | Replaced by original engine; behaviour tested | done |
| 23 | CDN dependencies for My Hands | Removed: MediaPipe runs from the local package | done |
| 24 | Smart home (Tuya) | Later; not inspected | V2-5 |
| 25 | Web search, news | Keep as a skill | V2-5 |
| 26 | Weather | Keep as a skill | V2-5 |
| 27 | Reminders | Improve: scheduler on the event bus | V2-5 |
| 28 | Open apps, computer control | Desktop-only skill behind CONFIRM; hidden in the browser | V2-5 |
| 29 | File controller | Keep with path allowlist; needs security review | V2-5 |
| 30 | Browser automation | Later; desktop-only; security review first | later |
| 31 | Messaging send | Later; credentials review first | later |
| 32 | YouTube, flights, games | Later; not inspected in detail | later |
| 33 | Shell commands | **Not in v2 browser.** Any desktop use needs an explicit owner decision | owner decision |
| 34 | Autonomous code writing and self-repair | **Not in v2.** No autonomous self-modification (master prompt). Owner decision for the existing code | owner decision |
| 35 | Undo | Later; not inspected | V2-5 |
| 36 | Confirmation of risky actions | Improve: permission tiers with UI | V2-1 |
| 37 | Plugin system | Improve: manifest, tier, test per skill | V2-5 |
| 38 | Diagnostics | Build new | V2-1 |
| 39 | Tests | Build new; grows each milestone | every milestone |
| 40 | `server.ts` Node dashboard | Not used; removal candidate after confirmation | owner decision |
| 41 | Local LLM (Ollama, LM Studio) | Optional provider; `core/llm_client.py` is not imported anywhere, so inspect first | V2-2 |

Not yet inspected, so the mapping above is provisional: features 10, 24, 30, 31, 32, 35.

## 6. Originality, attribution and licence

- **Original code.** New modules are written from written specifications. Each module
  gets a provenance note. Before a module is released, it passes the checks in
  `docs/MYHANDS_CLEAN_ROOM.md` §3 (identical-line and shared-phrase checks against any
  source that was read).
- **Ideas are not copies.** Architecture patterns from Pipecat, LiveKit Agents, Home
  Assistant Assist and the public hand-gesture projects are used as concepts. Their code,
  text and assets are not copied. Their licences are noted in `THIRD_PARTY_NOTICES.md`
  when a dependency is used.
- **Attribution stays.** The base project is CC BY-NC 4.0 by FatihMakes, derived from Mark
  LIII. A rewrite does not remove that obligation to credit it. Removing the credit would
  be a licence breach, and it would hurt the "we did not copy anyone" position rather than
  help it. The honest position is: the base is credited, the new code is original, and
  every borrowed idea is recorded.
- **Non-commercial.** The base licence is non-commercial. Any commercial use needs the
  licence holder's permission. This is a licence question, not legal advice. A lawyer should check before distribution.
- **barehands** stays AGPL-3.0 and is not used by v2 code.

## 7. Milestones

| Milestone | Scope | Exit check |
|---|---|---|
| **V2-0** | This blueprint, reviewed | Owner approves or changes it |
| **V2-1** | Event bus; device registry with camera lease; My Hands on the bus; diagnostics API; permission policy | **Built (2026-10-09).** Tests: bus, leases, policy, API and stream guard. Live check: one sequence across `my_hands` and `devices`. Deferred to V2-2: permission-tier UI and diagnostics panel; PIN and token fix in the legacy dashboard (see §9) |
| **V2-2** | Permission-tier confirmation UI; diagnostics panel; local intent router; chat on the bus; Gemini text via the server; quota meter | **Built (2026-10-09).** Local intents never call Gemini (tested). Budget counted and shown. Key never reaches the browser (tested). Local LLM (feature 41) not built here |
| **V2-3** | Microphone and speaker owners; STT and TTS; Gemini Live relay; barge-in; mute; wake word decision | **Built (2026-10-09), not yet proven with a live round-trip.** Fake-based tests pass. Live round-trip, barge-in on real speakers, and the cross-OS checks are still to do (§13) |
| **V2-4** | Memory migration (only after backup and Stage B review) | **Partly unblocked (2026-10-09).** Stage B approved. Source backup and baseline tests are done, and the archive-not-delete change is built (audit §15). Archive search (read-only) and restore (asks each time) are built as chat commands (audit §15). Still needed: the owner's backup copies in the workspace, so the migration can be checked against the real files. The owner has said the backup was run, but it is not verified here. Memory byte-identical before and after; rollback tested |
| **V2-5** | Skills ported with tiers and tests (weather, search, reminders, files, then desktop skills) | **Slices 1 and 2 built (2026-10-09), ahead of V2-4 because they do not touch memory.** Skill pattern (`backend/skills/`), tiers in the policy. Weather (CONFIRM, opens a search page; tested with a fake browser). Web search (SAFE, one Gemini request with Google Search on, counts against the budget; tested with a recording fake, not a live call). Reminders (in-app timer and a file in the runtime folder; adding and listing SAFE, cancelling CONFIRM; fire only while the app runs, late ones are marked; tested). Still to port: news as its own skill, files, flights, YouTube, and desktop skills. Each skill has a test and a tier; no shell in the browser |
| **V2-6** | Packaging for Windows, macOS, Linux; pairing from a phone | **Built (2026-10-10).** Starters for all three systems (`Start JARVIS.bat`, `Start JARVIS.command`, `start_jarvis.sh`, sharing `tools/start_jarvis.py`). Install notes per OS in `docs/INSTALL.md`. Phone pairing is off by default and needs two switches (`--phone`). Pairing tests (30) and launcher tests (17) pass. Linux starter run end to end, including phone pairing over HTTP (wrong code refused, phone cookie, forget cuts access). **Not run:** Windows and macOS starters (cannot run here); the phone page on real phones. No installer packages (.exe, .dmg), which need code signing |

Layer 2 expansion is out of scope for every milestone above, as the master prompt requires.

## 8. Risks

- Gemini free-tier limits, and the Live model is a preview that can change. Respect the quota; do not assume unlimited use.
- Camera and microphone permissions differ per OS. The browser route helps, but each OS needs a check.
- Hand tracking is untested on the owner's camera and lighting. Its success criteria are not met until measured.
- Memory migration: the memory files are not in this checkout, so they can only be backed up on the owner's machine.
- The old app and v2 must not both own the camera at the same time during the transition.

## 9. Decisions needed

Answers given by the owner on 2026-10-09 are recorded in §11. The questions below are kept for reference.

1. **Next step.** Start V2-1 now (event bus, camera lease, My Hands on the bus, diagnostics), or review this blueprint first?
2. **Where voice audio runs.** In the browser (works on any OS, needs browser permission) or on the server through the existing `sounddevice` path (desktop only, what the current app uses)?
3. **Old app.** Keep `main.py` and `ui.py` runnable as the legacy app until V2 reaches parity? (Recommended: yes.)
4. **Features 33 and 34** (shell commands, autonomous code writing). Drop them from v2, or keep them desktop-only behind a confirmation? (Recommended: drop from the browser; decide separately for desktop.)

## 10. What V2-1 built (2026-10-09)

| Piece | File | What it does |
|---|---|---|
| Event bus | `backend/events.py` | Sequenced, bounded, replayable; `publish(source, event)`, `since(seq, source)`; tested for ordering, copies, capacity and concurrency |
| Device registry | `backend/devices.py` | One device, many owners. First lease starts the device, last release stops it. Lease changes go on the bus |
| Camera lease | `backend/myhands_api.py` (`default_session`) | My Hands takes lease `myhands` on the camera. The session code is unchanged apart from the bus |
| My Hands on the bus | `myhands/session.py` | Events are published with source `my_hands`. `/ws/myhands` and its tests still pass |
| Event stream | `backend/stream.py` | `WS /ws/events?since=N`, all sources, local-only guard |
| Diagnostics | `backend/diagnostics.py`, `GET /api/diagnostics` | Version, key present (yes/no only), devices and holders, bus state, myhands status, last 10 problem events. No secrets, no file paths |
| Permission policy | `backend/permissions.py` | SAFE, CONFIRM, BLOCKED. Unknown actions denied. `shell.run` and `code.self_modify` are blocked for the browser, even if confirmed |

Tests: 145 pytest tests pass (5 runs in a row). 33 My Hands browser checks and 22 M2 browser checks
pass against the live backend. Live stream check: `my_hands` and `devices` events share one sequence.

Not in V2-1: no skill runs through the permission policy yet (no skills are ported), so the policy is
built and tested but not yet used by a live action.

## 11. Owner decisions (recorded 2026-10-09)

| Question | Answer | How it is applied |
|---|---|---|
| Next step | Start V2-1 now | Done (§10) |
| Where voice audio runs | On the server (`sounddevice`) | V2-3 builds the server microphone and speaker owners. Browser audio stays a later option |
| Wake word | On the server ("the more things run on the computer and not the browser, the better") | Listening runs on this computer only. The browser shows state and sends clicks. The `hey_jarvis` model files are **bundled** in `backend/voice/wake_models/` (owner decision 7, §14), under CC BY-NC-SA 4.0 (see that folder's NOTICE.md) |
| Original app | "Retire it now" | **Frozen, not deleted.** `main.py`, `ui.py` and the memory files are the only place voice and memory run today. Deleting them now would remove voice and memory access before v2 has either. Deletion waits for V2-3 (voice), V2-4 (memory, after backup and Stage B review), and your explicit go-ahead. No feature is added to the legacy app |
| Features 33 and 34 | Keep desktop-only behind confirmation | Not in the browser (blocked in the policy). A desktop policy with a per-run confirmation is planned in V2-5. Autonomous self-modification (part of 34) is **not** kept: the master prompt forbids adding it, so only confirmed, human-initiated actions could be kept |

Open item, not changed here: the legacy dashboard (`dashboard/server.py`) still has the default PIN
and token noted in the audit (§8). Changing them touches the legacy app, so it waits for your go-ahead.
v2 has no PIN login yet, so it does not have that problem.

## 12. What V2-2 built (2026-10-09)

Order followed the plan: local intents first, then chat on the bus, then the Gemini budget,
then the permission UI and diagnostics panel.

| Piece | File | What it does |
|---|---|---|
| Local intent router | `backend/router.py` | Plain patterns for the everyday commands: time, date, system status, list folders, open an allowed folder, turn My Hands on or off, help. English only. No match means Gemini |
| Agent | `backend/agent.py` | One entry point for a chat message. Runs the router, checks the policy, opens confirmations, spends the budget, calls Gemini, publishes chat turns to the bus (source `chat`) |
| Daily budget | `backend/quota.py` | Counts the Gemini calls this app makes, per local day. Default 20 (`SUPPER_GEMINI_DAILY_BUDGET`; 0 turns Gemini off). Stored in `runtime/quota.json` (git-ignored). Fails closed if the file is unreadable. A 429 from Gemini closes the budget for the day |
| Confirmations | `backend/permissions.py` (`ConfirmationStore`) | CONFIRM actions wait for the owner. Approve runs the action once. Deny or 120 s without an answer cancels it. Events go on the bus (source `permissions`). Queue of at most 10 |
| Policy table | `backend/permissions.py` (`default_policy`) | Every router action is registered. Starting My Hands is CONFIRM. Stopping it is SAFE. `shell.run` and `code.self_modify` are BLOCKED |
| Chat endpoint | `backend/app.py` | `POST /api/chat` now returns `reply`, `source` (`local`, `gemini`, `confirmation`, `blocked`), `intent`, `confirmation`, `open_path`. 429 when the budget is used up or the queue is full |
| Confirmation endpoints | `backend/app.py` | `GET /api/confirmations`; `POST /api/confirmations/{id}` with `{"approve": bool}`. Unknown, expired or answered ids return 404 |
| Budget in status and diagnostics | `backend/app.py`, `backend/diagnostics.py` | `/api/status` and `/api/diagnostics` show used, limit and remaining. Neither shows a key or a path |
| Control surface | `web/control.js`, `web/index.html`, `web/styles.css` | Budget chip in the top bar. Approve/Deny cards above the chat, with a countdown. Diagnostics drawer (devices and holders, budget, My Hands, event stream, permission tiers, recent problems). Updates from `/ws/events` |
| Answer labels | `web/app.js` | Each answer is tagged `local`, `Gemini`, `needs your OK`, `done` or `blocked`. Folder answers open the folder |

Decisions made while building, recorded here so they can be reviewed:

- **The budget counts this app's calls, not Google's quota.** Google's published free-tier
  figures differ by model and have changed over time, and sources disagree. The owner sets the number.
  Default 20 is the lowest daily figure reported for current Flash models in September 2026
  sources (for example [scriptbyai.com](https://www.scriptbyai.com/gemini-api-free-tier-limits/)).
  Others report 250 to 1,500 for other models. The real limit must be checked in Google AI Studio.
- **Local answers do not go into the Gemini history.** Only messages sent to Gemini are kept there.
- **The budget counts failed calls too,** because the provider may still count them.
- **The chat text goes on the bus,** which is in memory only and local-only. Diagnostics do not show it.
- **Text chat has no tools.** It can only answer. Actions happen only through the router and the policy.

Tests: 210 pytest tests pass (five runs). New tests cover the router, the budget (including the
unreadable-file and failed-save paths), confirmations, the agent, and the HTTP surface (including
a cross-site approval being refused). Browser checks: `tests/ui/control_ui.cjs` 28/28,
`tests/ui/myhands_ui.cjs` 33/33, `tests/ui/m2_ui_smoke.cjs` 22/22 (the last one needs the live backend).

Live check (this sandbox, no camera, no Gemini key): local commands answered with no key; Gemini
returned 503 without spending budget; deny and a second answer behaved as specified; a cross-site
Origin was refused; approving "turn on my hands" reached the real camera stack, which reported
`device_unavailable` in diagnostics and released its lease.

Not in V2-2: the local LLM (feature 41), voice (V2-3), skills (V2-5), and the PIN/token fix in
the legacy dashboard (still waiting for the owner, see §9).

Provenance for each new module: `docs/V2_PROVENANCE.md`.

## 13. What V2-3 built (2026-10-09)

Scope: voice on the server. The microphone and speaker belong to the server, one owner each.
Speech goes to Gemini Live and the spoken reply comes back to the server speaker. The browser
shows state and sends the owner's clicks. It never gets audio, and it never gets the key.

| Piece | File | What it does |
|---|---|---|
| Microphone and speaker owners | `backend/voice/audio.py` | Device owners that plug into the device registry. Opened only when a lease starts them. Mic 16 kHz, speaker 24 kHz, 1024-sample blocks. Mute drops blocks at the source. Speaker buffer capped at 10 s, with flush for barge-in. `sounddevice` is imported only when needed. A missing library gives a clear "PortAudio not found" message |
| Speech detection | `backend/voice/vad.py` | Energy-based detector with hysteresis, attack and hangover. Used for barge-in only |
| Wake word | `backend/voice/wake.py` | Detector interface, a no-op detector, an openWakeWord adapter loaded only when the owner installs it, and `availability()`, which checks files and does not load a model |
| Gemini Live relay | `backend/voice/live.py` | Mic audio goes up through the `audio` field (the older `media_chunks` field is rejected by 3.x Live). Reply audio goes to the speaker. Interruption flushes the speaker at once. Transcripts for both sides go to the bus as `voice_turn`. The resumption handle is kept in memory only. Reconnects are counted against the budget. Gives up after three failed connections |
| Controller | `backend/voice/controller.py` | Owns the state: Live on or off, wake on or off, mute, idle stop after 60 s with no speech, barge-in. Checks the key and the budget before any hardware opens. A failed device start rolls back the others |
| Factory | `backend/voice/factory.py` | Builds the real controller. Settings: `SUPPER_MIC_DEVICE`, `SUPPER_SPEAKER_DEVICE`, `SUPPER_VOICE_IDLE_S` |
| HTTP | `backend/voice/api.py` | `GET /api/voice/status`; `POST /api/voice/start`, `/stop`, `/mute` (`{muted}`), `/wake` (`{enabled}`). Turning wake on returns a confirmation. Errors: 409 wake not ready, 429 budget used up, 503 no key or no audio device |
| Chat commands | `backend/router.py`, `backend/agent.py` | "start voice", "stop voice", "mute the mic", "unmute the mic", "turn on the wake word", "stop the wake word" |
| Policy | `backend/permissions.py` | `voice.start` and `voice.wake` are CONFIRM. `voice.stop`, `voice.mute`, `voice.unmute` and `voice.wake_off` are SAFE |
| Diagnostics | `backend/diagnostics.py` | Shows a `voice` block. `voice_error` events count as recent problems |
| App wiring | `backend/app.py` | `create_app(..., voice=None)` builds the real controller when none is passed |
| Browser controls | `web/voice.js`, `web/index.html`, `web/styles.css`, `web/control.js` | Voice, Mute and Wake word buttons. A status chip. Transcripts in the chat, tagged `voice`. Refused starts show the server's reason |
| Dependencies | `backend/requirements-voice.txt` | `sounddevice==0.5.6` (MIT) and `numpy`. The openWakeWord line is commented out on purpose |

### Decisions made while building (for review)

- **Button press is the consent for voice.** The owner presses Voice, and that is the consent. A chat
  request ("start voice") goes through a confirmation, because the policy says CONFIRM. Owner to confirm this split.
- **`voice.wake_off` was added as SAFE.** It was not in the owner's list. It follows the same rule as `myhands.stop`:
  turning a listener off is always allowed.
- **(Superseded 2026-10-10: local speech to text and text to speech are now built, see §14 and `docs/LOCAL_VOICE.md`.)**
  **STT and TTS are the Live model's, on the server.** No separate speech-to-text or text-to-speech engine
  was built. The blueprint's list says "STT and TTS". Offline recognition (for example faster-whisper)
  and a local TTS voice are left for later. Piper is not used: one secondary source says it was archived
  in October 2025, which is unverified.
- **The budget counts each Live connection as one unit,** and each reconnect as one more. It does not
  count audio minutes or tokens. The owner sets the daily number (§12).
- **Transcripts go to the chat and the bus only.** They are not written to memory. Memory stays read-only until V2-4.
- **The idle timeout is 60 s** (`SUPPER_VOICE_IDLE_S`). Activity from either side resets it.
- **Barge-in thresholds are 1500 (start) and 900 (stop),** above normal echo from the speaker. Headphones
  are still advised. These numbers are not yet measured on real hardware.

### Wake-word licence

**Owner answer (2026-10-10): "wake word is correct"**, so "Hey Jarvis" is the wake word. This was read as
accepting that the model carries CC BY-NC-SA 4.0 (non-commercial, share-alike, attribution). If the owner
meant something else, this line is to be corrected. Owner decision 7 (§14, 2026-10-10) then said the model
**must be bundled**. It is bundled now; see the update below.

- openWakeWord's code is Apache-2.0 (`dscripka/openWakeWord`, checked 2026-10-09).
- Its pretrained models, including `hey_jarvis`, are CC BY-NC-SA 4.0 because of their training data. The Hugging Face model page carries the same tag.
- The `openwakeword` 0.6.0 wheel bundles **no** model files (checked from the wheel contents).
- **Update 2026-10-10:** the three files the adapter needs are bundled in `backend/voice/wake_models/`. Their
  SHA-256 values match the Git LFS objects in the openWakeWord v0.5.1 release source (checked). The upstream
  README states that all its pre-trained models, including the two shared feature models, are CC BY-NC-SA 4.0.
  So the earlier "licence question unresolved" for the feature models is answered: same licence as the model.
  Source: npm package `openwakeword-wasm-browser` 0.1.1, whose copies match upstream. Notice: `wake_models/NOTICE.md`.
- The project is CC BY-NC 4.0. Non-commercial use may fit. Share-alike, and whether a model may be shipped at all, are for the owner to decide, and this is not legal advice.
- The bundled files are checked by SHA-256 before wake word starts. A mismatch keeps wake off and says why.

### Known gaps (read before relying on voice)

- **Voice has no tools yet.** The legacy app's voice can call its actions. V2-3's voice cannot run
  actions. Tools come with V2-5. Until then, the legacy app stays runnable for that job.
- **Not run live.** The sandbox has no audio device, no PortAudio library, and no speech models. The
  Gemini Live round-trip, barge-in on real speakers, and wake word on a real microphone are not yet checked.
- The wake-word adapter is tested against a fake model only.

### Tests

- Fake-based tests: `tests/test_voice_audio.py` (audio owners, VAD, wake interface), `tests/test_voice_live.py`
  (relay with a scripted session), `tests/test_voice_controller.py` (state rules, real owners on fake streams),
  `tests/test_voice_api.py` (HTTP, chat, tiers, diagnostics, secret never shown).
- Browser: `tests/ui/voice_ui.cjs` (jsdom, 25 checks, run as in the file header).
- `tests/test_devices.py` adds the test for a device that fails to start (the registry no longer keeps a phantom holder).
- Whole suite: 302 pytest tests pass. pyflakes is clean for `backend`, `tests` and `tools`.
- Live server (127.0.0.1:8765, started with `python -m backend`): voice status, start without a key (503, with
  the reason), wake without the package (409), chat "start voice" (confirmation), approve with no key (refused as a
  result, budget not spent), "unmute the mic" (local), diagnostics `voice` block, foreign Host (403). M2 smoke: 22/22.
- Browser checks (jsdom): voice 25/25, control 28/28, My Hands 33/33.
- Not done: any Gemini Live call, any real microphone or speaker, any wake-word model.

### Cross-OS check plan (to run before V2-3 is called proven)

Each step is run on Linux, Windows and macOS. Record the result per OS.

1. Install: `pip install -r backend/requirements-voice.txt`. On Linux, install `libportaudio2` first.
2. Start with no key: Voice shows the "no key" message, and the microphone does not open.
3. Start with a key and a microphone. Say a short sentence. The transcript appears in the chat and the reply is heard from the speaker.
4. Barge-in: interrupt a long reply. It stops within about a second.
5. Mute: while muted, nothing reaches Gemini (check the diagnostics counters, not the audio).
6. Idle stop: wait 60 s with no speech. Voice turns itself off, and the microphone is released.
7. Wake word (the model is bundled; `tools/check_wake_model.py` must say ready): say the phrase from another room. Voice starts once.
8. Budget: with the daily limit at 0, Voice refuses with a clear message.

## 14. Owner decisions (recorded 2026-10-10)

The owner read the proposals in the build summary and gave consent to all five:

1. **Voice runs on this computer by default** (`SUPPER_VOICE_ENGINE=local`). Speech in is faster-whisper,
   speech out is Kokoro if its files are present, otherwise the computer's own voice. Voice does not call
   Gemini Live and spends no budget. Gemini Live stays available with `SUPPER_VOICE_ENGINE=live`.
   See `docs/LOCAL_VOICE.md`.
2. **Gemini answers are kept and reused,** for 30 days. Time-sensitive and personal questions are never kept.
   Off switch: `SUPPER_KNOWLEDGE_LEARN=off`. See `docs/LOCAL_KNOWLEDGE.md`.
3. **"learn: question = answer" takes effect at once,** without a confirmation. `forget <number>` archives it;
   nothing is deleted.
4. **Local knowledge is stored in `runtime/knowledge.json`.** Deleting `runtime/` removes learned answers. It
   does not touch the owner's memory (`memory/long_term.json`).
5. **Pressing the Voice button is the owner's consent to start voice.** This closes the open question in
   `docs/AUDIT_STAGE_A.md`. The chat command "start voice" still asks for confirmation, because the policy
   for `voice.start` is CONFIRM. Wake-word start also still goes through the wake-word setting.

6. **Wake word is the main way to start voice** ("Hey Jarvis"), so the owner presses fewer buttons. It is on at
   start-up once the model is ready (`SUPPER_WAKE_WORD=off` switches it off). A conversation started by the wake
   word uses the local engine.

7. **The wake-word model is bundled** in `backend/voice/wake_models/` (owner, 2026-10-10: "it must be bundled").
   The project's licence does not cover these files: they stay CC BY-NC-SA 4.0 with attribution and share-alike.
   `wake_models/NOTICE.md` says so. `tools/check_wake_model.py` checks the files. The earlier download helper is
   removed. This replaces the earlier "not bundled" line in items 6 and §13.

8. **The microphone stays on to listen** for "Hey Jarvis" by default (owner, 2026-10-10: "mic stays on to listen").
   Audio is scored on this computer and is not sent anywhere until the phrase is heard. `SUPPER_WAKE_WORD=off`
   turns this off.

9. **The daily Gemini budget stays at 20** requests (owner, 2026-10-10: "keep it to 20").

10. **V2-6 is next** (owner, 2026-10-10: "V2-6 sounds good"): packaging and phone pairing (§5, feature 18).

Still open: whether teach and forget should be SAFE (currently SAFE), and the Kokoro-82M licence check.
