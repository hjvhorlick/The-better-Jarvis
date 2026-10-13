/**
 * Headless proof that the mic and the voice work in the browser layer —
 * the layer that must work on a fresh install with nothing downloaded.
 *
 * It loads the real dashboard/static/app.html into jsdom and replaces only
 * the hardware edges (SpeechRecognition, speechSynthesis, getUserMedia,
 * Web Audio, fetch), then drives the situations that used to leave both dead:
 *
 *   1. no ear starts before a user gesture (browsers refuse it), and the
 *      first click starts the browser recogniser;
 *   2. a recognised sentence becomes a /api/command;
 *   3. a reply is spoken by the browser voice, in the tab — not by asking
 *      the (possibly absent) local voice service;
 *   4. "Local" engine really uses /api/voice/speak, and Auto falls back to
 *      it when the browser has no voices at all;
 *   5. without SpeechRecognition (Firefox), the raw microphone ear opens
 *      instead (the faster-whisper path);
 *   6. Mute stops the recogniser; the listen bar is actually visible.
 *
 * Run:  node tests/voice_browser_harness.mjs
 *       (jsdom is not a project dependency: npm i --no-save jsdom@24 first)
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const handScript = readFileSync(new URL('../dashboard/static/hand-gestures.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../dashboard/static/app.html', import.meta.url), 'utf8')
  .replace('<script src="/static/hand-gestures.js"></script>', `<script>${handScript}</script>`);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function makeDom({ withSR = true, browserVoices = [{ name: 'Daniel', lang: 'en-GB' }] } = {}) {
  const state = {
    recog: null, srStarts: 0, srAborts: 0,
    speakCalls: [], voiceRequests: [], commands: [], micOpenCalls: 0, proc: null,
  };
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    beforeParse(window) {
      window.isSecureContext = true;
      window.localStorage.removeItem('jarvis-voice-engine');

      window.navigator.mediaDevices = {
        getUserMedia: async () => {
          state.micOpenCalls++;
          return {
            getTracks: () => [{ stop: () => {} }],
            getAudioTracks: () => [{ label: 'Harness Microphone' }],
          };
        },
        enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'mic-1', label: 'Harness Microphone' }],
      };

      class FakeNode {
        connect() { return this; }
        disconnect() {}
      }
      window.AudioContext = class {
        constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = new FakeNode(); }
        createMediaStreamSource() { return new FakeNode(); }
        createScriptProcessor() {
          const node = new FakeNode();
          node.onaudioprocess = null;
          state.proc = node;
          return node;
        }
        createGain() { return Object.assign(new FakeNode(), { gain: { value: 0 } }); }
        createAnalyser() {
          return Object.assign(new FakeNode(), {
            fftSize: 1024,
            getByteTimeDomainData(arr) { arr.fill(128); },
          });
        }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
      };

      if (withSR) {
        window.SpeechRecognition = class {
          constructor() { state.recog = this; }
          start() {
            state.srStarts++;
            this.live = true;
          }
          stop() { if (this.live) { this.live = false; this.onend && this.onend(); } }
          abort() { state.srAborts++; this.stop(); }
          emit(text) {
            this.onresult && this.onresult({
              resultIndex: 0,
              results: [{ isFinal: true, 0: { transcript: text } }],
            });
          }
        };
      }

      window.speechSynthesis = {
        getVoices: () => browserVoices,
        addEventListener: () => {},
        speak(u) {
          state.speakCalls.push(u.text);
          setTimeout(() => u.onstart && u.onstart(), 0);
          setTimeout(() => u.onend && u.onend(), 30);
        },
        cancel() {},
        resume() {},
        paused: false, speaking: false, pending: false,
      };
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

      window.fetch = async (url, opts = {}) => {
        const urlText = String(url);
        let body = {};
        try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }
        if (urlText.includes('/api/voice/speak')) {
          state.voiceRequests.push(body.text);
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (urlText.includes('/api/voice/transcribe')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, text: 'open the files' }) };
        }
        if (urlText.includes('/api/voice/health')) {
          return { ok: true, status: 200, json: async () => ({ ok: false, code: 'offline', message: 'harness: no local service' }) };
        }
        if (urlText.includes('/api/command')) {
          state.commands.push(body);
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: 'Opening the file browser, sir.', id: body.requestId }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
      window.scrollTo = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (_t, k) => (k === 'canvas' ? null : (() => new Proxy({}, { get: () => () => {} }))),
        set: () => true,
      });
      window.Audio = class { play() { return Promise.resolve(); } pause() {} };
      window.URL.createObjectURL = () => 'blob:harness';
      window.URL.revokeObjectURL = () => {};
    },
  });
  return { dom, state, window: dom.window, doc: dom.window.document };
}

const click = (doc, window) => doc.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));

/* 1–3: browser recogniser + browser voice */
{
  const { window, doc, state } = makeDom();
  await settle(120);
  ok('ear: nothing tries the microphone before a gesture',
    window.jarvisMicStatus().state === 'off' && state.srStarts === 0,
    JSON.stringify(window.jarvisMicStatus()));

  click(doc, window);
  await settle(150);
  const mic = window.jarvisMicStatus();
  ok('ear: first click starts browser recognition', mic.state === 'listening' && mic.mode === 'browser', JSON.stringify(mic));
  ok('ear: listen bar is visible (show class)', doc.getElementById('listen-bar').classList.contains('show'));

  // Wait out the anti-self-hearing pause after the "Voice online" proof line
  // (Ear.resumeAt): a real recogniser is stopped while JARVIS speaks, so a
  // result can only land after that pause in a real browser too.
  await settle(700);
  state.recog.emit('what time is it');
  await settle(80);
  ok('ear: a recognised sentence becomes a command',
    state.commands.some((c) => JSON.stringify(c).includes('what time is it')),
    JSON.stringify(state.commands));

  const spokenBefore = state.speakCalls.length;
  window.speakReply('It is noon, sir.', 'harness-reply-1');
  await settle(250);
  ok('mouth: reply spoken by the browser voice, in the tab',
    state.speakCalls.slice(spokenBefore).some((t) => /noon/.test(t)), JSON.stringify(state.speakCalls));
  ok('mouth: …without asking the local voice service',
    state.voiceRequests.length === 0, JSON.stringify(state.voiceRequests));
  ok('mouth: status names the browser as the voice that spoke',
    window.jarvisSpeechStatus().lastEngine === 'browser', JSON.stringify(window.jarvisSpeechStatus()));

  /* 6: mute */
  window.toggleMute();
  await settle(60);
  ok('mute: stops the recogniser', window.jarvisMicStatus().state === 'muted' && state.srAborts > 0,
    JSON.stringify(window.jarvisMicStatus()));
  window.toggleMute();
  await settle(100);
  ok('mute: unmuting listens again', window.jarvisMicStatus().state === 'listening',
    JSON.stringify(window.jarvisMicStatus()));
}

/* 4: Local engine + Auto fallback when the browser has no voice */
{
  const { window, state } = makeDom();
  await settle(100);
  window.setVoiceEngine('local');
  window.speakReply('Said by the computer, sir.', 'harness-reply-2');
  await settle(200);
  ok('mouth (local): /api/voice/speak is used', state.voiceRequests.some((t) => /computer/.test(t)),
    JSON.stringify(state.voiceRequests));
  ok('mouth (local): status reports the server voice in use',
    window.jarvisSpeechStatus().lastEngine === 'local', JSON.stringify(window.jarvisSpeechStatus()));
}
{
  const { window, state } = makeDom({ browserVoices: [] });
  await settle(100);
  window.speakReply('Fallback sentence, sir.', 'harness-reply-3');
  await settle(500);
  ok('mouth (auto): no browser voices → local voice takes the sentence',
    state.voiceRequests.some((t) => /Fallback/.test(t)), JSON.stringify(state.voiceRequests));
}

/* 5: no SpeechRecognition → raw microphone ear */
{
  const { window, doc, state } = makeDom({ withSR: false });
  await settle(100);
  click(doc, window);
  await settle(200);
  const mic = window.jarvisMicStatus();
  ok('ear (no recogniser): raw microphone opens for the on-computer ear',
    state.micOpenCalls > 0 && mic.mode === 'local' && mic.state === 'listening', JSON.stringify(mic));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
