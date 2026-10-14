import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const dashboardHtml = readFileSync(new URL("../dashboard/static/app.html", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

await import("../dashboard/static/hand-gestures.js");
const { mapToCover, summarizeHand, createGestureEngine } = globalThis.JarvisHandGestures;

function okPinch(gap = 0.02, zOffset = 0) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };       // wrist
  lm[4] = { x: 0.5 + gap, y: 0.68, z: -zOffset };
  lm[5] = { x: 0.42, y: 0.60, z: 0 };
  lm[8] = { x: 0.5, y: 0.68, z: zOffset };
  lm[9] = { x: 0.5, y: 0.58, z: 0 };      // middle MCP / palm scale
  lm[12] = { x: 0.5, y: 0.30, z: 0 };
  lm[13] = { x: 0.58, y: 0.60, z: 0 };
  lm[16] = { x: 0.70, y: 0.43, z: 0 };
  lm[17] = { x: 0.65, y: 0.65, z: 0 };
  lm[20] = { x: 0.77, y: 0.52, z: 0 };
  return lm;
}

test("the supported dashboard wires real camera frames to the visible gesture UI", () => {
  assert.match(dashboardHtml, /id="btn-toggle-hands"[^>]*onclick="toggleMyHandsTracking\(\)"/);
  assert.match(dashboardHtml, /<video id="bg-camera"[^>]*autoplay[^>]*playsinline[^>]*muted/);
  assert.match(dashboardHtml, /<canvas id="hand-overlay-canvas"><\/canvas>/);
  assert.match(dashboardHtml, /id="hand-cursor" class="hand-cursor"/);
  assert.match(dashboardHtml, /navigator\.mediaDevices\.getUserMedia\(constraints\)/);
  assert.match(dashboardHtml, /HandLandmarker\.createFromOptions/);
  assert.match(dashboardHtml, /landmarker\.detectForVideo\(bgCam, now\)/);
  assert.match(dashboardHtml, /drawHandSkeleton\(lms, screenPointForCameraLandmark\)/);
  assert.match(dashboardHtml, /function publishGesture\(cursorX, cursorY, frame, handSpeed = 0\)/);
  assert.match(dashboardHtml, /requestVideoFrameCallback/);
  assert.match(dashboardHtml, /requestAnimationFrame\(trackingFrame\)/);
  assert.match(dashboardHtml, /new WebSocket\(`\$\{proto\}:\/\/\$\{location\.host\}\/ws\/myhands`\)/);
  assert.match(dashboardHtml, /Tracking requires a real camera; do not substitute synthetic landmarks\./);
  assert.doesNotMatch(dashboardHtml, /simulated/);

  assert.match(serverSource, /pathname === '\/ws\/myhands'/);
  assert.match(serverSource, /handsWss\.clients\.forEach\(\(client\)/);
  assert.match(serverSource, /client\.send\(msg\)/);
});

test("cover mapping mirrors and crops exactly like the camera element", () => {
  const center = mapToCover({ x: 0.5, y: 0.5 }, 1920, 1080, 1000, 1000, true);
  assert.deepEqual(center, { x: 500, y: 500 });

  // The 16:9 camera is wider than the square viewport, so its sides are
  // outside the visible crop. Landmarks stay registered to object-fit:cover.
  const cameraLeft = mapToCover({ x: 0, y: 0.5 }, 1920, 1080, 1000, 1000, true);
  const cameraRight = mapToCover({ x: 1, y: 0.5 }, 1920, 1080, 1000, 1000, true);
  assert.ok(cameraLeft.x > 1000);
  assert.ok(cameraRight.x < 0);

  const fullFrame = mapToCover({ x: 0.25, y: 0.75 }, 1600, 900, 1600, 900, true);
  assert.deepEqual(fullFrame, { x: 1200, y: 675 });
});

test("pinch ratio uses 2D image geometry and is unaffected by relative z noise", () => {
  const clean = summarizeHand(okPinch(0.064, 0));
  const noisyDepth = summarizeHand(okPinch(0.064, 0.4));
  assert.ok(Math.abs(clean.pinchRatio - 0.2) < 1e-9);
  assert.ok(Math.abs(noisyDepth.pinchRatio - clean.pinchRatio) < 1e-9);
  assert.equal(clean.pinchSignature, true);
  assert.equal(clean.handGarbage, false);
});

test("pinch start needs a stable Barehands pose signature when available", () => {
  const events = [];
  const engine = createGestureEngine({
    send: (event) => events.push(event),
    config: { pinchHoldMs: 40, releaseHoldMs: 20 },
  });
  const badPose = summarizeHand(okPinch(0.01));
  badPose.pinchSignature = false;
  for (let now = 0; now <= 200; now += 20) {
    engine.updateFrame(badPose, { now, cursorX: 0.5, cursorY: 0.5, pinchOn: 0.32, pinchOff: 0.55 });
  }
  assert.equal(events.some((event) => event.type === "pinch_started"), false);

  const goodPose = summarizeHand(okPinch(0.01));
  for (let now = 220; now <= 320; now += 20) {
    engine.updateFrame(goodPose, { now, cursorX: 0.5, cursorY: 0.5, pinchOn: 0.32, pinchOff: 0.55 });
  }
  assert.equal(events.filter((event) => event.type === "pinch_started").length, 1);
});

test("four early bad-signature frames drop a fresh pinch, but not a fast drag", () => {
  const events = [];
  const engine = createGestureEngine({
    send: (event) => events.push(event),
    config: { pinchHoldMs: 0, releaseHoldMs: 20 },
  });
  const good = summarizeHand(okPinch(0.01));
  const bad = { ...good, pinchSignature: false };
  const update = (frame, now, opts = {}) => engine.updateFrame(frame, {
    now, cursorX: 0.5, cursorY: 0.5, pinchOn: 0.32, pinchOff: 0.55, ...opts,
  });
  update(good, 0);
  update(good, 20);
  update(good, 30);
  assert.equal(engine.getState().pinching, true);
  for (let now = 40; now <= 70; now += 10) update(bad, now);
  update(bad, 100);
  assert.equal(events.some((event) => event.type === "pinch_released"), true);

  const carriedEvents = [];
  const carried = createGestureEngine({
    send: (event) => carriedEvents.push(event),
    config: { pinchHoldMs: 0, releaseHoldMs: 20 },
  });
  const carriedUpdate = (frame, now) => carried.updateFrame(frame, {
    now, cursorX: 0.5, cursorY: 0.5, pinchOn: 0.32, pinchOff: 0.55, pinchCarry: true,
  });
  carriedUpdate(good, 0);
  carriedUpdate(good, 20);
  carriedUpdate(good, 30);
  for (let now = 40; now <= 100; now += 10) carriedUpdate(bad, now);
  assert.equal(carried.getState().pinching, true);
  assert.equal(carriedEvents.some((event) => event.type === "pinch_released"), false);
});

test("fast motion uses the wider Barehands release gate to ignore blur spikes", () => {
  const engine = createGestureEngine({ config: { pinchHoldMs: 0, releaseHoldMs: 20 } });
  const closed = summarizeHand(okPinch(0.01));
  const update = (ratio, now) => engine.updateFrame({ ...closed, pinchRatio: ratio }, {
    now, cursorX: 0.5, cursorY: 0.5, pinchOn: 0.32, pinchOff: 0.55, handSpeed: 900,
  });
  update(0.01, 0);
  update(0.01, 20);
  update(0.01, 30);
  update(0.60, 40);
  assert.equal(engine.getState().pinching, true);
});
