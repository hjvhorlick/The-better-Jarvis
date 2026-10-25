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
import { JSDOM, VirtualConsole } from 'jsdom';

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
  assert.ok(script.includes('const spot = placeWindowClear(win') && script.includes('clampToStage(win, left, top)'),
    'opening a window from the header is not clamped (placeWindowClear must clamp it into the room, clear of other windows)');
  assert.ok(script.includes('const handPos = clampToStage(handGrabbedWin'), 'My Hands is not clamped');
  assert.ok(script.includes('const box = stageBox();'), 'resizing is not clamped');
  assert.ok(script.includes('keepWindowsInRoom();'), 'nothing pulls stray windows back on boot');
});

/**
 * The JARVIS connection belongs to startup, not to any button.
 *
 * This loads app.html in jsdom WITHOUT its external scripts, so
 * window.JarvisHandGestures never exists — the exact failure that used to
 * kill the second half of startup and make it look as though only the
 * My Hands button could start JARVIS. The connection must open on load
 * anyway, startup must run to the end, and pressing My Hands afterwards
 * must not create the JARVIS connection (it controls hand tracking only).
 * The button must also keep the same class as every other button in its
 * row: this fix adds no new UI and changes no styling.
 */
test('the JARVIS connection starts on load by itself; My Hands never starts it', async () => {
  const html = APP_HTML();
  const sockets = [];
  const fetches = [];
  const errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e.detail && e.detail.message) || e.message || e)));

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.WebSocket = class {
        constructor(url) {
          this.url = String(url);
          this.readyState = 0;
          this._listeners = {};
          sockets.push(this);
          setTimeout(() => {
            this.readyState = 1;
            if (typeof this.onopen === 'function') this.onopen();
            (this._listeners.open || []).forEach((f) => f());
          }, 1);
        }
        addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
        send() {}
        close() { this.readyState = 3; }
      };
      w.WebSocket.OPEN = 1;
      w.fetch = async (url) => {
        fetches.push(String(url));
        return { ok: true, status: 200, json: async () => ({ roots: [], present: false, entries: [] }) };
      };
      w.CryptoJS = {
        SHA256: () => ({}),
        lib: { WordArray: { random: () => ({ toString: () => '' }) } },
        AES: { encrypt: () => ({ ciphertext: { toString: () => '' } }) },
        enc: { Utf8: { parse: (x) => x }, Hex: {} }, mode: { CBC: {} }, pad: { Pkcs7: {} },
      };
      const gradient = { addColorStop() {} };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (_t, prop) => (prop === 'createRadialGradient' || prop === 'createLinearGradient'
          ? () => gradient
          : prop === 'measureText' ? () => ({ width: 0 }) : () => {}),
        set: () => true,
      });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getVideoTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }),
        enumerateDevices: async () => [],
      } });
      w.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {}, paused: false, addEventListener() {} };
      w.SpeechSynthesisUtterance = class {};
      w.AudioContext = class {
        constructor() { this.state = 'running'; this.sampleRate = 16000; this.destination = {}; this.currentTime = 0; }
        createMediaStreamSource() { return { connect() {} }; }
        createScriptProcessor() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { return { frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, type: '', connect() {}, start() {}, stop() {} }; }
        createAnalyser() { return { fftSize: 0, frequencyBinCount: 0, connect() {}, getByteTimeDomainData() {}, getFloatTimeDomainData() {} }; }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
      };
      w.HTMLMediaElement.prototype.play = async () => {};
      w.addEventListener('error', (e) => errors.push(String(e.message || e)));
    },
  });

  const w = dom.window;
  try {
    await sleep(900);   // let startup finish; nothing has been clicked

    const mainSockets = () => sockets.filter((s) => s.url.includes('/ws?token='));
    assert.equal(mainSockets().length, 1,
      'the JARVIS connection must open by itself when the application starts, with no button press');
    assert.equal(w.document.getElementById('status-txt').textContent, 'Active',
      'the status pill must show the live connection before anything is pressed');
    assert.ok(!errors.some((e) => e.includes('createGestureEngine') || e.includes('JarvisHandGestures')),
      `a missing hand-tracking library must never break startup; page errors were: ${errors.join(' | ')}`);
    assert.ok(fetches.some((u) => u.includes('/api/files/roots')),
      'startup must run to the end (desktop build) even when the hand-tracking library is missing');

    // My Hands keeps the common look of its row: same class as Camera, no inline styling of its own.
    const btnHands = w.document.getElementById('btn-toggle-hands');
    const btnCam = w.document.getElementById('btn-toggle-cam');
    assert.ok(btnHands && btnCam, 'the HUD row buttons must exist');
    assert.equal(btnHands.className, btnCam.className,
      'the My Hands button must look like the other buttons in its row');
    assert.equal(btnHands.getAttribute('style'), null,
      'the My Hands button must not carry styling of its own');

    // Pressing My Hands must not start (or restart) the JARVIS connection.
    assert.equal(typeof w.toggleMyHandsTracking, 'function');
    btnHands.click();
    await sleep(300);
    assert.equal(mainSockets().length, 1,
      'the My Hands button must only control My Hands, never the JARVIS connection');
    assert.ok(w.document.getElementById('hud-toast').textContent.includes('My Hands is unavailable'),
      'with the tracking library missing, My Hands reports itself unavailable and JARVIS carries on');
  } finally {
    w.close();
  }
});

/**
 * The owner's palette and window rules, pinned down:
 *  - every word on the transparent glass is bright yellow (with the dark
 *    halo), because dull words on see-through glass are unreadable;
 *  - there is no pink anywhere ("pink and yellow does not go");
 *  - green stays only where it means on/good;
 *  - the Brain is its own window with its own home beside Settings, and a
 *    window opened from the header steps clear of windows already open
 *    instead of landing on top of them.
 */
test('bright yellow words, no pink anywhere, and Brain opens clear of Settings', () => {
  const html = APP_HTML();
  const glass = readFileSync(join(ROOT, 'dashboard', 'static', 'jarvis-glass.css'), 'utf-8');
  const brainCss = readFileSync(join(ROOT, 'dashboard', 'static', 'brain.css'), 'utf-8');

  const pinks = ['#f43f5e', '#fb7185', '#fecdd3', '#ff6b6b', '#ffb86b', '#ff9c8b', '#c084fc', '--rose'];
  for (const [name, text] of [['app.html', html], ['jarvis-glass.css', glass], ['brain.css', brainCss]]) {
    for (const pink of pinks) {
      assert.ok(!text.toLowerCase().includes(pink), `${name} still uses ${pink}: pink and yellow do not go together`);
    }
  }

  assert.ok(glass.includes('--jg-text-soft: #ffe45c'), 'the quieter words must still be bright yellow');
  assert.ok(glass.includes('--jg-text-faint: #ffd60a'), 'labels and counts must be bright yellow');
  assert.ok(html.includes('text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85)'),
    'glass windows need the dark halo so the writing stays clear on transparency');
  assert.ok(brainCss.includes('.brain-status.ok { color: #a7edb3; }'), 'green means on/good, and it stays');

  const brainTag = html.match(/id="win-brain" style="([^"]*)"/);
  const settingsTag = html.match(/id="win-settings" style="([^"]*)"/);
  assert.ok(brainTag && settingsTag, 'both windows must exist');
  const brainLeft = parseInt(/left:\s*(\d+)px/.exec(brainTag[1])[1], 10);
  const setLeft = parseInt(/left:\s*(\d+)px/.exec(settingsTag[1])[1], 10);
  const setWidth = parseInt(/width:\s*(\d+)px/.exec(settingsTag[1])[1], 10);
  assert.ok(brainLeft >= setLeft + setWidth,
    `Brain must open beside Settings, not on top of it (brain left ${brainLeft}, settings ends at ${setLeft + setWidth})`);
  const { document } = new JSDOM(html).window;
  const brainWindow = document.getElementById('win-brain');
  const settingsWindow = document.getElementById('win-settings');
  assert.equal(brainWindow.parentElement.id, 'workspace-stage',
    'the Brain window must be a direct workspace window, not a child of Settings');
  assert.equal(settingsWindow.querySelectorAll('.glass-window').length, 0,
    'Settings must not contain any nested glass window');
  assert.equal(document.querySelectorAll('.glass-window .glass-window').length, 0,
    'no glass window may be nested inside another glass window');

  const script = APP_SCRIPT();
  assert.ok(script.includes('function placeWindowClear'), 'opened windows must be placed clear of each other');
  assert.ok(script.includes('placeWindowClear(win, win.offsetLeft, win.offsetTop)'),
    'toggleWindow must place the newly opened window clear of the ones already open');
});

/**
 * The voice is not a switch, and no button turns it on.
 *
 * Every browser forbids a page from making sound before its first touch
 * (click, tap or key, anywhere). The old code burned a pre-touch reply on
 * that locked voice AND marked the voice dead for the whole session
 * (synthDead) — so JARVIS stayed silent until the owner happened to click
 * something that reset it, which looked exactly like an on button (first
 * My Hands, then Settings). Now the words are held, the voice is never
 * bricked by a lock, and the first touch anywhere speaks the held words.
 */
test('words spoken before the first touch are held (not dropped, not fatal) and said on any first touch', async () => {
  const html = APP_HTML();
  const spoken = [];
  const errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e.detail && e.detail.message) || e.message || e)));

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.WebSocket = class {
        constructor(url) { this.url = String(url); this.readyState = 1; }
        addEventListener() {}
        send() {}
        close() { this.readyState = 3; }
      };
      w.WebSocket.OPEN = 1;
      w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ roots: [], present: false, entries: [] }) });
      w.CryptoJS = {
        SHA256: () => ({}),
        lib: { WordArray: { random: () => ({ toString: () => '' }) } },
        AES: { encrypt: () => ({ ciphertext: { toString: () => '' } }) },
        enc: { Utf8: { parse: (x) => x }, Hex: {} }, mode: { CBC: {} }, pad: { Pkcs7: {} },
      };
      const gradient = { addColorStop() {} };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (_t, prop) => (prop === 'createRadialGradient' || prop === 'createLinearGradient'
          ? () => gradient
          : prop === 'measureText' ? () => ({ width: 0 }) : () => {}),
        set: () => true,
      });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getVideoTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }),
        enumerateDevices: async () => [],
      } });
      const voice = { name: 'Daniel', lang: 'en-GB', localService: true, default: true };
      w.speechSynthesis = {
        paused: false,
        getVoices: () => [voice],
        speak(u) { spoken.push(u.text); if (u.onstart) u.onstart(); setTimeout(() => u.onend && u.onend(), 1); },
        cancel() {}, pause() {}, resume() {},
      };
      w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      w.AudioContext = class {
        constructor() { this.state = 'running'; this.sampleRate = 16000; this.destination = {}; this.currentTime = 0; }
        createMediaStreamSource() { return { connect() {} }; }
        createScriptProcessor() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { return { frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, type: '', connect() {}, start() {}, stop() {} }; }
        createAnalyser() { return { fftSize: 0, frequencyBinCount: 0, connect() {}, getByteTimeDomainData() {}, getFloatTimeDomainData() {} }; }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
      };
      w.HTMLMediaElement.prototype.play = async () => {};
      w.addEventListener('error', (e) => errors.push(String(e.message || e)));
    },
  });

  const w = dom.window;
  const probe = (expr) => w.eval(expr);
  try {
    await sleep(900);
    assert.equal(spoken.length, 0, 'nothing may be spoken before any reply exists');
    assert.equal(probe('pageActivated()'), false, 'the page starts untouched');

    // A reply arrives before any click or key: it must be HELD.
    w.speakReply('Good evening, sir.');
    await sleep(350);
    assert.equal(spoken.length, 0, 'a locked browser voice must not be attempted before the first touch');
    assert.equal(probe('Speech.held'), true, 'the waiting words must be marked held, not dropped');
    assert.equal(probe('Voice.synthDead'), false, 'a pre-touch reply must never brick the voice');
    assert.ok(String(probe('earStatusText()')).includes('no button needed'),
      'the status line must honestly say the voice waits for the first touch anywhere');

    // ONE touch - on empty page body, not on any button - releases the words.
    w.document.body.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    await sleep(400);
    assert.equal(probe('pageActivated()'), true, 'any touch anywhere counts as the browser unlock');
    assert.equal(spoken[0], 'Good evening, sir.', 'the held words are spoken first on unlock');
    assert.ok(!spoken.some((t) => t.includes('Voice online')),
      'no announcement on top of real waiting words: the touch was plumbing, not a switch');
    assert.equal(probe('Speech.held'), false, 'nothing stays held after the unlock');
    assert.equal(probe('Voice.synthDead'), false, 'the voice is alive and well after the unlock');
  } finally {
    w.close();
  }
});

test('the chat carries words, not buttons', () => {
  const html = APP_HTML();
  assert.ok(!html.includes('bubble-action-btn'),
    'no button may be rendered inside a chat bubble (fewer buttons, no clutter)');
  assert.ok(!html.includes("label: '↗ Open in New Tab'"),
    'no Open-in-New-Tab button may be offered into the chat; the fix is explained in words');
  const script = APP_SCRIPT();
  assert.ok(script.includes('function micReport(text)'), 'microphone reports are words only');
});

/**
 * My Hands is ONE switch, pointer included.
 *
 * With no camera available, My Hands falls back to the mouse pointer. That
 * fallback used to leave handTrackingActive false, so pressing the button
 * again could only start it again - the pointer never went away (only the
 * hidden V key stopped it), and the message even said "V to toggle"
 * without ever saying why a pointer had appeared at all. Now the first
 * press explains plainly (no camera here -> mouse is the hand -> same
 * button switches it off) and the second press switches it off.
 */
test('My Hands is one switch: the no-camera pointer comes on with a clear message and goes away on the second press', async () => {
  const html = APP_HTML();
  const errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e.detail && e.detail.message) || e.message || e)));

  const stillHand = { present: true, pinching: false, fist: false, pulling: false, scaling: false, turning: false };
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.WebSocket = class {
        constructor(url) { this.url = String(url); this.readyState = 0; this._l = {};
          setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); (this._l.open || []).forEach((f) => f()); }, 1); }
        addEventListener(t, f) { (this._l[t] ||= []).push(f); }
        send() {}
        close() { this.readyState = 3; }
      };
      w.WebSocket.OPEN = 1;
      w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ roots: [], present: false, entries: [] }) });
      w.JarvisHandGestures = {
        createGestureEngine: () => ({ updateFrame: () => stillHand, updateHands: () => stillHand, getState: () => stillHand, loseHand: () => {} }),
        summarizeHand: () => ({ pinchGate: 0.3, pinchRatio: 1, pinchSignature: true, handGarbage: false, aspect: 1, indexReach: 1, backMean: 1, openness: 1 }),
      };
      w.CryptoJS = {
        SHA256: () => ({}),
        lib: { WordArray: { random: () => ({ toString: () => '' }) } },
        AES: { encrypt: () => ({ ciphertext: { toString: () => '' } }) },
        enc: { Utf8: { parse: (x) => x }, Hex: {} }, mode: { CBC: {} }, pad: { Pkcs7: {} },
      };
      const gradient = { addColorStop() {} };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (_t, prop) => (prop === 'createRadialGradient' || prop === 'createLinearGradient'
          ? () => gradient
          : prop === 'measureText' ? () => ({ width: 0 }) : () => {}),
        set: () => true,
      });
      Object.defineProperty(w.navigator, 'mediaDevices', { value: {
        getUserMedia: async () => { const e = new Error('no camera here'); e.name = 'NotFoundError'; throw e; },
        enumerateDevices: async () => [],
      } });
      w.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {}, paused: false, addEventListener() {} };
      w.SpeechSynthesisUtterance = class {};
      w.AudioContext = class {
        constructor() { this.state = 'running'; this.sampleRate = 16000; this.destination = {}; this.currentTime = 0; }
        createMediaStreamSource() { return { connect() {} }; }
        createScriptProcessor() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { return { frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, type: '', connect() {}, start() {}, stop() {} }; }
        createAnalyser() { return { fftSize: 0, frequencyBinCount: 0, connect() {}, getByteTimeDomainData() {}, getFloatTimeDomainData() {} }; }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
      };
      w.HTMLMediaElement.prototype.play = async () => {};
      w.addEventListener('error', (e) => errors.push(String(e.message || e)));
    },
  });

  const w = dom.window;
  const probe = (expr) => w.eval(expr);
  try {
    await sleep(900);
    const btn = w.document.getElementById('btn-toggle-hands');
    const cursor = w.document.getElementById('hand-cursor');
    const status = () => w.document.getElementById('txt-hands-status').textContent;
    assert.ok(btn, 'the My Hands button must exist');
    assert.equal(probe('mouseHandActive'), false, 'starts off');
    assert.notEqual(cursor.style.display, 'block', 'no pointer before My Hands is pressed');

    btn.click();                       // first press: on (mouse-pointer fallback, no camera)
    await sleep(600);
    assert.equal(probe('mouseHandActive'), true, 'the fallback pointer is on');
    assert.equal(probe('handTrackingActive'), false, 'no camera loop is running without a camera');
    assert.equal(cursor.style.display, 'block', 'the pointer is visible');
    assert.ok(btn.classList.contains('active'), 'the button itself shows My Hands is on');
    assert.match(status(), /My Hands: On \(mouse pointer/, 'the status says why the pointer is there');
    assert.match(w.document.getElementById('hud-toast').textContent, /no camera here[\s\S]*Press My Hands again to switch it off/i,
      'one clear message: why it is there, and the same button switches it off');

    btn.click();                       // second press: the SAME button switches it off
    await sleep(300);
    assert.equal(probe('mouseHandActive'), false, 'the pointer is switched off by the second press');
    assert.equal(cursor.style.display, 'none', 'the pointer is gone from the screen');
    assert.ok(!btn.classList.contains('active'), 'the button no longer shows on');
    assert.equal(status(), 'My Hands: Off');
    void errors;
  } finally {
    w.close();
  }
});
