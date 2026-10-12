/* JARVIS browser hand-gesture engine.
 *
 * The dashboard's MediaPipe feed and the Python My Hands engine read the same
 * 21-point hand model. Keep the geometry and state-machine thresholds in sync
 * with myhands/handframe.py and myhands/gestures.py. This file is deliberately
 * dependency-free so it can be tested without a camera or browser.
 */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JarvisHandGestures = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const FOUR_FINGERS = [
    [5, 6, 8],    // index
    [9, 10, 12],  // middle
    [13, 14, 16], // ring
    [17, 18, 20], // pinky
  ];

  const DEFAULTS = Object.freeze({
    pinchOn: 0.30,
    pinchOff: 0.45,
    pinchHoldMs: 25,
    releaseHoldMs: 80,
    fistOn: 0.74,
    fistOff: 0.46,
    fistHoldMs: 90,
    stillRadius: 0.022,
    stillMs: 1000,
    rotateHz: 30,
    scaleHz: 30,
    clapGap: 0.30,
    clapSpeed: 1.10,
    clapCooldownMs: 700,
    clawOn: 0.30,
    clawOff: 0.14,
    clawHoldMs: 120,
    pullHz: 30,
    cursorHz: 30,
  });

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const unit = (v) => {
    const n = norm(v);
    return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
  };

  function pointOf(raw) {
    if (Array.isArray(raw)) {
      return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0];
    }
    return [Number(raw && raw.x) || 0, Number(raw && raw.y) || 0, Number(raw && raw.z) || 0];
  }

  function angleAt(joint, base, tip) {
    const a = unit(sub(base, joint));
    const b = unit(sub(tip, joint));
    if (norm(a) <= 1e-9 || norm(b) <= 1e-9) return 180;
    return Math.acos(clamp(dot(a, b), -1, 1)) * 180 / Math.PI;
  }

  /** Map one camera landmark to the viewport using the video's CSS object-fit:cover crop. */
  function mapToCover(rawPoint, videoWidth, videoHeight, viewWidth, viewHeight, mirror = true) {
    const vw = Math.max(1, Number(videoWidth) || Number(viewWidth) || 1);
    const vh = Math.max(1, Number(videoHeight) || Number(viewHeight) || 1);
    const sw = Math.max(1, Number(viewWidth) || 1);
    const sh = Math.max(1, Number(viewHeight) || 1);
    const scale = Math.max(sw / vw, sh / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (sw - dw) / 2, oy = (sh - dh) / 2;
    return {
      x: ox + (mirror ? 1 - rawPoint.x : rawPoint.x) * dw,
      y: oy + rawPoint.y * dh,
    };
  }

  /** Read all 21 MediaPipe landmarks. Safe on partial or degenerate frames. */
  function summarizeHand(rawLandmarks) {
    const points = Array.from(rawLandmarks || [], pointOf).slice(0, 21);
    while (points.length < 21) points.push([0, 0, 0]);

    const center = [0, 0, 0];
    for (const p of points) {
      center[0] += p[0] / 21;
      center[1] += p[1] / 21;
      center[2] += p[2] / 21;
    }

    const wrist = points[0];
    let normal = unit(cross(sub(points[5], wrist), sub(points[17], wrist)));
    if (norm(normal) <= 1e-9) normal = [0, 0, 1];
    if (normal[2] < 0) normal = normal.map((v) => -v);

    let direction = unit(sub(points[9], wrist));
    if (norm(direction) <= 1e-9) direction = [0, -1, 0];
    const scale = distance3(points[9], wrist);

    const curl = FOUR_FINGERS.map(([base, joint, tip]) =>
      clamp((180 - angleAt(points[joint], points[base], points[tip])) / 140, 0, 1));
    const fist = curl.reduce((sum, value) => sum + value, 0) / curl.length;
    const tips = [8, 12, 16, 20].map((i) => points[i]);
    let spread = 0;
    if (scale > 1e-6) {
      let span = 0;
      for (let i = 0; i < tips.length; i++) {
        for (let j = i + 1; j < tips.length; j++) span = Math.max(span, distance3(tips[i], tips[j]));
      }
      spread = clamp((span / (scale * 2.6) - 0.25) / 0.75, 0, 1);
    }
    const halfCurled = curl.every((v) => v >= 0.22 && v <= 0.78);
    // Match My Hands' measured pinch geometry: compare the thumb/index gap
    // with the wrist-to-middle-MCP palm axis in the image plane. MediaPipe z
    // is relative depth, not a metric pixel axis; mixing it into the pinch
    // distance makes the threshold vary with hand orientation and depth.
    const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const scale2D = dist2(points[9], wrist);
    const pinchGap2D = dist2(points[4], points[8]);
    const pinchRatio = scale2D > 1e-6 ? pinchGap2D / scale2D : 1;
    const palmWidth2D = dist2(points[5], points[17]);
    const aspect = palmWidth2D > 1e-6 ? scale2D / palmWidth2D : 9;
    const fingerReach = (tip, mcp) => {
      const baseReach = dist2(points[mcp], wrist);
      return baseReach > 1e-6 ? dist2(points[tip], wrist) / baseReach : 9;
    };
    const indexReach = fingerReach(8, 5);
    const backReach = (fingerReach(12, 9) + fingerReach(16, 13) + fingerReach(20, 17)) / 3;
    const thumbToRingBase = scale2D > 1e-6 ? dist2(points[4], points[13]) / scale2D : 0;
    // My Hands' false-pinch rejection: a real thumb/index OK pinch curls
    // index inward while the other three remain arched, or has the measured
    // near-on profile-hand silhouette. Gate only pinch START; do not make an
    // ongoing hold depend on noisy per-frame shape estimates.
    const pinchSignature = (backReach - indexReach > 0.18 && backReach > 1.30) ||
      (aspect < 2 && thumbToRingBase > 0.95);
    const pinchGate = aspect < 2 ? 0.38 : 0.32;
    const handGarbage = aspect > 6;
    const nz = Math.abs(normal[2]) > 0.30 ? normal[2] : (normal[2] >= 0 ? 0.30 : -0.30);

    return {
      landmarks: points,
      center: { x: center[0], y: center[1], z: center[2] },
      normal: { x: normal[0], y: normal[1], z: normal[2] },
      direction: { x: direction[0], y: direction[1], z: direction[2] },
      scale,
      scale2D,
      pinchGap2D,
      aspect,
      pinchGate,
      pinchSignature,
      handGarbage,
      fingerReach: { index: indexReach, backMean: backReach, thumbToRingBase },
      curl,
      fist,
      pinchRatio,
      spread,
      claw: halfCurled ? spread : 0,
      depth: wrist[2],
      depthSpread: Math.max(...points.map((p) => p[2])) - Math.min(...points.map((p) => p[2])),
      tilt: {
        yaw: Math.atan2(normal[0], Math.abs(nz)),
        pitch: Math.atan2(normal[1], Math.abs(nz)),
      },
    };
  }

  function stateView(s) {
    return {
      present: s.present,
      pinching: s.pinch.state === "pinched" || s.pinch.state === "releasing",
      fist: s.fist.state === "closed",
      scaling: s.scale.active,
      pulling: s.pull.state === "pulling",
      turning: s.rotate.state === "turning",
    };
  }

  /**
   * Create the testable gesture recognizer used by the dashboard.
   * Time is supplied in milliseconds (normally performance.now()). `send`
   * receives the exact event objects published on /ws/myhands.
   */
  function createGestureEngine({ send = () => {}, config = {} } = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const s = {
      present: false,
      pinch: { state: "open", since: null, startedAt: null, qualityEma: 0, qualityPrev: false },
      fist: { state: "open", since: null },
      rotate: { state: "idle", since: null, anchor: null, lastTilt: [0, 0], lastEmit: -Infinity },
      scale: { active: false, base: 0, lastFactor: 1, lastEmit: -Infinity },
      clap: { lastGap: null, lastT: null, cooledUntil: -Infinity },
      pull: { state: "open", since: null, origin: null, lastEmit: -Infinity },
      lastCursorAt: -Infinity,
    };

    function emit(type, now, fields = {}) {
      try { send({ type, t: Number((now / 1000).toFixed(3)), ...fields }); } catch (_) { /* a disconnected bus cannot stop tracking */ }
    }

    function due(now, last, hz) { return now - last >= (1000 / hz) - 1e-3; }
    function centre(frame) { return [frame.center.x, frame.center.y, frame.center.z]; }
    function handDistance(a, b) { return distance3(centre(a), centre(b)); }
    function wrapAngle(angle) {
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;
      return angle;
    }

    function updatePinch(frame, now, x, y, pinchOn, pinchOff, handSpeed, pinchCarry) {
      const p = s.pinch;
      const ratio = Number(frame.pinchRatio);
      const value = Number.isFinite(ratio) ? ratio : 1;
      const hasSignature = typeof frame.pinchSignature === "boolean";
      const quality = !hasSignature || (frame.pinchSignature && !frame.handGarbage);
      p.qualityEma = 0.70 * p.qualityEma + 0.30 * (quality ? 1 : 0);
      const qualityConfirmed = !hasSignature ||
        (quality && (p.qualityPrev || p.qualityEma > 0.55));
      p.qualityPrev = quality;
      const garbage = Boolean(frame.handGarbage);
      // My Hands protects a moving grab from one-frame blur spikes by asking
      // the hand to open farther at speed; stationary release stays responsive.
      const releaseAt = handSpeed > 800 ? Math.max(pinchOff, 0.70) : pinchOff;

      if (p.state === "open") {
        if (!garbage && qualityConfirmed && value < pinchOn) {
          p.state = "candidate"; p.since = now; p.badRun = 0;
        }
      } else if (p.state === "candidate") {
        if (garbage || value >= pinchOn || (!quality && p.qualityEma < 0.35)) {
          p.state = "open"; p.since = null; p.badRun = 0; p.startedAt = null;
        } else if (now - p.since >= cfg.pinchHoldMs) {
          p.state = "pinched"; p.since = now; p.startedAt = now; p.badRun = 0; p.forcedRelease = false;
          emit("pinch_started", now, { x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
        }
      } else if (p.state === "pinched") {
        // A geometrically impossible hand cannot start or keep a pinch. For a
        // fresh hold, four consecutive lost signature frames reject fold-
        // through poses; fast drags and a window already being carried are exempt.
        if (garbage) {
          p.state = "releasing"; p.since = now; p.forcedRelease = true;
        } else {
          if (hasSignature && !pinchCarry && handSpeed < 600 && now - p.startedAt < 400) {
            p.badRun = quality ? 0 : (p.badRun || 0) + 1;
            if (p.badRun >= 4) {
              p.state = "releasing"; p.since = now; p.forcedRelease = true;
            }
          } else p.badRun = 0;
          if (p.state === "pinched" && value > releaseAt) {
            p.state = "releasing"; p.since = now; p.forcedRelease = false;
          }
        }
      } else if (p.state === "releasing") {
        if (!p.forcedRelease && value <= releaseAt) { p.state = "pinched"; p.since = null; }
        else if (now - p.since >= cfg.releaseHoldMs) {
          p.state = "open"; p.since = null; p.startedAt = null; p.badRun = 0; p.forcedRelease = false;
          emit("pinch_released", now);
        }
      }
    }

    function updateFist(frame, now, enabled) {
      const f = s.fist;
      if (!enabled) {
        if (f.state === "closed") emit("fist_released", now, { reason: "disabled" });
        f.state = "open"; f.since = null;
        return;
      }
      const value = clamp(Number(frame.fist) || 0, 0, 1);
      if (f.state === "open") {
        if (value >= cfg.fistOn) { f.state = "closing"; f.since = now; }
      } else if (f.state === "closing") {
        if (value < cfg.fistOff) { f.state = "open"; f.since = null; }
        else if (now - f.since >= cfg.fistHoldMs) {
          f.state = "closed"; f.since = null;
          const c = frame.center;
          emit("fist_started", now, {
            x: clamp(1 - c.x, 0, 1), y: clamp(c.y, 0, 1), strength: Number(value.toFixed(3)),
          });
        }
      } else if (f.state === "closed" && value <= cfg.fistOff) {
        f.state = "open";
        emit("fist_released", now);
      }
    }

    function updateRotate(frame, now, held) {
      const r = s.rotate;
      if (!held) {
        if (r.state === "turning") emit("rotate_ended", now, { reason: "released" });
        r.state = "idle"; r.since = null; r.anchor = null;
        return;
      }

      const c = frame.center;
      const here = [c.x, c.y];
      if (r.anchor && Math.hypot(here[0] - r.anchor[0], here[1] - r.anchor[1]) > cfg.stillRadius) {
        r.anchor = here; r.since = now;
        if (r.state === "turning") {
          emit("rotate_ended", now, { reason: "moved" });
          r.state = "still";
        }
        return;
      }
      if (r.state === "idle") {
        r.state = "still"; r.since = now; r.anchor = here;
        r.lastTilt = [frame.tilt.yaw, frame.tilt.pitch];
        return;
      }
      if (r.state === "still") {
        if (now - r.since >= cfg.stillMs) {
          r.state = "turning";
          r.lastTilt = [frame.tilt.yaw, frame.tilt.pitch];
          r.lastEmit = now;
          emit("rotate_started", now);
        }
        return;
      }
      if (!due(now, r.lastEmit, cfg.rotateHz)) return;
      r.lastEmit = now;
      const tilt = [frame.tilt.yaw, frame.tilt.pitch];
      const yaw = wrapAngle(tilt[0] - r.lastTilt[0]);
      const pitch = wrapAngle(tilt[1] - r.lastTilt[1]);
      r.lastTilt = tilt;
      if (Math.abs(yaw) >= 1e-4 || Math.abs(pitch) >= 1e-4) {
        emit("rotate_delta", now, { yaw: Number(yaw.toFixed(5)), pitch: Number(pitch.toFixed(5)) });
      }
    }

    function updatePull(frame, now) {
      const p = s.pull;
      const value = clamp(Number(frame.claw) || 0, 0, 1);
      if (p.state === "open") {
        if (value >= cfg.clawOn) { p.state = "clawed"; p.since = now; }
      } else if (p.state === "clawed") {
        if (value < cfg.clawOff) { p.state = "open"; p.since = null; }
        else if (now - p.since >= cfg.clawHoldMs) {
          p.state = "pulling"; p.origin = centre(frame); p.lastEmit = now;
          emit("pull_started", now, { z: Number(p.origin[2].toFixed(4)) });
        }
      } else if (p.state === "pulling") {
        if (value < cfg.clawOff) {
          p.state = "open"; p.since = null; p.origin = null;
          emit("pull_ended", now);
          return;
        }
        if (!due(now, p.lastEmit, cfg.pullHz)) return;
        p.lastEmit = now;
        const c = centre(frame);
        const dx = c[0] - p.origin[0], dy = c[1] - p.origin[1], dz = c[2] - p.origin[2];
        if (Math.abs(dx) >= 1e-4 || Math.abs(dy) >= 1e-4 || Math.abs(dz) >= 1e-4) {
          emit("pull_delta", now, {
            dx: Number(dx.toFixed(4)), dy: Number(dy.toFixed(4)), dz: Number(dz.toFixed(4)),
          });
        }
      }
    }

    function updateFrame(frame, {
      now = performance.now(), cursorX = 0.5, cursorY = 0.5,
      pinchOn = cfg.pinchOn, pinchOff = cfg.pinchOff, fistEnabled = true,
      handSpeed = 0, pinchCarry = false,
    } = {}) {
      if (!frame || !frame.center || !frame.tilt) return stateView(s);
      if (!s.present) { s.present = true; emit("hand_detected", now); }

      if (due(now, s.lastCursorAt, cfg.cursorHz)) {
        emit("cursor_moved", now, { x: clamp(cursorX, 0, 1), y: clamp(cursorY, 0, 1) });
        s.lastCursorAt = now;
      }

      updatePinch(frame, now, cursorX, cursorY, pinchOn, pinchOff, handSpeed, pinchCarry);
      updateFist(frame, now, fistEnabled);
      const held = s.pinch.state === "pinched" || s.pinch.state === "releasing" || s.fist.state === "closed";
      updateRotate(frame, now, held);
      updatePull(frame, now);
      return stateView(s);
    }

    function updateHands(frames, now = performance.now()) {
      const list = Array.from(frames || []).filter((f) => f && f.center);
      if (list.length < 2) {
        if (s.scale.active) emit("scale_ended", now, { reason: "hand_left" });
        s.scale = { active: false, base: 0, lastFactor: 1, lastEmit: -Infinity };
        s.clap = { lastGap: null, lastT: null, cooledUntil: s.clap.cooledUntil };
        return stateView(s);
      }

      const a = list[0], b = list[1];
      const gap = handDistance(a, b);
      if (!s.scale.active) {
        s.scale = { active: true, base: Math.max(gap, 1e-6), lastFactor: 1, lastEmit: now };
        emit("scale_started", now, { factor: 1 });
      } else if (due(now, s.scale.lastEmit, cfg.scaleHz)) {
        s.scale.lastEmit = now;
        const factor = s.scale.base > 1e-6 ? gap / s.scale.base : 1;
        if (Math.abs(factor - s.scale.lastFactor) >= 0.004) {
          s.scale.lastFactor = factor;
          emit("scale_delta", now, { factor: Number(clamp(factor, 0.25, 4).toFixed(4)) });
        }
      }

      if (s.clap.lastGap !== null && s.clap.lastT !== null) {
        const dt = Math.max((now - s.clap.lastT) / 1000, 1e-6);
        const speed = (s.clap.lastGap - gap) / dt;
        if (speed >= cfg.clapSpeed && gap <= cfg.clapGap && now >= s.clap.cooledUntil) {
          s.clap.cooledUntil = now + cfg.clapCooldownMs;
          emit("clap", now, {
            x: Number(((a.center.x + b.center.x) / 2).toFixed(4)),
            y: Number(((a.center.y + b.center.y) / 2).toFixed(4)),
          });
        }
      }
      s.clap.lastGap = gap;
      s.clap.lastT = now;
      return stateView(s);
    }

    function loseHand(now = performance.now(), reason = "tracking_lost") {
      const wasPresent = s.present;
      if (s.pinch.state !== "open") emit("pinch_released", now, { reason });
      if (s.fist.state === "closed") emit("fist_released", now, { reason });
      if (s.rotate.state === "turning") emit("rotate_ended", now, { reason });
      if (s.scale.active) emit("scale_ended", now, { reason });
      if (s.pull.state === "pulling") emit("pull_ended", now, { reason });
      if (wasPresent) emit("hand_lost", now, { reason });

      s.present = false;
      s.pinch = { state: "open", since: null, startedAt: null, qualityEma: 0, qualityPrev: false };
      s.fist = { state: "open", since: null };
      s.rotate = { state: "idle", since: null, anchor: null, lastTilt: [0, 0], lastEmit: -Infinity };
      s.scale = { active: false, base: 0, lastFactor: 1, lastEmit: -Infinity };
      s.clap = { lastGap: null, lastT: null, cooledUntil: -Infinity };
      s.pull = { state: "open", since: null, origin: null, lastEmit: -Infinity };
      s.lastCursorAt = -Infinity;
      return stateView(s);
    }

    return Object.freeze({
      updateFrame,
      updateHands,
      loseHand,
      getState: () => stateView(s),
    });
  }

  return Object.freeze({ DEFAULTS, summarizeHand, createGestureEngine, distance3, mapToCover });
});
