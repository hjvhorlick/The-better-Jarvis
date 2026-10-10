// V2-2 control surface check (jsdom). Loads the real web/index.html, app.js, myhands.js
// and control.js. The backend, the WebSocket and the timers are stubbed, so every
// state is set by the test.
//
// Run (jsdom is not a project dependency; install it in a scratch folder):
//   mkdir -p /tmp/uitest && cd /tmp/uitest && npm init -y && npm i jsdom@24
//   NODE_PATH=/tmp/uitest/node_modules node /home/user/The-better-Jarvis/tests/ui/control_ui.cjs
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8765";
const REPO = path.join(__dirname, "..", "..", "web");
const html = fs.readFileSync(`${REPO}/index.html`, "utf8");
const scripts = ["app.js", "myhands.js", "control.js"].map((f) => fs.readFileSync(`${REPO}/${f}`, "utf8"));

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
  const w = dom.window;
  const d = w.document;

  // ---- backend stub ----
  const calls = [];
  const sockets = [];
  let budget = { day: "2026-10-09", used: 3, limit: 20, remaining: 17, enabled: true, unreadable: false,
                 saved: true, resets: "local midnight", note: "This app's own count." };
  let pending = [];
  let chatReply = null;                       // next /api/chat response override
  let diag = null;
  const future = () => Date.now() / 1000 + 120;

  w.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    let status = 200;
    let data = {};
    if (url === "/api/status") data = { api_key_configured: true, text_model: "x", file_roots_available: 1, gemini_budget: budget };
    else if (url === "/api/files/roots") data = { roots: [{ name: "demo", path: "/demo" }] };
    else if (url === "/api/confirmations" && method === "GET") data = { pending: pending.slice() };
    else if (url.startsWith("/api/confirmations/") && method === "POST") {
      const id = decodeURIComponent(url.split("/").pop());
      const item = pending.find((p) => p.id === id);
      if (!item) { status = 404; data = { detail: "no such pending confirmation" }; }
      else {
        pending = pending.filter((p) => p.id !== id);
        data = body.approve
          ? { id, action: item.action, status: "approved", result: "My Hands is starting." }
          : { id, action: item.action, status: "denied", result: "Cancelled." };
      }
    }
    else if (url === "/api/chat") {
      if (chatReply) { data = chatReply.data; status = chatReply.status || 200; chatReply = null; }
      else data = { reply: "pong", source: "gemini", intent: null, confirmation: null, open_path: null };
    }
    else if (url === "/api/diagnostics") data = diag;
    return {
      ok: status < 400, status,
      json: async () => data,
    };
  };
  w.WebSocket = class {
    constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; sockets.push(this); }
    close() { this.closed = true; }
  };
  w.navigator.sendBeacon = () => true;
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.id === "surface" ? 1000 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.id === "surface" ? 500 : 0; } });

  for (const s of scripts) w.eval(s);
  await sleep(150);

  const $ = (sel) => d.querySelector(sel);
  const logText = () => $("#log").textContent;
  const send = async (text) => {
    $("#input").value = text;
    $("#composer").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
    await sleep(60);
  };

  // 1. budget chip
  check("quota chip shows used of limit", await waitFor(() => $("#quota-chip").textContent === "Gemini today: 3/20"),
    $("#quota-chip").textContent);
  check("quota chip is not warning when plenty is left", !$("#quota-chip").classList.contains("warn") &&
    !$("#quota-chip").classList.contains("bad"));

  // 2. a local answer is labelled as local
  chatReply = { data: { reply: "It is 14:05.", source: "local", intent: "time.now", confirmation: null, open_path: null } };
  await send("what time is it");
  check("local answer carries the 'local' tag", await waitFor(() => $("#log").querySelector(".msg.assistant .tag")?.textContent === "local"));

  // 3. a Gemini answer is labelled as Gemini
  await send("hello");
  check("Gemini answer carries the 'Gemini' tag", await waitFor(() =>
    Array.from($("#log").querySelectorAll(".msg.assistant .tag")).some((t) => t.textContent === "Gemini")));

  // 4. CONFIRM: the card appears and the tray opens, with an approve/deny choice
  pending = [{ id: "abc123", action: "myhands.start", summary: "Turn on My Hands. The camera switches on.", expires_at: future() }];
  chatReply = { data: { reply: "This needs your OK: Turn on My Hands.", source: "confirmation", intent: "myhands.start",
                        confirmation: pending[0], open_path: null } };
  await send("turn on my hands");
  check("confirmation card is shown", await waitFor(() => $("#confirm-tray .confirm") !== null));
  check("tray is visible while a request waits", $("#confirm-tray").hidden === false);
  check("card shows the summary as text", $("#confirm-tray .confirm-summary").textContent.includes("Turn on My Hands"));
  check("card shows the countdown", await waitFor(() => $("#confirm-tray .confirm-expiry").textContent.includes("Expires in")));

  // 5. approve posts the right answer, then the card goes away and the result is shown
  $("#confirm-tray .approve").click();
  check("approve posts approve=true to the request id", await waitFor(() =>
    calls.some((c) => c.url === "/api/confirmations/abc123" && c.method === "POST" && c.body.approve === true)));
  check("card is removed after approval", await waitFor(() => $("#confirm-tray .confirm") === null));
  check("tray hides when nothing waits", $("#confirm-tray").hidden === true);
  check("approved result is shown", await waitFor(() => logText().includes("My Hands is starting.")));

  // 6. deny posts approve=false and does not start anything
  pending = [{ id: "def456", action: "myhands.start", summary: "Turn on My Hands.", expires_at: future() }];
  chatReply = { data: { reply: "This needs your OK.", source: "confirmation", intent: "myhands.start",
                        confirmation: pending[0], open_path: null } };
  await send("turn on my hands");
  await waitFor(() => $("#confirm-tray .confirm") !== null);
  $("#confirm-tray .deny").click();
  check("deny posts approve=false", await waitFor(() =>
    calls.some((c) => c.url === "/api/confirmations/def456" && c.body && c.body.approve === false)));
  check("denied result is shown", await waitFor(() => logText().includes("Cancelled.")));

  // 7. injected markup in a summary is shown as text, not run
  pending = [{ id: "xss789", action: "myhands.start", summary: "<img src=x onerror=alert(1)> Turn on", expires_at: future() }];
  chatReply = { data: { reply: "ok", source: "confirmation", intent: "myhands.start", confirmation: pending[0], open_path: null } };
  await send("turn on my hands");
  check("summary markup is text, not an element", await waitFor(() =>
    $("#confirm-tray .confirm-summary") && $("#confirm-tray .confirm-summary").textContent.startsWith("<img") &&
    $("#confirm-tray img") === null));
  $("#confirm-tray .deny").click();
  await waitFor(() => $("#confirm-tray .confirm") === null);

  // 8. budget used up: the 429 detail is shown as an error
  chatReply = { status: 429, data: { detail: "Today's Gemini budget is used up." } };
  await send("tell me a joke");
  check("429 shows the budget message", await waitFor(() => $("#log .msg.error")?.textContent === "Today's Gemini budget is used up."));

  // 9. the stream: a permission event refreshes the prompts
  const before = calls.filter((c) => c.url === "/api/confirmations" && c.method === "GET").length;
  const sock = sockets[sockets.length - 1];
  check("stream connects with a since= cursor", sockets.length >= 1 && /\/ws\/events\?since=\d+$/.test(sockets[0].url),
    sockets[0] && sockets[0].url);
  sock.onmessage({ data: JSON.stringify({ seq: 9, event: { source: "permissions", type: "confirm_requested" } }) });
  check("permission event triggers a refresh", await waitFor(() =>
    calls.filter((c) => c.url === "/api/confirmations" && c.method === "GET").length > before));

  // 10. diagnostics drawer
  diag = {
    version: "0.1.0", api_key_configured: true, text_model: "gemini-flash-latest", file_roots_available: 1,
    bus: { last_seq: 12, oldest_seq: 1, capacity: 2000 },
    devices: { camera: { holders: ["myhands"], status: { state: "streaming", message: "", frames_total: 40, reconnects: 0 } } },
    myhands: { running: true, camera: { state: "streaming" }, hand_present: true, idle_off_s: 600, tracker_available: true },
    gemini_budget: budget, confirmations_pending: 0,
    permissions: [{ action: "time.now", tier: "safe" }, { action: "myhands.start", tier: "confirm" }, { action: "shell.run", tier: "blocked" }],
    recent_problems: [{ seq: 7, source: "my_hands", type: "session_stopped", message: "camera_failed" }],
  };
  $("#btn-diag").click();
  check("diagnostics opens", await waitFor(() => $("#diag-panel").hidden === false));
  check("diagnostics button shows pressed", $("#btn-diag").getAttribute("aria-pressed") === "true");
  check("diagnostics shows devices and holders", await waitFor(() => $("#diag-body").textContent.includes("myhands")));
  check("diagnostics shows the budget", $("#diag-body").textContent.includes("3 of 20"));
  check("diagnostics shows the permission tiers", $("#diag-body").textContent.includes("shell.run: never runs here") &&
    $("#diag-body").textContent.includes("myhands.start: needs your OK"));
  check("diagnostics shows the recent problem", $("#diag-body").textContent.includes("camera_failed"));
  check("diagnostics never shows a key value", !$("#diag-body").textContent.includes("gemini_api_key"));

  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes diagnostics", await waitFor(() => $("#diag-panel").hidden === true));
  check("button returns to unpressed", $("#btn-diag").getAttribute("aria-pressed") === "false");

  // 11. opening a workspace closes the drawer
  $("#btn-diag").click();
  await waitFor(() => $("#diag-panel").hidden === false);
  $("[data-open='coding']").click();
  check("opening a workspace closes diagnostics", await waitFor(() => $("#diag-panel").hidden === true));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
