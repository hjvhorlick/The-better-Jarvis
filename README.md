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

**If JARVIS ever says he has no key when you have just saved one, read the build
line at the bottom of Settings → Voice.** It prints the page's build, the
server's build, and the folder this server is reading its settings from. When
the page and the server disagree, the browser is holding an older copy — press
Ctrl/Cmd+Shift+R (or restart the server, if it is the older of the two).

## What the main build does

- **Clear glass, thin yellow lines** — one look on every surface (dashboard and
  rooms share a single stylesheet, `dashboard/static/jarvis-glass.css`). The glass
  is clear: you look through it at the room, or at your own camera when it is on.
  A thin bright-yellow line draws the edge of every window and panel, the words are
  yellow with a dark halo so they stay readable over a picture, and a bloom plus a
  long shadow give the panes depth. Corners are sharp — cut glass, not tiles.
  Settings → *Clear Glass & Yellow Lines* has a **transparency** and a
  **sand-blast** slider for each kind of surface (windows, HUD and dock, rooms):
  a little frost tidies the picture, a lot of sand makes a pane milky and private.
  One slider sets the yellow line, one sets the bloom. The type is **Nunito**
  (rounded, vendored in `dashboard/static/fonts/` — no internet needed).
- **The camera, everywhere** — when the camera is on it becomes the glass in every
  room as well as in the dashboard: one capture, handed to the rooms page, with the
  server's own frame as a fallback. Say "camera on" / "camera off" (or press the
  Camera switch in the rooms bar). The rooms keep two switches only — Tools and
  Camera — because a room is a place to work, not a control panel.
- **The local drafting desk** — "draft an email to the plumber about the leak",
  "write a short note to Sarah thanking her", `read my drafts`, `read draft 2`, or
  an explicit field edit such as `set subject of draft 2 to ...`. A proper letter
  shape is built from your own words — greeting, opening, the ask, closing, your
  name and the date — with the details only you can fill in left in square brackets,
  never invented. **No AI call, no cost.** Drafts are kept as plain text in
  `runtime/drafts/`; chat or voice cannot delete one without confirmation in Email.
- **Email workspace** — open the Email room for Compose, Drafts, Recently edited,
  Search drafts, and Settings / Help. Edit To, CC, BCC, Subject and Body separately;
  save, reopen, duplicate, copy, or delete after an explicit confirmation. The same
  stable draft ID and `runtime/drafts/` storage are shared with the local drafting
  desk (no browser `localStorage` copy). **Preparation only:** there is no Gmail,
  Outlook or other provider connection and no send action. “Open in mail app” makes
  a correctly encoded `mailto:` handoff for you to review and send yourself.
- Glass HUD, My Hands gesture tracking, camera stage, file browser
- Chat with Gemini (`gemini-3.8-flash`, Google's current stable model), with your
  personality file `core/prompt.txt`
  and your memory as context; conversation survives restarts
- **No self-imposed limit.** The app counts every call that goes out to Google
  (total and per key, in `runtime/quota.json`, shown in Settings → "The Brain"
  and the terminal) and **warns** past `SUPPER_GEMINI_DAILY_WARN` (default 20) —
  it never blocks. Only a real `429` from Google stops calls, for that key until
  local midnight, and the message then says plainly that Google stopped us.
- **Second Gemini key (fallback).** Settings → "The Brain" takes an optional
  second key (`gemini_api_key_2` in `config/api_keys.json`, or
  `GEMINI_API_KEY_2`). All calls use the first key; when Google refuses it with
  a `429` or rejects it, the second key takes over for the rest of the day.
  It only doubles the real allowance if it comes from a different Google
  account/project. Voice and local answers never count.
- **Voice out** 🔊 — JARVIS speaks replies in this browser tab by default
  (Settings → Voice, engine *Auto*): the browser's own voice needs nothing
  installed and makes no Gemini TTS calls. If the browser has no working voice,
  the same sentence is spoken by this computer instead (Kokoro in
  `local_voice/service.py`, or the operating system's own voice when the Kokoro
  files are not downloaded yet). Engine *Local* keeps speech on this computer
  only; `GET /api/voice/health` says exactly which local pieces are present.
- **Voice in** 🎤 — click anywhere (or the 🎤 button) once and allow the
  microphone, then just talk: the browser's SpeechRecognition (Chrome, Edge,
  Safari) turns speech into commands. In Chrome/Edge that recognition sends
  audio to the browser maker's service; browsers without it (Firefox) use the
  raw-microphone fallback — audio goes to faster-whisper on this computer.
  The mic needs a secure page (`http://localhost:3000` or https).
- **Always listening** 🎙 — after that first click JARVIS answers ordinary
  speech with no "Hey Jarvis" before every sentence, restarts listening after
  each reply, and never hears his own voice (listening pauses while he speaks).
  The green bar above the chat shows the ear's status and the **🔇 Mute**
  switch stops the microphone outright.
- **Fast replies** — the answer is streamed into the chat as it is written, and the
  Gemini thinking step is switched off (thinkingBudget 0) with a capped answer
  length, which is what turns a ten-second wait into about a second.
- **The AI is used as little as possible** — every command is checked on this
  computer first. Notes, reminders, the time and date, diagnostics, My Hands, the
  rooms, the windows, mute, and anything in the **local knowledge base** are all
  answered or done with no Gemini call at all. A command that asks the computer to
  do something this build has no local tool for is answered honestly and offered
  the AI (say "… — use the AI") instead of quietly spending a call.
- **The local knowledge base** (`runtime/knowledge.json` + `knowledge/starter.json`) —
  the SAME store the desktop app uses, in the same format: answers you teach
  ("learn: <question> = <answer>"), the 32 starter answers that ship with the
  project, and answers Gemini has already given (kept so the same question is
  never paid for twice — time-sensitive and personal questions are never kept).
  `what have you learned`, `forget <number>`. Both halves of the project read and
  write this one file, so an answer taught in either is known to both.
  **Every kept Gemini answer records the model that wrote it.** An answer from an
  older model (or from before the app recorded one) is never used silently: the
  current model is asked first, and only if it cannot be reached is the old answer
  given — labelled with its model and date, and "not re-checked". Superseded
  answers are archived, never deleted.
- **No internet?** Local commands, saved answers, and *this computer's voice* (and
  the browser's own voice) all still work. Fresh open-ended answers do not — those
  are written by Gemini and need a connection. Nothing pretends otherwise, and
  nothing pretends an old answer is a new one.
- **Personality** — `core/prompt.txt` is used **in full** (repeated blocks are
  collapsed), plus a short conversation section: opinions that can be defended,
  one good follow-up question, interest in your family and your projects.
- **Persistent Brain** — the Brain button opens the single-local-profile panel for memories,
  saved topics/projects, decisions, tasks, sourced research, verified backups and restore.
  The Node app uses one BrainStore: `memory/long_term.json` holds structured records,
  `memory/recent_dialogue.json` holds recent turns, and older turns are retained in
  `memory/dialogue_archive.jsonl`. Corrections supersede prior values; forgetting is
  two-step and removes a record from active memory (recovery backups may retain an earlier copy).
  Passwords, API keys, tokens and financial credentials are rejected as memory.
- Chat retrieves bounded, topic-aware full-text context from that same BrainStore and
  sends only the current conversation history to Gemini. Retrieved memories are clearly
  marked as untrusted reference data, not system instructions. Topic continuity, saved
  decisions, open tasks and verified sourced-research references are added when relevant.
  Embeddings are not required or claimed.
- **Safe legacy import** — on startup the Brain checks the old dashboard notes/history
  and local knowledge file, makes hash-verified backups before importing, records a
  repeatable schema/migration report, and leaves source files in place. Malformed stores
  are not replaced by empty defaults; partial/blocked imports are visible in the Brain
  panel. Only data present on this computer can be imported; this checkout contains no
  owner-specific runtime memory to claim as migrated.
- **Sourced research** — the existing Research workspace remains the full-report store.
  When you explicitly save a report, its cited URLs and source-verification limits are
  indexed in Brain; unsaved task results are not silently converted into durable memory.
- `remember <fact>` / `what do you remember` — local memory operations; use
  `remember preferences/tea = green` or the Brain panel for a named record. Say
  `correct preferences/tea to black` to supersede a value, or `forget preferences/tea`
  and approve the one-time confirmation code to remove it from active memory.
- Diagnostics button — real measured telemetry, not canned text

## Engine room (not the app)

`backend/` + `web/` is the Python feature source (voice pipeline, skills, self-repair,
pairing — see `docs/`). Its features are merged into the main build step by step.
`main.py` / `ui.py` is the retired desktop prototype.

See `CREDITS.md` for origin and licence (CC BY-NC 4.0 — personal use).
