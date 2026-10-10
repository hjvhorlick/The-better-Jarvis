# Wake-word model files: notice

These files are bundled so that "Hey Jarvis" works without a download (owner decision 7, 2026-10-10).
They are NOT covered by the project's own licence (CC BY-NC 4.0, see `LICENSE`).

| File | What it is | SHA-256 |
|---|---|---|
| `hey_jarvis_v0.1.onnx` | "Hey Jarvis" detector | `94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb` |
| `melspectrogram.onnx` | shared audio feature model (mel spectrogram) | `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f` |
| `embedding_model.onnx` | shared audio feature model (speech embedding) | `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f` |

**Source:** openWakeWord, release v0.5.1, by David Scripka and contributors
(https://github.com/dscripka/openWakeWord). The files are byte-identical to the Git LFS objects recorded
in that release's source archive (`openwakeword/resources/models/`). They were taken from the npm package
`openwakeword-wasm-browser` 0.1.1, whose copies match those objects. That package's own code is MIT and is
not used here.

**Licence:** Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0),
https://creativecommons.org/licenses/by-nc-sa/4.0/. openWakeWord's README says all of its pre-trained models
are under this licence, because some training data has restrictive terms. Its code is Apache-2.0.

What this means in plain terms:

- Non-commercial use only for these files.
- Attribution: keep this notice and the source above.
- Share-alike: if you pass these files on, pass them on under CC BY-NC-SA 4.0 (or a compatible licence).
- Changing the model is a derivative; the same terms apply.

This is a summary, not legal advice. The owner should check it if the project is ever used commercially.

**Not used:** `silero_vad.onnx` (voice activity, from the same release) is not bundled, because the adapter
does not use it.

The three files are checked by `tools/check_wake_model.py` and by `backend/voice/wake.py` before wake word starts.
