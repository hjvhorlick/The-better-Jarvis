// M2 glass UI smoke test (jsdom) against the LIVE backend on 127.0.0.1:8765.
// Loads the real web/index.html and app.js and drives them over real HTTP.
//
// Run (start the backend first, with a demo folder that it may list):
//   mkdir -p /tmp/supper-demo && echo "Launch plan" > /tmp/supper-demo/notes.txt
//   SUPPER_FILE_ROOTS=/tmp/supper-demo .venv/bin/python -m backend      # in one terminal
//   NODE_PATH=/tmp/uitest/node_modules node tests/ui/m2_ui_smoke.cjs    # in another
// Copied from the M2 scratch harness (/tmp/uitest/ui_smoke.js) into the repo so it is kept.
const fs = require("fs");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8765";
const REPO = require("path").join(__dirname, "..", "..", "web");
const html = fs.readFileSync(`${REPO}/index.html`, "utf8");
const appJs = fs.readFileSync(`${REPO}/app.js`, "utf8");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (_) {}
    await sleep(50);
  }
  return false;
}

(async () => {
  const dom = new JSDOM(html, { url: BASE + "/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  const d = w.document;
  // jsdom gaps: pointer capture, fetch with absolute URLs.
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.releasePointerCapture = function () {};
  w.fetch = (u, o) => fetch(u.startsWith("http") ? u : BASE + u, o);
  // jsdom has no layout: give the surface and tiles real sizes for the drag maths.
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.id === "surface" ? 1000 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.id === "surface" ? 500 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.classList.contains("tile") ? 132 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.classList.contains("tile") ? 120 : 0; } });
  w.eval(appJs);

  const tiles = () => Array.from(d.querySelectorAll(".tile"));
  const tileNamed = (n) => tiles().find((t) => t.querySelector(".name").textContent === n);
  const dbl = (el) => el.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
  const panel = (ws) => d.querySelector(`.panel[data-ws="${ws}"]`);

  // 1. backend status shown
  check("status reports backend online",
    await waitFor(() => d.querySelector("#status").textContent.startsWith("backend online")),
    d.querySelector("#status").textContent);

  // 2. roots appear as tiles
  check("allowed folder shown as a tile",
    await waitFor(() => !!tileNamed("supper-demo")));

  // 3. open folder by double-click
  dbl(tileNamed("supper-demo"));
  check("folder contents listed after open",
    await waitFor(() => !!tileNamed("Projects") && !!tileNamed("notes.txt")));
  const order = tiles().map((t) => t.querySelector(".name").textContent);
  check("folders sorted before files", order[0] === "Projects", order.join(", "));
  check("breadcrumb shows path", d.querySelector("#crumb-path").textContent === "/tmp/supper-demo");
  check("up button enabled inside a folder", d.querySelector("#btn-up").disabled === false);

  // 4. open a text file -> Files panel with preview
  dbl(tileNamed("notes.txt"));
  check("text file opens the Files panel", await waitFor(() => !panel("files").hidden));
  check("text preview shows the content",
    await waitFor(() => d.querySelector("#preview").textContent.includes("Launch plan")),
    JSON.stringify(d.querySelector("#preview").textContent.slice(0, 60)));

  // 5. binary file is refused cleanly
  dbl(tileNamed("logo.png"));
  check("binary file shows a clear refusal",
    await waitFor(() => d.querySelector("#preview").textContent.includes("no text preview")),
    d.querySelector("#preview").textContent);

  // 6. go up, then to the roots view
  d.querySelector("#btn-up").click();
  check("up returns to the allowed-folder list", await waitFor(() => !!tileNamed("supper-demo")));
  d.querySelector("#btn-up").click();  // at root, parent is null -> roots view
  check("up at top level stays on allowed folders", await waitFor(() => !!tileNamed("supper-demo")));

  // 7. panels slide in and out
  d.querySelector('[data-open="coding"]').click();
  check("coding panel opens", !panel("coding").hidden);
  check("only one panel open at a time", panel("marketing").hidden && panel("design").hidden && panel("files").hidden);
  d.querySelector('[data-open="coding"]').click();
  check("clicking the same button closes it", panel("coding").hidden);
  d.querySelector('[data-open="design"]').click();
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes panels", panel("design").hidden);

  // 8. drag a tile and check the position is saved
  dbl(tileNamed("supper-demo"));
  await waitFor(() => !!tileNamed("notes.txt"));
  const t = tileNamed("notes.txt");
  const before = { l: t.offsetLeft, t: t.offsetTop };
  const pe = (type, x, y) => {
    const e = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    Object.defineProperty(e, "pointerId", { value: 1 });
    return e;
  };
  t.dispatchEvent(pe("pointerdown", 100, 100));
  t.dispatchEvent(pe("pointermove", 180, 160));
  t.dispatchEvent(pe("pointerup", 180, 160));
  const saved = JSON.parse(w.localStorage.getItem("supper.tilePositions.v1") || "{}");
  const key = Object.keys(saved).find((k) => k.endsWith("/tmp/supper-demo/notes.txt"));
  check("dragged tile position is saved", !!key && saved[key].left !== before.l,
    key ? JSON.stringify(saved[key]) : "no saved key");
  check("grabbed style removed after release", !t.classList.contains("grabbed"));

  // 9. a plain click (no movement) must not move the tile
  const u = tileNamed("Projects");
  const savedBefore = JSON.stringify(JSON.parse(w.localStorage.getItem("supper.tilePositions.v1") || "{}"));
  u.dispatchEvent(pe("pointerdown", 10, 10));
  u.dispatchEvent(pe("pointerup", 10, 10));
  check("a click without movement does not save a position",
    JSON.stringify(JSON.parse(w.localStorage.getItem("supper.tilePositions.v1") || "{}")) === savedBefore);

  // 10. chat without a key shows the backend's clear message, not a crash
  d.querySelector("#input").value = "hello there";
  d.querySelector("#composer").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  check("user message appears in the log",
    await waitFor(() => Array.from(d.querySelectorAll(".msg.user")).some((m) => m.textContent === "hello there")));
  check("missing key is reported as an error message",
    await waitFor(() => d.querySelector(".msg.error") && d.querySelector(".msg.error").textContent.includes("Gemini API key")),
    d.querySelector(".msg.error") ? d.querySelector(".msg.error").textContent : "none");
  check("ring shows error state", d.querySelector("#ring").classList.contains("error"));

  // 11. XSS: a file name containing HTML must be shown as text, never executed
  const xssName = "<img src=x onerror=alert(1)>.txt";
  require("fs").writeFileSync("/tmp/supper-demo/" + xssName, "payload");
  await sleep(100);
  d.querySelector("#btn-up").click();
  await waitFor(() => !!tileNamed("supper-demo"));
  dbl(tileNamed("supper-demo"));
  await waitFor(() => !!tileNamed(xssName));
  const xssTile = tileNamed(xssName);
  check("HTML in a file name is shown as text",
    !!xssTile && xssTile.querySelector("img") === null && xssTile.querySelector(".name").textContent === xssName);
  require("fs").unlinkSync("/tmp/supper-demo/" + xssName);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  dom.window.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
