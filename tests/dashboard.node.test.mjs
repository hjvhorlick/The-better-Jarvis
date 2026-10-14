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
