# Owner requirements for JARVIS

JARVIS is Vincent’s personal assistant. Treat the following as product requirements, not optional suggestions or assumptions from previous edits.

## Main app and launch paths

- The supported app is the Node dashboard: `server.ts` plus `dashboard/static/app.html`, started with `start_jarvis.sh` (or the Windows/macOS launcher).
- Keep every convenience launcher pointed at that same runtime. Do not route a launcher back to `main.py` or the legacy Python dashboard: it does not provide the Node dashboard’s local-voice API, hand-gesture WebSocket, or static hand-gesture script.
- Before changing a feature, trace the launcher, page, and API that actually run together. Treat separate/legacy UIs as out of scope unless Vincent asks for them.

## Chat and status UI

- Keep the app focused on chat. Do not cover it with offline, Gemini-key, or quota banners, overlays, gates, repeated toasts, or new panels/switches. Do not replace a removed notice with another notice.
- Gemini is optional for text answers. A missing key, network failure, or quota response must not stop the app, local commands, chat history, or My Hands. If a requested feature truly cannot proceed, use one short warning in chat and keep the rest usable.
- Preserve the complete chat reply. Do not silently truncate a reply or its spoken version.

## Voice

- Voice starts enabled by default and must be generated and recognized using on-device/local services. Do not add cloud speech services or a remote-voice mode.
- Use the app-local Kokoro generator first. Browser speech synthesis is only a fallback, and only for voices explicitly marked `localService === true`; never choose a remote voice.
- Use the app-local faster-whisper recogniser for microphone input. Do not use browser `SpeechRecognition`, whose implementation may send audio to a vendor service.
- Keep the existing local generator and repair its connection/readiness path before considering a replacement. There should be no online-voice mode switch.

## My Hands

- My Hands means real camera hand tracking: the visible stick-hand/skeleton and gestures must work in the supported dashboard.
- Do not silently substitute the Mouse Hand simulator when camera access or the tracker fails. Report a real failure briefly in chat; do not cover the UI with a camera/tracker banner.
- Keep camera/tracker behavior compatible with major browsers and preserve the existing gesture behavior when repairing it.

## Changes and verification

- Remove confirmed stale or duplicate code rather than layering workarounds on top. Inspect callers and tests first; preserve unrelated behavior.
- Update tests for each behavior change. Do not claim that camera, microphone, speakers, or local voice models were hardware-tested unless they were actually run on Vincent’s machine.
- Do not push, merge, or close a pull request without Vincent’s explicit instruction. In particular, never merge until he says so.
