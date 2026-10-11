/**
 * Headless proof that the dashboard microphone works, without a browser.
 *
 * It loads the real dashboard/static/app.html into jsdom and replaces only the
 * hardware edges (getUserMedia, Web Audio, SpeechRecognition, fetch), then drives
 * the situations that used to leave the button dead:
 *
 *   1. the browser's own recogniser works             -> words go to /api/command
 *   2. the recogniser is missing (Firefox/Safari-ish) -> audio is auto-stopped on
 *      silence and sent to POST /api/voice/transcribe
 *   3. the microphone is refused                      -> an explained System bubble
 *   4. the settings self-tests run
 *   5. always-on: the microphone arms itself on the first click, and the plain
 *      ON/OFF buttons in Settings control mic + speakers
 *
 * Run:  node tests/mic_harness.mjs
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../dashboard/static/app.html', import.meta.url), 'utf8');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

function makeDom({ withSR = true, micFails = null, transcribeText = 'open the files', srNeedsGesture = false, micAlwaysOn = false } = {}) {
  const state = {
    sr: null,            // last SpeechRecognition instance
    srCount: 0,
    proc: null,          // last ScriptProcessor
    waveform: new Float32Array(1024),   // what the analyser "hears"
    now: 0,
    posts: [],
    fetches: [],
    micOpenCalls: 0,
    stoppedTracks: 0,
    gestured: false,
  };

  const dom = new JSDOM(html, {
    url: 'https://jarvis.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    beforeParse(window) {
      window.isSecureContext = true;   // jsdom does not implement this
      window.localStorage.setItem('jarvis-wake', micAlwaysOn ? 'on' : 'off');

      // ── clock: each rAF tick is 100 ms of "audio time" ──
      window.performance.now = () => state.now;
      window.requestAnimationFrame = (cb) => {
        state.now += 100;
        setTimeout(() => cb(state.now), 20);
        return 1;
      };
      window.cancelAnimationFrame = () => {};

      // ── microphone ──────────────────────────────────────────────────────
      window.navigator.mediaDevices = {
        getUserMedia: async () => {
          state.micOpenCalls++;
          if (micFails) { const e = new Error('denied'); e.name = micFails; throw e; }
          return {
            getTracks: () => [{ stop: () => { state.stoppedTracks++; } }],
            getAudioTracks: () => [{ label: 'Harness Microphone' }],
          };
        },
        enumerateDevices: async () => ([
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Harness Microphone' },
        ]),
      };

      // ── web audio ───────────────────────────────────────────────────────
      class FakeAnalyser {
        constructor() { this.fftSize = 1024; }
        connect() {}
        disconnect() {}
        getByteTimeDomainData(arr) {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.max(0, Math.min(255, Math.round(128 + (state.waveform[i] || 0) * 128)));
          }
        }
      }
      class FakeNode {
        connect() { return this; }
        disconnect() {}
      }
      window.AudioContext = class {
        constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = new FakeNode(); }
        createOscillator() {
          return Object.assign(new FakeNode(), {
            type: 'sine', frequency: { value: 0 }, start() {}, stop() {},
          });
        }
        createAnalyser() { return new FakeAnalyser(); }
        createGain() {
          return Object.assign(new FakeNode(), {
            gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          });
        }
        createMediaStreamSource() { return new FakeNode(); }
        createScriptProcessor() {
          const node = new FakeNode();
          node.onaudioprocess = null;
          state.proc = node;
          return node;
        }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
      };

      // ── speech recognition (Chrome-like: first start needs a click) ─────
      if (withSR) {
        window.SpeechRecognition = class {
          constructor() {
            this.continuous = false;
            this.interimResults = false;
            state.sr = this;
            state.srCount++;
          }
          start() {
            if (srNeedsGesture && !state.gestured) {
              setTimeout(() => this.onerror && this.onerror({ error: 'not-allowed' }), 0);
              return;
            }
            this.onstart && this.onstart();
          }
          stop() {}
          abort() {}
        };
      }

      // ── network ─────────────────────────────────────────────────────────
      window.fetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : {};
        state.fetches.push({ url: String(url), body });
        if (String(url).includes('/api/voice/transcribe')) {
          state.posts.push(body);
          return { ok: true, status: 200, json: async () => ({ ok: true, text: transcribeText }) };
        }
        if (String(url).includes('/api/command')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: 'Opening the file browser, sir.' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
      window.scrollTo = () => {};
    },
  });

  dom.window.document.addEventListener('pointerdown', () => { state.gestured = true; }, true);
  return { dom, state, window: dom.window, doc: dom.window.document };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const click = (doc, window) => doc.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));

/* Speak for `loudTicks` meter ticks, then go quiet long enough to auto-stop. */
async function speak(state, { loudTicks = 6, quietTicks = 16 } = {}) {
  for (let i = 0; i < 1024; i++) state.waveform[i] = 0.35 * Math.sin(i / 3);
  for (let t = 0; t < loudTicks; t++) {
    if (state.proc && state.proc.onaudioprocess) {
      state.proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    }
    await settle(30);
  }
  state.waveform.fill(0);
  for (let t = 0; t < quietTicks; t++) await settle(30);
}

/* ── 1. a working browser recogniser ─────────────────────────────────────── */
{
  const { window, doc, state } = makeDom({ withSR: true });
  await settle(120);
  window.doMic();
  await settle(150);
  const status = window.jarvisMicStatus();
  ok('browser recogniser: microphone opened', state.micOpenCalls === 1, `calls=${state.micOpenCalls}`);
  ok('browser recogniser: state is listening', status.state === 'listening', JSON.stringify(status));
  ok('browser recogniser: listening strip shown', doc.getElementById('mic-strip').classList.contains('show'));
  state.sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'what is the status' }], { isFinal: true })] });
  await settle(800);
  const cmd = state.fetches.find((f) => f.url.includes('/api/command'));
  ok('browser recogniser: words became a command', cmd && cmd.body.text === 'what is the status', JSON.stringify(cmd && cmd.body));
  ok('browser recogniser: strip hidden again', !doc.getElementById('mic-strip').classList.contains('show'));
}

/* ── 2. no recogniser at all: silence auto-stop -> server transcription ──── */
{
  const { window, doc, state } = makeDom({ withSR: false });
  await settle(120);
  window.doMic();
  await settle(200);
  ok('fallback: microphone opened', state.micOpenCalls === 1);
  ok('fallback: no recogniser noted', state.sr === null);
  await speak(state, { loudTicks: 6, quietTicks: 16 });
  await settle(500);
  const sent = state.posts[0];
  ok('fallback: audio was sent to the server transcriber', !!sent, sent ? `bytes=${Math.round((sent.pcm.length * 3) / 4)} rate=${sent.rate}` : `status=${JSON.stringify(window.jarvisMicStatus())}`);
  const cmd = state.fetches.find((f) => f.url.includes('/api/command'));
  ok('fallback: transcript became a command', cmd && cmd.body.text === 'open the files', JSON.stringify(cmd && cmd.body));
  ok('fallback: microphone released', state.stoppedTracks > 0, `stopped=${state.stoppedTracks}`);
  ok('fallback: strip hidden again', !doc.getElementById('mic-strip').classList.contains('show'));
}

/* ── 3. a refused microphone explains itself on screen ───────────────────── */
for (const [name, errName] of [['a blocked frame', 'NotAllowedError'], ['no device', 'NotFoundError'], ['device busy', 'NotReadableError']]) {
  const { window, doc } = makeDom({ micFails: errName });
  await settle(120);
  window.doMic();
  await settle(300);
  const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent);
  const explained = bubbles.find((t) => /Microphone|microphone/.test(t) && /(permission|found|use|frame|Allow|plug)/i.test(t));
  ok(`refusal (${name}) is explained in the dialogue`, !!explained, explained ? explained.slice(0, 90) + '…' : `bubbles=${JSON.stringify(bubbles).slice(0, 120)}`);
  ok(`refusal (${name}) leaves the button idle`, doc.getElementById('mic-strip').classList.contains('show') === false);
}

/* ── 4. the settings self-tests run ──────────────────────────────────────── */
{
  const { window, doc } = makeDom({ withSR: true });
  await settle(120);
  let threw = null;
  try { await window.testSpeakersNow(); } catch (e) { threw = e; }
  ok('speaker test runs', !threw, threw && threw.message);
  const report = doc.getElementById('voice-test-report').textContent;
  ok('speaker test reports what it did', /Three tones are playing/i.test(report), report.split('\n')[0]);
  threw = null;
  try { await window.testMicNow(); } catch (e) { threw = e; }
  ok('mic test runs', !threw, threw && threw.message);
  ok('mic test reports a verdict', /works|silent|quietly/i.test(doc.getElementById('voice-test-report').textContent),
     doc.getElementById('voice-test-report').textContent.split('\n')[0]);
}

/* ── 5. always-on: the first click arms the microphone ───────────────────── */
{
  const { window, doc, state } = makeDom({ withSR: true, srNeedsGesture: true, micAlwaysOn: true });
  await settle(1500);                                   // the 1200 ms auto-arm timer
  const before = window.jarvisMicStatus();
  ok('always-on: microphone is on by default', before.micAlwaysOn === true, JSON.stringify(before));
  ok('always-on: waiting for the first click', before.waitingForFirstClick === true, `waiting=${before.waitingForFirstClick}`);
  ok('always-on: strip invites the click', /click anywhere/i.test(doc.getElementById('mic-status').textContent), doc.getElementById('mic-status').textContent);
  click(doc, window);
  await settle(300);
  const after = window.jarvisMicStatus();
  ok('always-on: first click arms the listener', after.alwaysListening === true, JSON.stringify(after));
  ok('always-on: strip says Hey Jarvis', /Hey Jarvis/i.test(doc.getElementById('mic-status').textContent), doc.getElementById('mic-status').textContent);
  ok('always-on: settings button reads ON', /Microphone: ON/.test(doc.getElementById('btn-mic-always').textContent), doc.getElementById('btn-mic-always').textContent);
  ok('always-on: speakers default ON', /Speakers: ON/.test(doc.getElementById('btn-speak-always').textContent), doc.getElementById('btn-speak-always').textContent);
  // A one-shot command must not leave the always-on listener dead behind it.
  window.doMic();
  await settle(150);
  state.sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'what is the time' }], { isFinal: true })] });
  await settle(900);
  ok('always-on: re-arms itself after a one-shot command', window.jarvisMicStatus().alwaysListening === true, JSON.stringify(window.jarvisMicStatus()));

  window.toggleWakeWord();
  await settle(120);
  ok('always-on: the OFF button switches it off', window.jarvisMicStatus().micAlwaysOn === false && window.localStorage.getItem('jarvis-wake') === 'off');
}

/* ── summary ─────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
