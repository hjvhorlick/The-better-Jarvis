# One source of truth: how the dashboard reads JARVIS's settings

Status: **complete; verified headlessly** (see §6). Written 2026-10-11 for the
dashboard build `2026-10-11-brain-config-1`.

## 1. The problem this closes

The dashboard carried its own configuration next to the application's:

| Setting | The application | The dashboard (before) |
|---|---|---|
| Gemini key | `GEMINI_API_KEY`, else `config/api_keys.json` → `gemini_api_key` (`backend/config.py`, `config/__init__.py`, every `actions/*.py`) | `process.env.GEMINI_API_KEY` only — the `.env` written by Settings |
| Model | `SUPPER_TEXT_MODEL`, else the app's pinned current model `CURRENT_TEXT_MODEL = "gemini-3.8-flash"` (the moving alias `gemini-flash-latest` is only the fallback if the pinned name is ever withdrawn) | hardcoded `gemini-2.5-flash` / `gemini-2.5-flash-image` at each call site |
| Count | `runtime/quota.json`, shared with `backend/quota.py` (which still carries the old hard limit) | nothing — the guard was bypassed; today the dashboard counts and warns (`SUPPER_GEMINI_DAILY_WARN`) and only Google stops calls |
| Names | `assistant_name` / `user_name` from `config/api_keys.json` | hardcoded "JARVIS" |

A key that worked for the app could look "missing" to the dashboard, and a
retired model name (`404 NOT_FOUND — … is no longer available to new users`)
killed chat, "Hey Jarvis" transcription and pictures at once — while the error
text blamed the connection and the key.

## 2. The resolver

`config.ts` (repository root, imported by `server.ts`) is now the only place
these settings are decided. Every Gemini call path — `processCommand()`,
`transcribeVoice()`, `makeAiImage()`, `GET /api/brain-check` — goes through it.

| Setting | Order (first match wins) | Reported source |
|---|---|---|
| **Key** | `GEMINI_API_KEY` from `./.env`, then from the shell/launcher, then `config/api_keys.json` → `gemini_api_key` | `.env` / `environment` / `config/api_keys.json` / none |
| **Text model** | `SUPPER_TEXT_MODEL` → `GEMINI_MODEL` (kept working from an earlier session) → the app's current pinned model `gemini-3.8-flash` → the app's moving alias `gemini-flash-latest` (fallback if the pin is withdrawn) → the model that last worked (`runtime/dashboard_models.json`) → **discovery last** (`ai.models.list()`) | named for every call |
| **Picture model** | `SUPPER_IMAGE_MODEL` → the model that last worked → discovery (`ai.models.list()`, ids naming an image model) | named for every call |
| **Names** | `config/api_keys.json` → `assistant_name` / `user_name` (defaults `JARVIS` / empty) | `config/api_keys.json` |
| **Base URL** | `SUPPER_GEMINI_BASE_URL` — unset in normal use; the test harness points the client at a stub | — |

Rules that are enforced, not just intended:

- **A configured model always wins.** Discovery is only consulted after every
  configured candidate (including the app's own alias) has failed, so
  `ai.models.list()` can never override the owner's setting.
- **Remember what worked, re-discover when it disappears.** The model that
  answered is written to `runtime/dashboard_models.json`; a model that fails is
  forgotten before re-discovery.
- **The current model is pinned; the alias is only the fallback.** `config.ts`
  names `gemini-3.8-flash` (Google's current stable Flash, GA 2 September 2026) and
  `server.ts` names `gemini-3.8-flash-tts` for speech. Both keep Google's moving
  alias as the next candidate, so a withdrawn pin steps back onto Google's own
  pointer instead of breaking — but the app never again drifts to a superseded
  generation because an alias was re-pointed.

## 3. The daily count: it counts and warns — only Google stops a call

**Decision (2026-10-13): the app never blocks itself. It counts every outbound
Gemini call, warns past a level the owner sets, and lets the call through. The
only thing that may stop calls is Google itself, with a real `429`.**

Before this, the dashboard shared the engine room's hard limit
(`SUPPER_GEMINI_DAILY_BUDGET`, default 20) and refused the 21st call of the day
with "I am not calling Gemini, sir: the day's budget is used" — even when Google
still had calls to give. That refusal is gone.

| Rule | Where |
|---|---|
| Every outbound QUESTION counts one unit (retries over models and thinking settings are free) | `config.ts: spendGeminiCall()` |
| Counted in total AND per key: `runtime/quota.json` = `{"day", "used", "keys": {"1", "2"}, "google_stopped": {"1", "2"}, "switched_at"}` — `{day, used}` first, the shape `backend/quota.py` reads | `readBrainCounter()` / `writeBrainCounter()` |
| Reset at local midnight | same |
| Past `SUPPER_GEMINI_DAILY_WARN` (default 20; an old `SUPPER_GEMINI_DAILY_BUDGET` is honoured as the warning level) the terminal, the dialogue (a system line) and Settings WARN — the call still goes through | `resolveDailyWarn()`, `onQuotaEvent()` |
| A counter file that exists but cannot be read: the count continues in memory for the day, the file is left alone, and Settings says the file could not be read — nothing is blocked | `readBrainCounter()` |
| A real `429` from Google stops THAT key until midnight Pacific (Google's own quota reset — NOT the local midnight the count resets at); Google rejecting a key does the same | `markKeyStoppedByGoogle()`, `liveStop()` |
| If the second key (`gemini_api_key_2` / `GEMINI_API_KEY_2`) is set and not stopped, it takes over for the rest of the day — the same question is retried on it at once (counted as one call on key 2, the one exception to "one unit per question", because Google counts it against key 2) | `runBrain()` / `runBrainStream()` |
| Only when EVERY key we have is stopped are calls refused before they are sent — code `google-stopped`, and the message says Google did it, not this app | `resolveActiveKey()`, `explainBrainFailure()` |
| Voice (Kokoro / faster-whisper on this computer) and local answers (knowledge, time, reminders, drafts, small talk, memory) never reach the gate and never count | they never call `runBrain()` |

Settings → "The Brain" shows both keys by their last four characters and
source, which key is answering and why, the calls made today per key, the
warning level, and whether Google has stopped a key (with the time).

**Honest limitation (the engine room).** `backend/quota.py` — the old
standalone app's counter — still carries the hard limit. It reads only `day`
and `used` from the shared file, so the dashboard's extra fields do not disturb
it; but if the desktop app is run on the same day it will still refuse at its
own limit. The dashboard is the one build started with `npm start`, so that is
left as documented rather than changed silently. The second key is also a
dashboard feature only; the engine room reads `gemini_api_key` alone.

**Honest limitation (concurrency).** Writes are a read-modify-write with an
atomic `tmp` + `rename`, so two *dashboards* cannot interleave a half-written
file. The Python engine room keeps its own count in memory and writes the whole
file when it spends, without a lock the dashboard knows about; two writers in
the same second can lose one unit of each other's count — the file is never
corrupted. In the normal case only one writer exists.

## 4. Errors name the real cause

`classifyGeminiError()` reads the failure and `explainBrainFailure()` writes the
sentence. The rules:

| What Google said | Code | What the dashboard says |
|---|---|---|
| `404 NOT_FOUND`, "no longer available" | `model-unavailable` | "The model name was withdrawn, sir — my key is fine, so do not change it." … names `SUPPER_TEXT_MODEL` / `GEMINI_MODEL`, the app's current model and its alias fallback |
| `401`/`403`, `API_KEY_INVALID` | `key-rejected` | the key itself is refused — names which key (1 or 2), where it came from and its last four characters; if the other key is set, it takes over for the day |
| `429`, `RESOURCE_EXHAUSTED` | `rate-limited` | Google's own quota — "Google stopping us, not this app"; that key is stopped until midnight Pacific, the second key takes over if set |
| `ENOTFOUND`, `ECONNREFUSED`, "fetch failed" | `connection` | the call never left the machine; neither key nor model is at fault |
| no key anywhere | `no-key` | names every place checked: `GEMINI_API_KEY` (including `./.env`) and `config/api_keys.json` → `gemini_api_key` |
| Google has stopped every key we have today | `google-stopped` | refused before it is sent: "Google has stopped our calls for today — Google, not this app", with the time each key was stopped and midnight Pacific (`googleResetPromise()`) as the reset |

Never returned or logged: the key itself. Only the last four characters, its
source, and the file it was read from.

## 5. Where the owner sees it

- **Settings → "The Brain"** — the key is saved to `config/api_keys.json` (the
  file the desktop app and every action read); `./.env` is updated too when it
  holds the key, so nothing shadows what was just saved. The status line shows
  the key's source and the model in use. The optional second key
  (`gemini_api_key_2`, Save / Remove) has its own line, and a count line shows
  the active key, the calls made today per key, the warning level and whether
  Google has stopped a key.
- **Settings → Voice** — the build marker plus the model, the key's source and
  the day's count (`#jarvis-build-line`).
- **Diagnostics / `voice test`** — one **real** call to `GET /api/brain-check`;
  the line prints the model that answered, which key, its latency and the count.
- **`GET /api/settings/gemini-key`** — the machine-readable version of the same
  facts (`source`, `sourceDetail`, `key2`, `activeKey`, `model`, `modelSource`,
  `quota` with `used`, `perKey`, `warnAt`, `googleStopped`, `stoppedByGoogle`,
  `summary`, names). `POST` takes `{ key, slot }` (slot 1 or 2) or
  `{ slot: 2, clear: true }`.
- **Telemetry (`status` in the chat)** — both keys' sources, the key answering
  now, the text model, the picture model and the count, measured.

## 6. Verification

| Check | Result |
|---|---|
| `node tests/config_harness.mjs` — real server, stub Gemini, key only in `config/api_keys.json` | 64 checks, all green |
| `node tests/mic_harness.mjs` — microphone, always-on, self-tests | 30/30 (unchanged) |
| `npx tsc --noEmit` | clean |
| `python -m pytest tests/ -q` | unchanged from the baseline (see PR) |

The harness never touches the owner's secrets or state: it starts the server in
a throwaway directory whose only settings file is a fake `config/api_keys.json`,
and points the client at a local stub, which speaks Google's HTTP shape
(`POST /v1beta/models/<model>:generateContent`, `GET /v1beta/models`).

## 7. Provenance

`config.ts`, the `/api/brain-check` route and `tests/config_harness.mjs` were
written for this project (CC BY-NC 4.0, see `CREDITS.md`). The settings order,
field names and quota rules deliberately mirror the existing Python modules
`backend/config.py`, `config/__init__.py`, `backend/quota.py` and the
`actions/*.py` readers; no code was copied from another project. The key
handling keeps the repo's rule: secrets live in `./.env` and
`config/api_keys.json`, both git-ignored, and are never printed.
