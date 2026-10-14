/**
 * Regression tests for the supported dashboard's local-only voice path.
 *
 * These tests exercise real functions lifted from dashboard/static/app.html
 * against fake browser APIs. They verify local TTS preference, refusal to use
 * remote browser voices or browser SpeechRecognition, microphone routing to the
 * app-local faster-whisper API, and complete spoken-reply handling. They do not
 * exercise a physical microphone, speaker, browser, or downloaded model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'dashboard', 'static', 'app.html'), 'utf8');

/** Extract a real page function so this suite cannot drift into testing a copy. */
function extractFunction(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`dashboard/static/app.html no longer defines function ${name}()`);
  const start = html.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at;
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const NAMES = [
  'browserVoiceList', 'voiceScore', 'bestBrowserVoice', 'refreshBrowserVoiceList',
  'browserCanSpeak', 'sayBrowserUtterance', 'sayWithBrowser', 'sayTextWithBrowser',
  'chunkForSpeech', 'speakOne', 'hearEngine', 'listenRunning', 'listenStart',
  'micOpenStream', 'earStart', 'earStop', 'earDropSentence', 'earStatusText',
  'earSend', 'earHeard', 'speakPart', 'speakStreamed', 'finishStreamed',
  'pumpSpeech', 'speakReply',
];

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  };
}

class FakeAudioContext {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.state = 'running';
    this.destination = {};
    this.closed = false;
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    this.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
    return this.processor;
  }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
}

function makeWorld({ voices = [], stream = fakeStream() } = {}) {
  const w = {
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    window: {
      isSecureContext: true,
      top: {}, self: {},
      AudioContext: FakeAudioContext,
      sendCommand: (text) => w.commands.push(text),
    },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, queueMicrotask,
    Promise, Math, Date, String, Number, Array, Object, JSON, Set, Map, RegExp, Error, console,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    _muted: false,
    _voiceProofDone: true,
    micInFrame: () => false,
    micPolicyAllows: () => null,
    micExplain: (err) => ({ short: err?.message || 'microphone failed', long: '', actions: [] }),
    micReport: (text, actions) => w.reports.push({ text, actions }),
    openStandaloneTab() {},
    toast() {},
    appendChat: (_speaker, text) => w.chat.push(text),
    renderEar() {},
    earFrame() {},
    earGated: () => w._muted,
    earHeard() {},
    voiceProblem: (text) => w.problems.push(text),
    renderVoiceEngineReport() {},
    fillBrowserVoiceSelect() {},
    cleanForSpeech: (text) => String(text || '').replace(/\s+/g, ' ').trim(),
    speakViaServer: async (text) => { w.serverSpeaks.push(text); return 'ok'; },
    _authFetch: async () => ({ ok: true, json: async () => ({ ok: true, text: 'turn left' }) }),
  };
  w.stream = stream;
  w.chat = [];
  w.commands = [];
  w.problems = [];
  w.reports = [];
  w.serverSpeaks = [];
  w.Ear = {
    ready: false, starting: false, ctx: null, stream: null, proc: null,
    rate: 48000, noise: 0.005, inSentence: false, loudBlocks: 0, generation: 0,
    chunks: [], samples: 0, quietSince: 0, resumeAt: 0,
    queue: [], sending: false, problem: '', lastHeard: { text: '', at: 0 },
  };
  w.Speech = { busy: false, controller: null, queue: [], generation: 0, streams: new Map(), spoken: new Set() };
  w.BrowserSpeech = { tail: Promise.resolve() };
  w.voiceSynthesis = {
    getVoices: () => voices,
    speakCount: 0,
    cancelled: 0,
    paused: false,
    utterances: [],
    speak(utterance) {
      this.speakCount++;
      this.last = utterance;
      this.utterances.push(utterance);
      if (utterance.onstart) {
        setTimeout(() => {
          utterance.onstart();
          setTimeout(() => utterance.onend && utterance.onend(), 0);
        }, 0);
      }
    },
    cancel() { this.cancelled++; },
    resume() {},
  };
  w.Voice = {
    synth: w.voiceSynthesis,
    voices, voice: null, voiceName: '',
    synthProblem: '', synthDead: false, synthRetryAt: 0,
  };
  return w;
}

function load(w) {
  const body = NAMES.map(extractFunction).join('\n');
  const fn = new Function(...Object.keys(w), `
    const VOICE_NAME_KEY = 'jarvis_voice_name';
    const EAR_RESUME_MS = 500;
    const BROWSER_START_TIMEOUT_MS = 20;
    const BROWSER_RETRY_MS = 10;
    ${body}
    return { ${NAMES.join(', ')} };
  `);
  return fn(...Object.keys(w).map((key) => w[key]));
}

const BRITISH = { name: 'British local voice', lang: 'en-GB', localService: true, default: true };
const FRENCH = { name: 'Local French voice', lang: 'fr-FR', localService: true, default: false };
const REMOTE = { name: 'Remote cloud voice', lang: 'en-US', localService: false, default: true };

test('the installed local English voice wins when a browser fallback is needed', () => {
  const w = makeWorld({ voices: [FRENCH, BRITISH] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  assert.equal(w.Voice.voice.name, BRITISH.name);
  assert.equal(api.browserCanSpeak(), true);
});

test('browser voices without an explicit localService flag are never selected', () => {
  const w = makeWorld({ voices: [REMOTE] });
  const api = load(w);
  api.refreshBrowserVoiceList();
  assert.deepEqual(w.Voice.voices, []);
  assert.equal(w.Voice.voice, null);
  assert.equal(api.browserCanSpeak(), false);
  assert.match(w.Voice.synthProblem, /installed local voice/);
});

test('the app-local Kokoro generator is primary, even when a browser-local voice exists', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const reply = 'The complete answer remains in the app-local voice.';
  w.speakViaServer = async (text) => { w.serverSpeaks.push(text); return 'ok'; };
  const api = load(w);
  api.refreshBrowserVoiceList();

  assert.equal(await api.speakOne(reply, 0), 'server');
  assert.deepEqual(w.serverSpeaks, [reply]);
  assert.equal(w.voiceSynthesis.speakCount, 0, 'the browser voice is only a fallback');
});

test('when Kokoro is unavailable, a local browser voice speaks the complete reply', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  const reply = 'The complete answer must survive local voice fallback. '.repeat(12);
  w.speakViaServer = async (text) => { w.serverSpeaks.push(text); return 'failed'; };
  const api = load(w);
  api.refreshBrowserVoiceList();

  assert.equal(await api.speakOne(reply, 0), 'browser');
  assert.equal(w.serverSpeaks.length, 1);
  assert.ok(w.voiceSynthesis.utterances.length > 1);
  assert.equal(w.voiceSynthesis.utterances.map((u) => u.text).join(' ').replace(/\s+/g, ' ').trim(), reply.trim());
  assert.equal(w.problems.length, 0);
});

test('remote-only browser voices are not used when the local generator fails', async () => {
  const w = makeWorld({ voices: [REMOTE] });
  w.speakViaServer = async () => 'failed';
  const api = load(w);
  api.refreshBrowserVoiceList();

  assert.equal(await api.speakOne('Keep the answer in chat.', 0), 'failed');
  assert.equal(w.voiceSynthesis.speakCount, 0);
  assert.equal(w.problems.length, 1);
  assert.match(w.problems[0], /complete answer remains in chat/);
});

test('a browser voice that never starts falls back without wedging the ordered queue', async () => {
  const w = makeWorld({ voices: [BRITISH] });
  w.speakViaServer = async () => 'failed';
  w.voiceSynthesis.speak = function (utterance) { this.speakCount++; this.last = utterance; };
  const api = load(w);
  api.refreshBrowserVoiceList();

  assert.equal(await api.speakOne('Do not hang the next reply.', 0), 'failed');
  assert.match(w.Voice.synthProblem, /did not start speaking/);
  assert.equal(w.problems.length, 1);
});

test('the local ear is selected in every browser; cloud SpeechRecognition is not constructed', async () => {
  assert.doesNotMatch(html, /new\s+(?:window\.)?(?:webkit)?SpeechRecognition\s*\(/);
  assert.doesNotMatch(html, /window\.(?:webkit)?SpeechRecognition\b/);
  const w = makeWorld();
  const api = load(w);

  assert.equal(api.hearEngine(), 'server');
  assert.equal(api.listenRunning(), false);
  await api.listenStart();
  assert.equal(w.Ear.ready, true);
  assert.equal(w.Ear.rate, 16000);
  assert.equal(w.Ear.stream, w.stream);
});

test('stopping a pending microphone request releases the late stream instead of reopening it', async () => {
  let release;
  const stream = fakeStream();
  const w = makeWorld({ stream });
  w.navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { release = resolve; });
  const api = load(w);
  const starting = api.earStart();

  assert.equal(w.Ear.starting, true);
  w._muted = true;
  api.earStop();
  release(stream);
  await starting;

  assert.equal(w.Ear.ready, false);
  assert.equal(w.Ear.starting, false);
  assert.equal(stream.tracks[0].stopped, true);
});

test('the page sends raw microphone audio to the local transcription API', async () => {
  const w = makeWorld();
  const calls = [];
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  w.Ear.queue.push({ rate: 16000, bytes });
  w._authFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, text: 'turn left' }) };
  };
  const api = load(w);
  await api.earSend();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/voice/transcribe');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].options.headers['X-Audio-Rate'], '16000');
  assert.equal(calls[0].options.body, bytes, 'the audio is raw PCM, not sent to a browser recognition service');
  assert.deepEqual(w.commands, ['turn left']);
  assert.equal(w.Ear.sending, false);
});

test('the visible ear status names the local recogniser', () => {
  const w = makeWorld();
  const api = load(w);
  w.Ear.ready = true;
  assert.match(api.earStatusText(), /app-local faster-whisper/);
  assert.doesNotMatch(api.earStatusText(), /browser recogniser/i);
});

test('microphone access uses the standard mediaDevices path for major browsers', async () => {
  const w = makeWorld();
  const calls = [];
  w.navigator.mediaDevices.getUserMedia = async (options) => { calls.push(options); return w.stream; };
  const api = load(w);
  const stream = await api.micOpenStream();

  assert.equal(stream, w.stream);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].video, false);
  assert.equal(calls[0].audio.echoCancellation, true);
});

test('speech chunking preserves a long reply without a chunk-count cap', () => {
  const api = load(makeWorld());
  const reply = 'Full reply content. '.repeat(700);
  const chunks = api.chunkForSpeech(reply);
  assert.ok(chunks.length > 60, `all chunks should remain available, got ${chunks.length}`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), reply.trim());
});

test('speakReply queues the complete cleaned response without a character cap', () => {
  const w = makeWorld();
  const api = load(w);
  const reply = 'Complete answer section. '.repeat(100);
  w.Speech.busy = true;

  api.speakReply(reply);
  assert.equal(w.Speech.queue[0], reply.trim());
  assert.ok(w.Speech.queue[0].length > 1400);
});

test('streamed speech speaks the sentence tail when the final response arrives', () => {
  const w = makeWorld();
  const api = load(w);
  w.Speech.busy = true;
  api.speakStreamed('reply-1', 'First complete sentence. Second complete sentence.');
  api.finishStreamed('reply-1', 'First complete sentence. Second complete sentence. Final tail');

  assert.match(w.Speech.queue[0], /First complete sentence/);
  assert.match(w.Speech.queue.join(' '), /Second complete sentence/);
  assert.match(w.Speech.queue.join(' '), /Final tail/);
});

test('a speech exception does not wedge the reply queue', async () => {
  const w = makeWorld();
  const failures = [];
  w.voiceProblem = (text) => failures.push(text);
  w.speakViaServer = async () => { throw new Error('local voice failed'); };
  const api = load(w);
  w.Speech.queue.push('first reply', 'second reply');

  api.pumpSpeech();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(w.Speech.busy, false);
  assert.deepEqual(w.Speech.queue, []);
  assert.equal(failures.length, 2);
});

test('the dashboard and server use the same updated build marker', () => {
  const page = html.match(/JARVIS_BUILD = '([^']+)'/)?.[1];
  const server = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf8').match(/SERVER_BUILD = '([^']+)'/)?.[1];
  assert.ok(page);
  assert.equal(page, server);
});
