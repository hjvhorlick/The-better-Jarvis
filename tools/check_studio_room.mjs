/* Runs the real shell.js, register.js and studio.js under a DOM shim, with a
 * fake server behind fetch, and checks the Studio mounts, wires every tool,
 * and drives script preparation, project CRUD, copy, and honest manual Scenering handoff.
 *
 * Run: node tools/check_studio_room.mjs
 *
 * It needs no packages: a DOM shim stands in for the browser, and fetch is
 * replaced with a fake server, so nothing touches the network.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../web/", import.meta.url).pathname;

// ---------- canvas, elements, document ----------
const ALL_CALLS = [];
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, on) => {
        const want = on === undefined ? !this.classList._s.has(c) : on;
        if (want) this.classList._s.add(c); else this.classList._s.delete(c);
        return want;
      },
      contains: (c) => this.classList._s.has(c),
    };
    this._listeners = {};
    this._className = "";
    this._id = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.rows = 0;
    this.width = 0;
    this.height = 0;
    this.files = [];
    if (this.tagName === "CANVAS") {
      this.getContext = () => ({
        globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
        font: "", textAlign: "", textBaseline: "", lineCap: "", lineJoin: "",
        fillRect: () => {}, clearRect: () => {}, beginPath: () => {},
        moveTo: () => {}, lineTo: () => {}, arc: () => {}, ellipse: () => {},
        rect: () => {}, fill: () => {}, stroke: () => {}, save: () => {},
        restore: () => {}, drawImage: () => {}, fillText: () => {},
        strokeText: () => {}, putImageData: () => {}, setLineDash: () => {},
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      });
      this.captureStream = () => ({ getTracks: () => [] });
      this.toDataURL = () => "data:image/png;base64,AAAA";
    }
  }
  get id() { return this._id; }
  set id(v) {
    this._id = v;
    if (v) byId.set(v, this);
    this.attributes.id = String(v);
  }
  get className() { return this._className; }
  set className(v) {
    this._className = v;
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id") { this._id = String(v); byId.set(String(v), this); }
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener(t) { delete this._listeners[t]; }
  dispatch(t, evt = {}) {
    const e = { type: t, target: this, preventDefault() {}, stopPropagation() {}, ...evt };
    (this._listeners[t] || []).forEach((fn) => fn(e));
    return e;
  }
  click() { return this.dispatch("click"); }
  input(v) { this.value = v; return this.dispatch("input"); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    // Handles "tag", ".class", "#id", and a descendant chain such as
    // ".studio-shot-head button". A chain returns the *last* matched element.
    const parts = sel.trim().split(/\s+/);
    const matchOne = (n, one) => {
      if (one.startsWith(".")) return n.classList.contains(one.slice(1));
      if (one.startsWith("#")) return n.id === one.slice(1);
      return n.tagName === one.toUpperCase();
    };
    const chainOk = (node, i) => {
      if (i < 0) return true;
      let p = node.parentNode;
      while (p) {
        if (matchOne(p, parts[i]) && chainOk(p, i - 1)) return true;
        p = p.parentNode;
      }
      return false;
    };
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matchOne(c, parts[parts.length - 1]) && chainOk(c, parts.length - 2)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width || 1280, height: this.height || 720 };
  }
  setPointerCapture() {}
  focus() {}
  select() { this.selected = true; }
  closest() { return null; }
}

const byId = new Map();
const document = {
  createElement: (t) => new El(t),
  getElementById: (id) => byId.get(id) || null,
  querySelector: (sel) => (sel.startsWith("#") ? byId.get(sel.slice(1)) || null : null),
  querySelectorAll: () => [],
  addEventListener() {},
  body: new El("body"),
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = document;
globalThis.performance = { now: () => Date.now() };
globalThis.location = { protocol: "http:", host: "localhost", origin: "http://localhost" };
globalThis.__promptAnswer = "Renamed project";
globalThis.prompt = () => globalThis.__promptAnswer;
globalThis.confirm = () => true;
globalThis.window = globalThis;
const windowListeners = new Map();
globalThis.addEventListener = (type, fn) => {
  if (!windowListeners.has(type)) windowListeners.set(type, []);
  windowListeners.get(type).push(fn);
};
globalThis.dispatchWindowMessage = (data) => {
  for (const fn of windowListeners.get("message") || []) fn({ type: "message", origin: location.origin, source: globalThis.parent, data });
};
globalThis.__parentMessages = [];
globalThis.parent = { postMessage: (data) => globalThis.__parentMessages.push(data) };
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};
globalThis.open = () => ({});
Object.defineProperty(globalThis, "navigator", {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async (t) => {
    if (globalThis.__clipboardFail) throw new Error("clipboard denied");
    globalThis.__clipboard = t;
  } } },
});
globalThis.__clipboard = null;
globalThis.__clipboardFail = false;
globalThis.MediaRecorder = class {
  constructor(stream, opts) { this.opts = opts; globalThis.__recorder = this; }
  static isTypeSupported(m) { return m.includes("vp9"); }
  start() { this.started = true; }
  stop() { if (this.onstop) this.onstop(); }
  ondataavailable = null;
  onstop = null;
};
globalThis.FileReader = class {
  readAsDataURL() { setTimeout(() => this.onload && this.onload({ target: { result: "data:," } }), 0); }
};
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
globalThis.Image = class {
  constructor() { this.onload = null; this.onerror = null; this.width = 100; this.height = 60; }
  set src(v) { this._src = v; if (this.onload) setTimeout(() => this.onload(), 0); }
  get src() { return this._src; }
};
globalThis.__fetch = [];

// ---------- the fake server ----------
const SCRIPT = {
  title: "Why the ocean is salty",
  title_variants: ["The salt in the sea", "Where ocean salt comes from"],
  hook: "The sea is salty. Here is why.",
  logline: "A short explainer on ocean salinity.",
  shots: [
    { narration: "The ocean covers most of the planet.", on_screen: "71 percent",
      image_prompt: "earth from space, blue ocean", seconds: 5, citations: [] },
    { narration: "Rivers carry salt into it.", on_screen: "Rivers bring salt",
      image_prompt: "a river meeting the sea", seconds: 5, citations: [] },
  ],
  description: "A short explainer.",
  hashtags: ["ocean", "science"],
  seconds: 10,
  words: 14,
  music_suggestion: "Soft strings (creative suggestion).",
  sound_effects: "A light chime (creative suggestion).",
  creative_notes: "Use clear illustrations.",
};
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
let projectSequence = 0;
const savedProjects = [];
const copyText = (project, format) => {
  if (!project.script && format !== "project") return "";
  if (format === "script") return [project.title, "", project.script.hook, "", ...project.script.shots.flatMap((s) => [s.narration, ""])].join("\n").trim();
  if (format === "scenes") return project.script.shots.map((s, i) => `Scene ${i + 1} (${s.seconds}s)\nNarration: ${s.narration}\nOn-screen text: ${s.on_screen}\nVisual: ${s.image_prompt}`).join("\n\n");
  return `Project: ${project.title}\nTopic: ${project.topic}\nFormat: ${project.format}\nTarget duration: ${project.durationSeconds} seconds\nStatus: ${project.status}`;
};
const projectSummary = (p) => ({ id: p.id, title: p.title, topic: p.topic, audience: p.audience,
  format: p.format, durationSeconds: p.durationSeconds, status: p.status, createdAt: p.createdAt,
  updatedAt: p.updatedAt, sourceCount: (p.research && p.research.sources || []).length });
globalThis.fetch = async (url, opts = {}) => {
  globalThis.__fetch.push({ url: String(url), opts });
  const body = opts.body ? JSON.parse(opts.body) : {};
  const method = String(opts.method || "GET").toUpperCase();
  const parsed = new URL(String(url), "http://localhost");
  const pathname = parsed.pathname;
  const json = (data, ok = true, status = ok ? 200 : 400) => ({
    ok, status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  if (pathname === "/api/studio/status") return json({ ok: true, scriptReady: true, sceneringImportSupported: false, handoff: "manual-copy" });
  if (pathname === "/api/studio/research-reports") return json({ ok: true, reports: [] });
  if (pathname === "/api/studio/scripts" && method === "POST") return json({ ok: true, script: structuredClone(SCRIPT), research: null });
  if (pathname === "/api/studio/projects" && method === "GET") {
    const q = (parsed.searchParams.get("q") || "").toLowerCase();
    const projects = savedProjects.filter((p) => !q || `${p.title} ${p.topic}`.toLowerCase().includes(q)).map(projectSummary);
    return json({ ok: true, projects, warning: "" });
  }
  if (pathname === "/api/studio/projects" && method === "POST") {
    const id = projectSequence++ === 0 ? PROJECT_ID : `123e4567-e89b-42d3-a456-42661417400${projectSequence}`;
    const project = { ...structuredClone(body), id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: body.script ? "script-ready" : "brief" };
    if (project.script) project.script.title = project.title;
    savedProjects.push(project);
    return json({ ok: true, project }, true, 201);
  }
  const projectMatch = pathname.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})(?:\/(text|duplicate))?$/i);
  if (projectMatch) {
    const [, id, tail] = projectMatch;
    const index = savedProjects.findIndex((p) => p.id === id);
    if (tail === "text" && method === "GET") {
      if (index < 0) return json({ error: "not found" }, false, 404);
      return json({ ok: true, text: copyText(savedProjects[index], parsed.searchParams.get("format")) });
    }
    if (tail === "duplicate" && method === "POST") {
      if (index < 0) return json({ error: "not found" }, false, 404);
      const p = structuredClone(savedProjects[index]);
      p.id = `123e4567-e89b-42d3-a456-42661417400${++projectSequence}`;
      p.title = `Copy of ${p.title}`;
      p.script && (p.script.title = p.title);
      p.createdAt = p.updatedAt = new Date().toISOString();
      savedProjects.push(p);
      return json({ ok: true, project: p }, true, 201);
    }
    if (index < 0) return json({ error: "not found" }, false, 404);
    if (method === "GET") return json({ ok: true, project: savedProjects[index] });
    if (method === "PUT") {
      savedProjects[index] = { ...structuredClone(body), id, createdAt: savedProjects[index].createdAt,
        updatedAt: new Date().toISOString(), status: body.script ? "script-ready" : "brief" };
      savedProjects[index].script && (savedProjects[index].script.title = savedProjects[index].title);
      return json({ ok: true, project: savedProjects[index] });
    }
    if (method === "PATCH") {
      savedProjects[index].title = body.title;
      savedProjects[index].script && (savedProjects[index].script.title = body.title);
      savedProjects[index].updatedAt = new Date().toISOString();
      return json({ ok: true, project: savedProjects[index] });
    }
    if (method === "DELETE") { savedProjects.splice(index, 1); return json({ ok: true, id }); }
  }
  if (pathname.startsWith("/api/studio/research-reports/")) return json({ error: "not found" }, false, 404);
  if (pathname === "/api/media/image") {
    return json({ id: "pic.jpg", kind: "images", url: "/api/media/file/images/pic.jpg",
      name: body.name || "a picture", prompt: body.prompt, size: [720, 1280] });
  }
  if (pathname === "/api/media/save") {
    return json({ id: "vid.webm", kind: "video", url: "/api/media/file/video/vid.webm", name: body.name || "video" });
  }
  if (pathname === "/api/media/library") return json({ items: [], counts: { images: 0, video: 0, audio: 0 } });
  if (pathname === "/api/media/options") {
    return json({ aspects: { "9:16": [720, 1280], "16:9": [1280, 720] }, models: ["flux", "turbo"],
      counts: {}, scenering: "https://scenering.com", script_ready: true });
  }
  return json({ error: "not found" }, false, 404);
};

// ---------- the shell's elements ----------
function fixture() {
  const rail = new El("section"); rail.id = "env-rail";
  const bar = new El("div"); bar.className = "env-bar";
  const prev = new El("button"); prev.id = "env-prev"; prev.disabled = true;
  const label = new El("span"); label.id = "env-label"; label.textContent = "Super AI Agent";
  const fps = new El("span"); fps.id = "env-fps";
  const next = new El("button"); next.id = "env-next"; next.disabled = true;
  const track = new El("div"); track.id = "env-track";
  bar.append(prev, label, fps, next);
  rail.append(bar, track);
  const switcher = new El("nav"); switcher.id = "env-switcher";
  const body = new El("body");
  body.append(switcher, rail);
  document.body = body;
  for (const el of [rail, bar, prev, label, fps, next, track, switcher]) byId.set(el.id, el);
}
fixture();

// ---------- load ----------
const TMP = "/tmp/studio-test-modules";
fs.mkdirSync(TMP, { recursive: true });
function load(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const dest = path.join(TMP, path.basename(file).replace(/\.js$/, ".mjs"));
  fs.writeFileSync(dest, src);
  return import(pathToFileURL(dest).href);
}
await load("shell.js");
const shell = globalThis.window.Shell;
await load("environments/register.js");
shell._setLoader((id) => load(`environments/${id}.js`));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) console.log("FAIL:", name, detail ?? "");
};
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------- open the Studio ----------
const slides = document.getElementById("env-track").children;
const slide = slides.find((s) => s.dataset.env === "studio");
check("the Studio registered as a slide", Boolean(slide));
await shell.open("studio");
await settle();

const body = slide.querySelector(".env-body");
check("the Studio mounted", Boolean(body.querySelector(".studio")));

// ---------- the brief controls ----------
const brief = document.getElementById("studio-brief-input");
const secs = document.getElementById("studio-seconds");
const aspect = document.getElementById("studio-aspect");
const model = document.getElementById("studio-model");
check("there is a box for the brief", Boolean(brief));
check("the length can be set", Boolean(secs) && secs._listeners.input?.length > 0);
check("the requested 16:9 and 9:16 shapes can be set", Boolean(aspect) && aspect.children.length === 2);
check("the picture model can be set", Boolean(model) && model.children.length === 2);

// ---------- every tool is wired ----------
const strip = slide.querySelector(".env-tools");
const tools = strip.querySelectorAll(".env-tool");
check("the tool strip has tools", tools.length >= 6, `${tools.length} tools`);
const dead = tools.filter((t) => t.tagName === "BUTTON" && !t._listeners.click?.length);
check("every tool button has a handler", dead.length === 0, dead.map((t) => t.textContent).join(", "));
const names = tools.map((t) => t.textContent);
for (const want of ["Jarvis, write it", "All pictures", "Compile video", "Copy for Scenering", "Open Scenering"]) {
  check(`the ${want} tool exists`, names.includes(want));
}

// ---------- the whole pipeline ----------
brief.input("why the ocean is salty");
secs.input("30");
aspect.value = "9:16";
await document.getElementById("tool-studio-write").click();
await settle();

const scriptCalls = globalThis.__fetch.filter((f) => f.url.includes("/api/studio/scripts"));
check("writing asks the primary server for a script", scriptCalls.length === 1);
check("the topic was sent", JSON.parse(scriptCalls[0].opts.body).topic === "why the ocean is salty");
check("the length was sent", JSON.parse(scriptCalls[0].opts.body).durationSeconds === 30);
check("the selected aspect ratio was sent", JSON.parse(scriptCalls[0].opts.body).format === "9:16");
check("Studio sends the dashboard session token to its authenticated API", scriptCalls[0].opts.headers.Authorization === "Bearer jarvis-live-session-token");

const shotCards = body.querySelectorAll(".studio-shot");
check("the script renders one card per shot", shotCards.length === 2, `${shotCards.length} cards`);
check("the title is filled in", document.getElementById("studio-title").value === "Why the ocean is salty");
const variants = document.getElementById("studio-variants");
check("the other titles are offered", variants.hidden === false && variants.children.length === 3);

// a card carries its caption, narration and picture prompt, all editable
const card = shotCards[0];
const cap = card.querySelector(".studio-shot-caption");
const nar = card.querySelector(".studio-shot-narration");
const prm = card.querySelector(".studio-shot-prompt");
check("a shot card has an editable caption", cap.value === "71 percent");
check("a shot card has an editable narration", nar.value.startsWith("The ocean covers"));
check("a shot card has an editable picture prompt", prm.value === "earth from space, blue ocean");

// making a picture for one shot
await card.querySelector(".studio-shot-head button").click();
await settle();
const picCalls = globalThis.__fetch.filter((f) => f.url.includes("/api/media/image"));
check("making a picture asks the server", picCalls.length === 1);
check("the picture prompt was sent", JSON.parse(picCalls[0].opts.body).prompt === "earth from space, blue ocean");
check("the picture appears on the card", Boolean(body.querySelector(".studio-shot-img")));

// the library is read
check("the library is read", globalThis.__fetch.some((f) => f.url.includes("/api/media/library")));

// ---------- the Scenering hand-off ----------
globalThis.__clipboard = null;
await document.getElementById("tool-studio-scenering").click();
await settle();
check("the script and title go to the clipboard", typeof globalThis.__clipboard === "string");
check("the clipboard holds the title", globalThis.__clipboard.startsWith("Why the ocean is salty"));
check("the clipboard holds the shots in order",
  globalThis.__clipboard.indexOf("The ocean covers") < globalThis.__clipboard.indexOf("Rivers carry salt"));
check("the clipboard holds the script narration", globalThis.__clipboard.includes("The ocean covers most of the planet."));
check("the script is copied as plain text, not an import payload", !globalThis.__fetch.some((f) => f.url.includes("scenering")));

globalThis.__clipboard = null;
await document.getElementById("studio-action-copy-scene-breakdown").click();
await settle();
check("the scene breakdown copy includes on-screen text", globalThis.__clipboard.includes("On-screen text: 71 percent"));
check("the scene breakdown copy includes visual prompts", globalThis.__clipboard.includes("Visual: earth from space, blue ocean"));
globalThis.__clipboardFail = true;
await document.getElementById("studio-action-copy-project-brief").click();
await settle();
check("clipboard denial shows the actual text for manual copying", !body.querySelector(".studio-copy-fallback").hidden
  && body.querySelector(".studio-copy-fallback").value.includes("Why the ocean is salty"));
check("clipboard denial reports failure honestly", body.querySelector(".studio-readout").textContent.includes("Clipboard access failed"));
globalThis.__clipboardFail = false;

let opened = null;
globalThis.open = (u) => { opened = u; return {}; };
await document.getElementById("tool-studio-open").click();
check("Scenering is opened separately", opened === "https://scenering.com");
check("Studio states that handoff is manual", body.querySelector(".studio-project-shelf").children.some((node) => String(node.textContent).includes("No supported project-import API")));
check("the Studio announced itself to the parent command bridge", globalThis.__parentMessages.some((m) => m.type === "studio_ready"));

// ---------- compiling ----------
await document.getElementById("tool-studio-compile").click();
await settle();
// Compiling records in real time — a 5-second shot really takes 5 seconds.
const untilSave = async (ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (globalThis.__fetch.some((f) => f.url.includes("/api/media/save"))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const kept = await untilSave(30000);
await settle();
const rec = globalThis.__recorder;
check("compiling records the canvas", Boolean(rec && rec.started));
check("it records as WebM", rec && /video\/webm/.test(rec.opts.mimeType));
check("the compiled video is kept in the library", kept);
check("it is saved as a video, with its title",
  globalThis.__fetch.some((f) => f.url.includes("/api/media/save")
    && JSON.parse(f.opts.body).name === "Why the ocean is salty"));

// ---------- saved project lifecycle and the iframe command bridge ----------
check("copy saved the preparation workspace as a local project", savedProjects.length === 1);
const originalProjectId = savedProjects[0] && savedProjects[0].id;
check("saved projects have a stable UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(originalProjectId || ""));
await document.getElementById("studio-action-duplicate").click();
await settle();
check("duplicate creates a separate saved project", savedProjects.length === 2 && savedProjects[1].id !== originalProjectId);
const duplicateId = savedProjects[1] && savedProjects[1].id;
await document.getElementById("studio-action-rename").click();
await settle();
check("rename retains the stable project ID", savedProjects.find((p) => p.id === duplicateId)?.title === "Renamed project");
const projectSearchBox = body.querySelectorAll(".studio-project-shelf input")[0];
projectSearchBox.input("Renamed");
await settle();
check("saved projects can be searched", body.querySelectorAll(".studio-project-row").length === 1);
const openButton = body.querySelector(".studio-project-open");
await openButton.click();
await settle();
check("a saved project can be reopened by its stable ID", globalThis.__fetch.some((f) => f.url === `/api/studio/projects/${duplicateId}`));
let confirms = 0;
globalThis.confirm = () => { confirms++; return false; };
await document.getElementById("studio-action-delete").click();
await settle();
check("cancelled deletion keeps the saved project", confirms === 1 && savedProjects.some((p) => p.id === duplicateId));
globalThis.confirm = () => { confirms++; return true; };
await document.getElementById("studio-action-delete").click();
await settle();
check("confirmed deletion removes only the selected project", confirms === 2 && savedProjects.length === 1 && !savedProjects.some((p) => p.id === duplicateId));
globalThis.dispatchWindowMessage({ type: "studio_control", command: { action: "search-projects", query: "salty" } });
await settle();
check("the parent can forward voice/chat project actions into Studio", projectSearchBox.value === "salty");

// ---------- report ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
if (failed.length) {
  console.log("failures:");
  for (const f of failed) console.log("  -", f.name, f.detail ?? "");
  process.exit(1);
}
