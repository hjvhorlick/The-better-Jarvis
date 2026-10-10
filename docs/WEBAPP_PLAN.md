# JARVIS → Web App with Full PC Hardware Integration — Plan

Status: **DRAFT / planning only.** Nothing here is committed or pushed.
Owner's note: the system prompt (`core/prompt.txt`) is being reworked in parallel,
so this plan avoids touching prompt content.

---

## 1. Goal

Turn the current desktop-only JARVIS (PyQt6 window in `ui.py`, run by `main.py`)
into a **web app** that:

1. Runs in a browser on the PC (and optionally on phone/tablet on the LAN).
2. Uses the **camera, microphone and speakers** of the PC directly, with
   live audio and video in both directions.
3. Keeps the existing capabilities (voice conversation with Gemini Live, the
   `actions/` tool modules, memory, plugins, wake word, dashboard features).

---

## 2. What the current code already gives us

| Area | Today | Reused in the web app? |
|---|---|---|
| Voice loop | `main.py` → Gemini Live over `sounddevice` streams (mic in, speaker out, 16 k / 24 k PCM) | Logic yes, transport changes |
| Device picker | `core/audio_devices.py` + settings dialog in `ui.py` | Replace with browser device APIs + a server-side fallback |
| Camera | `actions/screen_processor.py` (`_capture_camera`), live view in `ui.py` via OpenCV | Yes, as server-side capture; browser capture is preferred |
| Tools | `core/action_loader.py` auto-discovers `actions/*.py` | Yes — keep as-is |
| Web dashboard | `server.ts` (Express + `ws`), `dashboard/static/app.html`, PIN login, encrypted commands | Base for the new front end |
| Phone audio | `/ws/phone-audio` route exists but only logs chunks | Becomes the real audio path |
| Wake word, TTS, STT | `core/wake_word.py`, `core/tts.py`, `core/stt.py` | Yes, runs on the local backend |

Two stacks exist today (Python for the voice engine, Node/TypeScript for the
dashboard). The plan merges them around one backend (see §4).

---

## 3. The key constraint: what a browser can and cannot touch

A web page running in the browser **can**, with the user's permission:

- Open the **microphone** and **camera** (`getUserMedia`).
- Choose the **speaker** output device (`AudioContext.setSinkId` / `HTMLMediaElement.setSinkId`, Chromium/Edge; limited in Safari/Firefox).
- Capture the **screen or a window** (`getDisplayMedia`).
- Play, record and stream audio/video in real time (WebRTC, WebSocket, WebAudio).
- Use Web Speech / Web Serial / WebUSB / Bluetooth in some browsers.

A web page **cannot** on its own:

- Run shell commands, change volume/brightness, open apps, or control files.
- Read arbitrary USB/serial devices (only through WebUSB/Web Serial with user consent, Chromium only).
- Access hardware for a page loaded from a remote host without a secure context.

**Therefore** "full integration with the PC" requires a small **local companion
backend** (Python, already the language of the voice engine) that runs on the PC.
The browser is the face; the local backend is the hands.

Browser requirement: pages that use camera/mic must be served over **HTTPS or
`localhost`** (secure context). Plan for a local TLS certificate (`config/certs/`
is already git-ignored for this purpose).

---

## 4. Target architecture

```
┌──────────────────────── Browser (PWA) ────────────────────────┐
│  React/Vite (or plain TS) UI                                   │
│  • getUserMedia  → mic (AudioWorklet, 16 kHz PCM) + camera     │
│  • AudioContext(+setSinkId) → speaker playback (24 kHz PCM)    │
│  • getDisplayMedia → optional screen share for vision          │
│  • WebSocket / WebRTC to the backend (encrypted with session)  │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTPS + WSS (token, PIN login)
┌───────────────────────────────▼────────────────────────────────┐
│  Local JARVIS backend (one process, Python: FastAPI + uvicorn) │
│  • Gemini Live session (google-genai) — audio/video in/out     │
│  • Action registry (actions/*.py, unchanged plugin model)      │
│  • Memory, reminders, monitors, plugins (existing modules)     │
│  • Hardware services:                                          │
│      - audio:   sounddevice (for PC-side playback/record fallback)│
│      - camera:  OpenCV (server-side capture, e.g. for vision)  │
│      - system:  volume, brightness, apps, files (existing acts)│
│  • Serves the built web app as static files                    │
└────────────────────────────────────────────────────────────────┘
```

### Why Python backend (and not Node) for the merged stack
- The voice engine, actions, memory, wake word and device code are all Python.
- Hardware libraries (`sounddevice`, `opencv`, `pyautogui`, `psutil`, `pywin32`)
  are Python-first.
- `server.ts` is ~20 KB and already duplicates some of what the Python side does.
  Porting its routes to FastAPI is small work.
- Node/`server.ts` can be kept as a thin option during migration (see §8).

---

## 5. Hardware integration, device by device

### 5.1 Microphone
- **Primary:** browser `getUserMedia({audio})` → `AudioWorklet` → 16 kHz mono
  PCM16 → WebSocket → backend → Gemini Live input. Works on any device the
  browser can see; the user picks it in the UI (`enumerateDevices`).
- **Fallback:** backend opens the mic with `sounddevice` (current behaviour) for
  "always-on" wake-word listening when the browser tab is closed. Only when
  the user opts in.
- Echo cancellation / noise suppression enabled through `getUserMedia`
  constraints; the current `ui.py` mute button maps to track `enabled`.

### 5.2 Speakers
- **Primary:** browser plays the 24 kHz PCM from Gemini through `AudioContext`.
  Output device chosen with `setSinkId` (Chromium). Where `setSinkId` is not
  supported, the system default output is used.
- **Fallback:** backend plays through `sounddevice` on the PC (existing
  `RawOutputStream` code path) — useful when no browser is open.
- Interruption ("barge-in") is handled by flushing the playback queue when the
  server sends `interrupted`, as Gemini Live does.

### 5.3 Camera
- **Live view / vision input:** browser `getUserMedia({video})`, JPEG frames
  sampled at ~1 fps (or on request) sent to the backend; the backend forwards
  them to Gemini Live as video input.
- **Vision tool (`screen_processor`)**: keep server-side OpenCV capture as a
  fallback when no browser is open. Camera index stays in `api_keys.json`.
- Camera preview overlay (`_CameraPreview` in `ui.py`) becomes a floating
  `<video>` element.
- Camera must show a visible indicator and be closed by the existing
  `close_camera` tool.

### 5.4 Screen (optional, phase 3)
- `getDisplayMedia` for "look at my screen" from the browser, or the existing
  `mss` capture on the backend.

### 5.5 Other PC hardware (through the backend, not the browser)
- Volume, brightness, lock, shutdown, open/close apps, file ops: existing
  `actions/` modules, unchanged. The UI shows them as confirmations (`core/confirm.py`).
- USB / serial / Bluetooth peripherals: out of scope for phase 1; WebUSB/Web Serial
  can be added later for specific devices.

---

## 6. Security (must be fixed before exposing anything on the network)

The current dashboard has weaknesses that become serious once the app controls
the camera, microphone and the PC:

- Default PIN `JARVIS` and a hardcoded `defaultToken` in `server.ts`.
- `AES_SALT` is a constant string.
- Server listens on `0.0.0.0:3000` by design.

Plan:
- No default PIN: force a first-run PIN setup; store only a salted hash.
- Random per-install session secret; tokens expire; revocation list (the
  `revoke-devices` endpoint already exists).
- HTTPS/WSS only (local certificate); refuse plain HTTP on non-localhost.
- Camera and mic require an explicit on-screen "live" state; a visible indicator
  while they are active.
- Action confirmations (`core/confirm.py`) stay on for destructive actions and
  are shown in the web UI.
- Rate-limit login; log all hardware-control actions to `memory/command_log.txt`.
- Keep `config/api_keys.json`, `memory/long_term.json` and `.env` out of Git (already ignored).

---

## 7. Front end (web app)

- **Stack:** Vite + TypeScript + a lightweight UI framework (React or Svelte — to
  be decided). Built to static files, served by the backend.
- **PWA:** installable on the PC (Chrome/Edge "Install app") and on phones.
- **Screens:**
  1. Login / first-run PIN setup
  2. Main HUD: voice state (listening / thinking / speaking), transcript, live camera
  3. Settings: microphone, speaker, camera pickers; voice (30 Gemini voices);
     speaking style; wake word; plugins; permissions status
  4. Actions log and pending confirmations
  5. Files / uploads (existing `/api/upload`, `/api/files`)
- Mirror the existing dashboard features (`app.html`) so nothing is lost.
- Accessibility: keyboard shortcuts for mute/push-to-talk; text fallback for all voice functions.

---

## 8. Migration phases

**Phase 0 — prep (no behaviour change)**
- Freeze the current `main.py` / `ui.py` behaviour; add tests around `core/` (audio device resolution, action loader).
- Agree on the prompt changes (owner is working on this now).

**Phase 1 — backend**
- Create `backend/` with FastAPI, WebSocket endpoints: `/ws/session` (audio + video +
  events), `/api/*` (settings, devices, actions, files), static file serving.
- Move the Gemini Live session logic out of `main.py` into a service class, with
  no Qt dependency. `ui.py` becomes optional.
- Keep `sounddevice` as a server-side audio path.

**Phase 2 — web front end**
- `web/` (Vite app). Mic via AudioWorklet, speaker via AudioContext, camera via
  getUserMedia, device pickers, the HUD, settings.
- Connect to `/ws/session`. Verify full voice round-trip in Chrome and Edge.

**Phase 3 — hardware depth and security**
- Security work from §6; PWA install; screen capture; device-specific
  integrations.

**Phase 4 — retire the old paths**
- Decide whether to keep PyQt (`ui.py`) as an optional desktop shell (e.g. using
  `pywebview` to wrap the web app in a window), or remove it.
- Retire `server.ts` once the Python backend covers its routes.

---

## 9. Proposed repository layout (after migration)

```
backend/            Python: FastAPI app, Gemini session service, hardware services
  api/              REST routes
  session/          Gemini Live session, audio/video pipelines
  hardware/         mic, speaker, camera, system wrappers
web/                Vite + TS front end (PWA)
actions/            unchanged plugin tools
core/               unchanged (audio_devices, confirm, memory helpers, …)
plugins/            unchanged
config/             unchanged (api_keys.json git-ignored)
docs/WEBAPP_PLAN.md this file
```

`server.ts`, `dashboard/`, `ui.py` and `main.py` are the parts that change most.

---

## 10. Decisions needed from you

1. **Front-end framework:** React, Svelte, or plain TypeScript?
2. **Where it runs:** only this PC, or also phone/tablet on your home network?
   (Decides how strict the network security must be.)
3. **Desktop shell:** keep a native window (`pywebview`), keep PyQt, or browser only?
4. **Always-on listening:** should wake-word listening work when the browser is
   closed (backend mic), or only while the web app is open?
5. **Node `server.ts`:** retire it in favour of Python, or keep both during migration?
6. **Repo:** keep this as one repo, or split the web front end into its own repo?
7. **Prompt changes:** when you are ready, tell me and I will wire the new prompt
   into the backend (I will not touch `core/prompt.txt` until then).

---

## 11. Risks

- **Browser support for `setSinkId`:** only Chromium-based browsers. Firefox/Safari
  will use the system default speaker. Documented in the UI.
- **Latency:** browser → WebSocket → backend → Gemini adds a hop. Mitigate with
  small audio chunks (20–40 ms) and keeping the backend on the same PC.
- **Two audio paths** (browser vs `sounddevice`) must not play at once. The
  backend routes output to one active sink at a time.
- **Windows-only code** in `ui.py` / actions (pywin32, CREATE_NO_WINDOW) must be
  isolated so the backend still runs on Linux/macOS.
- **Scope:** this is a large rewrite. Phases 1–2 alone deliver most of the value;
  phases 3–4 can follow.
