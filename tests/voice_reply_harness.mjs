/**
 * Headless proof that a reply is ANSWERED and SPOKEN — the two failures the
 * owner reported — and that neither starves the other.
 *
 * Every check here was written for a defect that was real in this repository:
 *
 *   1. the browser-voice watchdog cut the SERVER voice off after 1.4 s. The
 *      watchdog asks "did the synthesiser start?" — but with the server voice
 *      the synthesiser is not the thing talking, so `synth.speaking` stays
 *      false and every sentence was declared swallowed. The queue then raced
 *      ahead and several sentences played on top of each other. (Only visible
 *      in a browser that HAS window.speechSynthesis — jsdom does not, which is
 *      why every earlier test passed.)
 *   2. a refused SPOKEN sentence called markBudgetExhausted(), which writes the
 *      TEXT counter. One quota message from the mouth stopped every answer for
 *      the rest of the day.
 *   3. the voice answer was always wrapped in a WAV header. The current TTS
 *      models return a COMPLETE WAV file, so the page was handed a WAV inside a
 *      WAV — a request that reports success and plays as silence.
 *   4. a server-voice failure posted one chat bubble PER SENTENCE, drowning the
 *      answer it was meant to explain.
 *   5. the voice self-test spoke with speechSynthesis even when the engine in
 *      force was the server voice — so on a machine with no voices installed it
 *      announced "I just spoke a test line" in absolute silence.
 *
 * Nothing here needs a real key or the internet: the Gemini client is pointed
 * at a stub that speaks the same HTTP shape as Google.
 *
 * Run:  node tests/voice_reply_harness.mjs
 *       (the page checks need jsdom: npm i --no-save jsdom@24)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'jarvis-live-session-token';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── a stub Gemini ───────────────────────────────────────────────────────────
 * Same HTTP contract as Google. A model is scripted by name:
 *   { audio: 'wav' | 'pcm' }  answer with a complete WAV / with raw PCM
 *   { retire: true }          404 NOT_FOUND, as a withdrawn name answers
 *   { boom: true }            500, an unexplained failure
 *   { rateLimited: true }     429 RESOURCE_EXHAUSTED
 * Text models answer streamGenerateContent, then generateContent.            */
function startStub(models) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: Object.keys(models).map((n) => ({ name: `models/${n}`, supportedActions: ['generateContent'] })) }));
        return;
      }
      const m = url.pathname.match(/\/models\/([^:]+):(\w+)/);
      if (!m) { res.writeHead(404).end('{}'); return; }
      const [, model, method] = m;
      const body = bodyText ? JSON.parse(bodyText) : {};
      const script = models[model] || {};
      const wantsAudio = Array.isArray(body?.generationConfig?.responseModalities)
        && body.generationConfig.responseModalities.includes('AUDIO');
      // Recorded BEFORE the scripted answer, so a call that FAILS is still
      // counted — that is the only way to prove what was and was not retried.
      calls.push({ kind: method === 'streamGenerateContent' ? 'stream' : 'generate', model, wantsAudio, body });
      if (script.retire) { send(404, { error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is no longer available` } }); return; }
      if (script.boom) { send(500, { error: { code: 500, status: 'INTERNAL', message: `the model ${model} fell over` } }); return; }
      if (script.rateLimited) { send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }); return; }

      if (method === 'streamGenerateContent') {
        const pieces = String(script.text || `answered by ${model}`).split(/(?<=\.)\s+/);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        pieces.forEach((piece) => res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] } }] })}\n\n`));
        res.end();
        return;
      }
      if (wantsAudio) {
        if (script.audio === 'wav') {
          // A complete WAV container, exactly as the current TTS models answer.
          const pcm = Buffer.alloc(1600);
          const head = Buffer.alloc(44);
          head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
          head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
          head.writeUInt32LE(24000, 24); head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
          head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
          send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.concat([head, pcm]).toString('base64') } }] } }] });
          return;
        }
        if (script.audio === 'pcm') {
          const pcm = Buffer.alloc(1600);
          send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] });
          return;
        }
        send(200, { candidates: [{ content: { parts: [{ text: 'I can only talk.' }] } }] });
        return;
      }
      send(200, { candidates: [{ content: { parts: [{ text: script.text || `answered by ${model}` }] } }], modelVersion: script.servedAs || model });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startDashboard({ models, env = {}, name = 'voice' }) {
  const stub = await startStub(models);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-'));
  fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'config', 'api_keys.json'), JSON.stringify({
    gemini_api_key: 'harness-key-0123456789abcdef', assistant_name: 'JARVIS', user_name: 'Mr Owner',
  }, null, 2));
  for (const link of ['dashboard', 'barehands', 'core', 'knowledge', 'web']) {
    try { fs.symlinkSync(path.join(REPO, link), path.join(cwd, link), 'dir'); } catch { /* optional */ }
  }
  const port = await freePort();
  const childEnv = { ...process.env, ...env };
  delete childEnv.GEMINI_API_KEY;
  for (const k of ['SUPPER_TEXT_MODEL', 'GEMINI_MODEL', 'SUPPER_IMAGE_MODEL', 'SUPPER_VOICE_MODEL', 'GEMINI_TTS_MODEL']) {
    if (!(k in env)) delete childEnv[k];
  }
  childEnv.SUPPER_DASHBOARD_PORT = String(port);
  childEnv.SUPPER_GEMINI_BASE_URL = `http://127.0.0.1:${stub.port}`;
  const child = spawn(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'server.ts')],
    { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  cleanup.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const ready = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) { cleanup.delete(child); throw new Error(`the server exited early:\n${log}`); }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/gemini-key`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > ready) throw new Error(`the server never came up:\n${log}`);
    await sleep(120);
  }
  return {
    name, cwd, port, stub, child, log: () => log,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    async stop() { killTree(child); cleanup.delete(child); stub.server.close(); await sleep(60); fs.rmSync(cwd, { recursive: true, force: true }); },
  };
}

const cleanup = new Set();
function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.on(sig, () => { for (const c of cleanup) killTree(c); });

const auth = () => ({ Authorization: `Bearer ${TOKEN}` });
const get = async (srv, p) => { const r = await fetch(srv.url(p), { headers: auth() }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = async (srv, p, body) => {
  const r = await fetch(srv.url(p), { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** The WAV the page is handed, decoded. */
function decodeWav(b64) {
  const buf = Buffer.from(b64, 'base64');
  return {
    buf,
    isRiff: buf.subarray(0, 4).toString('latin1') === 'RIFF',
    isWave: buf.subarray(8, 12).toString('latin1') === 'WAVE',
    riffSize: buf.readUInt32LE(4),
    dataSize: buf.readUInt32LE(40),
    rate: buf.readUInt32LE(24),
    riffCount: (buf.toString('latin1').match(/RIFF/g) || []).length,
  };
}

/* ══ 1. the brain answers, and the answer is a real Gemini answer ══════════ */
{
  const MODELS = { 'harness-text': { text: 'Good day, sir. The reactor is holding steady at ninety eight percent.', servedAs: 'harness-text-v7' } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text' }, name: 'brain' });
  try {
    const check = (await get(srv, '/api/brain-check')).body;
    ok('brain check: it names the VERSION actually answering, not just the alias',
      !!check.modelVersion && check.modelVersion !== check.model, `asked for ${check.model}, served as ${check.modelVersion}`);
    ok('brain check: the call succeeds', check.ok === true, JSON.stringify({ ok: check.ok, code: check.code, error: check.error }));
    ok('brain check: it names the model that answered', check.model === 'harness-text', String(check.model));
    ok('brain check: it names where the key came from', check.keySource === 'config/api_keys.json', String(check.keySource));
    ok('brain check: it reports a real response time', typeof check.latencyMs === 'number' && check.latencyMs >= 0, `${check.latencyMs} ms`);
    ok('brain check: it reports the day\'s budget', check.quota && check.quota.limit === 20, JSON.stringify(check.quota && { used: check.quota.used, limit: check.quota.limit }));

    // A real question still reaches the brain.
    const reply = (await post(srv, '/api/command', { text: 'explain what a flyback diode does' })).body;
    ok('a real question is answered by Gemini',
      /reactor is holding/.test(reply.reply || '') && !/my reasoning is offline/.test(reply.reply || ''),
      String(reply.reply).slice(0, 90));
    const chatCall = srv.stub.calls.findLast((c) => c.kind === 'stream');
    const gen = chatCall?.body?.generationConfig || {};
    const sentPrompt = JSON.stringify(chatCall?.body || {});
    ok('ordinary answers use a small output cap instead of a long-answer budget',
      gen.maxOutputTokens === 128, JSON.stringify(gen));
    ok('…and the model is explicitly asked to keep ordinary chat brief',
      /35 words or fewer/.test(sentPrompt), sentPrompt.slice(-170));
    const priorUserCopies = (chatCall?.body?.contents || []).slice(0, -1)
      .filter((c) => c.role === 'user').flatMap((c) => c.parts || []).map((p) => p.text || '');
    ok('the current command is sent once, not duplicated in conversation history',
      !priorUserCopies.some((text) => /explain what a flyback diode does/i.test(text)), JSON.stringify(priorUserCopies));

    const detailReply = (await post(srv, '/api/command', { text: 'explain in detail how an induction motor starts' })).body;
    const detailCall = srv.stub.calls.filter((c) => c.kind === 'stream').at(-1);
    const detailGen = detailCall?.body?.generationConfig || {};
    const detailPrompt = JSON.stringify(detailCall?.body || {});
    ok('an explicit request for detail keeps the larger output budget', detailGen.maxOutputTokens === 900, JSON.stringify(detailGen));
    ok('…and is not forced into the short-answer rule', !/35 words or fewer/.test(detailPrompt), detailPrompt.slice(-120));
    void detailReply;

    // A GREETING is not: it is answered on the spot without a model call.
    // Seed a stale long-form cache entry as earlier versions could have saved
    // Gemini's greeting. The new fast path must take priority over that entry.
    await post(srv, '/api/command', { text: 'learn: hello = This is a long old cached greeting that should not delay or replace the local one.' });
    const callsBefore = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    const greet = (await post(srv, '/api/command', { text: 'hello' })).body;
    const callsAfter = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    ok('a greeting is answered without asking Google at all',
      callsAfter === callsBefore, `${callsAfter - callsBefore} call(s)`);
    ok('…and it outranks a stale, long cached greeting',
      /^Good day[^.]{0,40}\.$/.test(String(greet.reply).trim()), JSON.stringify(String(greet.reply).slice(0, 80)));

    const localCallsBefore = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    const math = (await post(srv, '/api/command', { text: 'what is 15 percent of 80?' })).body;
    const localCallsAfter = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    ok('a simple percentage question is calculated locally, with no Gemini call',
      math.reply === '12.' && localCallsAfter === localCallsBefore,
      `reply=${JSON.stringify(math.reply)}, calls=${localCallsAfter - localCallsBefore}`);
    const present = (await post(srv, '/api/command', { text: 'are you there?' })).body;
    ok('a local presence check is instant and honest', /I am here/.test(present.reply || '') && !/offline/.test(present.reply || ''), String(present.reply));
    const beforeClock = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    const time = await post(srv, '/api/command', { text: 'what time is it?' });
    const date = await post(srv, '/api/command', { text: "what is today's date?" });
    ok('time and date questions are local and do not reach Gemini',
      /It is/.test(time.body.reply || '') && /Today is/.test(date.body.reply || '')
        && srv.stub.calls.filter((c) => c.kind !== 'list').length === beforeClock,
      `${String(time.body.reply).slice(0, 45)} / ${String(date.body.reply).slice(0, 45)}`);
    const beforeKnowledge = srv.stub.calls.filter((c) => c.kind !== 'list').length;
    const known = await post(srv, '/api/command', { text: 'celsius to fahrenheit' });
    ok('a stored local fact answers without using Gemini',
      /Multiply the Celsius/.test(known.body.reply || '')
        && srv.stub.calls.filter((c) => c.kind !== 'list').length === beforeKnowledge,
      String(known.body.reply).slice(0, 70));
  } finally { await srv.stop(); }
}

/* ══ 2. a failed Gemini request says so — it never pretends to have answered ═ */
{
  // Every text candidate fails, so there is no working model to fall back to —
  // that is the case in which the page must say so instead of answering for it.
  const MODELS = { 'harness-text': { boom: true }, 'gemini-flash-latest': { boom: true } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text' }, name: 'text-fails' });
  try {
    const reply = (await post(srv, '/api/command', { text: 'explain what a flyback diode does' })).body;
    ok('a failed Gemini call is answered honestly, not with a canned greeting',
      !/Good day/.test(reply.reply || '') && !/my reasoning is offline/.test(reply.reply || ''),
      String(reply.reply).slice(0, 100));
    // The message names the model the failure belongs to: with several
    // candidates tried it is the LAST one, which is the honest thing to report.
    ok('…and the honest message names the model that failed',
      /harness-text|gemini-flash-latest/.test(reply.reply || '') && /cannot classify|failed/.test(reply.reply || ''),
      String(reply.reply).slice(0, 140));
    // Fast must not mean dishonest: a greeting no longer spends a call, so it
    // cannot discover a broken brain for itself — it must still say so.
    await get(srv, '/api/brain-check');            // exactly what the page does on load
    const greet = (await post(srv, '/api/command', { text: 'hello' })).body;
    ok('…and small talk says so briefly, even though it never asked Google',
      /reasoning core did not answer its last check/.test(greet.reply || '') && String(greet.reply).length < 100,
      String(greet.reply).slice(0, 120));
    const check = (await get(srv, '/api/brain-check')).body;
    ok('…and the brain check fails with the same honesty', check.ok === false && check.code === 'failed', JSON.stringify({ ok: check.ok, code: check.code, error: String(check.error).slice(0, 60) }));
  } finally { await srv.stop(); }
}

/* ══ 3. the voice's own budget: a refused sentence may not stop the brain ══ */
{
  const MODELS = {
    'harness-text': { text: 'The reactor is steady, sir.' },
    'harness-voice': { rateLimited: true },
  };
  const srv = await startDashboard({
    models: MODELS,
    env: { SUPPER_TEXT_MODEL: 'harness-text', SUPPER_VOICE_MODEL: 'harness-voice', SUPPER_GEMINI_VOICE_BUDGET: '3', SUPPER_GEMINI_DAILY_BUDGET: '5' },
    name: 'quotas',
  });
  try {
    const speak = (await post(srv, '/api/voice/speak', { text: 'Good day, sir.' })).body;
    ok('a refused SENTENCE is reported as the voice\'s own problem',
      speak.ok === false && /voice|quota|budget|429/i.test(speak.message || ''), String(speak.code) + ' ' + String(speak.message).slice(0, 80));

    const voiceAfter = (await get(srv, '/api/system-status')).body.voice;
    ok('…and the voice counter is the one that is used up', voiceAfter.used >= voiceAfter.limit, `${voiceAfter.used}/${voiceAfter.limit}`);

    // THE POINT: the brain must still answer. It used to be switched off here,
    // because the refusal wrote the TEXT counter.
    // Not "status" — that word is answered locally, with no Gemini call at all.
    const reply = (await post(srv, '/api/command', { text: 'how is the reactor holding up' })).body;
    ok('…and the brain still answers: the mouth never starves the brain',
      /reactor is steady/.test(reply.reply || ''), String(reply.reply).slice(0, 80));

    const textQuota = (await get(srv, '/api/brain-check')).body.quota;
    ok('…and the text budget was never marked exhausted by the voice',
      textQuota.used < textQuota.limit, `${textQuota.used}/${textQuota.limit} (limit ${textQuota.limit})`);
  } finally { await srv.stop(); }
}

/* ══ 4. the audio the page is handed is playable ═══════════════════════════ */
for (const shape of ['wav', 'pcm']) {
  const MODELS = { 'harness-text': { text: 'Yes, sir.' }, 'harness-voice': { audio: shape } };
  const srv = await startDashboard({
    models: MODELS,
    env: { SUPPER_TEXT_MODEL: 'harness-text', SUPPER_VOICE_MODEL: 'harness-voice' },
    name: `audio-${shape}`,
  });
  try {
    const speak = (await post(srv, '/api/voice/speak', { text: 'Good day, sir.' })).body;
    ok(`the server voice returns audio when the model answers with ${shape.toUpperCase()}`, speak.ok === true, String(speak.message || '').slice(0, 80));
    const wav = decodeWav(speak.audio || '');
    ok(`…as a single, well-formed WAV file (${shape})`, wav.isRiff && wav.isWave, JSON.stringify({ riff: wav.isRiff, wave: wav.isWave }));
    if (shape === 'wav') {
      // A WAV must be passed through untouched: a second RIFF would mean the
      // container was wrapped in another container, which no browser can play.
      ok('…a complete WAV is passed through, not wrapped in a second header', wav.riffCount === 1, `RIFF appears ${wav.riffCount}×`);
      ok('…and its own length still adds up', wav.riffSize === wav.buf.length - 8, `riffSize=${wav.riffSize} bytes=${wav.buf.length}`);
      ok('…at the sample rate the model declared', wav.rate === 24000, String(wav.rate));
    } else {
      ok('…raw PCM is given the header it needs', wav.riffCount === 1 && wav.dataSize === 1600, JSON.stringify({ riff: wav.riffCount, data: wav.dataSize }));
      ok('…using the rate carried in the mime type', wav.rate === 24000, String(wav.rate));
    }
  } finally { await srv.stop(); }
}

/* ══ 5. a withdrawn voice model falls back, a refused key does not ═════════ */
{
  const MODELS = {
    'harness-text': { text: 'Yes, sir.' },
    'gemini-2.5-flash-preview-tts': { retire: true },
    'gemini-3.8-flash-tts': { audio: 'pcm' },
  };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text' }, name: 'voice-fallback' });
  try {
    const speak = (await post(srv, '/api/voice/speak', { text: 'Good day, sir.' })).body;
    ok('a withdrawn voice model falls through to the next one', speak.ok === true, String(speak.message || '').slice(0, 100));
    ok('…and says which model actually spoke', speak.model === 'gemini-3.8-flash-tts', String(speak.model));
  } finally { await srv.stop(); }
}
{
  const MODELS = { 'harness-text': { text: 'Yes, sir.' }, 'harness-voice': { boom: true } };
  const srv = await startDashboard({
    models: MODELS,
    env: { SUPPER_TEXT_MODEL: 'harness-text', SUPPER_VOICE_MODEL: 'harness-voice', SUPPER_GEMINI_VOICE_BUDGET: '50' },
    name: 'voice-boom',
  });
  try {
    // A speech failure must be reported as ITS OWN failure, separately from a
    // text failure — and it must not spend the whole budget retrying.
    const before = srv.stub.calls.filter((c) => c.wantsAudio).length;
    const speak = (await post(srv, '/api/voice/speak', { text: 'Good day, sir.' })).body;
    const tries = srv.stub.calls.filter((c) => c.wantsAudio).length - before;
    ok('a speech failure is reported separately from a text failure',
      speak.ok === false && /harness-voice/.test(speak.message || ''), String(speak.message).slice(0, 90));
    ok('…and an unexplained failure is not retried across every model name', tries === 1, `${tries} call(s)`);
    const reply = (await post(srv, '/api/command', { text: 'explain what a reactor does' })).body;
    ok('…while the text answer is unaffected', /Yes, sir/.test(reply.reply || ''), String(reply.reply).slice(0, 60));
  } finally { await srv.stop(); }
}

/* ══ 6. the page: the watchdog must not cut the server voice off ═══════════ */
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* reported below */ }
if (!JSDOM) {
  console.log('      (page checks skipped — install jsdom in a scratch folder: npm i --no-save jsdom@24)');
} else {
  const handScript = fs.readFileSync(path.join(REPO, 'dashboard/static/hand-gestures.js'), 'utf8');
  const pageHtml = fs.readFileSync(path.join(REPO, 'dashboard/static/app.html'), 'utf8')
    .replace('<script src="/static/hand-gestures.js"></script>', `<script>${handScript}</script>`);

  /**
   * The page, in the condition a real browser puts it in: window.speechSynthesis
   * EXISTS. That is what arms the 800 ms watchdog, and it is the one thing jsdom
   * does not give us by default — which is why the defect survived every test.
   */
  function makeDom({ audioMs = 2500, speakOk = true, browserVoiceStarts = false,
                     wsOpen = false, commandReply = '', commandDelayMs = 0, voiceDelayMs = 0 } = {}) {
    const state = { voiceRequests: [], utterances: [], played: [], live: 0, maxLive: 0, ended: 0, sockets: [], commandIds: [], t0: Date.now() };
    const dom = new JSDOM(pageHtml, {
      url: 'https://jarvis.test/', runScripts: 'dangerously', pretendToBeVisual: false,
      beforeParse(window) {
        window.isSecureContext = true;
        window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        const utterance = (u) => { state.utterances.push(u.text); if (browserVoiceStarts && u.onstart) setTimeout(() => u.onstart(), 10); };
        window.speechSynthesis = {
          speaking: false, pending: false, paused: false,
          getVoices: () => [{ name: 'Harness Voice', lang: 'en-GB' }],
          cancel() {}, resume() {}, speak: utterance,
        };
        window.fetch = async (url, opts = {}) => {
          const p = String(url);
          if (p.includes('/api/voice/speak')) {
            const text = JSON.parse(opts.body).text;
            state.voiceRequests.push({ text, at: Date.now() - state.t0 });
            if (voiceDelayMs) await new Promise((r) => setTimeout(r, voiceDelayMs));
            if (!speakOk) return { ok: true, status: 200, json: async () => ({ ok: false, code: 'boom', message: 'the voice model fell over' }) };
            const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(36), Buffer.from('WAVE'), Buffer.alloc(1600)]);
            return { ok: true, status: 200, json: async () => ({ ok: true, audio: wav.toString('base64'), mime: 'audio/wav', model: 'harness-tts', ms: 40 }) };
          }
          if (p.includes('/api/command')) {
            const sent = JSON.parse(opts.body || '{}');
            if (sent.requestId) state.commandIds.push(sent.requestId);
            if (commandDelayMs) await new Promise((r) => setTimeout(r, commandDelayMs));
            return { ok: true, status: 200, json: async () => ({ ok: true, reply: commandReply, id: sent.requestId }) };
          }
          if (p.includes('/api/settings/gemini-key')) {
            return { ok: true, status: 200, json: async () => ({ present: true, tail: 'cdef', source: 'config/api_keys.json', model: 'harness-text', modelSource: 'SUPPER_TEXT_MODEL', quota: { used: 1, limit: 20 }, voice: { used: 1, limit: 400 }, assistantName: 'JARVIS', userName: '', build: '2026-10-13-one-switch-1', configRoot: '/tmp/jarvis' }) };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        };
        window.WebSocket = class {
          // The page compares readyState against WebSocket.OPEN, so the constant
          // has to exist or "is the socket up?" is never true in these checks.
          static OPEN = 1; static CLOSED = 3;
          constructor() { this.readyState = wsOpen ? 1 : 3; this.onmessage = null; state.sockets.push(this); }
          send() {} close() {}
          deliver(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
        };
        window.scrollTo = () => {};
        window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
          get: (_t, k) => (k === 'canvas' ? null : (() => new Proxy({}, { get: () => () => {} }))), set: () => true,
        });
        window.Audio = class {
          constructor(src) {
            this.src = src;
            state.played.push({ at: Date.now() - state.t0 });
            state.live++; state.maxLive = Math.max(state.maxLive, state.live);
          }
          play() { setTimeout(() => { if (this._done) return; this._done = true; state.live--; state.ended++; this.onended && this.onended(); }, audioMs); return Promise.resolve(); }
          pause() { if (this._done) return; this._done = true; state.live--; }   // what stopSpeaking relies on
        };
        window.URL.createObjectURL = () => 'blob:harness-audio';
        window.URL.revokeObjectURL = () => {};
      },
    });
    return { dom, state, window: dom.window, doc: dom.window.document };
  }

  const THREE = 'Good day, sir. The reactor is holding at ninety eight percent and all systems are nominal. '
    + 'Your first meeting is at ten, and the draft to the plumber is waiting in the Email room. '
    + 'Shall I read it aloud, or would you rather open the rooms yourself?';

  /* — the defect: every sentence was swallowed after 1.4 s and they overlapped — */
  {
    // A spoken sentence is longer than the watchdog's 1.4 s — that is the whole
    // point of this check, and why a short sound file would hide the defect.
    const { window, state, doc } = makeDom({ audioMs: 2500 });
    await sleep(150);
    ok('the page is in the real-browser condition (speechSynthesis present)', window.jarvisSpeechStatus().supported === true,
      JSON.stringify({ supported: window.jarvisSpeechStatus().supported }));
    ok('…and the engine in force is the server voice', window.jarvisSpeechStatus().usingServer === true);
    state.t0 = Date.now();
    window.speakReply(THREE);
    await sleep(9000);
    const asked = state.voiceRequests.length;
    ok('every sentence of the reply is asked of the server voice', asked >= 2, `${asked} sentence(s)`);
    ok('…and they are played ONE AT A TIME, never on top of each other', state.maxLive === 1, `max concurrent=${state.maxLive}`);
    ok('…and each one finishes before the next begins', state.ended === asked, `ended=${state.ended} of ${asked}`);
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent);
    ok('…and the page does not claim the BROWSER voice failed when it was never used',
      !bubbles.some((t) => /computer’s own voice|computer's own voice/.test(t)), JSON.stringify(bubbles.map((b) => b.slice(0, 60))));
    ok('…and the browser synthesiser was not used at all', state.utterances.length === 0, JSON.stringify(state.utterances));
    dom_close(window);
  }

  /* — the owner's report: "he talks when he connects, and that is it." —
     A reply the brain could NOT answer is still a reply, and it is still
     spoken. The offline message is exactly the one that must be heard, because
     it is the one that says something is wrong. */
  {
    const OFFLINE = 'Good day, sir. One honest note: my reasoning is offline (no Gemini key), so I can only give built-in local replies.';
    const CONNECTION = 'My reasoning is offline, sir. The Gemini service could not be reached, so I can only run the built-in local commands.';

    // 1. The ordinary path: the answer arrives in pieces over the socket.
    const { window, state } = makeDom({ audioMs: 300 });
    await sleep(150);
    state.t0 = Date.now();
    window.__jarvisWs({ type: 'stream', id: 'r1', speaker: 'jarvis', text: 'Good day, sir. ', done: false, timestamp: Date.now() });
    await sleep(200);
    window.__jarvisWs({ type: 'stream', id: 'r1', speaker: 'jarvis', text: 'Good day, sir. The reactor is nominal.', done: true, timestamp: Date.now() });
    await sleep(1200);
    const streamedSpoken = state.voiceRequests.length;
    ok('a reply the brain DID answer is spoken', streamedSpoken >= 1, `${streamedSpoken} sentence(s)`);

    // 2. The same page, the next reply — and this one the brain could not answer.
    window.__jarvisWs({ type: 'log', id: 'r2', speaker: 'jarvis', text: OFFLINE, timestamp: Date.now() });
    await sleep(1200);
    ok('…and the NEXT reply is spoken too — he does not go quiet after the first',
       state.voiceRequests.length > streamedSpoken, JSON.stringify(state.voiceRequests.map((r) => r.text.slice(0, 30))));

    // 3. The reply that says the connection failed must be HEARD, not just printed.
    window.__jarvisWs({ type: 'log', id: 'r3', speaker: 'jarvis', text: CONNECTION, timestamp: Date.now() });
    await sleep(1200);
    const spoken = state.voiceRequests.map((r) => r.text).join(' ');
    ok('the message that says the brain is offline is spoken, not only printed',
       /reasoning is offline/i.test(spoken), JSON.stringify(state.voiceRequests.map((r) => r.text.slice(0, 40))));
    dom_close(window);
  }

  /* — the race that makes him look unwilling: the reply travels BOTH ways. —
     The server answers the POST and broadcasts the same reply on the socket. If
     the HTTP answer is handled first, the page files the id as "already shown
     and spoken" — and then the websocket frame, which is the only copy that ever
     gets spoken, is thrown away as a duplicate. Measured 1-8 ms apart on a
     loopback server, so which one wins is a coin toss: he talks, or he does not,
     for no visible reason. */
  {
    const REPLY = 'The call to Gemini failed for a reason I cannot classify (model gemini-3.8-flash, key from environment). The key is fine; check the internet connection or a proxy, then try again.';
    const { window, state, doc } = makeDom({ audioMs: 200, wsOpen: true, commandReply: REPLY });
    await sleep(150);
    state.t0 = Date.now();
    // The socket is UP, so the page will wait for the frame. Deliver the HTTP
    // answer first and the frame second — the ordering that used to silence him.
    window.sendCommand('how is the reactor holding up');
    await sleep(400);                       // the HTTP answer has been handled by now
    ok('while the socket is up, the HTTP answer alone does not speak — the socket owns the reply',
       state.voiceRequests.length === 0, `${state.voiceRequests.length} spoken`);
    // …and it must NOT file the id as done, or the frame below is discarded.
    const id = state.commandIds[0];
    const socket = state.sockets[0];
    socket.deliver({ type: 'log', id, speaker: 'jarvis', text: REPLY, timestamp: Date.now() });
    await sleep(700);
    ok('a reply is still spoken when the HTTP answer beats the websocket frame',
       state.voiceRequests.length >= 1, JSON.stringify(state.voiceRequests.map((r) => r.text.slice(0, 40))));
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].map((b) => b.textContent);
    ok('…and the words appear on screen exactly once, not once per path',
       bubbles.filter((t) => /cannot classify/.test(t)).length === 1, JSON.stringify(bubbles.map((b) => b.slice(0, 30))));
    dom_close(window);
  }

  /* — if the open socket drops every frame, the HTTP reply still arrives — */
  {
    const REPLY = 'Good day, sir. The reactor is nominal.';
    const { window, state, doc } = makeDom({ audioMs: 120, wsOpen: true, commandReply: REPLY });
    await sleep(150);
    state.t0 = Date.now();
    window.sendCommand('how is the reactor holding up');
    await sleep(900);                         // the 700 ms socket fallback has fired
    const id = state.commandIds[0];
    ok('the HTTP answer is used when an apparently-open socket drops the reply',
       state.voiceRequests.length >= 1, JSON.stringify(state.voiceRequests.map((r) => r.text)));
    const socket = state.sockets[0];
    // A late reconnect copy must not create a second bubble or second voice.
    socket.deliver({ type: 'stream', id, speaker: 'jarvis', text: REPLY, done: true, timestamp: Date.now() });
    socket.deliver({ type: 'log', id, speaker: 'jarvis', text: REPLY, timestamp: Date.now() });
    await sleep(400);
    const said = state.voiceRequests.map((r) => r.text).join(' ');
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].map((b) => b.textContent);
    ok('…and a late socket copy is not spoken a second time',
       (said.match(/Good day/g) || []).length === 1, JSON.stringify(state.voiceRequests.map((r) => r.text)));
    ok('…or displayed a second time',
       bubbles.filter((t) => /reactor is nominal/.test(t)).length === 1, JSON.stringify(bubbles.map((b) => b.slice(0, 30))));
    dom_close(window);
  }

  /* — two voices at once — */
  {
    // The owner heard two voices talking over each other. The cause: the mouth
    // stops by emptying its queue and forgetting the sentence in progress — but
    // a sound file that is already playing keeps playing, so the next sentence
    // starts on top of it.
    const { window, state } = makeDom({ audioMs: 2000 });
    await sleep(150);
    state.t0 = Date.now();
    window.speakReply(THREE);
    await sleep(700);                        // the first sentence is mid-flight
    const midFlight = state.live;
    window.__jarvisStopSpeaking();
    await sleep(150);
    ok('stopSpeaking silences the sentence already playing, not just the ones waiting',
       state.live === 0, `mid-flight=${midFlight}, after stopping=${state.live}`);
    window.speakReply('Good day, sir.');
    await sleep(2600);
    ok('…and the next reply is never spoken over the top of it',
       state.maxLive === 1, `max concurrent=${state.maxLive}`);
    dom_close(window);
  }

  {
    // The other way to hear two voices: the same reply arrives on both paths.
    const REPLY = 'Good day, sir. The reactor is nominal.';
    const { window, state, doc } = makeDom({ audioMs: 200, wsOpen: true, commandReply: REPLY });
    await sleep(150);
    state.t0 = Date.now();
    window.sendCommand('hello');
    await sleep(300);
    const id = state.commandIds[0];
    const socket = state.sockets[0];
    socket.deliver({ type: 'log', id, speaker: 'jarvis', text: REPLY, timestamp: Date.now() });
    await sleep(600);
    socket.deliver({ type: 'log', id, speaker: 'jarvis', text: REPLY, timestamp: Date.now() });   // the same reply again
    await sleep(700);
    const said = state.voiceRequests.map((r) => r.text).join(' ');
    const times = (said.match(/Good day/g) || []).length;
    ok('the same reply is never read out twice, whichever path delivers it',
       times === 1, `"Good day" spoken ${times} time(s)`);
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-jarvis')].map((b) => b.textContent);
    ok('…and it is not written to the screen twice either',
       bubbles.filter((t) => /reactor is nominal/.test(t)).length === 1, JSON.stringify(bubbles.map((b) => b.slice(0, 30))));
    dom_close(window);
  }

  /* — stream plus final/HTTP copy is one reply, not two — */
  {
    const { window, state } = makeDom({ audioMs: 160 });
    await sleep(150);
    state.t0 = Date.now();
    window.speakStreamed('stream-once', 'One short sentence.');
    window.finishStreamed('stream-once', 'One short sentence.');
    window.speakReply('One short sentence.', 'stream-once');  // same id on the final path
    window.speakReply('HTTP first sentence.', 'http-first');
    window.speakStreamed('http-first', 'HTTP first sentence.'); // late stream is also the same id
    window.finishStreamed('http-first', 'HTTP first sentence.');
    await sleep(800);
    const said = state.voiceRequests.map((r) => r.text);
    ok('a streamed sentence and its final copy are spoken once, not twice',
       said.filter((text) => text === 'One short sentence.').length === 1,
       JSON.stringify(said));
    ok('…and a late stream cannot re-read an HTTP reply',
       said.filter((text) => text === 'HTTP first sentence.').length === 1,
       JSON.stringify(said));
    dom_close(window);
  }

  /* — stopping during a slow voice request cannot start an old voice later — */
  {
    const { window, state } = makeDom({ audioMs: 2000, voiceDelayMs: 400 });
    await sleep(150);
    state.t0 = Date.now();
    window.speakReply('Old reply.');
    await sleep(80);                        // the server has not returned its audio yet
    window.__jarvisStopSpeaking();
    await sleep(60);
    window.speakReply('New reply.');
    await sleep(550);                        // both ignored-abort fetches have returned
    ok('an older in-flight voice response cannot begin after silence; only the new one plays',
       state.live === 1 && state.maxLive === 1 && state.played.length === 1,
       `live=${state.live}, max=${state.maxLive}, audio files=${state.played.length}`);
    window.__jarvisStopSpeaking();
    dom_close(window);
  }

  /* — a failure report is not a thing to read out loud character by character — */
  {
    const RAW = 'The call to Gemini failed for a reason I cannot classify (model gemini-3.8-flash, key from environment): '
      + '{"error":{"message":"{\"error\":{\"code\":503,\"status\":\"UNAVAILABLE\",\"message\":\"the model is overloaded\"}}","code":503,"status":"Service Unavailable"}}.';
    const { window, state } = makeDom({ audioMs: 200 });
    await sleep(150);
    state.t0 = Date.now();
    window.__jarvisWs({ type: 'log', id: 'raw-1', speaker: 'jarvis', text: RAW, timestamp: Date.now() });
    await sleep(700);
    const said = state.voiceRequests.map((r) => r.text).join(' ');
    ok('a failure is still spoken', state.voiceRequests.length >= 1, `${state.voiceRequests.length} sentence(s)`);
    ok('…but the raw error body is NOT read aloud — a voice asked to say JSON may simply refuse, which sounds like silence',
       !/[{}]/.test(said), said.slice(0, 120));
    ok('…and he says where the detail can be found instead', /details are on screen/i.test(said), said.slice(0, 120));
    dom_close(window);
  }

  /* — the watchdog must still catch a genuinely dead BROWSER voice — */
  {
    const { window, state, doc } = makeDom({ audioMs: 200, browserVoiceStarts: false });
    await sleep(150);
    window.setVoiceEngine('browser');
    state.t0 = Date.now();
    window.speakReply('Voice check, sir.');
    await sleep(3000);
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent);
    ok('a browser voice that never starts is still reported (the watchdog still works)',
      bubbles.some((t) => /never made a sound/.test(t)), JSON.stringify(bubbles.map((b) => b.slice(0, 50))));
    dom_close(window);
  }

  /* — one report per run of server-voice failures, not one per sentence — */
  {
    const { window, state, doc } = makeDom({ speakOk: false });
    await sleep(150);
    state.t0 = Date.now();
    window.speakReply(THREE);
    await sleep(4000);
    const bubbles = [...doc.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent);
    ok('a broken server voice is reported', bubbles.length >= 1, `${bubbles.length} bubble(s)`);
    ok('…ONCE per reply, not once per sentence, so the answer is not drowned',
      bubbles.length === 1, `${bubbles.length} bubble(s) for ${state.voiceRequests.length} sentence(s)`);
    ok('…and the report names the server voice', /server voice could not speak/.test(bubbles[0] || ''), String(bubbles[0]).slice(0, 80));
    dom_close(window);
  }

  /* — the voice self-test uses the engine that is actually in force — */
  {
    const { window, state } = makeDom({ audioMs: 300 });
    await sleep(200);
    window.runVoiceCheck();
    await sleep(2500);
    const said = [...state.voiceRequests.map((r) => r.text), ...state.utterances];
    ok('the voice self-test speaks through the engine in force (the server voice)',
      state.voiceRequests.some((r) => /Voice check/.test(r.text)), JSON.stringify(said.slice(0, 3)));
    ok('…not through speechSynthesis, which may have no voices at all',
      !state.utterances.some((t) => /Voice check/.test(t)), JSON.stringify(state.utterances));
    dom_close(window);
  }

  function dom_close(window) { try { window.close(); } catch { /* nothing to do */ } }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  · ${f.name}${f.extra ? ` — ${f.extra}` : ''}`);
  process.exitCode = 1;
}
