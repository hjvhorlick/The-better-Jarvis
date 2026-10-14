# Legacy Python architecture: `backend/app.py`, `web/`, and `myhands/`

> **Scope warning:** this document describes the separate legacy FastAPI application. It is not the supported dashboard runtime. The supported app is `server.ts` + `dashboard/static/app.html` + `local_voice/service.py`; read `AGENTS.md` before changing launchers, voice, My Hands, chat, or UI behavior. Do not apply this document's Gemini Live, browser-voice, or Python UI rules to the supported Node dashboard unless the owner explicitly asks.

Status: legacy Python architecture notes; the machine-checkable tests in `tests/test_architecture.py` cover that legacy path only.

## The picture

```
            the window or browser tab (web/)           <- shows things, sends clicks, holds no secrets
                         |  one WebSocket (events) + HTTP (requests)
   +---------------------------------------------------------------------------+
   |  backend/app.py   one FastAPI server: the only place that owns hardware   |
   |                   and the Gemini key                                      |
   |                                                                           |
   |  router -> agent -> permission policy -> handler (skill, feature, or API) |
   |                                                                           |
   |  event bus (backend/events.py): every feature publishes under its own name|
   |  device registry (backend/devices.py): camera, microphone, speaker owners  |
   |  budget (quota.py), confirmations (permissions.py), self-repair (repair/)  |
   +---------------------------------------------------------------------------+
```

My Hands is one feature in this picture. It is not a separate program. It uses the same bus, the same device registry, the same policy and the same confirmation queue as voice, reminders and search. Scenering remains a separate service; the Studio only prepares material for it.

The Persistent Brain is layered over the existing `memory/memory_manager.py` store and dialogue archive. It adds topic-scoped continuity, explicit owner-stated facts, tasks and sourced research without creating a second database. Memory corrections are atomic; forgetting a fact requires confirmation; verified local backup sets are made before the first Brain write and before explicit overwrite/removal operations. Conversation context is bounded and labeled as untrusted data, and legacy global dialogue is not mixed into a Brain-managed prompt.

## The rules

1. **One server owns everything that is dangerous.** Hardware (camera, microphone, speaker), the Gemini key and the saved memory are touched only by the server. The browser or window receives events and the camera preview picture, and sends requests.
2. **Every feature enters the same way.** A chat command goes: router -> agent -> policy tier -> handler. A button goes through an API route in `backend/app.py` or a feature's `*_api.py`. No feature calls another feature's internals.
3. **Hardware goes through the device registry.** A feature asks for a lease (`devices.lease(name, owner)`). Only the owner module imports the hardware library (cv2, sounddevice, mediapipe, openwakeword). The test enforces the list.
4. **Every action has a tier.** Each chat action and each skill is registered in `backend/permissions.py` as SAFE, CONFIRM or BLOCKED. A feature that is not in the policy cannot run. The test enforces this.
5. **Events have a source name.** A feature publishes on the bus under its own name (`voice`, `my_hands`, `assistant`, `permissions`, `devices`, `chat`). The window picks out the events it shows by source and type, and ignores types it does not know. Adding a new source or type does not break the others.
6. **Data that can be private stays on this computer.** Camera frames and audio never leave this computer. The camera preview picture goes only to the browser or window on this computer, over its local address. Memory and text reach Gemini only inside a question that needs Gemini (rule 10). Gemini text is sent only through `ChatService`.
7. **The window is not a browser tab.** The UI uses relative addresses and does not assume a browser. A later native window (pywebview) must be able to show the same UI with no code changes to the features.
8. **Stable surfaces.** The API paths, event shapes and skill interface are the contract between parts. Changing one needs a note here and a test that shows the old callers still work.
9. **Every new feature adds a row to the feature map below**, a test, and a provenance row in `docs/V2_PROVENANCE.md` if it was ported from the legacy app.
10. **Gemini is the last resort.** A message is answered locally first: a matching command, a stored fact that clearly holds the answer (`backend/recall.py`), a status or time reading, or a stored local answer (`backend/knowledge.py`, `docs/LOCAL_KNOWLEDGE.md`). Only when no local step can answer does the message go to Gemini, and only after the daily budget takes a unit. A local step that declines must say so by returning nothing, so the question moves on. Voice turns use the same order. The default voice engine is local (`docs/LOCAL_VOICE.md`): speech is heard and spoken on this computer, and the text goes to the same agent. Gemini Live is used only if the owner sets `SUPPER_VOICE_ENGINE=live`.
11. **Brain writes are deliberate and recoverable.** Ordinary conversation does not automatically become a saved fact. Topic/task/decision state is local; explicit memories carry provenance; forget is confirmation-gated; provider availability is only reported after a real, budget-counted request. Grounding citations are stored only when the provider supplies safe HTTP(S) source metadata.

## Known debt (to fix before the next big feature)

- `backend/agent.py` has grown: reminders, web search, error notes and the archive commands are handlers inside it. The next step is to move each into its own module under `backend/skills/`. The skill interface needs a context argument first (chat service, bus, reminders), so the move is planned rather than done in a hurry.
- Local voice is built and tested with fake speech engines. The real microphone, speaker and speech models have not been run in the build environment; the owner checks them on his computer (`docs/LOCAL_VOICE.md`). There is no echo cancellation, so headphones are advised for talk-over. The Kokoro model files are not in the repository.
- The My Hands camera preview is shown on the glass (2026-10-10). It is mirrored by the server, so the picture and the pointer agree. It takes its own lease on the camera through the device registry, so the camera is opened once.

## Adding a feature (checklist)

1. Write the feature as one module (a skill under `backend/skills/`, or a `backend/<feature>.py` with an `*_api.py` if it has buttons).
2. Register its actions in `backend/permissions.py` with a tier, and its router phrases in `backend/router.py` if it has chat commands.
3. Use the bus with its own source name. Use a device lease for any hardware.
4. Add a row to the feature map below.
5. Run `tests/test_architecture.py` and the full suite. Both must pass before the feature is called done.

## Feature map

Every file in `backend/`, `myhands/` and `web/` has a row here. "Uses" lists the modules the file imports from this project. The test checks that every such import is named. Browser files share state through `window.SupperUI`, `window.SupperCtl` and `window.SupperVoice`; these are listed as "page globals".

| File | Role | Uses |
|---|---|---|
| `backend/__init__.py` | package marker | none |
| `backend/__main__.py` | start-up (`python -m backend`) | `app`, `config` |
| `backend/app.py` | the one server: routes, lifespan (starts and stops reminders), wiring of all parts, phone pairing page and code exchange | `agent`, `brain`, `pairing`, `chat`, `config`, `devices`, `diagnostics`, `events`, `files`, `memory_view`, `media`, `myhands_api`, `permissions`, `quota`, `reminders`, `repair`, `security`, `stream`, `voice`, `workspaces` |
| `backend/config.py` | paths and settings (env vars, saved keys) | none |
| `backend/events.py` | the event bus: sequenced, bounded, replayable | none |
| `backend/stream.py` | the bus over one WebSocket (`/ws/events`) | `events` |
| `backend/permissions.py` | tiers (SAFE, CONFIRM, BLOCKED) and the confirmation queue; reads the skill list inside a function, so there is no start-up cycle | `skills` (lazy) |
| `backend/quota.py` | the daily Gemini budget | none |
| `backend/chat.py` | Gemini text: persona chat, topic-scoped persistent history/context, stateless `complete()` (proposals, web search), actual provider probe and Google Search citation extraction | `config`, `persona`, `workspaces` |
| `backend/persona.py` | builds the persona instruction from `core/prompt.txt` and memory; quotes retrieved memory/dialogue as untrusted data | none |
| `backend/router.py` | local phrases -> actions (before Gemini) | none |
| `backend/agent.py` | runs a message: router, policy, handlers, local knowledge, phone pairing commands, topic-scoped Brain context, Gemini last | `brain`, `chat`, `config`, `files`, `knowledge`, `pairing`, `permissions`, `quota`, `recall`, `reminders`, `repair`, `router`, `skills`, `workspaces` |
| `backend/brain.py` | topic continuity, owner-scoped local memories, corrections, decisions, tasks, sourced research, bounded dialogue context and verified backup sets; extends the existing `memory_manager` store | `memory.memory_manager` |
| `backend/recall.py` | answers "what is my ..." from stored facts, only when every word of the question matches; read-only | none (reads memory when called) |
| `backend/knowledge.py` | local answers: starter, taught and kept-from-Gemini entries in `runtime/knowledge.json`; 30-day expiry for Gemini answers; time-sensitive and personal questions never kept; forget archives | `recall` (keyword rules), `config` |
| `knowledge/starter.json` | the starter answers (coding, marketing, design, everyday); written by the assistant and marked for checking | none (data) |
| `backend/skills/__init__.py` | the skill registry (`ALL_SKILLS`) | `base`, `weather` |
| `backend/skills/base.py` | the skill record; kept apart so skills can import it without a cycle | `permissions` |
| `backend/skills/weather.py` | weather search page (CONFIRM) | `base`, `permissions` |
| `backend/devices.py` | device registry: one physical device, many owners, one open handle; lease changes are published as `devices` | `events` |
| `backend/security.py` | access guard: this computer by default; paired phones only on the allowed list (V2-6) | `pairing` |
| `backend/pairing.py` | phone pairing: 6-digit code, device tokens stored as hashes, 30-day expiry, forget | none |
| `backend/diagnostics.py` | the diagnostics panel data | `config`, `events`, `files` |
| `backend/files.py` | file list and preview inside allowed folders | `config` |
| `backend/media.py` | the Studio: pictures from Pollinations (free, no key), scripts and titles from Gemini counted against the daily budget, a media library in `runtime/media/` (indexed, searchable, nothing served from outside it), and the script laid out for pasting into Scenering | `config` |
| `backend/workspaces.py` | the workspace folders the agent may read and write | none |
| `backend/memory_view.py` | read-only memory summary for the panel | none |
| `backend/myhands_api.py` | My Hands routes (start, stop, status, the camera preview, scene, events) and session wiring; one MIRROR setting for the pointer and the picture (imports `myhands`) | `myhands.camera`, `myhands.gestures`, `myhands.session` |
| `backend/reminders.py` | reminders: store, in-app timer, fires to the bus | none |
| `backend/repair/__init__.py` | self-repair entry point | `engine`, `notices`, `policy`, `snapshots` |
| `backend/repair/engine.py` | repair runs: snapshot, trial copy, health check, rollback | `policy`, `snapshots`, `trial` |
| `backend/repair/notices.py` | error notices (kind, file and line only; repeats within 300 s suppressed) | `policy` |
| `backend/repair/policy.py` | what self-repair may touch and refuse (essential sections) | none |
| `backend/repair/proposer.py` | repair proposals to Gemini (CONFIRM) | `policy` |
| `backend/repair/snapshots.py` | snapshots, kept until the owner deletes them | none |
| `backend/repair/trial.py` | trial copy of the app used for health checks | none |
| `backend/voice/__init__.py` | package marker | none |
| `backend/voice/api.py` | voice routes | `controller` |
| `backend/voice/controller.py` | voice state rules (one owner per device, budget before hardware for Live only, idle stop, barge-in hook, the audio self-test entry) | `audio`, `doctor`, `vad` |
| `backend/voice/doctor.py` | audio self-test: a beep through the speaker, a microphone level reading, and the readiness of each speech engine, in plain language | `audio`, `stt`, `tts`, `vad`, `wake` |
| `backend/voice/local.py` | local voice relay: VAD turns, speech to text, the agent (quiet), speech out, barge-in; no Gemini Live | `audio`, `vad` |
| `backend/voice/stt.py` | speech to text on this computer (faster-whisper: the only importer; model downloaded once) | none |
| `backend/voice/tts.py` | spoken replies on this computer: Kokoro if its files are present, else the system voice (pyttsx3: the only importer) | `audio`, `config` |
| `backend/voice/audio.py` | microphone and speaker owners (sounddevice: the only importer) | none |
| `backend/voice/live.py` | Gemini Live relay, server side | `config` |
| `backend/voice/wake.py` | local wake-word detector (openwakeword: the only importer) | none |
| `backend/voice/vad.py` | voice activity detection | none |
| `backend/voice/factory.py` | builds the voice pieces from the parts above; chooses the engine (local by default) | `audio`, `config`, `controller`, `live`, `local`, `stt`, `tts`, `wake` |
| `myhands/__init__.py` | package marker | none |
| `myhands/camera.py` | camera source and the single-owner camera service (cv2: the only importer); `preview_jpeg` flips and encodes one frame for the preview | none |
| `myhands/tracker.py` | hand tracking (mediapipe: the only importer) | none |
| `myhands/gestures.py` | the gesture engine: pinch, fist, hold-still rotate, two-hand scale, clap, claw-pull | `myhands.filters`, `myhands.handframe` |
| `myhands/handframe.py` | reads a whole hand: palm centre, normal, tilt, per-finger curl, spread, depth | none |
| `myhands/filters.py` | smoothing of the cursor | none |
| `myhands/session.py` | My Hands session: start, stop, events, grabs; publishes as `my_hands` | `backend.events` |
| `web/index.html`, `web/styles.css` | the screen: the top line of function buttons, the Brain drawer (topics, memory, tasks, research), the thin left rail (the voice visualiser on top, the conversation below it, squeezable to almost nothing), the environment rail and its tool tabs, and the camera picture behind them | none |
| `web/shell.js` | the environment shell: slides whole workspaces left and right, fetches each one's code only when it is first opened, keeps exactly one live at a time, and lends each one its tool strip (`env._tools`) so it can add controls when it mounts | page globals: provides `Shell` |
| `web/environments/*.js` | one workspace each: Coding (code tree, ask Jarvis about the open file), Design (the 3D room), Flat (the 2D room: layers, drawing tools, image and video frames), **Studio** (Jarvis writes the script and the title; Pollinations makes a picture per shot; a canvas plays the shot list and `MediaRecorder` records it; the title and script are laid out for Scenering), Files (browse and read) | `three`, loaded on demand by Design only |
| `web/vendor/**` | the 3D engine and its model loaders, kept in the repo so the Design room works with no internet (three.js, Apache-2.0; see THIRD_PARTY_NOTICES.md) | none |
| `web/app.js` | glass desktop tiles, file panel, citation links, local conversation restore/new-chat flow; loads first | page globals: provides `SupperUI`, `SupperConversation`, uses `SupperCtl` if present |
| `web/brain.js` | Brain drawer client: topic state, explicit memory correction/forget requests, tasks, sourced research, verified backup and provider test | page globals: uses `SupperConversation`, `SupperCtl`, provides `SupperBrain` |
| `web/camera.js` | keeps the owner's camera picture consistent across rooms; uses a parent stream when available, otherwise browser capture, then local My Hands preview | page globals: `JarvisRoomsCamera`; same-origin postMessage |
| `web/myhands.js` | moves tiles from My Hands gesture events; shows and hides the camera picture with My Hands | page globals: uses `SupperUI` |
| `web/control.js` | shared event stream, confirmations, budget chip, diagnostics | page globals: provides `SupperCtl`, uses `SupperUI`, `SupperVoice`, `SupperBrain` |
| `web/voice.js` | voice buttons and voice messages | page globals: provides `SupperVoice`, uses `SupperCtl`, `SupperUI` |
