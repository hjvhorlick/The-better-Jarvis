"""Wake-word detection on the server ("Hey Jarvis").

The detector runs on this computer only. Audio is scored locally and is never sent
anywhere until the wake word is heard. That is the privacy rule of wake mode.

The detector is an interface (`feed(frame) -> bool`). The shipped adapter wraps the
openWakeWord package, which is imported only when wake mode is switched on.

Model files (decision 7, 2026-10-10, owner): the three ONNX files the adapter needs are
BUNDLED in `backend/voice/wake_models/`. They are the upstream openWakeWord v0.5.1 files,
checked by SHA-256 below. Their licence is CC BY-NC-SA 4.0 (see `wake_models/NOTICE.md`),
which is separate from the project's CC BY-NC 4.0 licence. If a bundled file is missing or
does not match its checksum, wake mode stays off and says why. As a fallback, files that
the openWakeWord package has in its own folder are used.

Provenance: the adapter is written for this project. No code taken from openWakeWord.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

WAKE_MODEL = "hey_jarvis"
WAKE_MODEL_FILE = "hey_jarvis_v0.1.onnx"
DEFAULT_THRESHOLD = 0.5
SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280            # 80 ms at 16 kHz, the detector's native frame

# Folder with the bundled model files (next to this module).
MODEL_DIR = Path(__file__).resolve().parent / "wake_models"

# Files the adapter loads (inference_framework="onnx") and their expected SHA-256.
# The values are the upstream openWakeWord v0.5.1 files (checked against the Git LFS
# pointers in that release's source archive, 2026-10-10).
BUNDLED_SHA256 = {
    WAKE_MODEL_FILE: "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
    "melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
}
FEATURE_MODELS = ("melspectrogram.onnx", "embedding_model.onnx")

_verified: dict[tuple, bool] = {}   # (path, size, mtime) -> checksum matched


class NullDetector:
    """Never fires. Used where wake mode is off or when testing other parts."""

    def feed(self, frame: bytes) -> bool:
        return False

    def close(self) -> None:
        pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _bundled_ok(path: Path, expected: str) -> bool:
    """True when the file matches its checksum. Cached until the file changes."""
    st = path.stat()
    key = (str(path), st.st_size, st.st_mtime_ns, expected)
    if key not in _verified:
        _verified[key] = _sha256(path) == expected
    return _verified[key]


def _package_models_dir() -> Path | None:
    spec = importlib.util.find_spec("openwakeword")
    if spec is None or not spec.origin:
        return None
    return Path(spec.origin).resolve().parent / "resources" / "models"


def model_path(name: str) -> Path | None:
    """Where a model file is, or None. Bundled copy first, then the openWakeWord package folder."""
    bundled = MODEL_DIR / name
    if bundled.is_file():
        return bundled
    pkg = _package_models_dir()
    if pkg is not None and (pkg / name).is_file():
        return pkg / name
    return None


def availability() -> tuple[bool, str]:
    """(ready, reason). Cheap enough for status checks: files, and checksums of bundled files."""
    spec = importlib.util.find_spec("openwakeword")
    if spec is None:
        return False, "wake word package not installed (see backend/requirements-voice.txt)"
    if not spec.origin:
        return False, "wake word package could not be inspected"
    missing = []
    for name in (WAKE_MODEL_FILE, *FEATURE_MODELS):
        path = model_path(name)
        if path is None:
            missing.append(name if name != WAKE_MODEL_FILE else f"{WAKE_MODEL}*.onnx")
            continue
        if path.parent == MODEL_DIR and not _bundled_ok(path, BUNDLED_SHA256[name]):
            return False, (f"wake word file {name} does not match its checksum; "
                           "copy the wake_models folder from the project again")
    if missing:
        return False, f"wake word model not downloaded yet (missing: {', '.join(missing)})"
    return True, "ready"


class OpenWakeWordDetector:
    def __init__(self, threshold: float = DEFAULT_THRESHOLD, model_factory=None) -> None:
        self._threshold = float(threshold)
        self._factory = model_factory or _load_model
        self._model = None
        self._pending = bytearray()
        self._closed = False

    def _ensure(self):
        if self._model is None:
            self._model = self._factory()
        return self._model

    def feed(self, frame: bytes) -> bool:
        if self._closed:                       # a late frame after close must not reload the model
            return False
        self._pending.extend(frame)
        need = CHUNK_SAMPLES * 2
        fired = False
        while len(self._pending) >= need:
            chunk = bytes(self._pending[:need])
            del self._pending[:need]
            if self._score(chunk) >= self._threshold:
                fired = True
                self._pending.clear()
                break
        return fired

    def _score(self, chunk: bytes) -> float:
        import numpy as np
        model = self._ensure()
        scores = model.predict(np.frombuffer(chunk, dtype=np.int16))
        best = 0.0
        for name, value in scores.items():
            if str(name).startswith(WAKE_MODEL):
                best = max(best, float(value))
        return best

    def close(self) -> None:
        self._closed = True
        self._model = None
        self._pending.clear()


def _load_model():
    from openwakeword.model import Model
    wake_path = model_path(WAKE_MODEL_FILE)
    melspec = model_path("melspectrogram.onnx")
    embedding = model_path("embedding_model.onnx")
    if wake_path is None or melspec is None or embedding is None:
        raise RuntimeError("wake word model files are missing")
    return Model(
        wakeword_models=[str(wake_path)],
        inference_framework="onnx",
        melspec_model_path=str(melspec),
        embedding_model_path=str(embedding),
    )
