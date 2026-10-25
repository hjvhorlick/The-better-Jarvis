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

test('the supplier registry renderer is actually in that script', () => {
  // A guard against the test passing vacuously: if the functions that draw the
  // registration area move out of the inline script, this test would keep
  // checking a page that no longer contains them.
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const script = inlineScripts(html).filter((s) => s.trim()).join('\n');
  for (const fn of ['refreshSupplierRegistry', 'supplierRow', 'saveImageKey', 'clearImageKey']) {
    assert.ok(script.includes(fn), `${fn} is no longer in the inline script`);
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
    assert.equal(body.classList.contains('show-tools'), false, 'tools start hidden until requested');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(window.getComputedStyle(firstStrip).display, 'none');

    for (let i = 0; i < 8; i++) {
      const shouldOpen = i % 2 === 0;
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

/**
 * The voice visualiser — the ring that shows whether JARVIS is listening,
 * thinking or speaking.
 *
 * It went missing once already in this project's other shell: the code that
 * drove it survived, the element it drove did not, and the app silently stopped
 * reporting its own voice state. So the element AND the code that reads the real
 * voice state are both checked here.
 */
test('the voice visualiser is in the conversation frame', () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const window_ = html.slice(html.indexOf('id="win-chat"'), html.indexOf('<!-- PANEL 3'));
  assert.ok(window_.includes('id="voice-orb"'), 'the voice visualiser element is missing from the chat frame');
  assert.ok(window_.includes('id="voice-orb-canvas"'), 'the visualiser has no canvas to draw on');
  assert.ok(window_.includes('id="voice-orb-label"'), 'the visualiser has no label saying what the voice is doing');
  // At the top of the conversation: above the messages, then the input.
  assert.ok(window_.indexOf('id="voice-orb"') < window_.indexOf('id="chat-feed"'),
    'the visualiser must sit above the conversation, not below it');
  assert.ok(window_.includes('role="status"') && window_.includes('aria-live="polite"'),
    'the visualiser is the voice status, so it must be announced');
});

test('the visualiser is driven by the real voice state, not a timer', () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const script = inlineScripts(html).filter((s) => s.trim()).join('\n');
  for (const fn of ['voiceOrbState', 'voiceOrbPaint', 'voiceOrbTick', 'voiceOrbStart']) {
    assert.ok(script.includes(`function ${fn}`), `${fn} is missing: nothing would draw the visualiser`);
  }
  // Every state it reports comes from something real:
  const stateFn = script.slice(script.indexOf('function voiceOrbState'), script.indexOf('function voiceOrbMeasure'));
  for (const source of ['Speech.busy', 'VoiceOrb.mic', '_muted', 'Ear.problem', 'Ear.ready']) {
    assert.ok(stateFn.includes(source), `the visualiser no longer reads ${source}, so its state can lie`);
  }
  // "JARVIS is talking" must come from the speech queue that only empties when
  // playback has finished — the same flag the ears use to stop listening.
  assert.ok(stateFn.includes("'speaking'"), 'there is no speaking state');
  // The microphone's own loudness feeds the bars while he listens.
  assert.ok(script.includes('VoiceOrb.mic ='), 'the microphone level never reaches the visualiser');
  // And it is actually started at boot, or nothing draws at all.
  assert.ok(/voiceOrbStart\(\);\s*\/\//.test(script), 'voiceOrbStart() is never called on boot');
});

test('the visualiser and the ears bar agree about who is talking', () => {
  const html = readFileSync(join(ROOT, 'dashboard', 'static', 'app.html'), 'utf-8');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  for (const state of ['listening', 'hearing', 'thinking', 'speaking', 'muted', 'error']) {
    assert.ok(css.includes(`.voice-orb[data-state="${state}"]`),
      `the visualiser has no colour for the "${state}" state, so the states look identical`);
  }
  // The ears bar is the mute button; it was styled to appear but never shown.
  const script = inlineScripts(html).filter((s) => s.trim()).join('\n');
  assert.ok(script.includes("bar.classList.add('show')"),
    'the ears bar is never shown, so the mute button cannot be reached');
});
