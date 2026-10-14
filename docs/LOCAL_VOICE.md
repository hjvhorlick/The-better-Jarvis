# JARVIS voice — supported Node dashboard

This document describes the voice path used by the supported app: `server.ts`,
`dashboard/static/app.html`, and `local_voice/service.py`. The older Python UI and
`backend/voice/` controller are separate legacy paths; they are not the dashboard's
voice service. See `AGENTS.md` before changing launchers or runtime behavior.

## What runs locally

- **Hearing:** the browser captures microphone audio with `getUserMedia` and sends
  it to the Node server. The server forwards it to the local `faster-whisper`
  service. Browser `SpeechRecognition` is deliberately not used because it can send
  microphone audio off this computer.
- **Speaking:** the app's local Kokoro generator is tried first and plays through
  this computer's speakers. If Kokoro cannot speak, JARVIS may use a browser
  speech-synthesis voice only when the browser explicitly marks it
  `localService === true`. Remote browser voices are never selected.

Speech replies are passed to the local generator as complete text. The browser
fallback is chunked without dropping the remaining text. A voice failure does not
remove or shorten the chat reply.

## One-time setup

1. Install the local voice dependencies with the Python interpreter JARVIS will
   use:

   ```sh
   python -m pip install -r backend/requirements-local-voice.txt
   ```

2. Put these Kokoro files in `models/kokoro/`:
   - `kokoro-v1.0.onnx`
   - `voices-v1.0.bin`

   The Kokoro files are model assets and are intentionally not committed to Git.
   `SUPPER_KOKORO_DIR` can point to a different folder.

3. If the required packages are installed in a different Python environment, set
   `SUPPER_PYTHON` to that interpreter before starting JARVIS. Otherwise the
   launcher checks `~/.venv-voice`, then the repository `.venv`, then `python3`
   (or `python` on Windows).

4. Start the Node dashboard normally. It starts `local_voice/service.py` on
   `127.0.0.1:3101` by default. The dashboard talks to that service through its
   own API; browser code does not call `localhost` for the voice service.

The first use of faster-whisper may download the configured speech model once.
After it is present locally, transcription runs on this computer. If the model
or Python packages are missing, JARVIS reports that in Settings → Voice and in
the server console with the `[local-voice]` prefix. That does not disable chat.

## Optional settings

| Environment variable | Default | Purpose |
|---|---|---|
| `SUPPER_PYTHON` | detected Python | Python environment containing the local voice packages |
| `SUPPER_LOCAL_VOICE_PORT` | `3101` | Local-only voice service port |
| `SUPPER_KOKORO_DIR` | `models/kokoro` | Folder containing the two Kokoro model files |
| `SUPPER_TTS_VOICE` | `bm_george` | Local Kokoro voice name |
| `SUPPER_STT_MODEL` | `tiny.en` | Local faster-whisper model |
| `SUPPER_STT_LANGUAGE` | `en` | Transcription language code |

The supported dashboard has no cloud-speech setting.
The microphone starts automatically after page load, subject to browser
permission. Use the chat-bar mute button to stop and release it.

## Troubleshooting and real-device check

1. Open Settings → Voice. The report shows whether the local Kokoro generator and
   faster-whisper recogniser are ready.
2. Use **Test Mic** and **Test Speakers**. The speaker test tries Kokoro first;
   an explicitly local browser voice is only the fallback.
3. If the local service is not ready, check the startup lines marked
   `[local-voice]`, `SUPPER_PYTHON`, the installed requirements, and the Kokoro
   files. The service health endpoint is proxied through `/api/system-status`.
4. Microphone access requires a secure page (`https://` or localhost) and browser
   permission. In an embedded preview that forbids microphone access, open the
   dashboard in its own tab.

Automated tests use fakes. They do not test a physical microphone, speaker,
installed browser voice, or downloaded local model; verify those on the computer
where JARVIS runs.
