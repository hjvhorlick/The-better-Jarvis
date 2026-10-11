# One source of truth: how the dashboard reads JARVIS's settings

Status: **complete; verified headlessly** (see §6). Written 2026-10-11 for the
dashboard build `2026-10-11-brain-config-1`.

## 1. The problem this closes

The dashboard carried its own configuration next to the application's:

| Setting | The application | The dashboard (before) |
|---|---|---|
| Gemini key | `GEMINI_API_KEY`, else `config/api_keys.json` → `gemini_api_key` (`backend/config.py`, `config/__init__.py`, every `actions/*.py`) | `process.env.GEMINI_API_KEY` only — the `.env` written by Settings |
| Model | `SUPPER_TEXT_MODEL`, else `DEFAULT_TEXT_MODEL = "gemini-flash-latest"` (a moving alias) | hardcoded `gemini-2.5-flash` / `gemini-2.5-flash-image` at each call site |
| Budget | `SUPPER_GEMINI_DAILY_BUDGET` + `runtime/quota.json`, fail closed (`backend/quota.py`) | nothing — the guard was bypassed |
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
| **Text model** | `SUPPER_TEXT_MODEL` → `GEMINI_MODEL` (kept working from an earlier session) → the app's alias `gemini-flash-latest` → the model that last worked (`runtime/dashboard_models.json`) → **discovery last** (`ai.models.list()`) | named for every call |
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
- **Nothing is pinned by version number.** The only model name in the source is
  the app's moving alias; `grep -n "gemini-2\|gemini-3" server.ts` returns
  nothing, and `config.ts` has no model name in a call path.

## 3. The daily budget: shared, deliberately

**Decision: the dashboard shares the engine room's counter — one budget, one
file, one set of rules.**

| Rule (`backend/quota.py`) | The dashboard |
|---|---|
| Limit from `SUPPER_GEMINI_DAILY_BUDGET`, default 20 | same, `config.ts: resolveDailyBudget()` |
| Counter in `runtime/quota.json`, shape `{"day": "YYYY-MM-DD", "used": n}` | same file, same shape |
| One unit per call that reaches Gemini, before it is sent (failures count) | same, `trySpendGeminiBudget()` before each attempt |
| Reset at local midnight | same |
| A counter that exists but cannot be read fails closed | same |
| A `429` marks the day exhausted | same, `markBudgetExhausted()` |

Why shared: the budget is the owner's, not a build's. Two counters would drift
exactly like the two configurations did — the dashboard could spend 20 calls
while the app believed 20 were still left, and neither number would mean
anything. Sharing also makes `GET /api/brain-check` and the app's diagnostics
report the same "used today" figure.

**Honest limitation (concurrency).** Writes are a read-modify-write with an
atomic `tmp` + `rename`, so two *dashboards* cannot interleave a half-written
file. The Python engine room, however, keeps its own count in memory and writes
the whole file when it spends, and it does not take a lock the dashboard knows
about. If the owner runs the desktop app and the dashboard at the same time and
both call Gemini within the same second, the two writers can lose one unit of
each other's spend — the file is never corrupted, and the limit can be
over-run by at most the handful of calls made in that race window. Closing that
properly means teaching `backend/quota.py` a lock (`runtime/quota.lock`) and
having both sides take it; that is a change to the engine room, so it is left
as a documented follow-up rather than done silently here. In the normal case —
the dashboard is the ONE build, started with `npm start` — only one writer
exists.

## 4. Errors name the real cause

`classifyGeminiError()` reads the failure and `explainBrainFailure()` writes the
sentence. The rules:

| What Google said | Code | What the dashboard says |
|---|---|---|
| `404 NOT_FOUND`, "no longer available" | `model-unavailable` | "The model name was withdrawn, sir — my key is fine, so do not change it." … names `SUPPER_TEXT_MODEL` / `GEMINI_MODEL` and the app alias |
| `401`/`403`, `API_KEY_INVALID` | `key-rejected` | the key itself is refused — names where the key came from and its last four characters |
| `429`, `RESOURCE_EXHAUSTED` | `rate-limited` | Google's own limit — the day is marked used up; the key and the model are not at fault |
| `ENOTFOUND`, `ECONNREFUSED`, "fetch failed" | `connection` | the call never left the machine; neither key nor model is at fault |
| no key anywhere | `no-key` | names every place checked: `GEMINI_API_KEY` (including `./.env`) and `config/api_keys.json` → `gemini_api_key` |
| budget spent / counter unreadable | `budget` | names `runtime/quota.json` and `SUPPER_GEMINI_DAILY_BUDGET` |

Never returned or logged: the key itself. Only the last four characters, its
source, and the file it was read from.

## 5. Where the owner sees it

- **Settings → "The Brain"** — the key is saved to `config/api_keys.json` (the
  file the desktop app and every action read); `./.env` is updated too when it
  holds the key, so nothing shadows what was just saved. The status line shows
  the key's source and the model in use.
- **Settings → Voice** — the build marker plus the model, the key's source and
  the day's budget (`#jarvis-build-line`).
- **Diagnostics / `voice test`** — one **real** call to `GET /api/brain-check`;
  the line prints the model that answered, its latency and the budget left.
- **`GET /api/settings/gemini-key`** — the machine-readable version of the same
  facts (`source`, `sourceDetail`, `model`, `modelSource`, `quota`, names).
- **Telemetry (`status` in the chat)** — the key's source, the text model, the
  picture model and the budget, measured.

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
