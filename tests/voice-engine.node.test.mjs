/**
 * The voice engine layer, tested without a browser.
 *
 * This build environment has no browser, no microphone and no speakers, so the
 * page's voice code cannot be exercised the way a person uses it. What CAN be
 * tested is the logic that decides which engine speaks and which ear listens,
 * because that logic is ordinary JavaScript over stubbed browser objects.
 *
 * The functions are lifted out of dashboard/static/app.html by name and run
 * against fakes: a fake speechSynthesis with a chosen set of voices, and a fake
 * SpeechRecognition whose events we fire ourselves. If the real file stops
 * defining one of these functions, this test fails loudly instead of silently
 * testing an old copy.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'dashboard', 'static', 'app.html'), 'utf8');

/** Pull one function out of the page by name, with its whole body. */
function extractFunction(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`dashboard/static/app.html no longer defines function ${name}()`);
  // Keep the async keyword: dropping it turns `await` into a syntax error and
  // the test then fails for a reason that has nothing to do with the voice.
  const start = html.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at;
  let depth = 0, i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error(`unterminated function ${name}`);
}

const NAMES = [
  'browserVoiceList', 'voiceScore', 'bestBrowserVoice', 'refreshBrowserVoiceList',
  'browserCanSpeak', 'sayWithBrowser', 'stopBrowserVoice', 'chunkForSpeech', 'recogExplain', 'recogStop',
  'recogRestartSoon', 'earsFallBack', 'recogSpawn', 'recogPause', 'recogResume',
  'hearEngine', 'listenRunning', 'listenStart', 'earStatusText',
  'pageActivated', 'serverVoiceReady',
];

// ── The page's world, faked just enough ───────────────────────────────────────
function makeWorld({ voices = [], withRecognition = true, recognitionError = '' } = {}) {
  const spoken = [];
  const booted = [];

  class FakeRecognition {
    constructor() { this.started = false; FakeRecognition.last = this; }
    start() { this.started = true; if (recognitionError) queueMicrotask(() => this.onerror && this.onerror({ error: recognitionError })); setTimeout(() => this.onstart && this.onstart(), 0); }
    abort() { this.aborted = true; this.started = false; }
    stop() { this.started = false; }
  }
  FakeRecognition.last = null;

  const world = {
    spoken, booted, FakeRecognition,
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    document: { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ classList: { add() {} }, appendChild() {}, addEventListener() {}, set textContent(v) {}, set innerHTML(v) {} }) },
    // These worlds model a page the owner is already using: the browser's
    // first-touch rule is satisfied (hasBeenActive). Words held UNTIL that
    // first touch are covered by the dashboard suite's jsdom test.
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) }, permissions: null, userActivation: { hasBeenActive: true } },
    window: { isSecureContext: true, top: {}, self: {}, sendCommand() {} },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, Math, Date, String, Number, Array, Object, JSON, Set, Map, RegExp, Error, console,
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    _muted: false,
    _pageActivated: false, _voiceServerInfo: null,
    _voiceProofDone: true,
    micInFrame: () => false,
    micPolicyAllows: () => null,
    openStandaloneTab: () => { world.openedTab = true; },
    micReport: (t, a) => { world.reported.push({ text: t, actions: a || [] }); },
    toast: () => {},
    appendChat: (who, t) => { world.chat.push(t); },
    renderEar: () => {},
    earHeard: (t) => { world.heard.push(t); },
    earFrame: () => {},
    earGated: () => world._muted,
    earDropSentence: () => {},
    earStart: () => { world.serverEarStarted = (world.serverEarStarted || 0) + 1; },
    earStop: () => {},
    cleanForSpeech: (t) => String(t || '').trim(),
    voiceProblem: (t) => { world.problems.push(t); },
    speakViaServer: () => { world.serverSpeaks.push(1); },
    // The settings panel is DOM; it is checked by reading the page, not here.
    renderVoiceEngineReport: () => { world.reportRendered = (world.reportRendered || 0) + 1; },
  };
  world.reported = [];
  world.chat = [];
  world.heard = [];
  world.problems = [];
  world.serverSpeaks = [];
  world.Ear = { ready: false, starting: false, problem: '', resumeAt: 0, queue: [], sending: false };
  world.Speech = { busy: false, queue: [], generation: 0, controller: null, held: false };
  world.voiceSynthesis = {
    getVoices: () => voices, speakCount: 0, cancelled: 0, paused: false, speaking: false, pending: false,
    speak(u) {
      this.speakCount++; this.last = u; this.speaking = true;
      if (u.onstart) setTimeout(() => { u.onstart(); setTimeout(() => { this.speaking = false; u.onend && u.onend(); }, 0); }, 0);
    },
    cancel() { this.cancelled++; this.speaking = false; this.pending = false; }, resume() { this.paused = false; },
  };
  world.Voice = {
    engine: 'auto',
    synth: world.voiceSynthesis,
    recogClass: withRecognition ? FakeRecognition : null,
    voices, voice: null, voiceName: '',
    synthProblem: '', synthDead: false, currentUtterance: null, browserStalls: 0, browserStallMs: 0,
    recogProblem: '', recogFatal: false, recogMisses: 0,
  };
  world.Listen = { recog: null, active: false, paused: false, missing: 0, restart: 0, interim: '', engine: 'browser', lastStart: 0 };
  return world;
}

/** Run the real functions from the page inside the faked world. */
function load(world, extra = []) {
  const all = [...NAMES, ...extra];
  const body = all.map(extractFunction).join('\n');
  const fn = new Function(...Object.keys(world), `
    const VOICE_ENGINE_KEY = 'jarvis_voice_engine';
    const VOICE_NAME_KEY = 'jarvis_voice_name';
    const EAR_RESUME_MS = 500;
    ${body}
    return { ${all.join(', ')} };
  `);
  return fn(...Object.keys(world).map((k) => world[k]));
}

const BRITISH = { name: 'Google UK English Male', lang: 'en-GB', localService: true, default: true };
const AMERICAN = { name: 'Alex', lang: 'en-US', localService: true, default: false };
const FRENCH = { name: 'Thomas', lang: 'fr-FR', localService: true, default: false };

test('the butler voice wins when the machine has one', () => {
  const w = makeWorld({ voices: [FRENCH, AMERICAN, BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  assert.equal(w.Voice.voice.name, 'Google UK English Male', 'a British voice must be preferred over a French or American one');
  assert.equal(api.browserCanSpeak(), true);
});

test('a non-English-only machine still speaks (never left silent)', () => {
  const w = makeWorld({ voices: [FRENCH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  assert.ok(w.Voice.voice, 'a French voice is still a voice — the fallback must not leave the page mute');
  assert.equal(api.browserCanSpeak(), true);
});

test('no voices at all means the other engine, not a silent failure', () => {
  const w = makeWorld({ voices: [] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  assert.equal(api.browserCanSpeak(), false);
  assert.match(w.Voice.synthProblem, /not listed a single voice/);
});

test('speaking with the browser reports success and actually speaks the words', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  const spoke = await api.sayWithBrowser('Good evening, sir.', 0);
  assert.equal(spoke, true);
  assert.equal(w.voiceSynthesis.speakCount, 1);
  assert.equal(w.voiceSynthesis.last.text, 'Good evening, sir.');
  assert.equal(w.voiceSynthesis.last.voice.name, 'Google UK English Male');
  assert.equal(w.voiceSynthesis.cancelled, 0,
    'an idle browser voice must not be cancel()ed before speaking — cancel+speak in one task can swallow the sentence');
  assert.equal(w.Voice.currentUtterance, null, 'the utterance reference is released once it has ended');
});

test('a browser that accepts the text and never starts speaking is reported, not hung', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  w.Voice.browserStallMs = 30;   // same watchdog, test speed
  w.voiceSynthesis.speak = function () { this.speakCount++; };   // lists a voice, says nothing
  const spoke = await api.sayWithBrowser('Are you there?', 0);
  assert.equal(spoke, false);
  assert.match(w.Voice.synthProblem, /never began speaking/);
  assert.equal(api.browserCanSpeak(), false, 'a failed browser voice must stay failed, not be re-chosen for the next sentence');
  assert.match(w.Voice.synthProblem, /never began speaking/, 'the reason survives the next engine check');

  // …until the browser says its voice list has actually changed.
  w.voiceSynthesis.speak = function (u) { this.speakCount++; if (u.onstart) setTimeout(() => { u.onstart(); setTimeout(() => u.onend && u.onend(), 0); }, 0); };
  api.refreshBrowserVoiceList(true);
  assert.equal(api.browserCanSpeak(), true, 'new voices are worth one more try');
});

test('the ears prefer the browser recogniser, and fall back when there is none', () => {
  const withIt = makeWorld({ withRecognition: true });
  const apiA = load(withIt);
  assert.equal(apiA.hearEngine(), 'browser');

  const without = makeWorld({ withRecognition: false });
  const apiB = load(without);
  assert.equal(apiB.hearEngine(), 'server', 'Firefox has no recogniser: the server ear must be used, not silence');
});

test('"this computer" is honoured when the owner chooses it', () => {
  const w = makeWorld({ withRecognition: true });
  w.Voice.engine = 'server';
  const api = load(w);
  assert.equal(api.hearEngine(), 'server');
  api.listenStart();
  assert.equal(w.serverEarStarted, 1, 'the server ear must open when the engine is set to this computer');
  assert.equal(w.FakeRecognition.last, null, 'the browser recogniser must NOT be opened as well');
});

test('a refused microphone falls back to the other ear and says why', () => {
  const w = makeWorld({ withRecognition: true, recognitionError: 'not-allowed' });
  const api = load(w);
  api.recogSpawn();
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(w.Voice.recogFatal, true);
    assert.equal(api.hearEngine(), 'server', 'the ears must move to the server rather than stay broken');
    assert.ok(w.reported.length >= 1, 'the owner is told in the chat, with an action where one exists');
    assert.match(w.reported[0].text, /permission|microphone/i);
    resolve();
  }, 30));
});

test('a blocked preview frame explains the fix in words, and offers no button', () => {
  const w = makeWorld({ withRecognition: true, recognitionError: 'not-allowed' });
  w.micPolicyAllows = () => false;
  w.micInFrame = () => true;
  const api = load(w);
  assert.equal(api.hearEngine(), 'browser');
  const why = w.Voice.recogFatal;             // untouched before the error arrives
  assert.equal(why, false);
  const explain = new Function('micPolicyAllows', 'micInFrame', 'openStandaloneTab',
    `return ${extractFunction('recogExplain')}`)(w.micPolicyAllows, w.micInFrame, w.openStandaloneTab);
  const out = explain('not-allowed');
  assert.match(out.short, /preview frame forbids/);
  assert.match(out.long, /own tab/, 'the fix is explained in plain words');
  assert.ok(!out.actions || out.actions.length === 0,
    'no button may be offered into the chat (owner rule: fewer buttons); words only');
});

test('the browser ear hears a sentence and hands it to the command line', async () => {
  const w = makeWorld({ withRecognition: true });
  const api = load(w);
  api.recogSpawn();
  await new Promise((r) => setTimeout(r, 10));
  const rec = w.FakeRecognition.last;
  rec.onresult({
    resultIndex: 0,
    results: Object.assign([
      Object.assign([{ transcript: 'what time is it' }], { isFinal: true }),
    ], { length: 1 }),
  });
  assert.deepEqual(w.heard, ['what time is it']);
});

test('muting stops the browser ear; unmuting starts it again', () => {
  const w = makeWorld({ withRecognition: true });
  const api = load(w);
  api.recogSpawn();
  assert.ok(w.Listen.recog, 'the recogniser is open');
  api.recogPause();
  assert.equal(w.Listen.paused, true);
  assert.equal(w.Listen.recog, null, 'muting must release the microphone');
  assert.equal(w.FakeRecognition.last.aborted, true);
  api.recogResume();
  assert.equal(w.Listen.paused, false);
  assert.ok(w.Listen.recog, 'unmuting must open the ear again');
});

test('the status line always says which ear is listening', () => {
  const w = makeWorld({ withRecognition: true });
  const api = load(w);
  w.Listen.active = true;
  assert.match(api.earStatusText(), /browser’s own ear/);

  w.Voice.recogFatal = true;
  w.Ear.ready = true;
  assert.match(api.earStatusText(), /server’s ear/);
});

test('"this computer" that cannot speak still gets heard in this browser', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  w.Voice.engine = 'server';                       // the owner chose the server voice
  w.speakViaServer = async () => 'failed';         // …and it could not speak
  const api = load(w, ['speakOne']);
  api.refreshBrowserVoiceList();
  await api.speakOne('The reply must still be heard.', 0);
  assert.equal(w.voiceSynthesis.speakCount, 1, 'silence is never the answer: the browser voice must take over');
  assert.equal(w.chat.length, 1, 'and the owner is told that the other voice said it');
  assert.match(w.chat[0], /could not speak/);
});

test('a working local mouth counts as ready even when the Whisper ear is not', () => {
  const w = makeWorld({ voices: [BRITISH] });
  w._voiceServerInfo = { voiceLocal: { ready: false, speakReady: true, hearReady: false } };
  const api = load(w);
  assert.equal(api.serverVoiceReady(), true,
    'Kokoro must be allowed to take over even if faster-whisper is not ready');
  Object.assign(w._voiceServerInfo.voiceLocal, { ready: true, speakReady: false, hearReady: true });
  assert.equal(api.serverVoiceReady(), false,
    'speakReady is the mouth readiness; the combined flag must not resurrect a broken mouth');
});

test('the utterance stays referenced while it is speaking (Chrome loses onend otherwise)', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  let seenWhileSpeaking = null;
  w.voiceSynthesis.speak = function (u) {
    this.speakCount++;
    this.speaking = true;
    seenWhileSpeaking = w.Voice.currentUtterance;
    setTimeout(() => { u.onstart(); setTimeout(() => { this.speaking = false; u.onend(); }, 0); }, 0);
  };
  const spoke = await api.sayWithBrowser('Still with me, sir.', 0);
  assert.equal(spoke, true);
  assert.ok(seenWhileSpeaking && seenWhileSpeaking.text === 'Still with me, sir.',
    'the live utterance must be kept referenced until the browser finishes with it');
  assert.equal(w.Voice.currentUtterance, null);
});

test('when the browser voice cuts out mid-reply, the local voice takes over from that exact piece', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  w.Voice.browserStallMs = 35;   // same watchdog, test speed
  const serverTexts = [];
  w.speakViaServer = async (text) => { serverTexts.push(text); return 'ok'; };
  const api = load(w, ['speakOne']);
  api.refreshBrowserVoiceList();
  let calls = 0;
  w.voiceSynthesis.speak = function (u) {
    this.speakCount++;
    this.last = u;
    this.speaking = true;
    calls++;
    const mine = calls;
    setTimeout(() => {
      u.onstart && u.onstart();
      if (mine === 1) setTimeout(() => { this.speaking = false; u.onend && u.onend(); }, 0);
      // the second piece starts and then never ends: the Chrome cut-out
    }, 0);
  };
  const first = `${'Alpha '.repeat(25).trim()}.`;
  const second = 'Bravo, this tail must still be heard.';
  await api.speakOne(`${first} ${second}`, 0);
  assert.equal(w.Voice.synthDead, true, 'a stalled browser voice must be retired, not trusted again next reply');
  assert.match(w.Voice.synthProblem, /stalled/);
  assert.equal(serverTexts.length, 1, 'the local voice must be asked exactly once');
  assert.match(serverTexts[0], /Bravo/, 'the local voice says the unspoken tail');
  assert.doesNotMatch(serverTexts[0], /Alpha/, 'pieces already heard must not be repeated in the other voice');
  assert.equal(api.browserCanSpeak(), false, 'later replies go straight to the local voice');
  assert.ok(w.chat.some((t) => /local voice took over/.test(t)), 'the owner is told, in words, that the local voice took over');
});

test('the build marker is bumped on both sides of the wire', () => {
  const page = html.match(/JARVIS_BUILD = '([^']+)'/)[1];
  const server = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf8').match(/SERVER_BUILD = '([^']+)'/)[1];
  assert.equal(page, server,
    'the page and the server must carry the same build marker — a mismatch is exactly what makes a stale page look like a broken voice');
});
