"""My Hands: hand-gesture control for the Supper AI Agent glass UI.

Original code, written from docs/MYHANDS_SPEC.md. See docs/MYHANDS_CLEAN_ROOM.md.

  filters.py   One Euro filter (cursor smoothing)
  gestures.py  pure gesture engine: pinch, grab, drag, release, tracking loss
  camera.py    single camera owner with explicit states and bounded retries
  tracker.py   MediaPipe Hands adapter (imported lazily)
  session.py   worker thread: camera -> tracker -> engine -> event log

Nothing here imports OpenCV or MediaPipe at import time.
"""
