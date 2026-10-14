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

**Gemini is optional for text answers.** If you want online text answers, add a key under
Settings → *Optional Gemini access*. JARVIS stores it in the local configuration
used by the server; local commands, chat history, memory and My Hands do not
depend on that key. A missing key or provider failure does not cover or disable
the dashboard. Settings → Voice shows the page build and local voice readiness.

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
- **Local-first chat.** The dashboard handles supported commands and saved local
  knowledge before asking an online provider. Gemini is optional for open-ended
  answers; if it is unavailable, chat, local tools and history continue. Where a
  requested task needs an unavailable provider, JARVIS gives a brief reply instead
  of disabling the app.
- **Gemini is not a UI gate.** A provider key can be saved under Settings →
  *Optional Gemini access*. Call counts and provider state are diagnostics only:
  no offline/quota banner is shown, and a Google quota response does not disable
  chat or unrelated local features. An optional second key can be configured
  with `GEMINI_API_KEY_2` or `gemini_api_key_2` in the local config.
- **Local voice** 🔊🎤 — voice starts enabled. Speaking uses the dashboard's
  app-local Kokoro generator first; only if it cannot speak may the browser use a
  voice explicitly marked `localService === true`. Microphone audio goes to the
  app-local faster-whisper recogniser. Browser `SpeechRecognition` is not used.
  Both paths use local services and models. Setup and troubleshooting are in
  [`docs/LOCAL_VOICE.md`](docs/LOCAL_VOICE.md).
- **My Hands** — the dashboard uses a real camera feed and hand landmarks to draw
  the stick-hand skeleton/cursor and drive pinch, fist, two-hand and room gestures.
  It does not silently substitute a mouse simulator when camera tracking fails.
  Allow camera access on a secure page (`https://` or localhost).
- **Complete replies** — the app does not trim a reply to fit the voice queue.
  Streaming updates the chat as available; the local voice receives the complete
  reply, and the local browser fallback preserves all remaining text if it is used.
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
- **No internet?** Local commands, saved knowledge and memory remain available.
  Gemini text answers and live web lookups need a network; losing that network does
  not disable chat or local features. Uncached browser tracker assets may also need
  to load once before My Hands can start.
- **Personality** — `core/prompt.txt` is used **in full** (repeated blocks are
  collapsed), plus a short conversation section: opinions that can be defended,
  one good follow-up question, interest in your family and your projects.
- **Persistent local memory** — the Node app stores structured records in
  `memory/long_term.json`, recent turns in `memory/recent_dialogue.json`, and older
  turns in `memory/dialogue_archive.jsonl`. Corrections supersede prior values;
  forgetting is two-step and removes a record from active memory (recovery backups
  may retain an earlier copy). Passwords, API keys, tokens and financial
  credentials are rejected as memory.
- When an online answer provider is used, chat retrieves bounded, topic-aware
  context from that same local memory store. Retrieved memories are clearly marked
  as untrusted reference data, not system instructions. Topic continuity, saved
  decisions, open tasks and verified research references are added when relevant.
  Embeddings are not required or claimed.
- **Safe legacy import** — on startup the Brain checks the old dashboard notes/history
  and local knowledge file, makes hash-verified backups before importing, records a
  repeatable schema/migration report, and leaves source files in place. Malformed stores
  are not replaced by empty defaults; partial/blocked imports are reported by the
  migration status. Only data present on this computer can be imported; this checkout contains no
  owner-specific runtime memory to claim as migrated.
- **Sourced research** — the existing Research workspace remains the full-report store.
  When you explicitly save a report, its cited URLs and source-verification limits are
  indexed in local memory; unsaved task results are not silently converted into durable memory.
- `remember <fact>` / `what do you remember` — local memory operations; use
  `remember preferences/tea = green` for a named record. Say
  `correct preferences/tea to black` to supersede a value, or `forget preferences/tea`
  and approve the one-time confirmation code to remove it from active memory.
- Diagnostics button — real measured telemetry, not canned text
- **The open web, and it never costs quota.** JARVIS can search the internet
  itself — `search the web for ...`, `look up ...`. Nothing there goes through
  Gemini, so a `429` from Google does not stop it and the offline switch does not
  either. When Gemini cannot answer, JARVIS answers from Wikipedia and
  DuckDuckGo and says so. Every link goes through the server, so no page you ask
  it to read can reach your network.
- **Suppliers — where JARVIS gets things from.** Pictures, video, sound, books,
  3D printable models, and addresses and places. Behind every keyed supplier
  sits one that needs nothing at all, so **every key is optional**: a missing key
  narrows the choice of supplier and never blocks a search.
  Ask in plain words — `find me a picture of a lion`, `a video of ...`,
  `a song about ...`, `a book about ...`, `a 3d model of ...`,
  `where is 41 Maple Street`.
  Keyed suppliers are Pexels, Pixabay, Jamendo, Geoapify, LocationIQ and
  Thingiverse; paste a key into Settings → *Workspace & Gestures* and it takes effect at
  once. Without any key you still get Wikimedia Commons, Openverse, the Internet
  Archive, Project Gutenberg, Nominatim, Photon and Open-Meteo. Limits and where
  to get each key are in `.env.example`.
- **Register a supplier of your own.** Any website with a JSON API — or one of
  your own applications — can be added from Settings → *Workspace & Gestures*: where to ask,
  which header the key goes in, and where in the answer the title and the file
  live. It needs **no restart and no edit to any code**, and it is tried before
  the built-in suppliers because you just added it. Definitions are kept in
  `config/suppliers.json` (gitignored — your keys stay yours), and its endpoint is
  fetched through the same guard every built-in supplier uses, so it cannot be
  pointed at your network.

## Engine room (not the app)

`backend/` + `web/` is the Python feature source (voice pipeline, skills, self-repair,
pairing — see `docs/`). Its features are merged into the main build step by step.
`main.py` / `ui.py` is the retired desktop prototype.

See `CREDITS.md` for origin and licence (CC BY-NC 4.0 — personal use).
