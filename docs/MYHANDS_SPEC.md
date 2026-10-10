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
- **HandFrame** (`myhands/handframe.py`): the whole hand read at once. From all 21 landmarks it derives the palm **centre** (their mean), the palm **normal** (the cross product of wrist→index-base and wrist→pinky-base, so it points out of the palm), the wrist→middle-base **direction**, the 3D **scale**, a **curl** per finger (the angle at the middle joint: 180° straight → 0, 40° folded → 1), the fingertip **spread**, the wrist **depth** (z) and how much depth varies across the hand.
- **Why the whole hand:** anticipation is easier to read from more points. A fist is four fingers closing together, not one gap between two fingertips; a turn is the palm facing a new way, which no fingertip distance can express; a pull toward the camera is only distinguishable from a sideways slide by z. Reading two fingertips throws away 19 of the 21 landmarks and the whole of depth, and with them every gesture that is not a pinch.
- **Palm distance:** the 3D distance between two hands' palm centres. Used for scaling, so hands that move toward the camera without moving across the image still read as coming closer.
- **Hand label:** MediaPipe reports each hand as `Left` or `Right`. This is what keeps two hands distinct from frame to frame; without it, two hands crossing over would be read as one hand jumping.
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
| Hands tracked at once | 2 | Two-hand gestures need both. |
| Fist starts when fist value ≥ | 0.74 | All four fingers curled together: a firm grasp of something too big to pinch. The thumb is excluded, so a thumb alone never makes a fist. |
| Fist ends when fist value ≤ | 0.46 | Hysteresis, as with the pinch. |
| Fist must hold for | 90 ms | Rejects a twitch. |
| Hold-still radius | 0.022 of the stage | The palm may wander this far and still count as still. Measured from where the stillness *began*, not from the last frame, so a hand drifting slowly across the screen is still a moving hand. |
| Hold-still time | 1.0 s | Hold your hand in place this long and what you are holding starts to turn. |
| Turn rate | at most 30 per second | Turns are reported as deltas of the palm's tilt, so the browser applies the total, not a guess. |
| Clap: palms closer than | 0.30 (3D) | And closing at 1.10 per second or faster. |
| Clap cooldown | 700 ms | One clap per gesture, not a machine gun. |
| Claw starts when claw value ≥ | 0.30 | Half-curled **and** spread: a claw, not a fist. A flat hand and a closed fist both read 0. |
| Pull rate | at most 30 per second | Reported as a change in depth, because that is what a pull is. |

## 5. State machine

Pinch: `OPEN → CANDIDATE → PINCHED → RELEASING → OPEN`.

- `OPEN → CANDIDATE` when ratio < start threshold.
- `CANDIDATE → OPEN` if the ratio rises again before the hold time (no event).
- `CANDIDATE → PINCHED` after the hold time. Emit `pinch_started`. Hit-test the cursor: if an object is under it (topmost first), emit `object_grabbed`.
- `PINCHED → RELEASING` when ratio > end threshold. While grabbed, the object follows the cursor.
- `RELEASING → PINCHED` if the ratio falls again before the release hold time.
- `RELEASING → OPEN` after the release hold time. Emit `object_released` (reason `release`) and `pinch_released`.

Fist: `OPEN → CLOSING → CLOSED → OPEN`. `CLOSING` cancels silently if the hand opens again; `CLOSED` ends when the hand opens. Independent of the pinch, so both can be live.

Turn: `IDLE → STILL → TURNING`. Only runs while something is actually held (a pinch or a fist). `STILL` accumulates only while the palm centre stays inside the radius; any larger move voids the stillness so far and restarts it. `TURNING` reports `rotate_delta` until the grab ends or the hand moves.

Scale: two hands present → `base` is set from the first frame's 3D palm distance; every later frame reports `factor = gap / base`. Ends when either hand leaves.

Clap: needs two hands. Fires when the gap is closing fast enough and is already small, then cools down. A single clap, not a repeat.

Claw: `OPEN → CLAWED → PULLING → OPEN`. `PULLING` reports `pull_delta` — a change in depth, which is the one thing that separates pulling toward you from sliding sideways.

Each gesture is its own small state machine, so adding one never changes how another behaves. Stopping the session, losing tracking or losing the camera puts them all back to rest, reporting what was live.

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
| `fist_started` | `x`, `y`, `strength` | The whole hand closed. `x`/`y` are the palm centre on the stage. |
| `fist_released` | — | The hand opened again. |
| `rotate_started` | — | The hand has been held still long enough; turning is live. |
| `rotate_delta` | `yaw`, `pitch` | How far the palm has tilted since the last report. Throttled. |
| `rotate_ended` | `reason` (`released`, `moved`, `tracking_lost`, `session_stopped`, `camera_failed`) | Turning stopped. |
| `scale_started` | `factor` | Two hands seen; scaling is live. |
| `scale_delta` | `factor` | Current scale relative to where the two hands started. Throttled. |
| `scale_ended` | `reason` (`hand_left`, `tracking_lost`, `session_stopped`, `camera_failed`) | Scaling stopped. |
| `clap` | `x`, `y` | Palms came together fast. Centre it. |
| `pull_started` | `z` | A claw is established; pulling is live. |
| `pull_delta` | `dx`, `dy`, `dz` | How far the palm has moved since the pull began. `dz` is the depth change. Throttled. |
| `pull_ended` | — | The hand opened. |

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

Learned prediction of intent, and any use of the third-party project's code, text
or media assets (see `docs/MYHANDS_CLEAN_ROOM.md` and `THIRD_PARTY_NOTICES.md`).

Two-hand gestures, claw and clap, and 3D rotation were listed here before. They are
now built: `myhands/handframe.py` reads the whole hand and `myhands/gestures.py`
turns it into the six gestures above. What is **not** yet done is tuning them on
the owner's real hands and a real camera — the numbers in §4 are starting values,
measured against synthetic hands, and every one of them must be re-measured before
anyone calls this finished.
