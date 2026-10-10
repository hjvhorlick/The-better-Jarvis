# ADR-001 — One application: local Python backend owns the devices, browser is the interface, native shell later

Status: **Proposed (revised 2026-10-09).** Not yet approved. No code has been changed for this decision.
Revision history: the first draft put the camera and microphone in the browser page. This revision moves them to the backend, after the failures described below.

## Context

- The owner runs the current app on Linux and wants it on any operating system.
- The owner wants one application: voice, memory, personality, camera, microphone,
  speakers, the My Hands gesture interface, and control of the desktop (windows,
  files, folders).
- Two separate programs were built, and they do not cooperate well.

### What the audit found (evidence from the code)

- **Barehands is a separate program.** It runs its own local web server on
  `127.0.0.1:8794` and its own page in a browser tab (`barehands/stage.html`).
  JARVIS starts it as a subprocess and opens the tab.
- **Control is one-way.** JARVIS controls the board by HTTP `/cmd` calls and by writing
  files in `barehands/state/`. Nothing in barehands sends gesture events, pinches or
  grabs back to JARVIS. The AI can move objects on the board but cannot see what
  the hand is doing.
- **The camera has no single owner.** The barehands page holds the camera through
  `getUserMedia` inside a browser tab. JARVIS opens its own OpenCV handle for live
  view and vision. The two cannot share the device reliably.
- **The camera's lifetime belongs to a browser tab.** Closing, reloading or
  suspending that tab stops the stream, and nothing in JARVIS notices or
  restores it. This is the likely cause of "the camera does not stay on". It has not
  yet been reproduced.
- **Barehands needs the internet on first run.** Its page loads MediaPipe and three.js
  from CDNs, and the hand model from Google storage. The server itself is local.

## Decision

1. **One application, one backend process (Python, FastAPI).** It runs on Windows,
   Linux and macOS, and binds to `127.0.0.1` by default. It owns the Gemini
   session and key, memory, personality, settings, the action/plugin system, and
   the board. The existing Python modules are reused, not rewritten.
2. **The backend owns the camera, microphone and speakers.**
   - Camera: OpenCV, one capture service. Frames are published to subscribers (hand
     tracking, vision on request, and the live preview).
   - Microphone and speakers: `sounddevice`, the path that already works on the owner's
     Linux PC.
   - Why: the device lives as long as the application, not a browser tab. It can be
     reclaimed automatically. There is one owner, so there are no contention bugs.
3. **My Hands tracking runs in the backend** (MediaPipe Python, same frames as the
   camera service). Gesture events (hand detected, pinch started, object grabbed,
   dragged, released, tracking lost) go to the agent as input, so it knows what the
   hand is doing. **Open question:** if MediaPipe Python proves less reliable than
   the browser version on the owner's hands, keep the browser tracker as an option.
   This is decided by measurement in M5, not by preference.
4. **The browser is the interface.** It is a web application (TypeScript + Vite,
   built to static files) that shows the chat, the status of each device, the camera
   preview, the glass board, and settings. It receives frames and events over one
   WebSocket. It does not hold any device. Chrome is the supported browser for v1.
5. **Browser capture is a fallback only**, for when the backend has no access to a
   device. For example, a phone on the LAN. That needs HTTPS and is a later step.
6. **Native desktop shell last.** A thin wrapper (for example pywebview or Tauri) that
   opens the same UI in a window and starts the backend. No new features.

## What runs where

| Capability | Backend | Browser UI | Notes |
|---|---|---|---|
| Gemini Live conversation | owns session, key | shows transcript, plays audio it receives | Key never leaves the backend. |
| Microphone | `sounddevice` capture | shows level and state | Keeps working when the tab is closed. |
| Speakers | `sounddevice` playback | shows speaking state | Existing path. |
| Camera | OpenCV capture, one owner | displays frames over WebSocket | Stays on while the app runs. |
| Vision on request | reads from the camera service | — | No second camera handle. |
| My Hands tracking | MediaPipe Python | renders board | Gesture events sent to agent. |
| Board (cards, objects) | authoritative state | renders and sends taps | Agent drives the board through the same internal interface, not HTTP between two apps. |
| Memory, personality, settings | yes (existing modules) | settings form | Unchanged modules. |
| Desktop windows, files, apps | per-OS adapters (M6+) | shows results and confirmations | Needs the backend running. |

## Constraints

- The backend must be running. The UI shows a clear status when it isn't, and chat is
  not available without it. A small launcher is needed (M1).
- A browser page cannot reach the desktop without the backend. This is the cost of
  the design, and the reason for the native shell at the end.
- Camera on macOS needs a terminal or app permission in System Settings, and
  Linux needs the user to be in the `video` group. The launcher checks both and says
  what to do.
- Injected input cannot control elevated windows on Windows unless the backend is
  elevated. On Linux, overlays and global input differ between X11 and Wayland. Both are
  decided at the desktop-control stage (M6).
- Licences must be settled before the combined code is published. The main project is
  CC BY-NC 4.0 and barehands is AGPL-3.0. Vendoring MediaPipe or the hand model must
  also be checked. See `docs/AUDIT_STAGE_A.md` §9.
- **Privacy is designed in, not left to timers.** The current 2–3 second camera
  cutoff is a rule in `main.py`: after a vision answer, the camera stops after 2 seconds.
  It is not an external decision. The rule and the tool description
  ("the live view stays open until the user closes it") contradict each other, and the
  new design resolves this explicitly:
  - **Camera modes**, chosen by the user, each with its own visible indicator:
    *Off*; *Snapshot* (one frame on request, then off); *Live* (on until stopped);
    *My Hands* (on while the board is open).
  - **Persistent indicator** showing whether the camera and microphone are on, and
    for what purpose.
  - **Stop controls that always work:** a button and a hotkey. A hand gesture may be
    added as a configurable extra, but never as the only way to stop.
  - **Auto-off timeout** set by the user (for example after 10 minutes of inactivity).
  - **Frames leave the PC only on request.** Hand tracking stays local. Frames go to
    Gemini only when the agent calls the vision tool or Live video is on, and each one
    is logged in the UI.
  - **Local activity log** of camera and microphone on/off events and frames sent. No
    image or audio content is stored.
  - **Limit to state plainly:** software cannot prove the hardware is off. A physical
    shutter or the hardware indicator is the only real guarantee.

## Milestones

- **M0 — Protect.** Owner backup on the owner's PC (memory, `api_keys.json`,
  `recent_dialogue.json`, `core/prompt.txt`, git bundle). Verify each file reads.
  Tag the current commit. **Requires owner action.**
- **M1 — Backend core and launcher.** FastAPI skeleton. Reuse `memory/`, `core/` and
  `actions/` without editing them. Text chat through the Gemini relay. Launcher that
  checks Python, dependencies, camera and microphone permissions. Tests on copies of memory.
- **M2 — Browser UI shell.** Chat, device status panel, settings (voice, style).
  Clear message when the backend is not running.
- **M3 — Voice in the backend.** Mic to Gemini and replies to speakers through the
  existing `sounddevice` path. Interrupt and recover. Browser shows the state.
- **M4 — Camera service.** One capture owner in the backend. Live preview over
  WebSocket. Vision on request reads from the same service. Measure how long the
  camera stays on under reload, tab switching and vision requests.
- **M5 — My Hands.** Backend tracking, gesture events to the agent, board rendering in
  the browser. Measure detection rate and false pinches on the owner's hands.
  Decide whether the browser tracker stays as an option.
- **M6 — Desktop control (Linux first).** Read-only folder and window listing, then
  write actions with confirmation and undo.
- **M7 — Windows and macOS adapters**, then the native wrapper.

## Consequences

- One process owns each device, so the camera stays on and recovers in one place.
- The agent sees gestures and controls the board through the same internal interface.
- The existing Python core, including the `sounddevice` audio path that already works,
  is reused, which keeps the risk of the first milestones low.
- The backend is a process to run and monitor. Its health is shown in the UI.
- Desktop control waits until M6, so the first release delivers voice, memory, camera
  and My Hands. The risky part stays out of v1.

## Rejected alternatives

- **Devices in the browser page (the first draft).** Ties the camera to a browser tab,
  which caused the current problems. Kept only as a fallback.
- **Electron or Tauri from the start.** Adds a large build chain before the core works.
  Deferred to M7.
- **Browser only, no backend.** Cannot reach desktop files or windows, and cannot keep
  the Gemini key out of the page.
- **Keep the two separate programs and improve the link.** Leaves two camera owners and
  one-way control. The link would have to be rebuilt anyway.
