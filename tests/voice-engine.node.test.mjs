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
  'browserCanSpeak', 'sayBrowserUtterance', 'sayWithBrowser', 'sayTextWithBrowser',
  'chunkForSpeech', 'stopBrowserVoice', 'recogExplain', 'recogStop',
  'recogRestartSoon', 'earsFallBack', 'recogSpawn', 'recogPause', 'recogResume',
  'hearEngine', 'listenRunning', 'listenStart', 'earStatusText',
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
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) }, permissions: null },
    window: { isSecureContext: true, top: {}, self: {}, sendCommand() {} },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, queueMicrotask, Promise, Math, Date, String, Number, Array, Object, JSON, Set, Map, RegExp, Error, console,
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    _muted: false,
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
  world.Speech = { busy: false, queue: [], generation: 0, controller: null, streams: new Map(), spoken: new Set() };
  world.BrowserSpeech = { tail: Promise.resolve() };
  world.voiceSynthesis = {
    getVoices: () => voices, speakCount: 0, cancelled: 0, paused: false, utterances: [],
    speak(u) {
      this.speakCount++;
      this.last = u;
      this.utterances.push(u);
      if (u.onstart) setTimeout(() => { u.onstart(); setTimeout(() => u.onend && u.onend(), 0); }, 0);
    },
    cancel() { this.cancelled++; }, resume() {},
  };
  world.Voice = {
    engine: 'auto',
    synth: world.voiceSynthesis,
    recogClass: withRecognition ? FakeRecognition : null,
    voices, voice: null, voiceName: '',
    synthProblem: '', synthDead: false, synthRetryAt: 0,
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
    const BROWSER_START_TIMEOUT_MS = 6000;
    const BROWSER_RETRY_MS = 5000;
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
  assert.equal(w.voiceSynthesis.cancelled, 0, 'normal utterances must not cancel the browser queue before speaking');
});

test('an unsolicited cancel before onstart is a failure, not phantom success', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  w.voiceSynthesis.speak = function (utterance) {
    this.speakCount++;
    this.last = utterance;
    queueMicrotask(() => utterance.onerror && utterance.onerror({ error: 'canceled', charIndex: 0 }));
  };

  const spoke = await api.sayWithBrowser('This must not be reported as heard.', 0);
  assert.equal(spoke, false, 'a canceled utterance that never started must trigger fallback');
  assert.match(w.Voice.synthProblem, /canceled.*before it began speaking/);
  assert.equal(w.Voice.synthDead, true);
  assert.equal(w.voiceSynthesis.cancelled, 1, 'a failed native queue is cleared once for recovery');
});

test('concurrent browser requests are serialized instead of canceling each other', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  const first = api.sayWithBrowser('First answer.', 0);
  const second = api.sayWithBrowser('Second answer.', 0);

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(w.voiceSynthesis.speakCount, 2);
  assert.equal(w.voiceSynthesis.cancelled, 0);
  assert.equal(w.voiceSynthesis.last.text, 'Second answer.');
});

test('a long browser reply is split into short native utterances', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w, ['speakOne']);
  api.refreshBrowserVoiceList();
  const reply = 'A long sentence that must keep going. '.repeat(35);

  await api.speakOne(reply, 0);
  assert.ok(w.voiceSynthesis.speakCount > 1, 'long replies should be voiced as safe-sized chunks');
  assert.ok(w.voiceSynthesis.utterances.every((utterance) => utterance.text.length <= 160),
    'no browser utterance should exceed 160 characters');
  assert.equal(w.serverSpeaks.length, 0, 'successful browser chunks must not call the server voice');
});

test('a browser that accepts the text and never starts speaking is reported, not hung', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  w.voiceSynthesis.speak = function () { this.speakCount++; };   // lists a voice, says nothing
  const spoke = await api.sayWithBrowser('Are you there?', 0);
  assert.equal(spoke, false);
  assert.match(w.Voice.synthProblem, /did not start speaking within 6 seconds/);
  assert.equal(api.browserCanSpeak(), false, 'a failed browser voice must stay failed, not be re-chosen for the next sentence');
  assert.match(w.Voice.synthProblem, /did not start speaking within 6 seconds/, 'the reason survives the next engine check');

  // …until the browser says its voice list has actually changed.
  w.voiceSynthesis.speak = function (u) { this.speakCount++; if (u.onstart) setTimeout(() => { u.onstart(); setTimeout(() => u.onend && u.onend(), 0); }, 0); };
  api.refreshBrowserVoiceList(true);
  assert.equal(api.browserCanSpeak(), true, 'new voices are worth one more try');
});

test('a constructor exception resolves as a browser failure instead of rejecting the speech queue', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  w.SpeechSynthesisUtterance = class { constructor() { throw new Error('engine unavailable'); } };
  const api = load(w);
  api.refreshBrowserVoiceList();

  await assert.doesNotReject(async () => {
    assert.equal(await api.sayWithBrowser('Good evening, sir.', 0), false);
  });
  assert.equal(w.Voice.synthDead, true);
  assert.match(w.Voice.synthProblem, /could not be used.*engine unavailable/);
});

test('a browser start failure gets one final retry if the server voice is unavailable', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  let attempts = 0;
  w.voiceSynthesis.speak = function (utterance) {
    this.speakCount++;
    this.last = utterance;
    this.utterances.push(utterance);
    if (attempts++ === 0) {
      queueMicrotask(() => utterance.onerror && utterance.onerror({ error: 'canceled', charIndex: 0 }));
    } else if (utterance.onstart) {
      setTimeout(() => { utterance.onstart(); setTimeout(() => utterance.onend && utterance.onend(), 0); }, 0);
    }
  };
  w.speakViaServer = async () => { w.serverSpeaks.push(1); return 'failed'; };
  const api = load(w, ['speakOne']);
  api.refreshBrowserVoiceList();

  await api.speakOne('Still speak this reply.', 0);
  assert.equal(w.voiceSynthesis.speakCount, 2, 'browser TTS should recover after the server fallback also fails');
  assert.equal(w.serverSpeaks.length, 1);
  assert.equal(w.Voice.synthDead, false);
  assert.match(w.chat.at(-1), /recovered on a retry/);
});

test('an unexpected speech rejection does not wedge the reply queue', async () => {
  const w = makeWorld();
  let attempts = 0;
  w.speakOne = async () => { attempts++; throw new Error('browser API threw'); };
  w.Speech.queue.push('first reply', 'second reply');
  w.setTimeout = () => 0; // do not leave a recogniser-resume timer behind in this focused test
  const api = load(w, ['pumpSpeech']);

  api.pumpSpeech();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 2, 'the next queued reply should still be attempted');
  assert.equal(w.Speech.busy, false, 'the busy flag must always be released');
  assert.deepEqual(w.Speech.queue, []);
  assert.equal(w.problems.length, 2, 'each unexpected failure should be visible, not silent');
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

test('a blocked preview frame offers the one action that fixes it', () => {
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
  assert.equal(out.actions.length, 1);
  assert.match(out.actions[0].label, /Open in New Tab/);
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

test('the build marker is bumped on both sides of the wire', () => {
  const page = html.match(/JARVIS_BUILD = '([^']+)'/)[1];
  const server = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf8').match(/SERVER_BUILD = '([^']+)'/)[1];
  assert.equal(page, server,
    'the page and the server must carry the same build marker — a mismatch is exactly what makes a stale page look like a broken voice');
});
