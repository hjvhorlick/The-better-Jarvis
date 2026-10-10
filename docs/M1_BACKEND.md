# M1 — Backend core: status and verification

Status: **complete for the M1 scope, not yet verified against the live Gemini API.**
Not committed or pushed. Branch `arena/6e171ee4-the-better-jarvis`.

## What was added (all new files)

| Path | Purpose |
|---|---|
| `backend/__init__.py` | Package and version (0.1.0) |
| `backend/config.py` | Paths, Gemini key lookup (env first, then `config/api_keys.json`), model name |
| `backend/persona.py` | System instruction built in the same order as `main.py` (time, identity, memory, recent dialogue, prompt, style) |
| `backend/chat.py` | `ChatService`: text chat through Gemini, read-only memory, in-process history |
| `backend/memory_view.py` | Read-only memory counts (never values) |
| `backend/app.py` | FastAPI app: `/api/health`, `/api/status`, `/api/memory/summary`, `/api/chat` |
| `backend/__main__.py` | `python -m backend` — binds `127.0.0.1:8765` by default |
| `backend/requirements.txt` | Runtime dependencies |
| `tests/` | 25 tests; all persistence redirected to temp directories |
| `docs/M1_BACKEND.md` | This file |

No existing file was modified. `memory/`, `core/`, `actions/`, `main.py`, `ui.py`,
`config/` and `barehands/` are untouched.

## Safety properties (enforced by tests)

- **Memory is never written by M1.** Chat reads the persona and memory only.
- **Tests never touch the real store.** The `isolated` fixture redirects
  `MEMORY_PATH`, `DIALOGUE_PATH` and the config file to a temp directory.
- **Secrets are never returned or logged.** `/api/status` returns a boolean.
  Provider error messages are reduced to their exception type.
- **Localhost by default.** The backend binds to `127.0.0.1`.

## Verification results

| Check | Result |
|---|---|
| `pytest` (25 tests: persona, memory isolation, chat service, API) | **25 passed** |
| Live server `GET /api/health` | 200 OK |
| Live server `GET /api/status` (no key configured) | 200, `api_key_configured: false` |
| Live server `GET /api/memory/summary` (no memory file in checkout) | 200, `file_present: false` |
| Live server `POST /api/chat` without key | 503 with a clear message |
| Live server `POST /api/chat` with empty text | 422 |
| Bind address | `127.0.0.1:8765` only (confirmed with `ss`) |

## Not verified (must be done on the owner's PC)

- **A real Gemini reply.** The sandbox cannot reach the Gemini API host and has no key.
  The request path is covered by tests with a fake client only. Expect the first real
  call to need a fix if the SDK's `config` argument differs from the one used here.
- **Personality on the real prompt and real memory.** Tests use sample memory. The owner
  must compare replies with the desktop app.
- **Memory on the real `long_term.json`.** Requires the M0 backup first.
- **The Live (voice) session.** Not part of M1.

## Known issues and technical debt

- `memory/memory_manager.py` defines `format_dialogue_for_prompt` twice (lines 551 and
  617); the second definition is the one in use. Not changed, because the file is off-limits for M1.
- The persona logic is a copy of the assembly in `main.py`, not a shared function.
  Moving it into one shared module should happen only after both paths are tested.
- Chat history lives in process memory and is lost on restart. Writing turns to
  `recent_dialogue.json` is deferred until the owner backup and migration tests exist.
- No authentication on the backend yet. It is localhost-only; authentication is required
  before any LAN exposure (see ADR-001 and `docs/AUDIT_STAGE_A.md` §8).
- Dependencies are lower-bounded, not pinned. A lock file is needed for reproducibility.

## How to run and test

```bash
cd ~/The-better-Jarvis
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt pytest httpx
python -m pytest -q          # 25 tests
python -m backend            # http://127.0.0.1:8765/api/health
```

Set the key without writing it to a file: `export GEMINI_API_KEY=...` before starting.

## Next

M0 (owner backup) is still required before any step that touches persistent data.
M2 (browser UI shell) can start next, since it only adds files.
