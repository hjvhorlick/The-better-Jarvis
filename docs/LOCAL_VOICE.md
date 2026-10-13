# JARVIS's voice

## Read this first: there are two machines

The dashboard is a web page, and a web page runs in a browser on some machine.
`local_voice/service.py` runs on the machine where `npm start` was typed. Two
cases, and they are not the same thing:

- **Same machine** (you started JARVIS yourself and opened `http://localhost:3000`).
  Both engines work. Use whichever voice you prefer.
- **Different machines** (a preview, a remote box, JARVIS on a home server and you
  on a laptop). The server's speakers are in the other room. A reply "spoken" by
  `service.py` plays into an empty room and you hear silence — while the app
  cheerfully reports success. This is why the browser's own voice leads.

So the dashboard has two engines for each direction:

| | This browser (default) | This computer (the server) |
|---|---|---|
| Speaking | Web Speech API — free, offline, no models, speaks on *your* machine | Kokoro in `local_voice/service.py` → the server's speakers |
| Hearing | `SpeechRecognition` — no models, built into Chrome/Edge/Safari | raw audio → server → faster-whisper |

**Auto** (Settings → Voice) means: prefer this browser, fall back to this
computer, and if both fail say plainly what each one said. **Gemini** is used only
for answers (text). It never makes or hears the voice.

The rest of this file is about the *server* engine — what to install for it, and
what it does. You do not need any of it for the browser engine, which is why the
voice works out of the box.

## Setup for the server engine (once)

1. `pip install -r backend/requirements-local-voice.txt`
2. Put the two Kokoro files in `models/kokoro/`:
   - `kokoro-v1.0.onnx`
   - `voices-v1.0.bin`
   Both are on the kokoro-onnx release page, `https://github.com/thewh1teagle/kokoro-onnx/releases` (release `model-files-v1.0`).
3. If the Python that has these packages is not `python3` (or `python` on Windows), start JARVIS with `SUPPER_PYTHON=/path/to/python`.
4. Start JARVIS (`npm start`). The voice service starts with it.

## When the voice fails: one place to look

Settings → Voice prints what is really in use, and every voice message goes to the
server console, marked `[local-voice]`. The green bar above the chat shows the
problem in one line. Common causes:

- `The Kokoro voice files are missing` — the two files are not in `models/kokoro/`.
- `sounddevice is not installed` / `speakers could not play` — install the requirements; check the output device.
- `numpy is not installed for this Python` — the service is up and answering, but the
  Python it was started with does not have the requirements. **The service now starts
  and says this** instead of dying at import, so the cause is never guessed at: the
  dashboard shows the same sentence in Settings → Voice.
- `The local voice is not answering` — the service did not start at all; look at the
  `[local-voice]` lines at startup.
- **You hear nothing, but the app says the server spoke.** The server spoke — into the
  speakers of the machine it runs on. You are sitting at a different machine. Set
  Voice engine to *Auto* so your own browser speaks.

---

# Local voice: setup and what it does

Status: built and tested with fake speech engines. The real microphone, speaker and speech models
were **not** run in the build environment (it has no audio device and cannot download the models).
Please run the check list at the end on your own computer.

## What runs where

| Step | Local (this computer) | Gemini |
|---|---|---|
| Hearing you | yes: the browser's own recogniser, or faster-whisper on the server | never |
| Finding the answer | yes: commands, your stored facts, the local answers in `runtime/knowledge.json`, the time and status readings | only if nothing local can answer, and only after the daily budget takes a unit |
| Speaking the reply | yes: this computer's own browser voice, or the Kokoro voice when its files are present | never |

The old voice path (Gemini Live) is still in the code. It runs only if you set
`SUPPER_VOICE_ENGINE=live`. The default is `local`.

## Install (once)

1. In the project folder, with the virtual environment active:

   ```
   pip install -r backend/requirements-local-voice.txt
   ```

2. Linux only, for the computer's own voice (skip this if you use Kokoro):

   ```
   sudo apt install espeak-ng
   ```

3. First use: the speech model downloads once from Hugging Face (the default `base` size).
   This needs the internet once. After that the speech model runs offline.

## The better voice (optional, recommended)

Kokoro sounds much more natural than the computer's own voice on Linux. Its model files are
large and are not in the repository. Put two files in `models/kokoro/`:

- `kokoro-v1.0.onnx` (the voice model)
- `voices-v1.0.bin` (the voices)

Both come from the kokoro-onnx project's release page at
`https://github.com/thewh1teagle/kokoro-onnx/releases` (release `model-files-v1.0`).
The model weights are Apache-2.0 according to the Kokoro-82M model card. If the release page lists
checksums, compare them with your downloads. If the files are present,
the app uses Kokoro automatically; otherwise it uses the computer's own voice.

## Wake word: "Hey Jarvis" (the normal way to start)

You can start a conversation by saying "Hey Jarvis", without pressing anything. This is the default.

1. Install the packages (the step above includes `openwakeword`).
2. The model is already in the project, in `backend/voice/wake_models/`. Nothing to download. To check it:

   ```
   python tools/check_wake_model.py
   ```

   It prints the licence and checks each file. The model is CC BY-NC-SA 4.0: non-commercial use, share-alike,
   attribution. See `backend/voice/wake_models/NOTICE.md`. The project's own licence does not cover these files.
3. Restart the app. It starts listening for "Hey Jarvis" by itself.

**The microphone is open while the app runs and wake listening is on.** That is the default. While it listens,
audio is scored on this computer only. Nothing is sent anywhere until the wake word is heard. Then a local
voice conversation starts. It ends after about a minute with no speech, and listening for "Hey Jarvis" carries on.

- Turn it off: say or type "stop wake word", or start the app with `SUPPER_WAKE_WORD=off`.
- Turn it on again: say or type "turn on the wake word" (it asks for your OK first).
- If a model file is missing or does not match its checksum, wake word stays off and the status panel says why.
  Copy the `wake_models` folder from the project again.

## Settings (environment variables, all optional)

| Name | Default | Meaning |
|---|---|---|
| `SUPPER_VOICE_ENGINE` | `local` | `local` or `live` (Gemini Live) |
| `SUPPER_STT_MODEL` | `base` | speech model size: `tiny`, `base`, `small` (more accurate, slower), `medium` |
| `SUPPER_STT_LANGUAGE` | `en` | language code; empty means detect |
| `SUPPER_TTS_ENGINE` | `auto` | `auto`, `kokoro`, `system`, or `off` (no spoken replies; text only) |
| `SUPPER_TTS_VOICE` | `af_heart` | Kokoro voice name |
| `SUPPER_VOICE_IDLE_S` | `60` | seconds without speech before the session stops |
| `SUPPER_WAKE_WORD` | `on` | `on` listens for "Hey Jarvis" at start-up once the model is installed; `off` does not |

## How a turn works

1. The microphone is open while Voice is on. Speech is detected by its level.
2. When you pause for about 0.8 seconds, the phrase is sent to the speech model on this computer.
3. The text goes to the same agent as typed chat: commands first, then stored answers, then Gemini last.
4. The reply appears in the chat and is spoken.
5. While the reply is spoken, the microphone is ignored, so the assistant does not hear itself.
6. If you talk over the reply, it stops at once and your words are heard.

## Limits to know about

- There is **no echo cancellation**. Use headphones, or the talk-over feature may trigger on the
  assistant's own voice.
- Accuracy depends on the microphone and the speech model size. `base` is quick and fairly good
  for short commands; `small` is better for longer speech.
- Replies longer than about 1,200 characters are cut short when spoken. The whole text stays in the chat.
- The wake word has been tested on synthesized speech, not on a real microphone. The model itself is bundled and checked by checksum.
- The microphone is open while wake listening is on, which is the normal state once the model is installed. The status panel shows it.

## If voice does not work: the audio test (added 2026-10-10)

When voice seems dead — nothing happens, no error — run the audio test first. It plays a short
beep (the speaker must be heard), listens to the microphone for a few seconds (speak normally),
measures the level against the speech threshold, and reports each part in plain language.

Three ways to run it, all on this computer, nothing sent anywhere:

1. **In the app:** press **Test audio**, next to the Voice button.
2. **In the chat:** type `test the sound` (also `check the mic`, `test the speakers`).
3. **Without the app:** from the project folder,
   `.venv\Scripts\python tools\check_voice.py` (Windows) or
   `.venv/bin/python tools/check_voice.py` (Linux/macOS).

How to read the result:

- **✗ sound system** — the audio packages are missing. Install
  `backend/requirements-voice.txt` (on Linux also `libportaudio2`). The starter scripts do
  this; if it still fails, the install itself failed — run the starter again and read its output.
- **✗ speaker / no beep heard** — wrong output device or volume. The line names the system
  default device; change it in the system sound settings.
- **✗ microphone, "no audio arrived"** — the OS is not giving Python the microphone. On
  Windows: Settings → Privacy & security → Microphone → allow desktop apps.
- **✗ microphone, "heard only silence"** — the mic works but is too quiet for speech
  detection (level shown in the line). Raise the input level in the system sound settings, or
  pick another microphone with `SUPPER_MIC_DEVICE`.
- **✗ speech to text / spoken replies / wake word** — the named package or model is missing;
  the line says which file to install from.

Since the same change, a wake word that cannot start no longer fails silently: the reason shows
in the voice status chip ("voice off · wake word is not listening: …") and in Diagnostics.

## Check list for you (about 10 minutes)

**First, with nothing installed at all** — this is the part that works everywhere:

1. Start the app and open the dashboard. Click once anywhere on the page (browsers
   will not play sound until you do). You should hear "Voice online, sir." out of
   your own computer's speakers. Settings → Voice reads *Speaking: this browser —
   <a voice name>*.
2. Allow the microphone when the browser asks, then say "what time is it". The
   green bar shows the live words as you speak, and the answer is spoken back.
   Nothing was installed and nothing was downloaded to get this far.
3. Ask a question with a starter answer, for example "how do I undo my last git
   commit". It should answer from the local store, with the note "please check".
4. Say "learn: what is our office wifi = …", then ask "what is our office wifi".
   It should answer from the store.
5. Talk over a long reply. It should stop, and your next sentence should be heard.
6. Press 🔇 Mute. The microphone light goes off — including the browser's own ear,
   which is released rather than left holding the microphone. Unmute to continue.

**Then, for the server engine (optional):**

7. Install as above. Restart JARVIS. Settings → Voice should now read *This
   computer's voice service: ready*. If it does not, that line says why — almost
   always a missing package or a missing model file, named exactly.
8. Switch Voice engine to *This computer* and press 🔊 Test Speakers. You hear it
   **only if JARVIS runs on this same machine**; you sitting at a different machine
   is the whole reason the browser engine leads. Either way the panel tells you
   what happened instead of claiming success.
9. Switch back to *Auto*. Say "what time is it" and confirm the answer is still
   spoken — now by the fallback order you chose.

If something does not work, tell me what you saw (the message in the chat, and which step failed).
Nothing needs to be changed in the code for these checks.
