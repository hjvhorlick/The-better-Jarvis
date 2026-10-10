"""One Euro filter (Casiez, Roussel, Vogel — CHI 2012).

A low-pass filter whose cutoff rises with speed: slow motion is smoothed
heavily (less jitter), fast motion passes through (less lag). Implemented from
the published formula.
"""
from __future__ import annotations

import math


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class LowPass:
    def __init__(self) -> None:
        self.value: float | None = None

    def apply(self, x: float, alpha: float) -> float:
        if self.value is None:
            self.value = x
        else:
            self.value = alpha * x + (1.0 - alpha) * self.value
        return self.value


class OneEuroFilter:
    def __init__(self, min_cutoff: float = 1.2, beta: float = 0.01, d_cutoff: float = 1.0) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x = LowPass()
        self._dx = LowPass()
        self._last_t: float | None = None

    def reset(self) -> None:
        self._x = LowPass()
        self._dx = LowPass()
        self._last_t = None

    def apply(self, x: float, t: float) -> float:
        if self._last_t is None or t <= self._last_t:
            self._last_t = t
            self._x.value = x
            self._dx.value = 0.0
            return x
        dt = t - self._last_t
        self._last_t = t
        prev = self._x.value if self._x.value is not None else x
        dx = (x - prev) / dt
        edx = self._dx.apply(dx, _alpha(self.d_cutoff, dt))
        cutoff = self.min_cutoff + self.beta * abs(edx)
        return self._x.apply(x, _alpha(cutoff, dt))
