# JARVIS — Vincent's personal assistant

**There is ONE main build: the glass dashboard** (`server.ts` + `dashboard/static/app.html`).
It is what AI Studio runs, and what you get with `npm start`. Everything else in this
repository is an engine room whose features are being merged INTO this build — nothing
else is "the app".

## Run (the main build)

The easiest way is the launcher for your system — it checks Node, installs the
packages the first time, opens the browser and starts the server:

- **Windows:** double-click `Start JARVIS.bat`
- **macOS:** double-click `Start JARVIS.command`
- **Linux:** run `./start_jarvis.sh`

Or by hand:

    npm install     # once
    npm start       # then open http://localhost:3000

**Your Gemini key goes in Settings → "The Brain".** Open the gear button in the
dashboard, paste the key, press Save. It is stored only in the local, git-ignored
`.env` file on your machine and takes effect immediately — no restart. You can
also copy `.env.example` to `.env` by hand if you prefer.

## What the main build does

- Glass HUD, My Hands gesture tracking, camera stage, file browser
- Chat with Gemini (`gemini-2.5-flash`), with your personality file `core/prompt.txt`
  and your memory as context; conversation survives restarts
- **Voice out** 🔊 — JARVIS speaks replies (browser speech synthesis)
- **Voice in** 🎤 — speak a command (browser speech recognition, with a server-side
  Gemini transcription fallback)
- **Wake word** 🎙 — "Hey Jarvis" hands-free, in the browser
- `remember <fact>` / `what do you remember` — notes kept in `memory/dashboard_memory.json`
  (your original `memory/long_term.json` is read-only and never touched)
- Diagnostics button — real measured telemetry, not canned text

## Engine room (not the app)

`backend/` + `web/` is the Python feature source (voice pipeline, skills, self-repair,
pairing — see `docs/`). Its features are merged into the main build step by step.
`main.py` / `ui.py` is the retired desktop prototype.

See `CREDITS.md` for origin and licence (CC BY-NC 4.0 — personal use).
