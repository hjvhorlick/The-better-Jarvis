"""Server-side voice (V2-3): microphone and speaker owners, Gemini Live relay, wake word.

Modules
  audio.py       Microphone and Speaker device owners (sounddevice, opened only on lease)
  vad.py         energy-based speech detection (barge-in)
  wake.py        wake-word detector interface and openWakeWord adapter (model files bundled in wake_models/)
  live.py        Gemini Live relay (audio up, replies down, transcripts to the bus)
  controller.py  state: Live on/off, wake on/off, mute, idle stop, barge-in
  factory.py     builds the real controller
  api.py         /api/voice/* routes

Everything runs in this process on this computer. The browser only shows state and
sends commands. The Gemini key never leaves the server.
"""
