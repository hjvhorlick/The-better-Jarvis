// V2-3 voice controls check (jsdom). Loads the real web/index.html, app.js, myhands.js,
// control.js and voice.js. The backend, the WebSocket and the timers are stubbed.
// The browser must show voice state and send clicks only: no audio and no key here.
//
// Run (jsdom is not a project dependency; install it in a scratch folder):
//   mkdir -p /tmp/uitest && cd /tmp/uitest && npm init -y && npm i jsdom@24
//   NODE_PATH=/tmp/uitest/node_modules node /home/user/The-better-Jarvis/tests/ui/voice_ui.cjs
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8765";
const REPO = path.join(__dirname, "..", "..", "web");
const html = fs.readFileSync(`${REPO}/index.html`, "utf8");
const scripts = ["app.js", "myhands.js", "control.js", "voice.js"].map((f) => fs.readFileSync(`${REPO}/${f}`, "utf8"));

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
  let voice = { live: false, origin: "", muted: false,
                wake: { enabled: false, available: true, reason: "ready" },
                idle_off_s: 60, last_error: "", mic: {}, speaker: {} };
  let startStatus = null;      // override the response to POST /api/voice/start
  let wakeReply = null;        // override the response to POST /api/voice/wake
  let testReply = { ok: true, checks: [
    { name: "speaker", ok: true, detail: "played a one-second beep" },
    { name: "microphone", ok: true, detail: "heard you clearly (loudest level 1800, threshold 600)" },
  ] };                         // the response to POST /api/voice/test
  let pending = [];

  w.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    let status = 200;
    let data = {};
    if (url === "/api/status") data = { api_key_configured: true, text_model: "x", file_roots_available: 1, gemini_budget: { used: 0, limit: 20, remaining: 20 } };
    else if (url === "/api/files/roots") data = { roots: [] };
    else if (url === "/api/confirmations") data = { pending: pending.slice() };
    else if (url === "/api/diagnostics") data = {};
    else if (url === "/api/voice/status") data = voice;
    else if (url === "/api/voice/start") {
      if (startStatus) { status = startStatus.status; data = { detail: startStatus.detail }; startStatus = null; }
      else { voice = { ...voice, live: true, origin: "button" }; data = voice; }
    } else if (url === "/api/voice/stop") { voice = { ...voice, live: false, origin: "" }; data = voice; }
    else if (url === "/api/voice/mute") { voice = { ...voice, muted: body.muted }; data = voice; }
    else if (url === "/api/voice/test") data = testReply;
    else if (url === "/api/voice/wake") {
      if (wakeReply) { data = wakeReply; wakeReply = null; }
      else if (!body.enabled) { voice = { ...voice, wake: { ...voice.wake, enabled: false } }; data = voice; }
      else data = { confirmation: { id: "w1", action: "voice.wake", summary: "Listen for Hey Jarvis.", expires_at: Date.now() / 1000 + 120 } };
    }
    return { ok: status < 400, status, json: async () => data };
  };
  w.WebSocket = class {
    constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; }
    close() { this.closed = true; }
  };
  w.navigator.sendBeacon = () => true;
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.id === "surface" ? 1000 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.id === "surface" ? 500 : 0; } });

  for (const s of scripts) w.eval(s);
  await sleep(150);

  const $ = (sel) => d.querySelector(sel);
  const click = async (sel) => { $(sel).click(); await sleep(60); };
  const posts = (url) => calls.filter((c) => c.method === "POST" && c.url === url);

  // 1. the page shows the state it was given
  check("voice chip starts as 'voice off'", await waitFor(() => $("#voice-chip").textContent === "voice off"),
    $("#voice-chip").textContent);
  check("Voice button is not pressed when off", $("#btn-voice").getAttribute("aria-pressed") === "false");
  check("the placeholder 'M3' button is gone", !d.body.textContent.includes("M3"));

  // 2. Voice on: a click sends one start request, and the chip follows the server
  await click("#btn-voice");
  check("clicking Voice sends POST /api/voice/start", await waitFor(() => posts("/api/voice/start").length === 1));
  check("button shows 'Stop voice' and is pressed once live",
    await waitFor(() => $("#btn-voice").textContent === "Stop voice" && $("#btn-voice").getAttribute("aria-pressed") === "true"));
  check("chip says voice is on", await waitFor(() => $("#voice-chip").textContent === "voice on"), $("#voice-chip").textContent);

  // 3. Mute toggles through the server, not in the browser
  await click("#btn-mute");
  check("Mute sends muted: true", posts("/api/voice/mute").at(-1)?.body?.muted === true);
  check("chip says muted", await waitFor(() => $("#voice-chip").textContent === "voice on · muted"));
  check("Mute button now offers Unmute", $("#btn-mute").textContent === "Unmute");
  await click("#btn-mute");
  check("Unmute sends muted: false", posts("/api/voice/mute").at(-1)?.body?.muted === false);

  // 4. Voice off
  await click("#btn-voice");
  check("clicking Stop voice sends POST /api/voice/stop", await waitFor(() => posts("/api/voice/stop").length === 1));
  check("chip returns to 'voice off'", await waitFor(() => $("#voice-chip").textContent === "voice off"));

  // 5. Start refused by the server shows the reason in the chat, not a silent failure
  startStatus = { status: 503, detail: "No Gemini API key on this server. Voice needs one." };
  await click("#btn-voice");
  check("a refused start shows the server's reason in the log",
    await waitFor(() => $("#log").textContent.includes("No Gemini API key on this server")));
  check("the Voice button stays off after a refusal", await waitFor(() => $("#btn-voice").getAttribute("aria-pressed") === "false"));

  // 6. Wake word needs the owner's OK: clicking asks, and does not switch on by itself
  await click("#btn-wake");
  check("turning wake on sends enabled: true", posts("/api/voice/wake").at(-1)?.body?.enabled === true);
  check("the wake button is still off until approved", $("#btn-wake").getAttribute("aria-pressed") === "false");
  check("the owner is told to approve it in the panel",
    await waitFor(() => $("#log").textContent.includes("Wake word needs your OK")));

  // 7. Wake word unavailable (no model yet): the button is disabled and says why,
  //    and the status chip carries the reason too (a tooltip alone is too easy to miss).
  voice = { ...voice, wake: { enabled: false, available: false, reason: "wake word model not downloaded yet" } };
  await sleep(3200);                                   // one poll cycle
  check("wake button is disabled when the model is missing", await waitFor(() => $("#btn-wake").disabled === true));
  check("the wake button explains why", $("#btn-wake").title.includes("not downloaded yet"), $("#btn-wake").title);
  check("the status chip shows the wake reason",
    $("#voice-chip").textContent.includes("wake word not ready") &&
    $("#voice-chip").textContent.includes("not downloaded yet"), $("#voice-chip").textContent);

  // 7b. The audio self-test: the button posts, and the result lines land in the chat
  await click("#btn-voicetest");
  check("the test button posts to /api/voice/test",
    await waitFor(() => posts("/api/voice/test").length === 1));
  const logText = () => $("#log").textContent;
  check("a passing test is reported line by line",
    await waitFor(() => logText().includes("Audio test passed.") && logText().includes("✓ speaker")),
    logText().slice(-200));
  testReply = { ok: false, checks: [
    { name: "speaker", ok: true, detail: "played a one-second beep" },
    { name: "microphone", ok: false, detail: "no audio arrived from the microphone" },
  ] };
  await click("#btn-voicetest");
  check("a failing test shows the failed line as an error",
    await waitFor(() => {
      const errs = d.querySelectorAll("#log .msg.error");
      return [...errs].some((e) => e.textContent.includes("✗ microphone — no audio arrived"));
    }), logText().slice(-200));

  // 8. Turning wake off is immediate
  voice = { ...voice, wake: { enabled: true, available: true, reason: "ready" } };
  await sleep(3200);
  await click("#btn-wake");
  check("turning wake off sends enabled: false", posts("/api/voice/wake").at(-1)?.body?.enabled === false);

  // 9. Events from the stream: transcripts go to the chat with a voice tag
  w.SupperVoice.onEvent({ type: "voice_turn", role: "user", text: "what time is it" });
  w.SupperVoice.onEvent({ type: "voice_turn", role: "assistant", text: "It is ten past two." });
  check("the owner's words appear in the chat, tagged voice",
    await waitFor(() => $("#log .msg.user .tag")?.textContent === "voice"));
  check("the assistant's words appear in the chat",
    $("#log .msg.assistant")?.textContent.includes("It is ten past two."));

  // 10. A voice fault appears as an error line, and the page does not render any markup from it
  w.SupperVoice.onEvent({ type: "voice_error", reason: "connection", message: "<img src=x onerror=alert(1)>" });
  const lastError = () => { const all = d.querySelectorAll("#log .msg.error"); return all[all.length - 1]?.textContent || ""; };
  check("a voice error is shown as text", await waitFor(() => lastError().includes("<img src=x")), lastError());
  check("no element is created from the error text", $("#log img") === null);

  // 11. Nothing secret or audio-related is sent from the browser
  const sent = calls.filter((c) => c.method === "POST").map((c) => JSON.stringify(c.body || {})).join(" ");
  check("browser sends no key and no audio",
    !/key|api_key|audio|pcm|base64/i.test(sent) && calls.every((c) => !c.url.includes("generativelanguage")));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  w.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
