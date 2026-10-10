"""Hand tracking via MediaPipe Hands (Apache-2.0). Imported lazily.

Runs entirely on this machine: the model files ship inside the mediapipe
package, so no network access is needed at run time.
"""
from __future__ import annotations

from .gestures import Observation


class MediaPipeHandTracker:
    def __init__(self, max_hands: int = 2, min_detection: float = 0.6, min_tracking: float = 0.5) -> None:
        import mediapipe as mp  # heavy import: only when tracking actually starts
        self._hands = mp.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=max_hands,
            min_detection_confidence=min_detection,
            min_tracking_confidence=min_tracking,
        )

    def process(self, frame_bgr) -> list[Observation]:
        import numpy as np
        rgb = np.ascontiguousarray(frame_bgr[:, :, ::-1])
        result = self._hands.process(rgb)
        out: list[Observation] = []
        if not result.multi_hand_landmarks:
            return out
        for i, hand in enumerate(result.multi_hand_landmarks):
            score = 0.0
            label = ""
            if result.multi_handedness and i < len(result.multi_handedness):
                cls = result.multi_handedness[i].classification[0]
                score = float(cls.score)
                # Left or Right: this is what keeps two hands distinct from
                # frame to frame, which two-hand gestures depend on.
                label = str(cls.label or "")
            pts = tuple((p.x, p.y, p.z) for p in hand.landmark)
            out.append(Observation(landmarks=pts, score=score, label=label))
        return out

    def close(self) -> None:
        try:
            self._hands.close()
        except Exception:
            pass
