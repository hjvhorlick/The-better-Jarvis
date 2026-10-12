# Stage A — Audit of the existing application

Status: **read-only audit. No source files, memory, or config were modified.**
Repository: `hjvhorlick/The-better-Jarvis`, branch `arena/6e171ee4-the-better-jarvis`,
base commit `d6b67c6`. Nothing committed or pushed.

Evidence key: **[code]** = read in the source; **[doc]** = stated in a README;
**[hyp]** = hypothesis that needs runtime testing (no camera, microphone or
speakers are available in this sandbox, so no runtime testing was possible).

---

## 1. Technology stack

| Layer | Technology | Where |
|---|---|---|
| Desktop app (primary) | Python 3, PyQt6 UI | `main.py` (1,804 lines), `ui.py` (4,803 lines) |
| Voice / AI | Google `google-genai` SDK, Gemini Live API | `main.py` |
| Local LLM (alternate) | Ollama or OpenAI-compatible HTTP (`requests`) | `core/llm_client.py` (586 lines) |
| Remote dashboard (used) | Python FastAPI + uvicorn, plain HTTP, port 8000 | `dashboard/server.py` (794 lines), `dashboard/static/app.html` |
| Remote dashboard (orphan?) | Node/Express + `ws` in TypeScript | `server.ts`, `package.json`, `tsconfig.json` |
| Gesture system "My Hands" | Separate project "barehands": stdlib Python HTTP server + single-file browser page with MediaPipe + three.js | `barehands/server.py`, `barehands/stage.html`, plugin `plugins/barehands.py` |
| Audio I/O | `sounddevice` (PortAudio) | `main.py`, `core/audio_devices.py`, `ui.py` |
| Camera | OpenCV (`cv2`) | `actions/screen_processor.py`, `ui.py`, `sitecustomize.py` |
| Packaging / run | `run.sh` (hard-coded `/home/vincent/Jarvis`), `setup.py`, `requirements.txt`, `metadata.json` | root |
| Tests | **None.** No test files exist in the repository. | — |
| CI / build | None found. `package.json` build script targets `server.ts` only. | — |

**Dependency hygiene:** `requirements.txt` is almost entirely unpinned.
`package.json` uses `"@google/genai": "latest"`. Both are reproducibility risks.

### Orphan / duplicate code
- `server.ts` is referenced only by `package.json` and `tsconfig.json`.
  Nothing in the Python app launches it [code]. It duplicates `dashboard/server.py`
  (PIN login, WebSocket, encrypted commands). **Treat as a candidate for removal,
  but only after confirmation.**
- `core/llm_client.py` (Ollama / LM Studio) is **not imported by any other module** [code].
  The Gemini path is the only active AI path.
- `sitecustomize.py` monkey-patches the camera UI at interpreter start [code] (see §8).

---

## 2. AI reasoning and the Gemini connection

- **Live voice session:** `main.py` line 96: `LIVE_MODEL = "models/gemini-3.1-flash-live-preview"`.
  Connected with `client.aio.live.connect(model=LIVE_MODEL, config=...)` (line ~1634).
  The API key is read from `config/api_keys.json` key `gemini_api_key` (`_get_api_key()`, line 124).
- **Tool calls inside actions:** many modules create their own `genai.Client` and call
  `gemini-flash-latest` or `gemini-flash-lite-latest` (`web_search`, `code_helper`,
  `dev_agent`, `file_processor`, `youtube_video`, `flight_finder`, `desktop`,
  `computer_control`). Each reads the key from the same file. **Several model names
  are `-latest` aliases, which can change behaviour without notice.**
- **Update, 2026-10-12:** the identifiers recorded above are what the audit found,
  and are kept as the record. The code has since moved to Google's current models:
  Live `models/gemini-3.8-live`, actions `gemini-3.8-flash` (and
  `gemini-3.5-flash-lite` for the small cheap tasks), speech
  `gemini-3.8-flash-tts` with `gemini-3.8-flash-lite-tts` as the fallback. The
  `gemini-3.1-flash-live-preview` and `gemini-3.1-flash-tts-preview` names above
  are shut down on 17 November 2026. Sources: ai.google.dev/gemini-api/docs/models,
  /deprecations and /models/gemini-3.8-live, read 2026-10-12.
- **Free tier:** the README says "Free Gemini API key" [doc]. Nothing in the code
  enforces, checks, or reports free-tier quota. Rate-limit handling exists only in
  `dev_agent.py` (retries on 429 with a 20 s wait) [code]. Actual quotas must be
  checked in Google AI Studio; they are **not verified here**.
- **Reconnect:** `request_reconnect()` and `_watch_reconnect()` (lines 552–585) restart
  the Live session, keeping or dropping context, and reuse session resumption
  [code/doc].

**Browser implication:** the Live API key must never reach browser JavaScript.
Browser audio/video must go through a backend relay that owns the Gemini session.

---

## 3. Personality configuration

- The personality is in **`core/prompt.txt`** (11,756 bytes) [code]. Loaded by
  `_load_system_prompt()` (main.py line 129; used at line ~686).
- At connect time `main.py` assembles the system instruction from, in order:
  1. A voice speaking-style preset (`memory/config_manager.py` `VOICE_STYLES`,
     default `"Jarvis — British butler (RP)"`) prepended to the prompt.
  2. The prompt file.
  3. The identity injection (assistant name from `api_keys.json`, default `"JARVIS"`).
  4. The memory block from `format_memory_for_prompt()`.
- The prompt's first rule is **"Speak ENGLISH ONLY"** and the file defines behaviour
  such as "DO ONLY WHAT IS ASKED". The personality text is clearly expressed in
  the file [code].

**Important conflict:** `update_mechanic.py` (see §8) **overwrites `core/prompt.txt`**
from an embedded base64 blob on each run [code]. You are actively editing the prompt.
**Running `update_mechanic.py` would replace your work.** It must not be run until
the prompt is settled.

---

## 4. Persistent memory

Location and format [code]:

| File | Git status | Purpose |
|---|---|---|
| `memory/long_term.json` | git-ignored | Main persistent memory. Categories: `identity`, `preferences`, `projects`, `relationships`, `wishes`, `notes`. Entries are `{"value": str, "updated": "YYYY-MM-DD"}`. |
| `memory/recent_dialogue.json` | **not** ignored, not in repo | Rolling dialogue turns (max 60) for conversation continuity. |
| `memory/command_log.txt` | tracked | Shell command log from the `run_command` plugin. Contains the owner's home paths. |
| `config/api_keys.json` | git-ignored | Gemini key, assistant name, user name, voice, style, device names, plugin settings. |

- **Retrieval:** identity always in full; recent entries from other categories up to
  2,500 characters; an index of keys (values omitted) up to 1,000 characters; the
  `recall_memory` tool does on-demand search (`search_memory`) [code].
- **Writes:** `update_memory()` merges into `long_term.json` and rewrites the whole file.
  Entries are capped at 1,200 characters each; total store capped at 200,000 characters
  with oldest entries trimmed when over the cap, and the trim is announced in the log [code].
- **Session summaries:** `save_session_summary()`, `pop_last_session()`, `get_last_session()`
  [code].
- **Concurrency:** a single process-wide `threading.Lock` guards reads/writes [code].
  Writes are not atomic (`write_text` directly), so a crash mid-write could corrupt the file [hyp].
- **Multi-user:** none. Single-user, single-file design [code]. The dashboard
  shares the same store.

**Critical fact for migration:** **there is no `memory/long_term.json`,
`recent_dialogue.json` or `config/api_keys.json` in this checkout.** The live data is on
the owner's own machine (the paths in `command_log.txt` and `run.sh` point to
`/home/vincent/Jarvis`). **This sandbox cannot back up or migrate the real memory.**
Stage B requires the owner to provide or run a backup on the real machine.

---

## 5. Current implementation of camera, microphone, speakers and My Hands

### Camera
- Desktop vision: `actions/screen_processor.py` `_capture_camera()` opens a new
  `cv2.VideoCapture` **every call**, discards 10 frames, reads one, and releases it [code].
- Live camera view in the desktop UI: `ui.py` `start_camera_stream()` (line ~3052)
  opens its **own** `cv2.VideoCapture` on a background thread and emits JPEG frames [code].
- Camera index cached in `api_keys.json` (`camera_index`) [code].
- Dashboard (browser): `dashboard/static/app.html` calls `navigator.mediaDevices.getUserMedia`
  with fallback constraints, then `getUserMedia({video:true})` [code].
- My Hands camera: `barehands/stage.html` line ~1584 calls `getUserMedia({video, audio:false})`
  in the browser, and can cycle cameras with the **C** key [code/doc].

### Microphone and speakers
- Microphone: `sounddevice.InputStream` in `main.py` (~line 977), with a preferred and a
  backup device, resolved by `core/audio_devices.py` [code].
- Speaker: `sounddevice.RawOutputStream` in `main.py` (~line 1160) [code].
- `core/audio_devices.py` **probes every host API with silence at startup** and
  measures what actually works [code/doc]. The README records that PortAudio
  DirectSound output is a "silent sink" on Windows and that WASAPI shared mode does
  not resample [doc]. This is a clear sign of hardware-specific failure modes.
- Browser phone-audio: `dashboard/static/app.html` opens `getUserMedia({audio:true})`
  and streams PCM over `/ws/phone-audio` [code]. The Python side forwards that to Gemini
  (`main.py` ~line 1525) [code].
- Speech-to-text / text-to-speech: `core/stt.py`, `core/tts.py`, `core/wake_word.py`
  (openWakeWord, opt-in) [code]. Not yet read in detail.

### My Hands (barehands)
- `barehands/server.py`: stdlib `ThreadingHTTPServer` bound to **`127.0.0.1:8794`** [code].
- `barehands/stage.html`: single file, MediaPipe `HandLandmarker` loaded from the
  jsDelivr CDN, three.js from the jsDelivr CDN, model from `storage.googleapis.com` [code].
  Hand tracking, pinch, grab, drag, release, claw, clap, explode, and 3D rotate all
  run in the browser [code/doc].
- Object state is in `localStorage` (`bkey`) for box geometry [code].
- Integration: `plugins/barehands.py` starts `barehands/server.py` as a subprocess, sets
  the port, and mirrors JARVIS state (LISTENING / THINKING / SPEAKING) into `barehands/state/` [code].
- Licence: **barehands is AGPL-3.0** [code: `barehands/LICENSE`]. The main project is
  **CC BY-NC 4.0** [code: `LICENSE`, `CREDITS.md`]. These are different licences
  and carry different obligations (see §9).

---

## 6. Existing features and migration classification

Classification legend: **P** = working and preserved as-is; **A** = working, needs adaptation;
**D** = unreliable, needs diagnosis; **X** = desktop-only, needs replacement or compatibility layer;
**U** = unclear, needs more inspection.

| # | Feature | Current implementation | Class | Migration note |
|---|---|---|---|---|
| 1 | Conversation with Gemini Live (voice) | `main.py` Live session | A | Move session to backend relay; browser sends PCM. |
| 2 | Text chat / keyboard input | `ui.py` input box; `/api/command` in `dashboard/server.py` | A | Expose as web chat. |
| 3 | Personality (`core/prompt.txt`) | File + assembly in `main.py` | P | Keep file. Do not edit until owner finishes. |
| 4 | Voice styles (`VOICE_STYLES`) and 30 voices | `memory/config_manager.py` | P | Data-only; reuse. |
| 5 | Persistent memory `long_term.json` | `memory/memory_manager.py` | P | **Needs owner backup first.** Keep file format. |
| 6 | Recall tool and memory index | `memory_manager.py`, `recall_memory` tool | P | Reuse as-is. |
| 7 | Recent dialogue continuity | `recent_dialogue.json` | P | Reuse as-is. |
| 8 | Session summaries | `memory_manager.py` | P | Reuse as-is. |
| 9 | Settings and preferences (`api_keys.json`) | `config_manager.py` | A | Keep file; add web settings UI. |
| 10 | Wake word "Hey Jarvis" (opt-in) | `core/wake_word.py` | X/U | Needs browser alternative or backend mic. Not yet inspected. |
| 11 | Camera live view (desktop) | `ui.py` `start_camera_stream` | D/A | Replace with shared camera service in the browser. |
| 12 | Vision on request ("look at camera") | `screen_processor._capture_camera` | D | Opens a fresh camera each time. Route through shared service. |
| 13 | Screen capture ("look at screen") | `screen_processor._capture_screen` (`mss`) | X | Browser: `getDisplayMedia`, with user consent. |
| 14 | Microphone input | `main.py` `sounddevice` | D | Browser: `getUserMedia` + AudioWorklet. |
| 15 | Speaker output | `main.py` `sounddevice` | D | Browser: AudioContext; `setSinkId` where supported. |
| 16 | Output/input device pickers | `core/audio_devices.py`, `ui.py` settings | A | Replace with `enumerateDevices()` plus backend fallback. |
| 17 | Mute button | `ui.py` `_mute_btn` | A | Map to track `enabled`. |
| 18 | Remote dashboard (phone, QR pairing) | `dashboard/server.py` | A | Keep; consider as the web app base. |
| 19 | Dashboard PIN login | `dashboard/server.py` `/login` | **D (security)** | See §8. |
| 20 | Dashboard file upload / list / preview | `dashboard/server.py`, `/api/upload`, `/api/files` | A | Keep. Check path safety. |
| 21 | My Hands gesture board | `barehands/` + `plugins/barehands.py` | A | Keep the page; move server to a standard port with a relay. |
| 22 | My Hands pinch / grab / drag / release | `barehands/stage.html` | P | Preserve the logic. Do not retune from theory (see its TROUBLESHOOTING). |
| 23 | My Hands CDN dependencies | `stage.html` | A | Offline use needs vendored copies. Licences need checking. |
| 24 | Smart home (Tuya) | `plugins/` (tinytuya) | U | Not yet inspected. |
| 25 | Web search / news / research | `actions/web_search.py` (Gemini grounded + DDG) | A | Works from backend. |
| 26 | Weather report | `actions/weather_report.py` | A | Works from backend. |
| 27 | Reminders | `actions/reminder.py` | A | Check the scheduler is not OS-specific. |
| 28 | Open applications / computer control | `actions/open_app.py`, `computer_control.py`, `computer_settings.py` | X | Desktop-only. Keep behind the backend; hide in browser. |
| 29 | File controller / processing | `actions/file_controller.py`, `file_processor.py` | X/A | Restrict paths. Needs security review. |
| 30 | Browser automation (Playwright) | `actions/browser_control.py` | X | Desktop backend only. |
| 31 | Messaging send | `actions/send_message.py` | U | Needs a credentials review. |
| 32 | YouTube, flights, games | `youtube_video.py`, `flight_finder.py`, `game_updater.py` | U | Not yet inspected in detail. |
| 33 | Run arbitrary shell commands | `plugins/run_command.py` | **X (risk)** | Unrestricted execution. See §8. Excluded from the browser by the brief. |
| 34 | Autonomous code writing / self-repair | `actions/dev_agent.py`, `code_helper.py`, `update_mechanic.py` | **X (risk)** | Self-modification. Excluded from the browser by the brief. |
| 35 | Undo system | `core/undo.py` | U | Not yet inspected. |
| 36 | Confirmation of risky actions | `core/confirm.py` | A | Keep. Show in the web UI. |
| 37 | Plugin system | `core/plugin_loader.py`, `core/action_loader.py` | P | Keep; this is what makes the app extensible. |
| 38 | Diagnostics | none central; `print()` and `write_log` | **Missing** | Required by the brief (§14). Build new. |
| 39 | Tests | none | **Missing** | Build new. |
| 40 | `server.ts` Node dashboard | `server.ts` | U | Appears unused. Candidate for removal after confirmation. |
| 41 | Local LLM (Ollama / LM Studio) | `core/llm_client.py` | U | Not imported anywhere. Confirm before keeping. |

---

## 7. Likely causes of camera and audio reliability problems

Only the first point has direct code evidence. The rest are hypotheses.

**Camera**
1. **[code] Two independent camera owners.** `ui.py` keeps a live `VideoCapture` open
   while the screen_processor tool opens a second one to take a snapshot. On most
   operating systems one camera cannot serve two `VideoCapture` objects, so a
   vision request can fail or freeze the live view. The cache of the camera index
   helps the choice of device but not the lock.
2. **[code] Open/close per request.** `_capture_camera` opens, discards 10 frames,
   reads one, and releases on every call. This costs seconds and repeats the lock contention in point 1.
3. **[code] Monkey-patching at startup.** `sitecustomize.py` patches the camera UI
   before `MainWindow` is created. This makes the failure point hard to see.
4. **[hyp] Browser side:** no single owner of `MediaStream`; `app.html` and
   `stage.html` each call `getUserMedia` independently. Two tabs or two components
   contend for the same device. Tracks are not verified to be stopped on unmount.
5. **[hyp] Permissions:** `getUserMedia` requires a secure context (HTTPS or localhost).
   The dashboard uses plain HTTP on the LAN (`dashboard/server.py` says so explicitly),
   so **camera and microphone are blocked in the browser on any LAN address** [code + browser rule].
   This is a near-certain blocker for phone use.
6. **[hyp] barehands server bound to 127.0.0.1** means it cannot be reached from another
   device; camera use is local-only by design.

**Audio**
1. **[doc] Silent sink on Windows DirectSound.** Documented by the author: the stream
   opens and writes return success while no sound is produced. The app works around this
   by probing; the probe is the evidence [doc].
2. **[doc] WASAPI does not resample.** Causes open failures at 16 kHz / 24 kHz against 48 kHz hardware [doc].
3. **[hyp] Reconnect loops.** Audio device changes call `request_reconnect()`
   (`main.py` line 583). Repeated device errors could cause repeated reconnects. Not reproduced.
4. **[hyp] Duplicate listeners.** The wake-word, the phone-audio route and the desktop
   microphone can all read input. Interaction between them not tested.
5. **[hyp] Browser speech APIs.** The web speech path (if used) depends on the browser's
   speech service; autoplay policies block audio playback until a user gesture.

---

## 8. Security and safety issues found (not yet fixed)

These must be addressed before any browser exposure:

1. **Hardcoded default PIN `JARVIS`** in `server.ts` (`DEFAULT_PIN`) and a hardcoded
   token `jarvis-live-session-token` that is always accepted [code]. The `server.ts`
   token check also accepts `defaultToken` unconditionally.
2. **PIN login in `dashboard/server.py`** accepts a PIN generated per session and
   stores the derived AES key in memory [code]. It runs over plain HTTP [code].
   The dashboard binds to all interfaces so it is reachable on the LAN.
3. **Firewall changes:** `dashboard/server.py` `_ensure_network_access()` opens OS
   firewall ports and programs, with `netsh` and similar commands [code]. This is
   an OS-level change the user did not explicitly request.
4. **`update_mechanic.py` overwrites `core/prompt.txt` and `actions/code_helper.py`**
   from embedded blobs [code]. It is a self-modification path.
5. **`plugins/run_command.py`** executes shell commands; "risky" ones are held for a
   spoken "confirm" [code]. Commands are logged to `memory/command_log.txt`, which
   contains the owner's home paths. The log is tracked by git.
6. **`actions/dev_agent.py`** plans and writes code autonomously using Gemini [code].
7. **`sitecustomize.py`** runs on every Python start when the repo root is on `sys.path` [code].
8. **`memory/command_log.txt` is tracked in git** and contains paths. Low sensitivity, but
   it should not be published.
9. **Unpinned dependencies** (`requirements.txt`, `"latest"` in `package.json`) [code].

---

## 9. Licence and attribution (must be respected in the rename)

- **Main project:** `LICENSE` is **CC BY-NC 4.0** and states
  "Copyright (c) 2026 FatihMakes". It says **"Commercial use is not permitted."**
  `CREDITS.md` says the work is derived from FatihMakes' Mark-LIII and that
  the modifications are by "Vincent". `README.md` says "Personal use only".
- **barehands:** **AGPL-3.0** [code]. AGPL section 13 requires that a modified version
  offered to users over a network makes its source available. A browser-served
  version of the barehands page is therefore a network-service case. Confirm
  before publishing.
- **Renaming** to "Supper AI Agent" does not change these licences. The
  attribution to FatihMakes and the CC BY-NC and AGPL terms must be kept
  wherever the code is redistributed. Commercial use of the main project is not
  permitted by its licence.
- Third-party CDN assets used by barehands (MediaPipe, three.js) carry their own
  licences. These need checking before they are vendored.

*This is an engineering note, not legal advice.*

---

## 10. Obsolete branding (for the rename stage)

Counted with `grep -rIl` excluding `.git` and `docs/`:

| Term | Files | Typical location |
|---|---|---|
| `JARVIS` | 33 | window titles, README, dashboard HTML, PIN, token, firewall rule names, salts |
| `Jarvis` | 18 | comments, paths (`~/Jarvis`), `run.sh` |
| `MARK` | 7 | "MARK LIII", "MARK XL", "MARK 53" in `LICENSE`, `ORIGINAL_README.md`, code comments |
| `barehands` | 22 | plugin, server, page, docs |
| `Vincent` | 3 | `README.md`, `CREDITS.md`, `ui.py` line 4070 ("Vincent's build") |
| `FatihMakes` | 3 | `LICENSE`, `CREDITS.md`, `ORIGINAL_README.md` (must be retained) |

**Do not rename blindly.** Some identifiers are functional:
- `JARVIS` appears in the `api_keys.json` default `assistant_name`, so changing it
  changes the spoken name the model uses. Default values need a decision.
- The `jarvis_token` and `jarvis-live-session-token` strings are client/server contracts.
- The `"Jarvis"` path segments point at a real directory on the owner's machine.
- `LICENSE` and `ORIGINAL_README.md` attributions must not be altered.

---

## 11. Test inventory

- **Existing automated tests:** none.
- **Existing manual verification:** described in `barehands/TROUBLESHOOTING.md`
  (the "tuning clinic" method: measure first, then edit) and in `ORIGINAL_README.md`.
- **Known documented errors:** `memory/command_log.txt` shows a `find` that timed out,
  and a `cd` to a missing path. Also the `TROUBLESHOOTING.md` entries for port
  conflicts, camera not opening, and Windows interpreter stubs.

---

## 12. Technical obstacles before implementation

1. **Real data not in the repo.** `long_term.json`, `recent_dialogue.json` and
   `api_keys.json` live on the owner's machine. The owner has to make the backup
   (Stage B). I cannot verify memory preservation from here.
2. **No hardware in the sandbox.** Camera, microphone and speaker behaviour can only
   be tested on the owner's PC, in the browser the owner uses. Stage D and E results
   depend on that.
3. **Gemini Live from the browser.** The Live API key must stay server-side, so
   a backend relay is required. It needs a WebSocket relay for PCM audio and JPEG frames.
   Choice of language for the backend (Python recommended) must be decided.
4. **Secure context.** `getUserMedia` is blocked over plain HTTP on a LAN address.
   Options: HTTPS with a local certificate, or `localhost` only.
5. **Prompt conflict.** `update_mechanic.py` would overwrite the prompt you are
   editing. Must be disabled or guarded before any further runs.
6. **Licence decision.** The non-commercial licence and AGPL obligations must be
   reviewed before the product is branded and distributed.
7. **Two dashboards.** `dashboard/server.py` (in use) and `server.ts` (apparently unused).
   Keep one. The plan assumes `dashboard/server.py` survives and `server.ts` is retired after confirmation.
8. **Preview environment constraint.** Any server started for review must bind `0.0.0.0`.
   The current `barehands/server.py` binds `127.0.0.1` and cannot be previewed as is.
9. **Unpinned dependencies.** Reproducible migration needs a lock file.

---

## 13. Proposed Stage B (requires your review first)

No changes until you approve. Proposed:

1. **Owner backup (on the owner's machine, not in this sandbox):** copy
   `memory/long_term.json`, `memory/recent_dialogue.json`, `config/api_keys.json`,
   `memory/command_log.txt`, `core/prompt.txt`, and a `git bundle` of the repo.
   Verify each file opens (`python -m json.tool` for JSON).
2. **Source backup:** a `git bundle` or tag of the current commit, plus a copy of the
   working tree. Nothing deleted.
3. **Baseline tests:** write tests for `memory_manager` round-trips against a copy of
   the real memory file, `config_manager` read/write, and the action loader, all on copies.
4. **Disable `update_mechanic.py`** from running (rename or guard), so the prompt cannot be overwritten.
5. Nothing else until items 1–4 are verified.

---

## 14. Questions for you

1. Can you run the owner backup (§13 step 1) on your PC, or give me a copy of
   `memory/long_term.json` and `config/api_keys.json` with the key removed? I need
   the actual memory to verify migration.
2. Which browser do you use for the app? Chrome is the only browser where the
   barehands hand tracking has been proven [doc].
3. Should the browser app be reachable only on your PC (`localhost`), or also on your
   phone over the LAN? A phone needs HTTPS for the camera and microphone.
4. Do you want `server.ts` removed, or kept as an alternative?
5. Keep the local-LLM option (`core/llm_client.py`)?
6. Confirm the licence position: is the product intended for personal use only
   (current CC BY-NC) or for wider distribution? This decides whether the rename can
   be published.
7. Is the prompt you are editing meant to replace `core/prompt.txt`? Should I
   preserve the current file as the baseline for personality testing?

---

## 15. Stage B progress and decisions (2026-10-09)

**Owner approval (2026-10-09):** "approved", for all the proposed changes below. The owner also said the
owner backup (step 1) has been run on the owner's machine. **That backup is not in this checkout, so it has
not been verified here.**

| Stage B item | State |
|---|---|
| 1. Owner backup | Reported done by the owner. Not verified here. V2-4 needs copies of the real `long_term.json`, `recent_dialogue.json` and `api_keys.json` to check the migration |
| 2. Source backup | **Done.** `/home/user/backups/stage-b-20261009-204208/`: a git bundle of the branch, a copy of the working tree (no `.venv`, no `.git`), and SHA-256 checksums of the protected files before the change |
| 3. Baseline tests on copies | **Done.** `tests/test_memory_baseline.py` (now 21 tests). Every path is a temp copy |
| 4. Disable `update_mechanic.py` | **Done.** A guard at the top of the file exits before anything is written. The file is kept, so it is easy to reverse. Checked: running it exits with status 1, and `core/prompt.txt` is unchanged |

### What changed, and how it was checked

| Finding | Change | Test |
|---|---|---|
| 1. Oldest memory entries deleted over the size limit | Moved to `memory/memory_archive.json` (append-only, written atomically). Nothing is deleted. The active file keeps what fits | `test_oldest_entries_are_archived_not_deleted_when_over_the_limit` |
| 2. Only the newest 15 sessions kept | Older sessions move to the archive | `test_sessions_beyond_fifteen_are_archived_not_deleted` |
| 3. Unreadable `api_keys.json` replaced on save | Refused. A copy is saved as `api_keys.json.corrupt-<time>`. The original is untouched. Every setter uses one helper | `test_unreadable_config_is_never_overwritten`, `test_every_setter_refuses_an_unreadable_file` |
| Archive unreadable | The memory save is refused. `long_term.json` stays as it was | `test_nothing_is_removed_when_the_archive_is_unreadable` |

**Behaviour change you should know about:** archived memories are no longer in the active file, so the
assistant will not use them unless they are restored. A search and restore tool is built (see below).

**Legacy UI effect:** the legacy voice, plugin, device and wake-word controls call these setters. If
`api_keys.json` is unreadable, those controls now raise an error (shown as a traceback in the console) and
the file is not changed. Before, the settings were silently lost.

### Dialogue log (approved 2026-10-09: "archive")

| Finding | Change | Test |
|---|---|---|
| Dialogue cap dropped the oldest turns beyond 60 | Dropped turns are appended to `memory/dialogue_archive.jsonl`, one JSON line per turn. Nothing is dropped if the archive cannot be written; the log keeps every turn | `test_dialogue_beyond_sixty_turns_is_archived_not_deleted`, `test_dialogue_is_kept_when_the_archive_cannot_be_written` |
| `clear_recent_dialogue` deleted the log | Every turn is archived first. If the archive write fails, the live log is left as it is | `test_clear_recent_dialogue_archives_before_removing`, `test_clear_keeps_the_live_log_when_the_archive_fails` |
| An unreadable dialogue log was replaced on the next append | Copied aside as `recent_dialogue.json.corrupt-<time>` and a fresh log is started. The original is not overwritten | `test_an_unreadable_dialogue_log_is_copied_aside_not_overwritten` |

**Behaviour change:** the assistant's recent-dialogue context is still the newest 60 turns. Older turns are
kept in the archive but are not sent to the model.

### Archive search and restore (owner request, 2026-10-09: "yes")

| Command (chat) | What it does | Tier |
|---|---|---|
| `search the archive for <text>` (also `search archive for`, `look up archive for`, `find archive for`) | Case-insensitive search of `memory_archive.json` (memory facts and session summaries) and `dialogue_archive.jsonl`. Shows up to the newest 10 matches. Memory facts show a number. Marks a fact "(active again)" if it has been restored | SAFE (read-only, local, no Gemini call) |
| `restore archive entry <number>` (also `restore memory <n>`, `restore #<n>`, `restore <n>`) | Copies one archived memory fact back into `long_term.json`. The archive keeps its copy | CONFIRM (asks each time; the confirmation shows the fact) |

Rules built in:
- **Never overwrites.** If the same category and key already has a value, the restore is refused and nothing is changed.
- **Needs room.** If the restored file would be over `MEMORY_MAX_CHARS`, the restore is refused. Otherwise the size trim would archive the fact again straight away.
- **Only memory facts restore.** Session summaries and dialogue turns can be searched, not restored.
- **Archive numbers never change.** The archive only grows, so a number always means the same entry.
- **Unreadable archive:** search and restore report it and change nothing. The file is never rewritten by these commands.

Tests: `tests/test_memory_archive_tools.py` (27 tests): search, restore, the refusals, the router phrases, the tiers, the confirmation flow, a corrupt archive, and a check that the size trim does not move a restored fact back to the archive.

**Not done:** the assistant (Gemini) cannot call these yet. They are chat commands. A model-callable tool comes with the V2-5 skill tools.

**Known limit:** restore reads and writes `long_term.json` without a lock shared with the legacy app. Do not run both apps at the same moment and restore at once.

### Still open

- **Finding 5, duplicate definitions** in `memory/memory_manager.py`: the dialogue functions are defined twice.
  The second (live) definitions were changed. The first, dead copies are left for V2-4, after review.
  `pyflakes memory/` reports them.
- **Non-atomic writes** to `long_term.json`, `recent_dialogue.json` and the config file (`write_text`). Not changed.
- **Wake-word licence** (§13) is still open. Whether the Voice button counts as consent is **resolved 2026-10-10: yes** (see `docs/V2_REDESIGN.md` §14).
