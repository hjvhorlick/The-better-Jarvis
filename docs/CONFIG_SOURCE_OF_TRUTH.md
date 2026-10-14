# One source of truth: how the dashboard reads JARVIS's settings

Status: **updated for the supported Node dashboard**; current verification
results are listed in §6. Updated 2026-10-14 for build
`2026-10-14-local-first-full-replies-2`.

## 1. The problem this closes

The dashboard carried its own configuration next to the application's:

| Setting | The application | The dashboard (before) |
|---|---|---|
| Gemini key | `GEMINI_API_KEY`, else `config/api_keys.json` → `gemini_api_key` (`backend/config.py`, `config/__init__.py`, every `actions/*.py`) | `process.env.GEMINI_API_KEY` only — the `.env` written by Settings |
| Model | `SUPPER_TEXT_MODEL`, else the app's pinned current model `CURRENT_TEXT_MODEL = "gemini-3.8-flash"` (the moving alias `gemini-flash-latest` is only the fallback if the pinned name is ever withdrawn) | hardcoded `gemini-2.5-flash` / `gemini-2.5-flash-image` at each call site |
| Count | `runtime/quota.json`, shared with `backend/quota.py` (which still carries the old hard limit) | before: nothing — the guard was bypassed; now the dashboard counts and warns (`SUPPER_GEMINI_DAILY_WARN`), while no usable key, the Gemini switch, or Google refusing every key can skip Gemini requests only |
| Names | `assistant_name` / `user_name` from `config/api_keys.json` | hardcoded "JARVIS" |

A key that worked for the app could look "missing" to the dashboard, and a
retired model name (`404 NOT_FOUND — … is no longer available to new users`)
killed chat, "Hey Jarvis" transcription and pictures at once — while the error
text blamed the connection and the key.

## 2. The resolver

`config.ts` (repository root, imported by `server.ts`) decides the optional
Gemini key/model and provider accounting. Gemini call paths such as
`processCommand()`, `makeAiImage()`, research, and `GET /api/brain-check` use it.

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
- **The text model is pinned; the alias is only the fallback.** `config.ts`
  names `gemini-3.8-flash` (Google's current stable Flash, GA 2 September 2026).
  The moving alias `gemini-flash-latest` is the next text-model candidate, so a
  withdrawn pin steps back onto Google's own pointer instead of breaking. Text
  answers do not drift to a superseded generation because an alias was re-pointed.

## 3. Optional Gemini accounting: never a chat gate

**Decision (2026-10-14): Gemini is optional.** The dashboard counts provider
calls for diagnostics, but it does not turn a missing key, network failure, or
Google quota response into an app-wide offline gate. Local commands, chat
history, saved knowledge and My Hands keep working. A provider-only
request uses any available local/open-web path or gets a short task-specific reply.
The dashboard does not push offline/quota notices into chat when provider state
changes, and it has no blocking banner or quota panel.

| Rule | Where |
|---|---|
| Every outbound Gemini question increments the daily total and per-key count; there is no app-imposed hard budget | `spendGeminiCall()` |
| Counted in `runtime/quota.json` as `{"day", "used", "keys": {"1", "2"}, "google_stopped": {"1", "2"}, "switched_at}` | `readBrainCounter()` / `writeBrainCounter()` |
| The diagnostic count resets at local midnight | `readBrainCounter()` |
| Past `SUPPER_GEMINI_DAILY_WARN` (default 20), a warning is written to the server terminal only. It does not block the call, add a chat message, or open a UI notice | `resolveDailyWarn()`, `spendGeminiCall()` |
| If the existing counter file cannot be read, the file is left untouched and counting continues in memory; the failure is reported in the server terminal | `readBrainCounter()` |
| A real Google 429 or rejected key stops that key until midnight Pacific. A configured second key may take over; if none can be used, the provider request is skipped and the rest of the dashboard continues | `markKeyStoppedByGoogle()`, `resolveActiveKey()`, `runBrain()` / `runBrainStream()` |
| Provider/offline details are available to diagnostic API consumers and explicit status checks; the dashboard does not render them as a banner or broadcast them as unsolicited chat notices | `/api/offline`, `/api/settings/gemini-key`, `realStatusReport()` |

**Honest limitation (the legacy engine room).** `backend/quota.py` belongs to
the separate Python application and still has its own hard limit. It reads only
`day` and `used` from the shared file; its behavior does not define or block the
supported Node dashboard. The second Gemini key is also a dashboard feature only.

**Honest limitation (concurrency).** Writes are a read-modify-write with an
atomic `tmp` + `rename`, so two *dashboards* cannot interleave a half-written
file. The Python engine room keeps its own count in memory and writes the whole
file when it spends, without a lock the dashboard knows about; two writers in
the same second can lose one unit of each other's count — the file is never
corrupted. In the normal case only one writer exists.

## 4. Errors name the real cause

`classifyGeminiError()` classifies provider failures and
`explainBrainFailure()` returns a short, task-scoped message. A failure of an
explicitly requested Gemini task does not turn into a chat-wide status notice;
normal chat may use local knowledge or a separate open-web path instead.

| Provider result | Code | Short Gemini-task response |
|---|---|---|
| `404 NOT_FOUND`, unavailable model | `model-unavailable` | "The configured Gemini model is unavailable. Check `SUPPER_TEXT_MODEL` or use the app default." |
| `401`/`403`, `API_KEY_INVALID` | `key-rejected` | "Google rejected the configured Gemini key. Check Settings → Optional Gemini access." |
| `429`, `RESOURCE_EXHAUSTED`, or all configured keys stopped | `rate-limited` / `google-stopped` | "Google is not accepting Gemini requests right now. Local chat and tools remain available; try again later." |
| `ENOTFOUND`, `ECONNREFUSED`, "fetch failed" | `connection` | "Gemini could not be reached. Check the connection or proxy; local features remain available." |
| no key anywhere | `no-key` | "Gemini is optional and no key is configured. Local chat and tools remain available." Lookup locations remain in diagnostic API data, not this reply. |
| Gemini explicitly disabled by the owner's manual provider switch | `offline` | "Gemini is turned off. Local chat, tools, and separate open-web paths remain available." |
| no usable text / other provider failure | `empty` / `unknown` | "Gemini returned no usable text. Try again." / a short generic error directing the owner to the server console |

The diagnostic API can still report key source, last four characters, model,
counts, and provider-stop state for explicit consumers. The key itself is never
returned or printed.

## 5. What the dashboard shows

- **Settings → Optional Gemini access** — the owner may save a key to the local
  configuration (`config/api_keys.json`; `.env` is updated when applicable).
  The key is never returned to the page. This section does not display a quota
  counter or provider-offline banner.
- **`GET /api/settings/gemini-key`, `/api/offline`** — machine-readable provider
  diagnostics for explicit consumers. The dashboard does not use them to gate
  chat or push status-change announcements.
- **`status` in chat** — an explicit user request for diagnostics may include
  Gemini key/provider and count details. No such message is emitted merely
  because Gemini status changes.

## 6. Verification

Run on 2026-10-14 for this working tree, in the repository-required order:

| Check | Result |
|---|---|
| `npm ci` | completed; npm reported one moderate-severity audit finding. |
| `npm run lint` | passed (`tsc --noEmit`) |
| `npm run build` | passed (esbuild bundle generated) |
| `npm run test:node` | 100/100 passed |
| `node tests/config_harness.mjs --http-only` | 291/291 passed |
| `node --import tsx --test tests/dashboard.node.test.mjs` | 4/4 passed |
| `.venv/bin/python -m pytest -q tests/test_dashboard_local_voice_service.py` | 2 passed (concurrent local-model initialization; no hardware or model download) |
| `node tests/config_harness.mjs` | 300/300 passed, including the jsdom dashboard-page checks |

The configuration harness runs the real server in a throwaway directory whose
only settings file is a fake `config/api_keys.json`. Its text-provider client is
pointed at a local stub that speaks Google's HTTP shape (`POST
/v1beta/models/<model>:generateContent`, `GET /v1beta/models`). The `--http-only`
flag skips optional jsdom page checks; the full harness was also run and passed
300/300 with these simulated page checks included. This is DOM simulation, not
browser testing.

The Node tests use faked browser APIs. No real browser, camera, microphone, or
speaker was exercised, and no local speech model was downloaded or tested.

## 7. Provenance

`config.ts`, the `/api/brain-check` route and `tests/config_harness.mjs` were
written for this project (CC BY-NC 4.0, see `CREDITS.md`). The settings order,
field names and quota rules deliberately mirror the existing Python modules
`backend/config.py`, `config/__init__.py`, `backend/quota.py` and the
`actions/*.py` readers; no code was copied from another project. The key
handling keeps the repo's rule: secrets live in `./.env` and
`config/api_keys.json`, both git-ignored, and are never printed.
