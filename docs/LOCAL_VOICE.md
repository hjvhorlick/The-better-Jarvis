# Local voice: setup and what it does

Status: built and tested with fake speech engines. The real microphone, speaker and speech models
were **not** run in the build environment (it has no audio device and cannot download the models).
Please run the check list at the end on your own computer.

## What runs where

| Step | Local (this computer) | Gemini |
|---|---|---|
| Hearing you | yes: faster-whisper, after a one-time model download | never |
| Finding the answer | yes: commands, your stored facts, the local answers in `runtime/knowledge.json`, the time and status readings | only if nothing local can answer, and only after the daily budget takes a unit |
| Speaking the reply | yes: the Kokoro voice if its files are present, otherwise this computer's own voice | never |

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

## Check list for you (about 10 minutes)

1. Install as above. Start the app. Check that the Voice status says the speech engine is ready.
2. Press Voice. Say "what time is it". You should hear the time, with no Gemini call.
3. Ask a question with a starter answer, for example "how do I undo my last git commit". It should
   answer from the local store, with the note "please check".
4. Say "learn: what is our office wifi = …", then ask "what is our office wifi". It should answer
   from the store.
5. Talk over a long reply. It should stop, and your next sentence should be heard.
6. Say "Hey Jarvis" (after the model is downloaded). The status should show wake listening, and a conversation should start.
7. Say "stop wake word". The microphone should close.
8. Turn Voice off. The microphone light should go off.

If something does not work, tell me what you saw (the message in the chat, and which step failed).
Nothing needs to be changed in the code for these checks.
