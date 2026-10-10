# V2 provenance record

Purpose: for each new v2 module, say where the idea came from, who wrote the code, and what the
checks found. This is a technical record for the owner. It is not legal advice. The licence
position for the whole project is in `docs/V2_REDESIGN.md` §6 and `THIRD_PARTY_NOTICES.md`.

Rule (blueprint §6): ideas may come from public projects. No code, prose or assets are copied.
Each module below was written for this project in this repository.

## Modules

| Module | Written for this project from | Ideas taken (concept only) | Checks: identical lines / shared 8-word runs |
|---|---|---|---|
| `backend/events.py` | the V2 blueprint §3 (one event stream, replay) | Sequenced frame logs (Pipecat's idea of typed stages, concept only) | 1 / 0 (import line) |
| `backend/devices.py` | the blueprint §1 "one owner per device" and audit feature 11 | none beyond the blueprint | 1 / 1 (generic method shape) |
| `backend/permissions.py` | audit §8 and feature 36 | none; tiers are our own design | 2 / 2 (import lines, common Python idiom) |
| `backend/stream.py` | the event bus (above) | none | 1 / 0 |
| `backend/diagnostics.py` | audit feature 38 | none | 1 / 0 |
| `backend/router.py` | the blueprint §4 item 2 (archive search and restore rules added 2026-10-09) | Local intents before the language model (Home Assistant Assist's `prefer_local_intents`, concept only) | 2 / 0 (import lines) |
| `backend/agent.py` | the router, policy and budget designs | none | 1 / 0 |
| `backend/quota.py` | the free-tier limits, read from public pages (see V2_REDESIGN §12) | none | 1 / 3 (import lines; `path.parent.mkdir(parents=True, exist_ok=True)` idiom) |
| `backend/myhands_api.py` (`default_session`) | V2-1 wiring | none | 1 / 0 |
| `web/control.js` | the blueprint §5 features 36 and 38 | none | 0 / 3 (fetch-with-JSON idiom already in `web/app.js`) |
| `tests/ui/control_ui.cjs` | the My Hands jsdom harness pattern (our own) | none | 0 / 0 |
| `backend/skills/base.py` | the V2-5 plan: a skill has an action, a tier, a summary and a handler (blueprint §5 feature 37) | none; the dataclass is ours | 2 / 1 (`__future__` and `dataclass` import lines) |
| `backend/skills/__init__.py` | our registry of skills | none | 1 / 0 (`__future__` import) |
| `backend/skills/weather.py` | the legacy `actions/weather_report.py` behaviour (open a web search for the city). Rewritten: new wording, a DuckDuckGo search URL, city validation, an injected browser opener, CONFIRM tier. Checked after the first draft; shared wording was reworded | none | 2 / 0 (`__future__` import; `quote_plus` import, which the standard library defines) |
| `memory/config_manager.py` (`_read_for_update`, `ConfigUnreadable`) | the owner decision in audit §15 (refuse, keep a copy) | none | legacy file, changed under owner approval; `import shutil`/`datetime` standard lib |
| `memory/memory_manager.py` (`_archive`, `_trim_to_limit`, dialogue archive, `search_archive`, `restore_archive_entry`) | the owner decision in audit §15 (archive, never delete) | none | legacy file, changed under owner approval |
| `update_mechanic.py` (guard only) | audit §8 and §15 | none | legacy file, guard added under owner approval; the rest is unchanged |
| `backend/repair/` (policy, snapshots, trial, engine) | the owner's self-repair rules (docs/SELF_REPAIR.md). The snapshot and trial approach is our own design | none | 1 / 0 (`__future__` import, standard idioms) |
| `backend/reminders.py` | the legacy `actions/reminder.py` feature (a reminder at a set time). Rewritten: an in-app timer and a JSON file in the runtime folder, instead of the legacy Windows Task Scheduler and macOS/Linux scheduler calls. No scheduler code taken | none | 1 / 0 for barehands; legacy: standard import lines and the atomic-write idiom (from `memory/memory_manager.py`) |
| `backend/recall.py` | our own design (2026-10-10): answers "what is my ..." from stored facts only when every word of the question matches. Walks the memory categories the same way `memory/memory_manager.py` does (the project's own code, not third-party). No code from barehands | none | 0 / 3 (8-word sequences) with the project's own legacy memory code; no barehands match |
| `backend/knowledge.py` | our own design (2026-10-10): local answers kept in `runtime/knowledge.json`, matched by word overlap; Gemini answers kept with a 30-day expiry; time-sensitive and personal questions never kept. Written for this project; no code taken | none | 0 lines of 30+ characters found in barehands (checked line by line); the 8-word overlaps are the project's own memory code and Python idioms |
| `knowledge/starter.json` | starter answers written by the assistant for the project (coding, marketing, design, everyday). Marked "please check" in the replies. Not copied from any source | none | 0 barehands matches |
| `backend/voice/local.py` | our own design (2026-10-10): local voice relay, turn-taking with the existing energy VAD, barge-in through the controller's hook. Standard energy-threshold design; no code taken | none | 0 barehands matches |
| `backend/voice/stt.py`, `backend/voice/tts.py` | our own adapters for faster-whisper (MIT), pyttsx3 (MPL-2.0) and kokoro-onnx (MIT), written from their public APIs | none | 0 barehands matches |
| `backend/repair/notices.py` | our own design (docs/SELF_REPAIR.md §5c). Stores the error kind, file and line only, never the message | none | 0 / 0 for barehands; legacy: import lines and a common `mkdir` idiom |
| web search (`backend/agent.py` `_web_search`, `backend/chat.py` `complete(grounded=True)`) | the legacy `actions/web_search.py` feature (Gemini with the Google Search tool and a short answer). Rewritten: budget counted, key kept on the server, its own system instruction, output shortened | Google Search grounding as a Gemini tool (the legacy approach) | 0 / 0 for barehands; the tool name `google_search` is the API's own |
| `backend/voice/audio.py` | the V2-3 plan: device owners under the registry (blueprint §7) | Stop playback when the user speaks (common voice-assistant pattern; Pipecat's interruption idea, concept only) | 2 / 3 (`__future__` import; sounddevice callback signature; Gemini Live audio rates 16 kHz in, 24 kHz out, which are protocol facts) |
| `backend/voice/vad.py` | an energy threshold with hysteresis and hangover (our own design) | none | 1 / 0 (`__future__` import) |
| `backend/voice/wake.py` | openWakeWord's public Python API (Apache-2.0 code). Model files bundled in wake_models/ (CC BY-NC-SA 4.0, see NOTICE.md there; V2_REDESIGN §13 and §14) | Wake word as a local detector behind an interface (openWakeWord's concept) | 2 / 1 (`__future__` import; `from openwakeword.model import Model`, the library's public API) |
| `backend/voice/live.py` | Gemini Live facts noted from the legacy app (`main.py`): audio field, output and input transcription, sliding window, resumption. The code is rewritten, and its structure and helpers are ours. Two spots (the session config builder and the resumption-handle reader) were reworked after a check found them too close to `main.py` | Session resumption and sliding context (Google's Live API features, concept only) | 4 / 11 (imports, `__future__`, typing annotations; Live API attribute names such as `session_resumption_update`, which the API defines) |
| `backend/voice/controller.py` | the V2-3 state rules (blueprint §7): one owner per device, budget before hardware, idle stop | Barge-in and idle stop are common patterns; no code taken | 1 / 0 (`__future__` import) |
| `backend/voice/factory.py` | our wiring of the registry, budget, config and the relay | none | 1 / 0 (`__future__` import) |
| `backend/voice/api.py` | our route pattern (`backend/myhands_api.py`) | none | 1 / 0 (`__future__` import) |
| `web/voice.js` | our control pattern (`web/control.js`) | none | 0 / 0 (the fetch-with-JSON idiom is in `web/app.js`) |
| `tests/ui/voice_ui.cjs` | the `control_ui.cjs` jsdom harness (ours) | none | 0 / 0 |

"Identical lines" means lines of 30+ characters that match a line in the reference corpus after
whitespace normalisation. Every match listed above is an import or a common idiom. None is a
block of code, a comment, or a sentence.

## How to re-run

From the repository root:

```
.venv/bin/python tools/provenance_check.py backend/router.py backend/agent.py backend/quota.py \
    backend/permissions.py backend/stream.py backend/diagnostics.py backend/events.py \
    backend/devices.py backend/myhands_api.py web/control.js tests/ui/control_ui.cjs
.venv/bin/python tools/provenance_check.py backend/voice/*.py web/voice.js tests/ui/voice_ui.cjs
```

The reference corpus is `barehands/` (AGPL-3.0), plus the legacy app's own files
(`main.py`, `ui.py`, `core/`, `actions/`, `dashboard/`, `memory/`, `config/`, `server.ts`).
Checking against the legacy app matters because the owner asked for v2 to be new work, not a move
of the old code.

## What the check does not cover

- It does not compare against upstream projects that are not in the repository (for example the
  original Mark LIII project or the Home Assistant and Pipecat code). Those were read only as
  concept sources, and no code was copied from them. A second reviewer should check this (MYHANDS_CLEAN_ROOM §6).
- Shared identifiers are reported but not judged. Most are standard API names.
- The licence of the combined project is an owner decision, pending a lawyer's review
  (V2_REDESIGN §6).

## Third-party code in v2

No new third-party packages were added in V2-1 or V2-2. The only new runtime dependencies are the
My Hands packages listed in `backend/requirements-myhands.txt` (V2-1 and Track A), with their
licences recorded in `THIRD_PARTY_NOTICES.md`.

V2-3 adds optional voice packages in `backend/requirements-voice.txt`: `sounddevice` (MIT) and
`numpy`. openWakeWord is listed there but commented out, because its models need a licence decision
first (V2_REDESIGN §13). Licences are in `THIRD_PARTY_NOTICES.md`.

Self-repair additions (2026-10-09). Written from the owner's rules in `docs/SELF_REPAIR.md`. The provenance
check (`tools/provenance_check.py`) was run on the new repair files against two corpora. Against `barehands/`
(AGPL-3.0): no shared 8-word sequence in any of them. Against the base project's own legacy files (`actions/`,
`memory/`, `core/`; CC BY-NC 4.0, the same project): short generic phrases and Python idioms, such as the
atomic-write lines and `mkdir(parents=True, exist_ok=True)`. Those are common code, not copied text. The new files are `backend/repair/*.py`, `backend/chat.py` (`complete`), `tools/repair_drill.py`,
`tests/test_repair*.py`, `tests/test_memory_archive_tools.py`.

