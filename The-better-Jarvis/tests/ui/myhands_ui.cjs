// My Hands browser check (jsdom). Real index.html + app.js + myhands.js.
// Backend and WebSocket are stubbed so the test can send exact gesture events.
// My Hands browser check (jsdom). Loads the real web/index.html, app.js and myhands.js.
// The backend and the WebSocket are stubbed, so the test can send exact gesture events.
//
// Run (jsdom is not a project dependency; install it in a scratch folder):
//   mkdir -p /tmp/uitest && cd /tmp/uitest && npm init -y && npm i jsdom@24
//   NODE_PATH=/tmp/uitest/node_modules node /home/user/The-better-Jarvis/tests/ui/myhands_ui.cjs
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8765";
const REPO = path.join(__dirname, "..", "..", "web");
const html = fs.readFileSync(`${REPO}/index.html`, "utf8");
const appJs = fs.readFileSync(`${REPO}/app.js`, "utf8");
const mhJs = fs.readFileSync(`${REPO}/myhands.js`, "utf8");

const results = [];
function check(name, ok, detail = "") {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (_) {} await sleep(20); }
  return false;
}

(async () => {
  const dom = new JSDOM(html, { url: BASE + "/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;

  // ---- stubs ----
  const calls = [];
  const sockets = [];
  let status = { running: false, tracker_available: true, last_event_seq: 0, hand_present: false };
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    let data = {};
    if (url === "/api/myhands/status") data = status;
    else if (url === "/api/myhands/start") { status = { ...status, running: true }; data = status; }
    else if (url === "/api/myhands/stop") { status = { ...status, running: false }; data = status; }
    else if (url === "/api/myhands/scene") data = { count: 1 };
    else if (url === "/api/files/roots") data = { roots: [{ name: "demo", path: "/demo" }] };
    else if (url === "/api/status") data = { api_key_configured: true, text_model: "x", file_roots_available: 1 };
    return { ok: true, status: 200, json: async () => data };
  };
  w.WebSocket = class {
    constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; sockets.push(this); }
    close() { this.closed = true; }
  };
  w.navigator.sendBeacon = (url) => { calls.push({ beacon: url }); return true; };
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.id === "surface" ? 1000 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.id === "surface" ? 500 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.classList.contains("tile") ? 132 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.classList.contains("tile") ? 120 : 0; } });
  w.Element.prototype.getBoundingClientRect = function () {
    return this.id === "surface" ? { left: 0, top: 0, width: 1000, height: 500 } : { left: 0, top: 0, width: 0, height: 0 };
  };
  w.eval(appJs);
  w.eval(mhJs);

  const btn = d.querySelector("#btn-myhands");
  const chip = d.querySelector("#mh-chip");
  const chipTxt = () => d.querySelector("#mh-text").textContent;
  const cursor = d.querySelector("#hand-cursor");
  const log = d.querySelector("#log");
  const tile = () => d.querySelector(".tile");
  const msgs = () => Array.from(log.querySelectorAll(".msg")).map((m) => m.textContent);
  const lastSocket = () => sockets[sockets.length - 1];
  const emit = (seq, event) => lastSocket().onmessage({ data: JSON.stringify({ seq, event }) });
  const sceneCalls = () => calls.filter((c) => c.url === "/api/myhands/scene");

  check("My Hands button is enabled and off", !btn.disabled && btn.getAttribute("aria-pressed") === "false");
  check("chip hidden while off", chip.hidden === true);
  check("tile rendered", await waitFor(() => !!tile()));

  // ---- start ----
  btn.click();
  check("start posts to the backend", await waitFor(() => calls.some((c) => c.url === "/api/myhands/start" && c.method === "POST")));
  check("button shows Stop after start", await waitFor(() => btn.getAttribute("aria-pressed") === "true" && btn.textContent === "Stop My Hands"));
  check("scene pushed with the tile in stage units",
    await waitFor(() => sceneCalls().length >= 1),
    JSON.stringify(sceneCalls()[0] && sceneCalls()[0].body));
  const first = sceneCalls()[0].body.objects[0];
  check("scene object has id, bounds, z",
    first.id === "t0" && first.x === 0.016 && first.y === 0.032 && first.w === 0.132 && first.h === 0.24 && first.z === 0,
    JSON.stringify(first));
  check("websocket opened on the local host with since=0",
    await waitFor(() => !!lastSocket()) && lastSocket().url === "ws://127.0.0.1:8765/ws/myhands?since=0", lastSocket() && lastSocket().url);

  // ---- events ----
  emit(1, { type: "session_started", t: 0, mode: "my_hands" });
  check("chip says looking for a hand", chipTxt() === "looking for a hand" && !chip.hidden);
  emit(2, { type: "hand_detected", t: 0 });
  check("chip says hand found", chipTxt() === "hand found");
  emit(3, { type: "cursor_moved", t: 0, x: 0.5, y: 0.5 });
  check("cursor placed at stage position", cursor.style.left === "500px" && cursor.style.top === "250px" && !cursor.hidden,
    `${cursor.style.left} ${cursor.style.top}`);
  emit(4, { type: "pinch_started", t: 0, x: 0.5, y: 0.5 });
  check("cursor shows pinch", cursor.classList.contains("pinched"));

  emit(5, { type: "object_grabbed", t: 0, id: "t0", x: 0.016, y: 0.032 });
  check("grabbed tile gets the grabbed class", tile().classList.contains("grabbed"));
  const sceneBefore = sceneCalls().length;
  emit(6, { type: "object_dragged", t: 0, id: "t0", x: 0.4, y: 0.3 });
  check("drag moves the tile", tile().style.left === "400px" && tile().style.top === "150px", `${tile().style.left} ${tile().style.top}`);
  await sleep(250);
  check("no scene sync while a grab is held", sceneCalls().length === sceneBefore);

  emit(7, { type: "pinch_released", t: 0 });
  emit(8, { type: "object_released", t: 0, id: "t0", x: 0.42, y: 0.31, reason: "release" });
  check("release places the tile and clears the grab",
    tile().style.left === "420px" && tile().style.top === "155px" && !tile().classList.contains("grabbed"));
  check("released position saved to layout storage",
    JSON.parse(w.localStorage.getItem("supper.tilePositions.v1") || "{}")[tile().dataset.key]?.left === 420);
  check("normal release adds no chat message", !msgs().some((m) => m.includes("dropped")));
  check("scene re-synced after release",
    await waitFor(() => sceneCalls().length > sceneBefore && sceneCalls().slice(-1)[0].body.objects[0].x === 0.42));

  // ---- failure paths ----
  emit(9, { type: "object_grabbed", t: 0, id: "t0", x: 0.42, y: 0.31 });
  emit(10, { type: "tracking_unavailable", t: 0, reason: "camera stopped delivering frames" });
  check("tracking pause shows in chip and log",
    chipTxt() === "camera stopped delivering frames" && chip.classList.contains("bad") && msgs().some((m) => m.includes("tracking paused")));
  emit(11, { type: "object_released", t: 0, id: "t0", x: 0.42, y: 0.31, reason: "camera_failed" });
  check("camera failure drops the tile and says so", msgs().some((m) => m.includes("camera failed, dropped")));
  emit(12, { type: "session_stopped", t: 0, reason: "camera_failed" });
  check("session stop from the camera turns the button off",
    btn.getAttribute("aria-pressed") === "false" && btn.textContent === "My Hands" && chip.hidden === true);
  check("camera failure stop is explained in chat", msgs().some((m) => m.includes("camera failed. Camera released.")));
  check("socket closed on stop", lastSocket().closed === true);

  // ---- idle auto-off: one message, not two ----
  btn.click();
  await waitFor(() => btn.getAttribute("aria-pressed") === "true");
  const beforeAuto = msgs().length;
  emit(14, { type: "session_started", t: 0, mode: "my_hands" });
  emit(15, { type: "auto_off", t: 0 });
  emit(16, { type: "session_stopped", t: 0, reason: "auto_off" });
  check("auto-off gives exactly one message", msgs().length === beforeAuto + 1 &&
    msgs().slice(-1)[0].includes("long time without a hand"), msgs().slice(beforeAuto).join(" | "));
  check("auto-off turns the button off", btn.getAttribute("aria-pressed") === "false");

  // ---- user stop and page close ----
  btn.click();
  await waitFor(() => btn.getAttribute("aria-pressed") === "true");
  emit(13, { type: "session_started", t: 0, mode: "my_hands" });
  check("second start works", btn.getAttribute("aria-pressed") === "true");
  const msgCountBeforeStop = msgs().length;
  btn.click();
  check("user stop posts to the backend", await waitFor(() => calls.filter((c) => c.url === "/api/myhands/stop").length >= 1));
  check("user stop turns the button off", await waitFor(() => btn.getAttribute("aria-pressed") === "false"));
  check("user stop adds no message", msgs().length === msgCountBeforeStop);

  btn.click();
  await waitFor(() => btn.getAttribute("aria-pressed") === "true");
  w.dispatchEvent(new w.Event("pagehide"));
  check("closing the page sends a stop beacon", calls.some((c) => c.beacon === "/api/myhands/stop"));

  // ---- reload while running: resumes after the last seen event, no replay ----
  {
    const d2 = new JSDOM(html, { url: BASE + "/", pretendToBeVisual: true, runScripts: "outside-only" });
    const w2 = d2.window;
    const socks2 = [];
    status = { running: true, tracker_available: true, last_event_seq: 40, hand_present: true };
    w2.fetch = async (url) => {
      let data = {};
      if (url === "/api/myhands/status") data = status;
      else if (url === "/api/files/roots") data = { roots: [] };
      return { ok: true, status: 200, json: async () => data };
    };
    w2.WebSocket = class { constructor(url) { this.url = url; socks2.push(this); } close() {} };
    w2.eval(appJs);
    w2.eval(mhJs);
    check("reload: button shows the running state",
      await waitFor(() => w2.document.querySelector("#btn-myhands").getAttribute("aria-pressed") === "true"));
    check("reload: socket resumes after seq 40", await waitFor(() => socks2.length === 1) &&
      socks2[0].url === "ws://127.0.0.1:8765/ws/myhands?since=40", socks2[0] && socks2[0].url);
    w2.close();
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
