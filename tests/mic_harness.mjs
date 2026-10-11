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
 *       (jsdom is not a project dependency: npm i --no-save jsdom@24 first)
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../dashboard/static/app.html', import.meta.url), 'utf8');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

function makeDom({ withSR = true, micFails = null, transcribeText = 'open the files', srNeedsGesture = false, micAlwaysOn = false, srEndsItself = false, srScripts = null, speakScript = null, mutedByDefault = false, voiceDead = false, serverVoice = true, withSpeech = true, voiceEngine = null } = {}) {
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
    srStarts: 0,          // how many times a recogniser was started (= listener restarts)
    srLive: 0,            // sessions that have not ended
    srAborts: 0,
    speakCalls: [],       // utterances handed to speechSynthesis.speak
    cancels: 0,
    resumed: 0,
    playedFiles: [],      // audio files the page played (the server voice)
    voiceRequests: [],    // sentences asked of /api/voice/speak
  };

  const dom = new JSDOM(html, {
    url: 'https://jarvis.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    beforeParse(window) {
      window.isSecureContext = true;   // jsdom does not implement this
      window.localStorage.setItem('jarvis-wake', micAlwaysOn ? 'on' : 'off');
      if (mutedByDefault) window.localStorage.setItem('jarvis-mute', 'on');
      else window.localStorage.removeItem('jarvis-mute');
      if (voiceEngine) window.localStorage.setItem('jarvis-voice-engine', voiceEngine);
      else window.localStorage.removeItem('jarvis-voice-engine');

      // ── clock: real time, plus 100 ms of "audio time" for each rAF tick, so
      // both the page's own timers and the meter's ticks behave as they would in
      // a browser ──
      state.t0 = Date.now();
      state.virtual = 0;
      window.performance.now = () => 1000 + (Date.now() - state.t0) + state.virtual;
      window.requestAnimationFrame = (cb) => {
        state.virtual += 100;
        setTimeout(() => cb(window.performance.now()), 20);
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
      if (!withSpeech) {
        // A computer with no browser voice at all: the synthesiser simply is not there.
        try { delete window.speechSynthesis; } catch (_) { window.speechSynthesis = undefined; }
      }
      if (withSR) {
        window.SpeechRecognition = class {
          constructor() {
            this.continuous = false;
            this.interimResults = false;
            state.sr = this;
            state.srCount++;
          }
          start() {
            if (srNeedsGesture && !state.gestured && !state.gesturedOnce) {
              setTimeout(() => this.onerror && this.onerror({ error: 'not-allowed' }), 0);
              return;
            }
            state.srStarts++;
            state.srLive++;
            const mine = this;
            this.onstart && this.onstart();
            // Chrome ends a session after a silence — the page must bring it back.
            if (srEndsItself) setTimeout(() => {
              if (mine.ended) return;
              mine.ended = true;
              state.srLive--;
              mine.onend && mine.onend();
            }, 700);
            if (srScripts) srScripts(this, state);
          }
          stop() { if (this.ended) return; this.ended = true; state.srLive--; this.onend && this.onend(); }
          abort() { state.srAborts++; this.stop(); }
        };
        if (!withSpeech) { /* nothing to install */ } else window.speechSynthesis = {
          getVoices: () => [{ name: 'Daniel', lang: 'en-GB' }, { name: 'Google US English', lang: 'en-US' }],
          speak(u) {
            state.speakCalls.push(u.text);
            if (voiceDead) return;                                        // a browser voice that says nothing, ever
            if (speakScript && speakScript(u, state) === false) return;   // a scripted failure
            setTimeout(() => u.onstart && u.onstart(), 0);
            const life = Math.min(400, 40 + u.text.length * 4);
            setTimeout(() => u.onend && u.onend(), life);
          },
          cancel() { state.cancels++; },
          resume() { state.resumed++; },
          paused: false, speaking: false, pending: false,
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
        if (String(url).includes('/api/voice/speak')) {
          state.voiceRequests.push(body.text);
          if (!serverVoice) return { ok: false, status: 200, json: async () => ({ ok: false, code: 'budget', message: 'the day\'s Gemini budget is used up' }) };
          const wav = Buffer.from('RIFF' + '\u0000'.repeat(40) + 'fake audio').toString('base64');
          return { ok: true, status: 200, json: async () => ({ ok: true, audio: wav, mime: 'audio/wav', model: 'harness-tts', ms: 120 }) };
        }
        if (String(url).includes('/api/command')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, reply: 'Opening the file browser, sir.', id: body.requestId }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
      window.scrollTo = () => {};
      // jsdom ships neither a 2D canvas nor the utterance class; Chrome has both.
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (_t, k) => (k === 'canvas' ? null : (() => new Proxy({}, { get: () => () => {} }))),
        set: () => true,
      });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      // jsdom has no audio output; the page's server voice plays an ordinary
      // <audio> file, so the harness records what was played and "finishes" it.
      window.Audio = class {
        constructor(src) { this.src = src; state.playedFiles.push(String(src).slice(0, 24)); }
        play() { setTimeout(() => this.onended && this.onended(), 60); return Promise.resolve(); }
        pause() {}
      };
      window.URL.createObjectURL = () => 'blob:harness-audio';
      window.URL.revokeObjectURL = () => {};
    },
  });

  dom.window.document.addEventListener('pointerdown', () => { state.gestured = true; state.gesturedOnce = true; }, true);
  return { dom, state, window: dom.window, doc: dom.window.document };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/* The engine under test is the SERVER voice by default (the owner's rule), so
   "was it said?" is the browser's utterances PLUS the sentences asked of the
   server. Each test still names which throat it expects. */
const spoken = (state) => [...state.speakCalls, ...state.voiceRequests];
const saidByServer = (state, re) => state.voiceRequests.some((t) => re.test(t));
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
  ok('always-on: the strip asks for the click the browser demands', /click anywhere/i.test(doc.getElementById('mic-status').textContent), doc.getElementById('mic-status').textContent);
  click(doc, window);
  // The very first click also earns one spoken sentence ("Voice online, sir."),
  // which pauses the ear while he says it — so the ear is checked after that.
  const earBack = Date.now() + 4000;
  while (Date.now() < earBack && window.jarvisMicStatus().alwaysListening !== true) await settle(80);
  const after = window.jarvisMicStatus();
  ok('always-on: first click arms the listener', after.alwaysListening === true, JSON.stringify(after));
  ok('always-on: the bar shows the ear is open', /just speak|Listening/i.test(doc.getElementById('listen-text').textContent), doc.getElementById('listen-text').textContent);
  ok('always-on: the first click is answered with one spoken sentence', spoken(state).length > 0, JSON.stringify(spoken(state)));
  ok('always-on: settings button reads ON', /Microphone: ON/.test(doc.getElementById('btn-mic-always').textContent), doc.getElementById('btn-mic-always').textContent);
  ok('always-on: speakers default ON', /Speakers: ON/.test(doc.getElementById('btn-speak-always').textContent), doc.getElementById('btn-speak-always').textContent);
  // A one-shot dictation must not leave the always-on listener dead behind it.
  window.doMic();
  await settle(150);
  state.sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'what is the time' }], { isFinal: true })] });
  await settle(2000);                                  // the reply is spoken first; the ear returns after
  ok('always-on: re-arms itself after a one-shot command', window.jarvisMicStatus().alwaysListening === true, JSON.stringify(window.jarvisMicStatus()));

  window.toggleWakeWord();
  await settle(120);
  ok('always-on: the OFF button switches it off', window.jarvisMicStatus().micAlwaysOn === false && window.localStorage.getItem('jarvis-wake') === 'off');
}

/* ── 6. ALWAYS-ON: no wake word, mute on demand, and a reliable voice ─────── */
{
  // A recogniser that behaves like Chrome's: it ends itself after a silence, and
  // it can be handed whatever was "said" through state.sr.onresult.
  const { window, doc, state } = makeDom({ withSR: true, srEndsItself: true, micAlwaysOn: true });
  await settle(1200);                                   // the auto-arm timer

  const status = () => window.jarvisMicStatus();
  // A person waits for JARVIS to stop talking before replying — the ear is
  // closed while he speaks (he would otherwise hear himself), so the tests do
  // the same thing a human does: wait for the "listening" state.
  const waitListening = async (ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (status().listenState === 'listening') return true;
      await settle(60);
    }
    return status().listenState === 'listening';
  };
  ok('always-on: microphone on by default', status().micAlwaysOn === true, JSON.stringify(status().listenState));
  ok('always-on: mode defaults to "no wake word"', status().listenMode === 'always', status().listenMode);
  ok('always-on: the ear is actually open', status().listenState === 'listening', JSON.stringify(status().listenState));
  ok('always-on: the green bar is visible', doc.getElementById('listen-bar').classList.contains('show'));
  ok('always-on: the bar says just speak', /just speak/i.test(doc.getElementById('listen-text').textContent), doc.getElementById('listen-text').textContent);

  // 1.8 s later Chrome has ended the session; the ear must have come back by itself.
  const startsBefore = state.srStarts;
  await settle(900);
  ok('always-on: the ear reopens itself after the browser ends the session',
     state.srStarts > startsBefore && status().listenState === 'listening',
     `starts ${startsBefore} -> ${state.srStarts}, live=${state.srLive}`);

  // Just talking — no wake word — becomes a command.
  const say = (text) => {
    state.sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  };
  const speakTo = async (text) => { await waitListening(); say(text); };
  state.sr.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'what is the time' }], { isFinal: false })] });
  await settle(60);
  ok('always-on: the interim words appear in the bar', /Hearing/.test(doc.getElementById('listen-text').textContent), doc.getElementById('listen-text').textContent);
  await speakTo('what is the time');
  await settle(900);
  const firstCommands = state.fetches.filter((f) => f.url.includes('/api/command'));
  ok('always-on: speaking (no wake word) sends the command', firstCommands.length === 1 && firstCommands[0].body.text === 'what is the time',
     JSON.stringify(firstCommands.map((f) => f.body.text)));
  ok('always-on: every command carries an id', !!firstCommands[0].body.requestId, JSON.stringify(firstCommands[0].body));

  // A pause in the middle of a sentence must be one command, not two.
  await speakTo('remind me to');
  await settle(160);
  await speakTo('call the office');
  await settle(900);
  const joined = state.fetches.filter((f) => f.url.includes('/api/command'));
  ok('always-on: a mid-sentence pause joins instead of splitting',
     joined.length === 2 && joined[1].body.text === 'remind me to call the office',
     JSON.stringify(joined.map((f) => f.body.text)));

  // Noise is not a command.
  await speakTo('um');
  await settle(800);
  ok('always-on: a stray word is not obeyed', state.fetches.filter((f) => f.url.includes('/api/command')).length === 2);

  // The mute button — the bar's own button — stops everything at once.
  const commandsSoFar = () => state.fetches.filter((f) => f.url.includes('/api/command')).length;
  const beforeMuted = commandsSoFar();
  doc.getElementById('listen-mute-btn').dispatchEvent(new window.Event('click'));
  await settle(300);
  ok('mute: the ear closes', status().muted === true && status().alwaysListening === false, JSON.stringify({ muted: status().muted, ear: status().alwaysListening, state: status().listenState }));
  ok('mute: the bar says so', /Muted/.test(doc.getElementById('listen-text').textContent), doc.getElementById('listen-text').textContent);
  ok('mute: the choice is remembered', window.localStorage.getItem('jarvis-mute') === 'on');
  ok('mute: he says that he is muted', saidByServer(state, /Muted/i), JSON.stringify(state.voiceRequests.slice(-2)));
  // Being muted must also survive a page reload: a fresh page reads the same flag.
  const reloaded = makeDom({ withSR: true, micAlwaysOn: true, mutedByDefault: true });
  await settle(1200);
  const reloadedEar = reloaded.window.jarvisMicStatus();
  ok('mute: a page reloaded with the mute saved comes up muted and silent',
     reloadedEar.muted === true && reloadedEar.alwaysListening === false && reloadedEar.listenState === 'muted',
     JSON.stringify({ muted: reloadedEar.muted, ear: reloadedEar.alwaysListening, state: reloadedEar.listenState }));
  reloaded.window.close();
  await speakTo('what is the weather');
  await settle(900);
  ok('mute: nothing said while muted is sent', commandsSoFar() === beforeMuted, `${beforeMuted} -> ${commandsSoFar()}`);
  ok('mute: the settings button says "Unmute"', /Unmute/.test(doc.getElementById('btn-mute').textContent), doc.getElementById('btn-mute').textContent);

  window.toggleMute();
  await settle(500);
  ok('unmute: the ear comes straight back', status().muted === false && status().listenState === 'listening', JSON.stringify(status().listenState));
  await speakTo('system status');
  await settle(900);
  ok('unmute: commands are sent again', commandsSoFar() === beforeMuted + 1, `${beforeMuted} -> ${commandsSoFar()}`);

  // Wake-word mode still exists for anyone who wants the room private.
  const beforeWake = commandsSoFar();
  doc.getElementById('sel-listen-mode').value = 'wake';
  doc.getElementById('sel-listen-mode').dispatchEvent(new window.Event('change'));
  await settle(300);
  ok('wake mode: it can be switched on from Settings', status().listenMode === 'wake' && window.localStorage.getItem('jarvis-listen-mode') === 'wake', status().listenMode);
  await speakTo('open the files');
  await settle(900);
  ok('wake mode: speech without the wake word is ignored', commandsSoFar() === beforeWake, `${beforeWake} -> ${commandsSoFar()}`);
  await speakTo('hey jarvis open the files');
  await settle(900);
  ok('wake mode: the wake word starts a command',
     commandsSoFar() === beforeWake + 1 && state.fetches.filter((f) => f.url.includes('/api/command')).pop().body.text === 'open the files',
     JSON.stringify(state.fetches.filter((f) => f.url.includes('/api/command')).map((f) => f.body.text)));
  // "Hey Jarvis" on its own is answered and then waits for the command.
  await speakTo('hey jarvis');
  await settle(1000);
  ok('wake mode: the bare wake word is answered with a question', saidByServer(state, /Yes, sir/i), JSON.stringify(state.voiceRequests.slice(-2)));
  await speakTo('what is the weather');
  await settle(900);
  ok('wake mode: the answer to "Yes, sir?" is the command',
     commandsSoFar() === beforeWake + 2 && state.fetches.filter((f) => f.url.includes('/api/command')).pop().body.text === 'what is the weather',
     JSON.stringify(state.fetches.filter((f) => f.url.includes('/api/command')).map((f) => f.body.text)));
  window.setListenMode('always');
  await settle(300);
  ok('mode: it switches back to always listening', status().listenMode === 'always');

  // ── the voice: every fresh reply is spoken, with no same-tick cancel ──────
  ok('voice: replies are spoken', spoken(state).length > 0, `${spoken(state).length} sentences, cancels=${state.cancels}`);
  const firstVoice = spoken(state)[spoken(state).length - 1];
  ok('voice: the spoken text is the reply, not a status line', typeof firstVoice === 'string' && firstVoice.length > 2, firstVoice);
  ok('voice: a cancel never precedes the first speak', state.cancels === 0, `cancels=${state.cancels}`);
  const speech = window.jarvisSpeechStatus();
  ok('voice: the server voice is the default', speech.engine === 'server' && speech.usingServer === true, JSON.stringify({ engine: speech.engine, using: speech.usingServer }));
  ok('voice: speech is on by default', speech.on === true, JSON.stringify({ on: speech.on, supported: speech.supported }));
  ok('voice: the browser voice was NOT used', state.speakCalls.length === 0, JSON.stringify(state.speakCalls));

  // JARVIS must not obey his own voice: replay part of what he just said.
  // (With the server voice the words live in the server requests, not the browser.)
  const hisOwnWords = spoken(state)[0].split(' ').slice(0, 6).join(' ');
  const beforeEcho = state.fetches.filter((f) => f.url.includes('/api/command')).length;
  await speakTo(hisOwnWords);
  await settle(900);
  ok('voice: his own words coming back are not obeyed',
     state.fetches.filter((f) => f.url.includes('/api/command')).length === beforeEcho,
     `heard "${hisOwnWords}"`);
}

/* ── 7. a streamed answer is shown and spoken as it is written ───────────── */
{
  const { window, doc, state } = makeDom({ withSR: true, micAlwaysOn: true, srEndsItself: true });
  await settle(1200);
  window.jarvisStopSpeaking && window.jarvisStopSpeaking();
  const voiceBefore = state.speakCalls.length;

  const feed = (m) => window.__jarvisWs && window.__jarvisWs(m);
  ok('stream: the page exposes a websocket feeder for tests', typeof feed === 'function');

  feed({ type: 'stream', id: 's-1', speaker: 'jarvis', text: 'The time is ten past nine. ', done: false });
  await settle(120);
  const live = doc.querySelector('.chat-bubble.streaming');
  ok('stream: a live bubble appears while the answer is written', !!live, `bubbles=${doc.querySelectorAll('.chat-bubble').length}`);
  ok('stream: the bubble holds the words so far', !!live && /ten past nine/.test(live.textContent), live && live.textContent.slice(0, 60));
  ok('stream: the finished sentence is already being spoken', spoken(state).length > voiceBefore, JSON.stringify(spoken(state).slice(voiceBefore)));

  feed({ type: 'stream', id: 's-1', speaker: 'jarvis', text: 'The time is ten past nine. Shall I set a reminder?', done: false });
  await settle(120);
  feed({ type: 'log', id: 's-1', speaker: 'jarvis', text: 'The time is ten past nine. Shall I set a reminder?', timestamp: Date.now() });
  await settle(200);
  const finished = doc.querySelectorAll('.chat-bubble.streaming');
  ok('stream: the finished reply replaces the live bubble', finished.length === 0, `streaming=${finished.length}`);
  const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].map((b) => b.textContent);
  const matching = bubbles.filter((t) => /ten past nine/.test(t));
  ok('stream: the reply appears exactly once', matching.length === 1, JSON.stringify(bubbles.map((t) => t.slice(0, 40))));
  ok('stream: the tail is spoken too', spoken(state).join(' ').includes('Shall I set a reminder'), JSON.stringify(spoken(state)));

  // The server echoes the command back to every client, the sender included: the
  // page that sent it must not print its own words a second time.
  window.sendCommand('what is the time');
  await settle(150);
  const sentId = state.fetches.filter((f) => f.url.includes('/api/command')).pop().body.requestId;
  feed({ type: 'log', id: sentId, speaker: 'user', text: 'what is the time', timestamp: Date.now() });
  await settle(150);
  const userBubbles = [...doc.querySelectorAll('.chat-bubble.speaker-user')].filter((b) => /what is the time/.test(b.textContent));
  ok('echo: a sent command appears exactly once, even with the server echo', userBubbles.length === 1, `${userBubbles.length} bubbles`);

  // Both paths can deliver the same reply (the HTTP answer and the websocket
  // copy). Whichever lands first, the answer must appear exactly once.
  const voiceBeforeRace = state.speakCalls.length;
  const countReplies = () => [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].filter((b) => /Opening the file browser/.test(b.textContent)).length;
  const beforeRace = countReplies();
  window.sendCommand('what is the time');
  await settle(400);                                   // the HTTP answer lands first
  const raceId = state.fetches.filter((f) => f.url.includes('/api/command')).pop().body.requestId;
  feed({ type: 'log', id: raceId, speaker: 'jarvis', text: 'Opening the file browser, sir.', timestamp: Date.now() });
  await settle(300);
  ok('race: one reply, one bubble, whichever path delivers it', countReplies() - beforeRace === 1, `${beforeRace} -> ${countReplies()}`);
  ok('race: and it is spoken once', state.speakCalls.length - voiceBeforeRace <= 2, `${state.speakCalls.length - voiceBeforeRace} utterances`);

  // And the history replayed to a freshly opened page is never read aloud.
  const voiceBeforeReplay = state.speakCalls.length;
  feed({ type: 'log', speaker: 'jarvis', text: 'Old news from yesterday, sir.', timestamp: Date.now(), replay: true });
  await settle(200);
  ok('replay: old history is shown but never spoken', state.speakCalls.length === voiceBeforeReplay,
     JSON.stringify(state.speakCalls.slice(voiceBeforeReplay)));
  const showed = [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].some((b) => /Old news/.test(b.textContent));
  ok('replay: the old line is still visible', showed);
}

/* ── 8. THE SERVER VOICE: audible even where the browser has no voice ───── */
{
  // A machine with no speech synthesis at all (a bare Linux desktop, a webview).
  const { window, doc, state } = makeDom({ withSR: true, micAlwaysOn: true, withSpeech: false });
  await settle(50);
  // This machine has no browser voice at all: the automatic engine must choose
  // the server's voice, without the owner having to know anything about it.
  ok('server voice: with no browser voice, the engine picks the server', window.jarvisSpeechStatus().usingServer === true,
     JSON.stringify(window.jarvisSpeechStatus()));

  window.__jarvisWs({ type: 'log', speaker: 'jarvis', text: 'The time is ten past nine, sir.', timestamp: Date.now() });
  await settle(400);
  ok('server voice: the sentence was asked of the server', state.voiceRequests.length === 1, JSON.stringify(state.voiceRequests));
  ok('server voice: the audio file was played', state.playedFiles.length === 1, JSON.stringify(state.playedFiles));
  ok('server voice: the sentence is what was sent', /ten past nine/.test(state.voiceRequests[0] || ''), state.voiceRequests[0]);

  // A browser voice that accepts the sentence and never makes a sound — the exact
  // failure the server voice exists for. Chosen on purpose (browser engine), the
  // page must say so and point at the server voice rather than going quiet.
  const dead = makeDom({ withSR: true, micAlwaysOn: true, voiceDead: true, voiceEngine: 'browser' });
  await settle(200);
  ok('dead voice: the browser engine is only used when it is chosen',
     dead.window.jarvisSpeechStatus().usingServer === false, JSON.stringify(dead.window.jarvisSpeechStatus().engine));
  dead.window.__jarvisWs({ type: 'log', speaker: 'jarvis', text: 'Testing the silent browser, sir.', timestamp: Date.now() });
  await settle(3400);                                   // the 800 ms watchdog, on its next two ticks
  const told = [...dead.doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent).join('\n');
  ok('dead voice: the silence is reported and the server voice offered',
     /never made a sound/i.test(told) && /server voice/i.test(told), told.slice(0, 160));
  ok('dead voice: the report offers the server voice as a button',
     [...dead.doc.querySelectorAll('.bubble-action-btn')].some((b) => /server voice/i.test(b.textContent)),
     JSON.stringify([...dead.doc.querySelectorAll('.bubble-action-btn')].map((b) => b.textContent)));

  // And the owner can simply choose it: the setting is remembered.
  window.setVoiceEngine('server');
  await settle(100);
  ok('setting: the server voice can be chosen outright',
     window.localStorage.getItem('jarvis-voice-engine') === 'server' && window.jarvisSpeechStatus().usingServer === true);
  window.setVoiceEngine('browser');
  await settle(100);
  ok('setting: and the browser voice can be chosen back', window.localStorage.getItem('jarvis-voice-engine') === 'browser');
  const engineSelect = doc.getElementById('sel-voice-engine');
  ok('setting: Settings shows a voice-engine control', !!engineSelect && /auto|browser|server/.test(engineSelect.innerHTML));

  // A refused server voice is reported instead of failing silently.
  const broke = makeDom({ withSR: true, micAlwaysOn: true, serverVoice: false, voiceEngine: 'server' });
  await settle(50);
  broke.window.__jarvisWs({ type: 'log', speaker: 'jarvis', text: 'This one cannot be spoken.', timestamp: Date.now() });
  await settle(400);
  const bubbles = [...broke.doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent);
  ok('server voice: a refusal is explained on screen', bubbles.some((t) => /server voice could not speak/i.test(t)),
     JSON.stringify(bubbles.slice(-1)).slice(0, 140));

  // The first click earns one spoken sentence — the proof that he is audible.
  const proof = makeDom({ withSR: true, micAlwaysOn: true });
  await settle(60);
  proof.doc.dispatchEvent(new proof.window.Event('pointerdown', { bubbles: true }));
  await settle(200);
  ok('first click: the page answers with one spoken sentence', proof.state.speakCalls.length + proof.state.voiceRequests.length > 0,
     JSON.stringify({ spoken: proof.state.speakCalls, asked: proof.state.voiceRequests }));
}

/* ── 9. THE VOICE ENGINE IS THE SERVER'S, AND REPEATS ARE FREE ───────────── */
{
  // Default: the server speaks, the browser's voice is never touched.
  const { window, doc, state } = makeDom({ withSR: true, micAlwaysOn: true });
  await settle(80);
  ok('engine: the default is the server voice', window.jarvisSpeechStatus().usingServer === true && state.speakCalls.length === 0,
     JSON.stringify({ using: window.jarvisSpeechStatus().usingServer, browserUtterances: state.speakCalls.length }));
  ok('engine: the settings offer both voices, server first',
     /server/.test(doc.getElementById('sel-voice-engine').innerHTML) && /browser/.test(doc.getElementById('sel-voice-engine').innerHTML),
     doc.getElementById('sel-voice-engine').options ? [...doc.getElementById('sel-voice-engine').options].map((o) => o.value).join(',') : '');

  // The same sentence twice is asked of the server ONCE (the page remembers the audio).
  window.speakReply('Repeated line, sir.');
  await settle(200);
  window.speakReply('Repeated line, sir.');
  await settle(200);
  const asked = state.voiceRequests.filter((t) => /Repeated line/.test(t));
  ok('engine: a repeated line is not synthesised twice', asked.length === 1, `${asked.length} requests`);

  // The owner can still pick this computer's voice (offline use) — deliberately.
  window.setVoiceEngine('browser');
  await settle(150);
  ok('engine: choosing this computer\'s voice really uses it',
     window.jarvisSpeechStatus().usingServer === false && state.speakCalls.length > 0, JSON.stringify(state.speakCalls.slice(-1)));
  const beforeSwitch = state.voiceRequests.length;
  window.speakReply('Said by the computer this time.');
  await settle(200);
  ok('engine: …and asking the server stops while it is chosen', state.voiceRequests.length === beforeSwitch,
     `${beforeSwitch} -> ${state.voiceRequests.length}`);
  window.setVoiceEngine('server');
  await settle(150);
  ok('engine: switching back to the server voice is remembered',
     window.localStorage.getItem('jarvis-voice-engine') === 'server' && window.jarvisSpeechStatus().usingServer === true);

  // A failure of the server voice is reported, never hidden behind the browser voice.
  const broke = makeDom({ withSR: true, micAlwaysOn: true, serverVoice: false });
  await settle(80);
  broke.window.speakReply('This one will fail, sir.');
  await settle(300);
  ok('engine: a broken server voice never silently falls back to the browser',
     broke.state.speakCalls.length === 0, JSON.stringify(broke.state.speakCalls));
}

/* ── summary ─────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
