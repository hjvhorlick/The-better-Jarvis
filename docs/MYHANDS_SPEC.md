# My Hands — specification (original design)

Status: **specification for a new implementation. Not verified on real hands yet.**
This document is written from the owner's requirements and from first principles.
It is the only input to the implementation in `myhands/`.

## 1. Purpose

My Hands lets the owner point, pinch, grab, drag and release the folders and files that
JARVIS shows on its glass desktop, using the camera. It is part of the JARVIS backend
(one process owns the camera) and its events go to the same browser UI.

## 2. Requirements

1. Pinch to grab an item under the hand cursor; move the hand to drag it; open the hand to release it.
2. A grabbed item must never stay grabbed when tracking is lost, the camera fails, or the session stops.
3. Short tracking dropouts must not drop a grab. Accidental pinches must not start a grab.
4. Every state change is an event with a reason, so the UI and the assistant can react to it.
5. The camera has one owner, shows its state, and stops on request or after an inactivity timeout.
6. Nothing is sent to any cloud service by this module. Hand tracking runs locally.
7. Clear state for each part: camera, tracking, hand presence, and grab.

## 3. Concepts

- **Observation:** one tracked hand in one frame: 21 landmarks (normalised x, y, z in the camera image) and a handedness confidence score.
- **Cursor:** the index fingertip, mirrored horizontally for a front-facing camera, mapped through an optional calibration rectangle to stage coordinates (0–1 each axis), then smoothed.
- **Hand scale:** distance from the wrist to the middle-finger base. Used to make pinch distance independent of how far the hand is from the camera.
- **Pinch ratio:** thumb-tip to index-tip distance divided by hand scale.
- **Scene object:** a rectangle on the stage with an id, position, size and stacking order.

## 4. Gesture rules (starting values; all must be tuned on the owner's hands)

| Rule | Value (start) | Why |
|---|---|---|
| Minimum hand confidence | 0.6 | Below this, the frame counts as "no hand". |
| Pinch starts when ratio < | 0.30 | Thumb and index nearly touching. |
| Pinch ends when ratio > | 0.45 | Hysteresis: a wider gap than the start threshold, so the state does not flicker. |
| Pinch must hold for | 120 ms | Rejects accidental touches. |
| Release must hold for | 80 ms | Rejects a single noisy frame. |
| Tracking-loss grace | 300 ms | A dropout shorter than this keeps the grab. |
| Cursor smoothing | One Euro filter, min cutoff 1.2 Hz, beta 0.01, derivative cutoff 1.0 Hz | Reduces jitter while keeping fast moves responsive. |
| Event rate for moves | at most 30 per second | Keeps the browser light. The final position is always sent. |

## 5. State machine

Pinch: `OPEN → CANDIDATE → PINCHED → RELEASING → OPEN`.

- `OPEN → CANDIDATE` when ratio < start threshold.
- `CANDIDATE → OPEN` if the ratio rises again before the hold time (no event).
- `CANDIDATE → PINCHED` after the hold time. Emit `pinch_started`. Hit-test the cursor: if an object is under it (topmost first), emit `object_grabbed`.
- `PINCHED → RELEASING` when ratio > end threshold. While grabbed, the object follows the cursor.
- `RELEASING → PINCHED` if the ratio falls again before the release hold time.
- `RELEASING → OPEN` after the release hold time. Emit `object_released` (reason `release`) and `pinch_released`.

Tracking: `NO_HAND → HAND`, and `HAND → NO_HAND` only after the grace period.
Leaving `HAND` ends any pinch and any grab with reason `tracking_lost`.

## 6. Events

Each event: `{"type": ..., "t": <seconds>, ...}`.

| Type | Fields | Meaning |
|---|---|---|
| `hand_detected` | — | A confident hand appeared. |
| `hand_lost` | — | No confident hand for longer than the grace period. |
| `cursor_moved` | `x`, `y` | Smoothed cursor, stage coordinates. Throttled. |
| `confidence_changed` | `score`, `level` (`high`/`low`) | Hand confidence crossed the minimum. |
| `pinch_started` | `x`, `y` | Pinch confirmed. |
| `pinch_released` | — | Pinch ended. |
| `object_grabbed` | `id`, `x`, `y` | Object picked up. |
| `object_dragged` | `id`, `x`, `y` | Object moved (throttled; final position always sent). |
| `object_released` | `id`, `x`, `y`, `reason` (`release`, `tracking_lost`, `session_stopped`, `camera_failed`) | Object let go. |
| `tracking_unavailable` | `reason` | The camera is not delivering frames. |
| `auto_off` | — | The session stopped after the inactivity timeout. |

## 7. Camera service

States: `not_initialized`, `connecting`, `active`, `interrupted`, `reconnecting`,
`device_unavailable`, `error`, `stopped`.

- One capture handle, owned by the service. No other code opens the camera.
- A frame older than 2 s counts as a stall → `interrupted` → bounded reconnects with
  back-off (0.5 s, 1 s, 2 s, 4 s, 8 s), at most 5 per outage. After that → `error` with a message.
- Opening fails 3 times in a row at start → `device_unavailable` with a message
  (the message says to check that the camera is free and, on Linux, that the user is in the `video` group).
- Stopping releases the capture handle exactly once.

## 8. Session, privacy and safety

- The session starts only on an explicit request. The status shows `camera: on` while it runs.
- Idle timeout: if no confident hand is seen for 10 minutes, the session stops with `auto_off`.
- Every stop path (user, timeout, camera failure, process exit) releases any grab first.
- Frames are not stored and are not sent off the machine.

## 9. Calibration

The camera image can be mapped to the stage through a rectangle (`cx0, cy0, cx1, cy1`) so the owner can use a corner of the camera view. Default: the full frame.

## 10. Success criteria (to be measured, not assumed)

- Pinch-grab-drag-release works on the owner's hands in the owner's lighting.
- False pinches while typing or gesturing without intent: measured per hour, target agreed with the owner.
- Grab never persists after tracking loss in tests and in a manual test with the hand removed mid-drag.
- Camera stall or unplug leads to a visible state and a release, never a silent freeze.

## 11. Out of scope for this version

Two-hand gestures, claw/clap/extended poses, 3D rotation, learned prediction of intent,
and any use of barehands' code, text, or media assets.
