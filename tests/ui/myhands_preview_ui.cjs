// My Hands camera preview browser check (jsdom). Real index.html, app.js and myhands.js.
// The backend is stubbed. Checks: the picture is on only while My Hands is on, the owner can
// hide and show it, the choice is remembered, and a refused picture is hidden quietly.
//
// Run (jsdom is not a project dependency; install it in a scratch folder):
//   mkdir -p /tmp/uitest && cd /tmp/uitest && npm init -y && npm i jsdom@24
//   NODE_PATH=/tmp/uitest/node_modules node /home/user/The-better-Jarvis/tests/ui/myhands_preview_ui.cjs
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

function makePage(preset) {
  const dom = new JSDOM(html, { url: BASE + "/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  if (preset !== undefined) w.localStorage.setItem("supper.mhView", preset);
  const calls = [];
  let status = { running: false, tracker_available: true, last_event_seq: 0, hand_present: false };
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ url, method });
    let data = {};
    if (url === "/api/myhands/status") data = status;
    else if (url === "/api/myhands/start") { status = { ...status, running: true }; data = status; }
    else if (url === "/api/myhands/stop") { status = { ...status, running: false }; data = status; }
    else if (url === "/api/myhands/scene") data = { count: 0 };
    else if (url === "/api/files/roots") data = { roots: [] };
    else if (url === "/api/status") data = { api_key_configured: true, text_model: "x", file_roots_available: 0 };
    return { ok: true, status: 200, json: async () => data };
  };
  const sockets = [];
  w.WebSocket = class { constructor() { this.onmessage = null; this.onclose = null; sockets.push(this); } close() {} };
  w.navigator.sendBeacon = () => true;
  w.eval(appJs);
  w.eval(mhJs);
  return {
    w, d, calls, sockets,
    btn: d.querySelector("#btn-myhands"),
    view: d.querySelector("#mh-view"),
    img: d.querySelector("#mh-preview"),
    hide: d.querySelector("#btn-mh-view"),
  };
}

const srcOf = (img) => img.getAttribute("src");
const onSrc = (img) => (srcOf(img) || "").startsWith("/api/myhands/preview?t=");

(async () => {
  // ---- off: no picture, no request ----
  {
    const p = makePage();
    await sleep(50);
    check("picture hidden while My Hands is off", p.view.hidden === true);
    check("no picture address set while off", !srcOf(p.img));
    check("hide button hidden while off", p.hide.hidden === true);
  }

  // ---- on: the picture appears, from a relative address on this computer ----
  const p = makePage();
  p.btn.click();
  check("picture shows after start", await waitFor(() => !p.view.hidden && onSrc(p.img)),
    srcOf(p.img) || "(no src)");
  check("picture address is relative (no host, no localhost)",
    onSrc(p.img) && !/https?:|localhost|127\.0\.0\.1/.test(srcOf(p.img)));
  check("hide button shown with the picture", !p.hide.hidden && p.hide.textContent === "Hide camera");

  // ---- the owner hides it: picture goes, choice is remembered ----
  p.hide.click();
  check("hide removes the picture address", !srcOf(p.img));
  check("hide makes the picture hidden", p.view.hidden === true);
  check("hide button now offers to show", p.hide.textContent === "Show camera");
  check("choice saved as off", p.w.localStorage.getItem("supper.mhView") === "off");

  // ---- stop: nothing left running ----
  p.btn.click();
  check("stop turns My Hands off", await waitFor(() => p.btn.getAttribute("aria-pressed") === "false"));
  check("stop leaves no picture address", !srcOf(p.img) && p.view.hidden === true);

  // ---- start again with the choice remembered: still hidden ----
  p.btn.click();
  check("second start works", await waitFor(() => p.btn.getAttribute("aria-pressed") === "true"));
  await sleep(30);
  check("remembered 'off' keeps the picture hidden on start", !srcOf(p.img) && p.view.hidden === true);

  // ---- the owner shows it again while My Hands is on ----
  p.hide.click();
  check("show brings the picture back", await waitFor(() => !p.view.hidden && onSrc(p.img)));
  check("show saves on", p.w.localStorage.getItem("supper.mhView") === "on");

  // ---- a refused picture (server says no) is hidden without a fuss ----
  p.img.dispatchEvent(new p.w.Event("error"));
  check("a refused picture is hidden", p.view.hidden === true);
  check("a refused picture adds no chat message",
    !Array.from(p.d.querySelectorAll("#log .msg")).some((m) => /camera|preview/i.test(m.textContent)));

  // ---- the server ends the session by itself (auto-off): the picture goes with it ----
  // The button now reads "Hide camera" (the choice is still on), so two clicks: hide, then show.
  p.hide.click();
  p.hide.click();
  check("picture back on before auto-off", await waitFor(() => onSrc(p.img) && !p.view.hidden));
  const sock = p.sockets[p.sockets.length - 1];
  check("events socket open", await waitFor(() => !!sock && typeof sock.onmessage === "function"));
  sock.onmessage({ data: JSON.stringify({ seq: 1, event: { type: "session_stopped", reason: "auto_off" } }) });
  check("auto-off turns My Hands off", await waitFor(() => p.btn.getAttribute("aria-pressed") === "false"));
  check("auto-off takes the picture down", !srcOf(p.img) && p.view.hidden === true);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
