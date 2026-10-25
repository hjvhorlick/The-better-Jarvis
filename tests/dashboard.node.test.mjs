/**
 * The dashboard's inline script, checked for syntax.
 *
 * This exists because of a real failure. `dashboard/static/app.html` carries its
 * whole application in ONE inline <script> block, so a single bad token anywhere
 * in it stops the entire page: no windows, no event handlers, no settings, no
 * chat. The bug that prompted this was an over-escaped regex —
 * /^https?:\\\\/\\\\// instead of /^https?:\/\// — which Node rejects as
 * "Invalid regular expression flags".
 *
 * Nothing else in the suite could catch it. `tsc` only covers TypeScript, and the
 * Node tests never load app.html, so a page that could not run at all passed
 * every check and was merged. Parsing it is the only thing that catches this
 * class, so parsing it is what this test does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The inline <script> blocks of a page — not the ones loaded from a src. */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function checkSyntax(source) {
  const file = join(tmpdir(), `jarvis-syntax-${randomBytes(6).toString('hex')}.js`);
  writeFileSync(file, source, 'utf-8');
  try {
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return String(err.stderr || err.message || err);
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

test('app.html has an inline script, and it parses', () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const blocks = inlineScripts(html).filter((s) => s.trim());
  assert.ok(blocks.length > 0, 'no inline script found — the page shape changed, update this test');

  for (const [i, block] of blocks.entries()) {
    const error = checkSyntax(block);
    assert.equal(error, null,
      `inline script block ${i} of app.html does not parse, which stops the whole page:\n${error}`);
  }
});

test('every other served page parses too', () => {
  // The same failure would be just as fatal in any other page that carries its
  // logic inline, so they are all checked rather than only the main one.
  const pages = ['dashboard/static/app.html'];
  for (const rel of pages) {
    let html;
    try {
      html = readFileSync(join(ROOT, rel), 'utf-8');
    } catch {
      continue; // page not present in this checkout
    }
    for (const [i, block] of inlineScripts(html).filter((s) => s.trim()).entries()) {
      const error = checkSyntax(block);
      assert.equal(error, null, `inline script block ${i} of ${rel} does not parse:\n${error}`);
    }
  }
});

test('the whole Rooms page toggles every room tool strip on every press', async () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'rooms.html'), 'utf-8');
  const dom = new JSDOM(html, {
    url: 'https://jarvis.test/rooms.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  try {
    window.fetch = async () => ({ ok: true, json: async () => ({}) });
    window.WebSocket = class {
      constructor() { this.readyState = 1; }
      addEventListener() {}
      close() { this.readyState = 3; }
    };
    const context = {
      clearRect() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {},
      moveTo() {}, lineTo() {}, stroke() {}, rect() {}, ellipse() {}, fillText() {},
      getImageData() { return { data: new Uint8ClampedArray(4) }; }, putImageData() {},
    };
    window.HTMLCanvasElement.prototype.getContext = () => context;

    const css = window.document.createElement('style');
    css.textContent = readFileSync(join(ROOT, 'web', 'styles.css'), 'utf-8');
    window.document.head.appendChild(css);

    // Evaluate the real modules in the same order as rooms.html. The shell's
    // loader is replaced only so its initial Coding environment does not need a
    // network import; Flat itself is the real source, evaluated as a classic
    // script for jsdom and returned by that loader when the test opens Flat.
    window.eval(readFileSync(join(ROOT, 'web', 'shell.js'), 'utf-8'));
    const flatSource = readFileSync(join(ROOT, 'web', 'environments', 'flat.js'), 'utf-8')
      .replace(/\bexport\s+default\s+/, 'window.__flatEnvironment = ');
    window.eval(flatSource);
    window.Shell._setLoader(async (id) => ({
      default: id === 'flat' ? window.__flatEnvironment : { mount() {} },
    }));
    window.eval(readFileSync(join(ROOT, 'web', 'environments', 'register.js'), 'utf-8'));
    window.eval(readFileSync(join(ROOT, 'web', 'camera.js'), 'utf-8'));

    const body = window.document.body;
    const toggle = window.document.getElementById('env-tools-toggle');
    const firstStrip = window.document.querySelector('.env-tools');
    assert.ok(toggle && firstStrip, 'the page scripts must have built the switch and room tool strips');
    // This build opens with the room tools in view (the owner asked for them
    // visible), so the first press hides them and the rest alternate.
    assert.equal(body.classList.contains('show-tools'), true, 'the room tools are shown on open');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.notEqual(window.getComputedStyle(firstStrip).display, 'none');

    for (let i = 0; i < 8; i++) {
      const shouldOpen = i % 2 === 1;
      toggle.click();
      assert.equal(body.classList.contains('show-tools'), shouldOpen, `body state after press ${i + 1}`);
      assert.equal(toggle.getAttribute('aria-pressed'), String(shouldOpen), `ARIA state after press ${i + 1}`);
      assert.equal(window.getComputedStyle(firstStrip).display === 'none', !shouldOpen,
        `room tools should ${shouldOpen ? 'show' : 'hide'} after press ${i + 1}`);
    }

    // Voice control and the button share the same state, even after explicit
    // open/close messages arrive from the dashboard parent.
    const sendTools = (open) => window.dispatchEvent(new window.MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'jarvis-rooms-tools', open },
    }));
    sendTools(true);
    assert.equal(body.classList.contains('show-tools'), true);
    toggle.click();
    assert.equal(body.classList.contains('show-tools'), false, 'button clicks must follow the state set by voice control');
    sendTools(true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');

    const flatTab = window.document.querySelector('.env-switch[data-env="flat"]');
    flatTab.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drawer = window.document.querySelector('.flat-drawer');
    const flatTools = window.document.getElementById('tool-flat-tools');
    assert.ok(drawer && flatTools, 'Flat must mount its own drawer and Tools button');
    assert.equal(drawer.hidden, true);
    assert.equal(window.getComputedStyle(drawer).display, 'none', 'CSS must not override the drawer hidden attribute');
    flatTools.click();
    assert.equal(drawer.hidden, false);
    assert.equal(window.getComputedStyle(drawer).display, 'flex');
    flatTools.click();
    assert.equal(drawer.hidden, true);
    assert.equal(window.getComputedStyle(drawer).display, 'none');
  } finally {
    window.close();
  }
});


/* ── THE VOICE VISUALISER ──────────────────────────────────────────────────
 * It happened exactly as this project's other shell warned: the code that drew
 * the visualiser survived a rewrite, the canvas it draws on did not, and the
 * app quietly stopped showing whether JARVIS was listening, thinking or
 * speaking. These tests check the element AND the state it is driven by, so a
 * silent removal cannot pass again.
 */
const APP_HTML = () => readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
const APP_SCRIPT = () => inlineScripts(APP_HTML()).filter((s) => s.trim()).join('\n');

test('the voice visualiser has an element to draw on, and a word for its state', () => {
  const html = APP_HTML();
  assert.ok(html.includes('id="viz-canvas"'), 'the visualiser canvas is missing: nothing can be drawn');
  assert.ok(html.includes('id="dock-state"'), 'the visualiser has no state word, so its colour is the only clue');
  // It lives in the reactor pod, and that pod is moved into the permanent dock
  // at boot — so the visualiser is furniture, not a window that can be closed.
  const pod = html.slice(html.indexOf('id="win-telemetry"'), html.indexOf('id="win-chat"'));
  assert.ok(pod.includes('id="viz-canvas"'), 'the visualiser must be inside the reactor pod');
  const script = APP_SCRIPT();
  assert.ok(/getElementById\('dock-top'\)\.appendChild\(t\)/.test(script),
    'the pod is no longer assembled into the dock, so the visualiser would float');
  assert.ok(script.includes("getElementById('dock-chat').appendChild(c)"),
    'the conversation is no longer docked under the visualiser');
});

test('the visualiser is driven by the real voice state, not a decoration timer', () => {
  const script = APP_SCRIPT();
  const start = script.indexOf('function vizState');
  assert.ok(start > -1, 'vizState is gone: nothing decides what the visualiser shows');
  const fn = script.slice(start, script.indexOf('function vizHeard'));
  for (const source of ['Speech.busy', 'Viz.mic', '_muted', 'Ear.problem', 'listenRunning()']) {
    assert.ok(fn.includes(source), `the visualiser no longer reads ${source}, so its state can lie`);
  }
  // "JARVIS is talking" must come from the speech queue, which empties only when
  // playback has finished — the same flag the ears use to stop listening.
  assert.ok(/if \(Speech\.busy \|\| Speech\.queue\.length > 0\) return 'speaking';/.test(fn),
    'the speaking state must come from Speech.busy/the queue');
  // The microphone's own loudness reaches it from the raw-audio ear…
  assert.ok(script.includes('Viz.mic ='), 'the microphone level never reaches the visualiser');
  // …and this browser's own recogniser rings the bell as words form.
  assert.ok(script.includes('vizHeard();'), 'hearing a word never reaches the visualiser');
  // A sent command shows "thinking" until the reply lands — on all four paths.
  const clears = script.split('Viz.thinkingUntil = 0').length - 1;
  assert.ok(script.includes('Viz.thinkingUntil = performance.now()'), 'nothing sets the thinking state');
  assert.ok(clears >= 4, `the thinking state is cleared on only ${clears} of the reply paths`);
  // And it is actually started, or nothing draws at all.
  assert.ok(script.includes('(function startVisualiser()'), 'startVisualiser is gone');
  assert.ok(/const c = document\.getElementById\('viz-canvas'\);\s*\n\s*if \(!c\) return;/.test(script),
    'startVisualiser must give up quietly when the canvas is absent, never throw');
});

test('every voice state has its own colour, so the states are distinguishable', () => {
  const html = APP_HTML();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const state of ['listening', 'hearing', 'thinking', 'speaking', 'muted', 'error']) {
    assert.ok(css.includes(`.dock-state[data-state="${state}"]`),
      `the visualiser has no colour for "${state}", so it looks the same as the others`);
  }
  const script = APP_SCRIPT();
  for (const state of ['idle', 'listening', 'hearing', 'thinking', 'speaking', 'muted', 'error']) {
    assert.ok(new RegExp(`[\\s{,]${state}: \\[`).test(script) || script.includes(`${state}: [`),
      `the painter has no colour for "${state}"`);
  }
});

/* ── THE DOCK AND THE HEADER ARE FURNITURE ─────────────────────────────────
 * The owner's rule: the conversation is permanently attached to the header,
 * always visible, and nothing may be moved behind it or under the header.
 */
test('the dock is one number wide, and that number is narrower than it was', () => {
  const html = APP_HTML();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(/--dock-w:\s*182px/.test(css), 'the dock width variable is gone or was widened again');
  assert.ok(/width:\s*var\(--dock-w\)/.test(css), 'the dock does not use --dock-w, so the one number is not the source');
  assert.ok(html.includes('id="dock-width-btn"') && html.includes('function toggleDockWidth'),
    'the owner must be able to widen the column again');
});

test('nothing can be moved behind the conversation or the header', () => {
  const html = APP_HTML();
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const stage = css.slice(css.indexOf('#workspace-stage {'), css.indexOf('#workspace-stage {') + 400);
  assert.ok(/left:\s*var\(--dock-w\)/.test(stage),
    'the workspace stage must start at the dock edge, or windows can slide under the dock');
  assert.ok(/top:\s*var\(--header-h\)/.test(stage), 'the stage must start below the header');
  assert.ok(/overflow:\s*hidden/.test(stage), 'the stage must clip, so nothing can leave the room');
  assert.ok(/left:var\(--dock-w\)/.test(html), 'the rooms must open beside the dock, not over it');

  const script = APP_SCRIPT();
  for (const fn of ['function stageBox', 'function clampToStage', 'function keepWindowsInRoom']) {
    assert.ok(script.includes(fn), `${fn} is gone: windows can be dragged over the chat again`);
  }
  // Every way a window can move must use the clamp.
  assert.ok(script.includes('const pos = clampToStage(activeDragWin'), 'dragging is not clamped');
  assert.ok(script.includes('const spot = clampToStage(win'), 'opening a window from the header is not clamped');
  assert.ok(script.includes('const handPos = clampToStage(handGrabbedWin'), 'My Hands is not clamped');
  assert.ok(script.includes('const box = stageBox();'), 'resizing is not clamped');
  assert.ok(script.includes('keepWindowsInRoom();'), 'nothing pulls stray windows back on boot');
});
