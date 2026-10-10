"""Energy-based voice activity detection on 16-bit PCM frames.

Speech starts after `attack_frames` loud frames in a row, and ends after the level has
stayed below the lower threshold for `hangover_frames` frames. The two thresholds form a
hysteresis band, so the state does not flicker when the level hovers near one value.

Used for barge-in (the owner talks over the assistant). It is not a wake word and not
a recogniser. It only answers "is someone speaking now?".

Provenance: standard energy-threshold VAD with hysteresis and hangover, written for this
project. No code taken from other projects.
"""
from __future__ import annotations

import array
import math


def frame_rms(frame: bytes) -> float:
    """Root-mean-square level of 16-bit little-endian PCM."""
    samples = array.array("h")
    samples.frombytes(frame[: len(frame) - (len(frame) % 2)])
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class EnergyVAD:
    def __init__(self, on_threshold: float = 500.0, off_threshold: float = 300.0,
                 attack_frames: int = 3, hangover_frames: int = 10) -> None:
        if off_threshold > on_threshold:
            raise ValueError("off_threshold must not be above on_threshold")
        self._on = float(on_threshold)
        self._off = float(off_threshold)
        self._attack = max(1, int(attack_frames))
        self._hangover = max(1, int(hangover_frames))
        self._loud = 0
        self._hold = 0
        self.speaking = False

    def process(self, frame: bytes) -> bool:
        level = frame_rms(frame)
        if not self.speaking:
            if level >= self._on:
                self._loud += 1
                if self._loud >= self._attack:
                    self.speaking = True
                    self._hold = self._hangover
            else:
                self._loud = 0
        else:
            if level >= self._off:
                self._hold = self._hangover
            else:
                self._hold -= 1
                if self._hold <= 0:
                    self.speaking = False
                    self._loud = 0
        return self.speaking

    def reset(self) -> None:
        self._loud = 0
        self._hold = 0
        self.speaking = False
