/**
 * Headless proof that the dashboard uses the application's own configuration.
 *
 * It runs the real server (tsx server.ts) in a throwaway working directory whose
 * only settings file is config/api_keys.json — no .env, no environment key — and
 * points the Gemini client at a stub that speaks the same HTTP shape as Google.
 * Nothing here needs a real key or the internet, and nothing touches the owner's
 * own secrets or runtime state.
 *
 * Proven:
 *   1. a key present ONLY in config/api_keys.json is found and works — chat,
 *      the server ear (POST /api/voice/transcribe) and pictures all answer;
 *   2. a configured model override (SUPPER_TEXT_MODEL / GEMINI_MODEL) wins over
 *      API discovery — only the configured model is ever called;
 *   3. a retired model name falls through to the next candidate, and when
 *      nothing works the message names the withdrawal — never the key or the
 *      connection;
 *   4. a missing key produces the documented message, naming every place checked;
 *   5. the app's count (runtime/quota.json) counts and WARNS past
 *      SUPPER_GEMINI_DAILY_WARN but never blocks; a damaged counter warns and
 *      never blocks; only a real 429 from Google stops calls, until midnight;
 *   5b. the second key: a 429 on key 1 switches to key 2 for the day (the same
 *      question is retried on it, the next call goes out on it), per-key counts,
 *      and only when both keys are stopped does the app say Google stopped us;
 *   5c. Settings saves, reports, shadows and removes the second key honestly;
 *   6. Settings → "The Brain" and the voice check report the key's source and the
 *      model in use (the page itself, loaded in jsdom);
 *   7. the clear glass is one stylesheet for both surfaces, the rounded face is
 *      vendored, the rooms carry the camera behind their glass, and the local
 *      drafting desk writes an email or a letter without ever calling Gemini.
 *
 * Run:  node tests/config_harness.mjs
 *       (jsdom is not a project dependency — for the page checks, install it in a
 *        scratch folder first:  npm i --no-save jsdom@24  — or skip them by
 *        running with --http-only.)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'jarvis-live-session-token';
const HTTP_ONLY = process.argv.includes('--http-only');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real 24 kHz mono 16-bit WAV: 0.1 s of 440 Hz, so it is a playable file. */
function wavBytes(rate = 24000) {
  const frames = Math.round(rate * 0.1);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* ── the stub Gemini ─────────────────────────────────────────────────────────
 * Same HTTP contract as Google: POST /v1beta/models/<model>:generateContent
 * with an x-goog-api-key header, and GET /v1beta/models for discovery. Each
 * model can be scripted: 'answer', 'words' (text instead of a picture), 'retire'
 * (the 404 the owner saw), or 'boom' (an unexplained failure).                */
function startStub(models) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const key = req.headers['x-goog-api-key'] || url.searchParams.get('key') || '';
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        calls.push({ kind: 'list', key });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: Object.keys(models).map((name) => ({
            name: `models/${name}`,
            supportedActions: models[name].listable === false ? ['countTokens'] : ['generateContent', 'countTokens'],
          })),
        }));
        return;
      }
      const m = url.pathname.match(/\/models\/([^:]+):(\w+)/);
      if (!m) { res.writeHead(404).end('{}'); return; }
      const [, model, method] = m;
      // A streaming call answers in server-sent events, exactly as Google does:
      // one JSON chunk per event, each holding the next slice of the answer.
      if (method === 'streamGenerateContent') {
        const script0 = models[model] || {};
        if (script0.retire) { res.writeHead(404).end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: `This model models/${model} is no longer available to new users.` } })); return; }
        if (script0.modelAccessDenied) { res.writeHead(403).end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: `Your account does not have permission to access model ${model}.` } })); return; }
        if (script0.boom) { res.writeHead(500).end(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: `the model ${model} fell over` } })); return; }
        if (script0.rateLimited) { res.writeHead(429).end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })); return; }
        // Per-KEY refusals: Google's quota is per key/project, so the stub can
        // refuse one key and answer another on the same model.
        if (Array.isArray(script0.rateLimitedKeys) && script0.rateLimitedKeys.includes(key)) {
          calls.push({ kind: 'stream', model, key, refused: 429 });
          res.writeHead(429).end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for key …${String(key).slice(-4)}` } })); return;
        }
        if (Array.isArray(script0.rejectKeys) && script0.rejectKeys.includes(key)) {
          calls.push({ kind: 'stream', model, key, refused: 400 });
          res.writeHead(400).end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key. [reason: API_KEY_INVALID]' } })); return;
        }
        if (script0.noStream) { res.writeHead(400).end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'streaming is not supported here' } })); return; }
        calls.push({ kind: 'stream', model, key: req.headers['x-goog-api-key'] || url.searchParams.get('key') || '', body: bodyText ? JSON.parse(bodyText) : {},
          thinkingBudget: (() => { try { return JSON.parse(bodyText)?.generationConfig?.thinkingConfig?.thinkingBudget; } catch { return undefined; } })(),
          thinkingLevel: (() => { try { return JSON.parse(bodyText)?.generationConfig?.thinkingConfig?.thinkingLevel; } catch { return undefined; } })() });
        if (script0.rejectsThinking) {
          const asked = (() => { try { return JSON.parse(bodyText || '{}')?.generationConfig?.thinkingConfig; } catch { return undefined; } })();
          if (asked) { res.writeHead(400).end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "thinkingConfig": Cannot find field.' } })); return; }
        }
        const sentence = String(script0.streamText || `answered by ${model}`);
        const pieces = script0.words
          ? sentence.split(' ').reduce((acc, w) => (acc.length && acc[acc.length - 1].length < 12 ? acc.slice(0, -1).concat(acc[acc.length - 1] + ' ' + w) : acc.concat(w)), [])
          : [sentence];
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        pieces.forEach((piece, i) => {
          const payload = { candidates: [{ content: { parts: [{ text: (i ? ' ' : '') + piece }] } }] };
          res.write(piece ? `data: ${JSON.stringify(payload)}\n\n` : '');
        });
        res.end();
        return;
      }
      const body = bodyText ? JSON.parse(bodyText) : {};
      const parts = body?.contents?.[0]?.parts || [];
      const audio = parts.some((p) => p?.inlineData?.mimeType?.startsWith('audio/'));
      const picture = parts.some((p) => p?.inlineData?.mimeType?.startsWith('image/'));
      const spoken = parts.some((p) => p?.inlineData?.mimeType?.startsWith('audio/'));
      calls.push({ kind: 'generate', model, method, key, audio, picture, spoken, body });
      const script = models[model] || {};
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (script.retire) {
        send(404, { error: { code: 404, status: 'NOT_FOUND', message: `This model models/${model} is no longer available to new users. Please update your code to use models/gemini-4.2-flash` } });
        return;
      }
      if (script.modelAccessDenied) {
        send(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: `Your account does not have permission to access model ${model}.` } });
        return;
      }
      if (script.boom) { send(500, { error: { code: 500, status: 'INTERNAL', message: `the model ${model} fell over` } }); return; }
      if (script.rateLimited) { send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }); return; }
      if (Array.isArray(script.rateLimitedKeys) && script.rateLimitedKeys.includes(key)) {
        send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for key …${String(key).slice(-4)}` } }); return;
      }
      if (Array.isArray(script.rejectKeys) && script.rejectKeys.includes(key)) {
        send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key. [reason: API_KEY_INVALID]' } }); return;
      }
      if (audio) {
        send(200, { candidates: [{ content: { parts: [{ text: 'open the files' }] } }] });
        return;
      }
      if (script.words || (script.picture === false)) {
        send(200, { candidates: [{ content: { parts: [{ text: 'I can only talk, not draw.' }] } }] });
        return;
      }
      if (script.voice) {
        const pcm = Buffer.alloc(2400);                    // 0.1 s of silence at 24 kHz
        send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] });
        return;
      }
      if (script.wav) {
        // What the CURRENT TTS models return: a complete WAV file (audio/wav), not
        // headerless PCM. Wrapping this in a second WAV header is silence.
        send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wavBytes(24000).toString('base64') } }] } }] });
        return;
      }
      if (script.picture) {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
        send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] });
        return;
      }
      send(200, { candidates: [{ content: { parts: [{ text: script.streamText || `answered by ${model}` }] } }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

/* ── the dashboard server, in its own throwaway working directory ─────────── */
const KEY1 = 'harness-key-0123456789abcdef';
const KEY2 = 'harness-second-key-fedcba9876543210';

async function startDashboard({ models, env = {}, name = 'harness', files = {}, writeConfigFile = true, config = {} } = {}) {
  const stub = await startStub(models);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-config-'));
  // Only what the server needs to boot; the settings live in config/api_keys.json.
  fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
  if (writeConfigFile) {
    fs.writeFileSync(path.join(cwd, 'config', 'api_keys.json'), JSON.stringify({
      gemini_api_key: KEY1,
      assistant_name: 'Tessa',
      user_name: 'Mr Owner',
      ...config,
    }, null, 2));
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
  }
  for (const link of ['dashboard', 'barehands', 'core', 'knowledge', 'web']) {
    try { fs.symlinkSync(path.join(REPO, link), path.join(cwd, link), 'dir'); } catch { /* optional */ }
  }

  const port = await freePort();
  const childEnv = { ...process.env, ...env };
  delete childEnv.GEMINI_API_KEY;          // the keys must come from the file, not the environment
  delete childEnv.GEMINI_API_KEY_2;
  for (const k of ['SUPPER_TEXT_MODEL', 'GEMINI_MODEL', 'SUPPER_IMAGE_MODEL', 'SUPPER_VOICE_MODEL', 'GEMINI_TTS_MODEL', 'SUPPER_GEMINI_DAILY_BUDGET', 'SUPPER_GEMINI_DAILY_WARN', 'SUPPER_GEMINI_VOICE_BUDGET', 'SUPPER_GEMINI_BASE_URL']) {
    if (!(k in env)) delete childEnv[k];
  }
  childEnv.SUPPER_DASHBOARD_PORT = String(port);
  childEnv.SUPPER_GEMINI_BASE_URL = `http://127.0.0.1:${stub.port}`;

  // tsx re-executes node with its loaders, so the server is a grandchild: the
  // whole process group is started and killed, or a stray server would be left
  // running after the checks are done.
  const child = spawn(process.execPath, [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'server.ts')], {
    cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  cleanup.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const ready = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) { cleanup.delete(child); throw new Error(`the server exited early:\n${log}`); }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/gemini-key`, { headers: auth() });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > ready) throw new Error(`the server never came up:\n${log}`);
    await sleep(120);
  }

  return {
    name, cwd, port, stub, child, log: () => log,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    async stop() {
      killTree(child);
      cleanup.delete(child);
      stub.server.close();
      await sleep(60);
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Every server started here is killed as a group, even if a check throws.
const cleanup = new Set();
function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => { for (const child of cleanup) killTree(child); });
}

const auth = () => ({ Authorization: `Bearer ${TOKEN}` });
const get = async (srv, p) => { const r = await fetch(srv.url(p), { headers: auth() }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = async (srv, p, body) => {
  const r = await fetch(srv.url(p), { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ── 1. the key lives ONLY in config/api_keys.json, and everything works ──── */
{
  const MODELS = {
    'harness-text-model': { },                 // answers text
    'harness-image-model': { picture: true },  // answers with a picture
  };
  const srv = await startDashboard({ models: MODELS, name: 'key-in-file' });
  try {
    const settings = await get(srv, '/api/settings/gemini-key');
    ok('key in config/api_keys.json is found', settings.body.present === true, JSON.stringify({ present: settings.body.present, source: settings.body.source }));
    ok('…and the source is named as config/api_keys.json', settings.body.source === 'config/api_keys.json', String(settings.body.source));
    ok('…and the last four characters are shown', settings.body.tail === 'cdef', String(settings.body.tail));
    ok('…and the model in use is reported', Boolean(settings.body.model), `${settings.body.model} (${settings.body.modelSource})`);
    ok('…and the app\'s names are read, not hardcoded', settings.body.assistantName === 'Tessa' && settings.body.userName === 'Mr Owner', `${settings.body.assistantName} / ${settings.body.userName}`);

    const chat = await post(srv, '/api/command', { text: 'tell me about the reactor' });
    ok('chat replies work with the file key', chat.body.reply === `answered by ${settings.body.model}`, String(chat.body.reply).slice(0, 80));
    const chatCall = srv.stub.calls.filter((c) => (c.kind === 'stream' || c.kind === 'generate') && !c.audio).pop();
    ok('…and the call carried the file\'s key', chatCall && chatCall.key === 'harness-key-0123456789abcdef', chatCall ? `key=${chatCall.key.slice(0, 12)}…` : 'no call');

    // The ear is LOCAL now (faster-whisper in local_voice/service.py): whatever
    // it answers, no audio may ever be sent to Gemini and nothing is counted.
    const pcm = Buffer.alloc(48000 * 2);       // 1 s of silence, mono PCM16
    const countBeforeEar = srv.stub.calls.length;
    const voice = await post(srv, '/api/voice/transcribe', { rate: 48000, pcm: pcm.toString('base64') });
    ok('the ear is local: no audio is ever sent to Gemini', !srv.stub.calls.some((c) => c.audio) && srv.stub.calls.length === countBeforeEar, JSON.stringify(voice.body).slice(0, 90));

    const picture = await post(srv, '/api/ai/image', { prompt: 'a teapot, glass, studio light' });
    ok('pictures work with the file key', picture.status === 200 && typeof picture.body.image === 'string' && picture.body.mime === 'image/png', JSON.stringify(picture.body).slice(0, 80));
    ok('…and the picture model was discovered from the key, never hardcoded', srv.stub.calls.some((c) => c.kind === 'generate' && c.model === 'harness-image-model'), srv.stub.calls.filter((c) => c.picture).map((c) => c.model).join(',') || 'none');

    const brain = await get(srv, '/api/brain-check');
    ok('the brain check makes a real call and names the model', brain.body.ok === true && brain.body.reply === `answered by ${settings.body.model}`, JSON.stringify({ ok: brain.body.ok, model: brain.body.model, reply: brain.body.reply }));
    ok('…and reports latency, the count and the warning level', typeof brain.body.latencyMs === 'number' && brain.body.quota && brain.body.quota.warnAt === 20 && brain.body.quota.used >= 1, `latency=${brain.body.latencyMs}ms count=${brain.body.quota?.used} warnAt=${brain.body.quota?.warnAt}`);
    ok('…and names the key that answered', brain.body.keySlot === 1 && brain.body.keyTail === 'cdef', `key ${brain.body.keySlot} …${brain.body.keyTail}`);
    ok('the counter is kept where the app keeps it', fs.existsSync(path.join(srv.cwd, 'runtime', 'quota.json')), 'runtime/quota.json');
    // Saving a new key: it must land in the app's file, and nothing else in it
    // may be damaged on the way.
    fs.writeFileSync(path.join(srv.cwd, 'config', 'api_keys.json'), JSON.stringify({
      gemini_api_key: 'harness-key-0123456789abcdef',
      assistant_name: 'Tessa',
      user_name: 'Mr Owner',
      os_system: 'linux',
    }, null, 2));
    const saved = await post(srv, '/api/settings/gemini-key', { key: 'harness-key-replacement-99' });
    const savedFile = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'config', 'api_keys.json'), 'utf-8'));
    ok('saving a key writes it where the app reads it', saved.status === 200 && savedFile.gemini_api_key === 'harness-key-replacement-99', JSON.stringify(saved.body).slice(0, 90));
    ok('…and the app\'s other settings survive the save', savedFile.assistant_name === 'Tessa' && savedFile.user_name === 'Mr Owner' && savedFile.os_system === 'linux', JSON.stringify(savedFile).slice(0, 90));
    ok('…and the report names the files written', Array.isArray(saved.body.savedTo) && saved.body.savedTo.includes('config/api_keys.json'), JSON.stringify(saved.body.savedTo));
    const stillWorks = await get(srv, '/api/brain-check');
    ok('…and the new key is live at once, with no restart', stillWorks.body.ok === true && stillWorks.body.keyTail === 't-99', String(stillWorks.body.keyTail));
  } finally { await srv.stop(); }
}

/* ── 1b. a key in ./.env is found, and named as coming from there ─────────── */
{
  const srv = await startDashboard({
    models: { 'harness-text-model': { } },
    name: 'key-in-env',
    writeConfigFile: false,                                  // the key is ONLY in ./.env
    files: { '.env': 'GEMINI_API_KEY=harness-key-in-the-env-file\n' },
  });
  try {
    const brain = await get(srv, '/api/brain-check');
    ok('a key in ./.env is found', brain.body.ok === true && brain.body.keyTail === 'file', `tail=${brain.body.keyTail}`);
    ok('…and is named as coming from .env', brain.body.keySource === '.env', String(brain.body.keySource));
  } finally { await srv.stop(); }
}

/* ── 2. a configured model override wins over discovery ───────────────────── */
{
  const MODELS = { 'harness-configured-model': { }, 'harness-other-model': { } };
  for (const [setting, label] of [['SUPPER_TEXT_MODEL', 'SUPPER_TEXT_MODEL'], ['GEMINI_MODEL', 'GEMINI_MODEL']]) {
    const srv = await startDashboard({ models: MODELS, env: { [setting]: 'harness-configured-model' }, name: label });
    try {
      const brain = await get(srv, '/api/brain-check');
      ok(`${label} wins over discovery`, brain.body.ok === true && brain.body.model === 'harness-configured-model', `${brain.body.model} (${brain.body.modelSource})`);
      const used = srv.stub.calls.filter((c) => c.kind === 'generate').map((c) => c.model);
      ok(`…and nothing else is called first (${label})`, used.length > 0 && used.every((m) => m === 'harness-configured-model'), used.join(',') || 'none');
      ok(`…and no model list is fetched (${label})`, !srv.stub.calls.some((c) => c.kind === 'list'), 'no discovery call');
    } finally { await srv.stop(); }
  }
}

/* ── 2b. stale Gemini 2.5 text overrides migrate to the current stable model ── */
{
  for (const setting of ['SUPPER_TEXT_MODEL', 'GEMINI_MODEL']) {
    const srv = await startDashboard({
      models: { 'gemini-3.8-flash': {}, 'gemini-flash-latest': {} },
      env: { [setting]: 'gemini-2.5-flash' },
      name: `legacy-text-model-${setting}`,
      files: { 'runtime/dashboard_models.json': JSON.stringify({ text: { model: 'gemini-2.5-flash', at: '2026-10-12T00:00:00.000Z' } }) },
    });
    try {
      const brain = await get(srv, '/api/brain-check');
      const called = srv.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').map((c) => c.model);
      ok(`legacy Gemini 2.5 setting ${setting} is upgraded to Gemini 3.8 Flash`,
        brain.body.ok === true && brain.body.model === 'gemini-3.8-flash',
        `${brain.body.model} (${brain.body.modelSource})`);
      ok(`legacy Gemini 2.5 is never called for ${setting}`,
        !called.includes('gemini-2.5-flash') && called.every((m) => m === 'gemini-3.8-flash'),
        called.join(',') || 'none');
      ok(`Settings explains the ${setting} migration`,
        new RegExp(`legacy ${setting}.*automatically upgraded`).test(String(brain.body.modelSource)),
        String(brain.body.modelSource));
      const remembered = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'dashboard_models.json'), 'utf8'));
      ok(`stale remembered Gemini 2.5 is replaced for ${setting}`,
        remembered.text?.model === 'gemini-3.8-flash',
        JSON.stringify(remembered.text));
    } finally { await srv.stop(); }
  }
}

/* ── 2c. model-scoped 403 access denial falls back to current stable model ──── */
{
  const srv = await startDashboard({
    models: { 'harness-restricted-model': { modelAccessDenied: true }, 'gemini-3.8-flash': {} },
    env: { SUPPER_TEXT_MODEL: 'harness-restricted-model' },
    name: 'model-access-denied',
  });
  try {
    const brain = await get(srv, '/api/brain-check');
    const calls = srv.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').map((c) => c.model);
    ok('model-specific 403 does not incorrectly blame the API key',
      brain.body.ok === true && brain.body.model === 'gemini-3.8-flash',
      `${brain.body.model} (${brain.body.modelSource})`);
    ok('the denied model is followed by the current stable model',
      calls[0] === 'harness-restricted-model' && calls.includes('gemini-3.8-flash'),
      calls.join(',') || 'none');
  } finally { await srv.stop(); }
}

/* ── 3. a retired model name falls through ────────────────────────────────── */
{
  const MODELS = { 'harness-retired-model': { retire: true }, 'gemini-3.8-flash': {}, 'gemini-flash-latest': { } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-retired-model' }, name: 'retired' });
  try {
    const brain = await get(srv, '/api/brain-check');
    ok('a retired model falls through to the current stable model', brain.body.ok === true && brain.body.model === 'gemini-3.8-flash', `${brain.body.model} (${brain.body.modelSource})`);
    ok('…and the fall-through is reported, not hidden', brain.body.modelSource && /current stable text model|current model|moving alias/.test(String(brain.body.modelSource)), String(brain.body.modelSource));
    // A real question (not a greeting — greetings never reach Gemini now).
    const chat = await post(srv, '/api/command', { text: 'explain what a flyback diode does' });
    ok('…and a chat reply still arrives', typeof chat.body.reply === 'string' && chat.body.reply.startsWith('answered by'), String(chat.body.reply).slice(0, 60));
  } finally { await srv.stop(); }

  // Every candidate retired: the message must name the withdrawal — never the
  // connection, and never the key.
  const dead = { 'harness-retired-model': { retire: true }, 'gemini-3.8-flash': { retire: true }, 'gemini-flash-latest': { retire: true }, 'harness-image-model': { retire: true } };
  const srv2 = await startDashboard({ models: dead, env: { SUPPER_TEXT_MODEL: 'harness-retired-model' }, name: 'all-retired' });
  try {
    const brain = await get(srv2, '/api/brain-check');
    const message = String(brain.body.error || '');
    ok('a fully withdrawn model explains itself', brain.body.ok === false && brain.body.code === 'model-unavailable', String(brain.body.code));
    ok('…and the message blames the model name, not the key', /withdrawn/i.test(message) && /key is fine/i.test(message), message.slice(0, 120));
    ok('…and it never blames the connection', !/connection/i.test(message), message.slice(0, 80));
    ok('…and it points at the setting', /SUPPER_TEXT_MODEL|GEMINI_MODEL/.test(message), message.slice(0, 120));
    const chat = await post(srv2, '/api/command', { text: 'explain this model availability error' });
    ok('…and the dialogue says the same thing', /withdrawn/i.test(String(chat.body.reply)) && /key is fine/i.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 100));
    const before = srv2.stub.calls.length;
    await post(srv2, '/api/voice/transcribe', { rate: 48000, pcm: Buffer.alloc(48000 * 2).toString('base64') });
    ok('…and the local ear never asks Gemini at all', srv2.stub.calls.length === before, `calls before=${before} after=${srv2.stub.calls.length}`);
    const picture = await post(srv2, '/api/ai/image', { prompt: 'a teapot' });
    ok('…and the picture tool as well', picture.status >= 400 && /withdrawn|no picture|key is fine/i.test(String(picture.body.error)), String(picture.body.error).slice(0, 100));
  } finally { await srv2.stop(); }
}

/* ── 4. no key anywhere ───────────────────────────────────────────────────── */
{
  const MODELS = { 'harness-text-model': { } };
  const srv = await startDashboard({ models: MODELS, name: 'no-key' });
  try {
    fs.rmSync(path.join(srv.cwd, 'config', 'api_keys.json'));
    const brain = await get(srv, '/api/brain-check');
    ok('no key produces the documented message', brain.body.ok === false && brain.body.code === 'no-key', String(brain.body.code));
    const message = String(brain.body.error || '');
    ok('…naming the environment key', /GEMINI_API_KEY/.test(message), message.slice(0, 120));
    ok('…naming config/api_keys.json and the field', /config\/api_keys\.json/.test(message) && /gemini_api_key/.test(message), message.slice(0, 160));
    ok('…and naming ./.env', /\.env/.test(message), message.slice(0, 160));
    const settings = await get(srv, '/api/settings/gemini-key');
    ok('…and Settings agrees there is no key', settings.body.present === false && settings.body.source === null, JSON.stringify({ present: settings.body.present, source: settings.body.source }));
    const greeting = await post(srv, '/api/command', { text: 'hello' });
    ok('…and an offline greeting stays brief and honest', /no Gemini key is set/.test(String(greeting.body.reply)) && String(greeting.body.reply).length < 100,
       String(greeting.body.reply));
    const chat = await post(srv, '/api/command', { text: 'what can you tell me offline' });
    ok('…and an unanswered offline question names every place checked', /GEMINI_API_KEY/.test(String(chat.body.reply)) && /config\/api_keys\.json/.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 110));
    ok('…and no call was made without a key', !srv.stub.calls.some((c) => c.kind === 'generate'), `calls=${srv.stub.calls.length}`);
    const saved = await post(srv, '/api/settings/gemini-key', { key: 'a-new-harness-key-012345' });
    ok('saving a key clears the previous no-key status', saved.body.ok === true && !/no Gemini key is set|did not answer|offline/i.test(String((await post(srv, '/api/command', { text: 'hello' })).body.reply)),
       String(saved.body.ok));
  } finally { await srv.stop(); }
}

/* ── 5. THE COUNT WARNS, ONLY GOOGLE STOPS ───────────────────────────────────
 * The owner's rule: the app never blocks itself. It counts every outbound call
 * (one unit per question), warns past SUPPER_GEMINI_DAILY_WARN, and keeps
 * going. The only thing that stops a call is a real 429 from Google — and that
 * is said plainly as Google's doing, until local midnight.                    */
{
  const MODELS = { 'harness-text-model': { } };
  const readCounter = (srv) => JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'quota.json'), 'utf-8'));

  // (a) a warning level of 1: the second, third… calls still go out
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_GEMINI_DAILY_WARN: '1', SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'count-warns' });
  try {
    const first = await get(srv, '/api/brain-check');
    ok('count: the first call counts one unit', first.body.ok === true && first.body.quota.used === 1, `used=${first.body.quota?.used} warnAt=${first.body.quota?.warnAt}`);
    const counter = readCounter(srv);
    ok('count: the counter file keeps the shape the engine room reads ({day, used}) plus per-key detail',
       counter.used === 1 && typeof counter.day === 'string' && counter.keys && counter.keys['1'] === 1 && counter.keys['2'] === 0, JSON.stringify(counter));
    const second = await get(srv, '/api/brain-check');
    const third = await get(srv, '/api/brain-check');
    ok('count: past the warning level the calls STILL go out — nothing blocks', second.body.ok === true && third.body.ok === true && third.body.quota.used === 3,
       `second=${second.body.ok} third=${third.body.ok} used=${third.body.quota?.used}`);
    ok('count: …and Google really was called every time', srv.stub.calls.filter((c) => c.kind === 'generate').length === 3, `generates=${srv.stub.calls.filter((c) => c.kind === 'generate').length}`);
    ok('count: Settings reports it as past the warning level', third.body.quota.pastWarn === true && third.body.quota.warnAt === 1 && /SUPPER_GEMINI_DAILY_WARN/.test(third.body.quota.warnSource), JSON.stringify({ pastWarn: third.body.quota.pastWarn, warnAt: third.body.quota.warnAt }));
    ok('count: the terminal warned, and said the call still goes through', /warning level of 1/.test(srv.log()) && /still goes through/.test(srv.log()), (srv.log().match(/.*warning level of 1.*/) || [''])[0].slice(0, 140));
    ok('count: the old refusal is gone', !/I am not calling Gemini/.test(JSON.stringify([first.body, second.body, third.body])), 'no "I am not calling Gemini" anywhere');
    const chat = await post(srv, '/api/command', { text: 'tell me about the reactor coolant' });
    ok('count: the dialogue answers too, past the level', /answered by harness-text-model/.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 60));
    const settings = await get(srv, '/api/settings/gemini-key');
    ok('count: Settings shows total and per-key counts', settings.body.quota.used === 4 && settings.body.quota.perKey['1'] === 4 && settings.body.quota.perKey['2'] === 0, JSON.stringify(settings.body.quota.perKey));
    ok('count: …and which key is active', settings.body.activeKey && settings.body.activeKey.slot === 1 && settings.body.activeKey.tail === 'cdef', JSON.stringify(settings.body.activeKey));
  } finally { await srv.stop(); }

  // (b) the OLD setting, SUPPER_GEMINI_DAILY_BUDGET=1, no longer blocks either
  const legacy = await startDashboard({ models: MODELS, env: { SUPPER_GEMINI_DAILY_BUDGET: '1', SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'legacy-budget' });
  try {
    await get(legacy, '/api/brain-check');
    const second = await get(legacy, '/api/brain-check');
    ok('count: the old SUPPER_GEMINI_DAILY_BUDGET no longer blocks at any number', second.body.ok === true && second.body.quota.used === 2, `ok=${second.body.ok} used=${second.body.quota?.used}`);
    ok('count: …it is read as the warning level and named as such', second.body.quota.warnAt === 1 && /SUPPER_GEMINI_DAILY_BUDGET/.test(second.body.quota.warnSource) && /never blocks/.test(second.body.quota.warnSource), second.body.quota.warnSource.slice(0, 100));
  } finally { await legacy.stop(); }

  // (c) a damaged counter: warns, never blocks
  const srv2 = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'damaged-counter' });
  try {
    fs.mkdirSync(path.join(srv2.cwd, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(srv2.cwd, 'runtime', 'quota.json'), '{not json at all');
    const brain = await get(srv2, '/api/brain-check');
    ok('damaged counter: the call still goes out', brain.body.ok === true && srv2.stub.calls.filter((c) => c.kind === 'generate').length === 1, `ok=${brain.body.ok} generates=${srv2.stub.calls.filter((c) => c.kind === 'generate').length}`);
    ok('damaged counter: …it is reported as unreadable and counted in memory', brain.body.quota.unreadable === true && brain.body.quota.used === 1, JSON.stringify({ unreadable: brain.body.quota.unreadable, used: brain.body.quota.used }));
    ok('damaged counter: …the terminal warns that the count could not be read, and that nothing is blocked', /could not be read/.test(srv2.log()) && /Nothing is blocked/.test(srv2.log()), (srv2.log().match(/.*could not be read.*/) || [''])[0].slice(0, 140));
    ok('damaged counter: …and the damaged file was left alone, not overwritten', fs.readFileSync(path.join(srv2.cwd, 'runtime', 'quota.json'), 'utf-8') === '{not json at all', 'untouched');
  } finally { await srv2.stop(); }

  // (d) a real 429 from Google, one key only: Google stops us until midnight
  const srv3 = await startDashboard({ models: { 'harness-text-model': { rateLimited: true } }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'rate-limited' });
  try {
    const brain = await get(srv3, '/api/brain-check');
    ok('429: reported as Google stopping us, not as a key problem and not as the app', brain.body.ok === false && brain.body.code === 'rate-limited' && /Google stopping us/.test(String(brain.body.error)) && /not this app/.test(String(brain.body.error)) && !/invalid|refused the key/i.test(String(brain.body.error)), String(brain.body.error).slice(0, 140));
    ok('429: …and it says no second key is set', /No second key is set/.test(String(brain.body.error)), 'offers the second key');
    const after = readCounter(srv3);
    ok('429: the counter records that Google stopped key 1 today', after.google_stopped && after.google_stopped['1'] && after.google_stopped['1'].reason === 'quota', JSON.stringify(after.google_stopped));
    const sent = srv3.stub.calls.filter((c) => c.kind === 'generate').length;
    const next = await get(srv3, '/api/brain-check');
    ok('429: the next call is refused before it is sent — Google stopped us until midnight', next.body.ok === false && next.body.code === 'google-stopped' && srv3.stub.calls.filter((c) => c.kind === 'generate').length === sent, `${next.body.code}; generates still ${sent}`);
    ok('429: …and the message blames Google, names the time, and promises midnight', /Google, not this app/.test(String(next.body.error)) && /key 1 was stopped at \d\d:\d\d/.test(String(next.body.error)) && /local midnight/.test(String(next.body.error)), String(next.body.error).slice(0, 160));
    ok('429: …and the count is not pretended to be used up', next.body.quota.used === 1 && next.body.quota.stoppedByGoogle === true, JSON.stringify({ used: next.body.quota.used, stoppedByGoogle: next.body.quota.stoppedByGoogle }));
    const chat = await post(srv3, '/api/command', { text: 'explain how a transistor works' });
    // The owner's rule: a 429 is a WARNING, not a block. The chat does not stop
    // and it does not dump the provider error — the app goes OFFLINE, answers
    // from this computer, and says so in one line.
    ok('429: the chat does NOT stop — it goes offline and answers locally', !/Google has stopped our calls for today/.test(String(chat.body.reply)) && /offline/i.test(String(chat.body.reply)) && /answered from this computer/.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 120));
    ok('429: …and the reply is a warning, not a wall of provider error', !/RESOURCE_EXHAUSTED/.test(String(chat.body.reply)) && /429/.test(String(chat.body.reply)) && /local midnight/.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 140));
    ok('429: …and it offers the local way forward (teach it, or wait for midnight)', /learn:/i.test(String(chat.body.reply)), 'offers "learn:"');
    // Local answers never go near the gate.
    const time = await post(srv3, '/api/command', { text: 'what time is it' });
    ok('429: local answers still work while Google has stopped us (the time)', !/Google/.test(String(time.body.reply)) && /\d/.test(String(time.body.reply)), String(time.body.reply).slice(0, 80));
    const learn = await post(srv3, '/api/command', { text: 'learn: the coolant pump is in bay three' });
    const recall = await post(srv3, '/api/command', { text: 'where is the coolant pump' });
    ok('429: …and learned knowledge', /bay three/.test(String(recall.body.reply)), `${String(learn.body.reply).slice(0, 40)} / ${String(recall.body.reply).slice(0, 60)}`);
    const draft = await post(srv3, '/api/command', { text: 'draft an email to Pepper about the reactor review' });
    ok('429: …and the drafting desk', /draft|email/i.test(String(draft.body.reply)) && !/Google has stopped/.test(String(draft.body.reply)), String(draft.body.reply).slice(0, 80));
    ok('429: …none of which counted or called Google', readCounter(srv3).used === 1 && srv3.stub.calls.filter((c) => c.kind === 'generate').length === sent, `used=${readCounter(srv3).used}`);
    const settings = await get(srv3, '/api/settings/gemini-key');
    ok('429: Settings says Google stopped us', settings.body.quota.stoppedByGoogle === true && settings.body.activeKey.stoppedByGoogle === true && /GOOGLE HAS STOPPED US/.test(settings.body.quota.summary), settings.body.quota.summary.slice(0, 120));
    ok('429: the terminal says Google stopped key 1 and no second key is set', /Google stopped key 1/.test(srv3.log()) && /no second key is set/.test(srv3.log()), (srv3.log().match(/.*Google stopped key 1.*/) || [''])[0].slice(0, 160));
  } finally { await srv3.stop(); }
}

/* ── 5b. THE SECOND KEY: Google stops key 1, key 2 carries on ─────────────── */
{
  const readCounter = (srv) => JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'quota.json'), 'utf-8'));

  // (a) key 1 is over Google's quota; key 2 answers the SAME question and the next one
  const two = await startDashboard({
    models: { 'harness-text-model': { rateLimitedKeys: [KEY1] } },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    config: { gemini_api_key_2: KEY2 },
    name: 'two-keys',
  });
  try {
    const before = await get(two, '/api/settings/gemini-key');
    ok('two keys: Settings shows both keys by their last four characters and source',
       before.body.tail === 'cdef' && before.body.key2 && before.body.key2.present === true && before.body.key2.tail === '3210' && before.body.key2.source === 'config/api_keys.json',
       JSON.stringify({ key1: before.body.tail, key2: before.body.key2 && before.body.key2.tail, source: before.body.key2 && before.body.key2.source }));
    ok('two keys: key 1 is the active one to begin with', before.body.activeKey.slot === 1, JSON.stringify(before.body.activeKey));

    const chat = await post(two, '/api/command', { text: 'explain the reactor coolant loop' });
    const sent = two.stub.calls.filter((c) => c.kind === 'stream' || c.kind === 'generate');
    ok('two keys: the question went out on key 1 first, and Google refused it', sent.some((c) => c.key === KEY1 && c.refused === 429), sent.map((c) => `${c.kind}:…${String(c.key).slice(-4)}${c.refused ? `(${c.refused})` : ''}`).join(' '));
    ok('two keys: …and the SAME question was answered on key 2', /answered by harness-text-model/.test(String(chat.body.reply)) && sent.some((c) => c.key === KEY2 && !c.refused), String(chat.body.reply).slice(0, 60));
    ok('two keys: the terminal announced the switch', /Switching to key 2 for the rest of the day/.test(two.log()), (two.log().match(/.*Switching to key 2.*/) || [''])[0].slice(0, 160));
    ok('two keys: …and the retry on key 2 counted as one call on key 2', /retrying the same question on key 2/.test(two.log()) && readCounter(two).keys['2'] === 1 && readCounter(two).keys['1'] === 1, JSON.stringify(readCounter(two).keys));
    ok('two keys: key 1 was asked ONCE, not twice — no doomed second request to a stopped key', sent.filter((c) => c.key === KEY1).length === 1, `${sent.filter((c) => c.key === KEY1).length} request(s) on key 1`);

    const countBefore = two.stub.calls.length;
    const next = await get(two, '/api/brain-check');
    const nextCalls = two.stub.calls.slice(countBefore).filter((c) => c.kind === 'generate' || c.kind === 'stream');
    ok('two keys: the NEXT call goes straight out on key 2 — key 1 is not tried again today', next.body.ok === true && nextCalls.length >= 1 && nextCalls.every((c) => c.key === KEY2), nextCalls.map((c) => `…${String(c.key).slice(-4)}`).join(','));
    ok('two keys: …and the brain check names key 2 as the one that answered', next.body.keySlot === 2 && next.body.keyTail === '3210', `key ${next.body.keySlot} …${next.body.keyTail}`);
    const settings = await get(two, '/api/settings/gemini-key');
    ok('two keys: Settings shows key 2 active, with the reason', settings.body.activeKey.slot === 2 && /Google stopped the first one/.test(settings.body.activeKey.reason), settings.body.activeKey.reason.slice(0, 120));
    ok('two keys: …and the calls counted per key', settings.body.quota.perKey['1'] === 1 && settings.body.quota.perKey['2'] === 2 && settings.body.quota.used === 3, JSON.stringify(settings.body.quota.perKey));
    ok('two keys: …and when the switch happened', typeof settings.body.quota.switchedAt === 'string' && settings.body.quota.googleStopped['1'] && !settings.body.quota.googleStopped['2'], JSON.stringify({ switchedAt: settings.body.quota.switchedAt, stopped: settings.body.quota.googleStopped }));
    ok('two keys: it is NOT reported as Google stopping us — key 2 is still working', settings.body.quota.stoppedByGoogle === false && !/GOOGLE HAS STOPPED US/.test(settings.body.quota.summary), settings.body.quota.summary.slice(0, 120));
    const counter = readCounter(two);
    ok('two keys: the switch survives a restart — it is in the counter file', counter.google_stopped['1'] && counter.switched_at && counter.keys['2'] === 2, JSON.stringify(counter).slice(0, 160));
  } finally { await two.stop(); }

  // (b) both keys over Google's quota: only now does the app say Google stopped us
  const both = await startDashboard({
    models: { 'harness-text-model': { rateLimitedKeys: [KEY1, KEY2] } },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    config: { gemini_api_key_2: KEY2 },
    name: 'both-stopped',
  });
  try {
    const brain = await get(both, '/api/brain-check');
    const sent = both.stub.calls.filter((c) => c.kind === 'generate');
    ok('both stopped: key 1 then key 2 were both tried', sent.some((c) => c.key === KEY1) && sent.some((c) => c.key === KEY2), sent.map((c) => `…${String(c.key).slice(-4)}`).join(','));
    ok('both stopped: the report says Google stopped us, for both keys', brain.body.ok === false && brain.body.code === 'rate-limited' && /key 1 was stopped at/.test(String(brain.body.error)) && /key 2 was stopped at/.test(String(brain.body.error)), String(brain.body.error).slice(0, 200));
    ok('both stopped: the terminal says both are stopped — Google, not the app', /key 2 is stopped too|key 1 is stopped too/.test(both.log()) && /GOOGLE HAS STOPPED US/.test(both.log()), (both.log().match(/.*GOOGLE HAS STOPPED US.*/) || [''])[0].slice(0, 160));
    const after = await get(both, '/api/brain-check');
    ok('both stopped: the next call is refused before it is sent', after.body.code === 'google-stopped' && both.stub.calls.filter((c) => c.kind === 'generate').length === sent.length, after.body.code);
    const settings = await get(both, '/api/settings/gemini-key');
    ok('both stopped: Settings says so', settings.body.quota.stoppedByGoogle === true && settings.body.quota.googleStopped['1'] && settings.body.quota.googleStopped['2'], settings.body.quota.summary.slice(0, 120));
    ok('both stopped: …and each key shows the one call Google saw from it', settings.body.quota.perKey['1'] === 1 && settings.body.quota.perKey['2'] === 1, JSON.stringify(settings.body.quota.perKey));
    const time = await post(both, '/api/command', { text: 'what is the date today' });
    ok('both stopped: local answers still work', /\d/.test(String(time.body.reply)) && !/Google/.test(String(time.body.reply)), String(time.body.reply).slice(0, 80));
  } finally { await both.stop(); }

  // (c) Google REJECTS key 1 (a bad key): key 2 takes over the same way
  const rejected = await startDashboard({
    models: { 'harness-text-model': { rejectKeys: [KEY1] } },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    config: { gemini_api_key_2: KEY2 },
    name: 'key1-rejected',
  });
  try {
    const brain = await get(rejected, '/api/brain-check');
    ok('rejected key 1: key 2 answers', brain.body.ok === true && brain.body.keySlot === 2, `ok=${brain.body.ok} key=${brain.body.keySlot}`);
    ok('rejected key 1: …and the terminal says why', /Google rejected the key itself/.test(rejected.log()) && /Switching to key 2/.test(rejected.log()), (rejected.log().match(/.*Google stopped key 1.*/) || [''])[0].slice(0, 160));
    const settings = await get(rejected, '/api/settings/gemini-key');
    ok('rejected key 1: Settings records the reason', settings.body.quota.googleStopped['1'] && settings.body.quota.googleStopped['1'].reason === 'key-rejected', JSON.stringify(settings.body.quota.googleStopped['1']));
  } finally { await rejected.stop(); }

  // (d) a second key from ./.env is found and named as coming from there
  const envKey = await startDashboard({
    models: { 'harness-text-model': { rateLimitedKeys: [KEY1] } },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    files: { '.env': 'GEMINI_API_KEY_2=harness-env-second-key-00aa\n' },
    name: 'key2-in-env',
  });
  try {
    const settings = await get(envKey, '/api/settings/gemini-key');
    ok('key 2 from ./.env: found and named', settings.body.key2.present === true && settings.body.key2.source === '.env' && settings.body.key2.tail === '00aa', JSON.stringify(settings.body.key2));
    const brain = await get(envKey, '/api/brain-check');
    ok('key 2 from ./.env: …and it is the one that carries on', brain.body.ok === true && brain.body.keySlot === 2 && brain.body.keySource === '.env', `key ${brain.body.keySlot} from ${brain.body.keySource}`);
  } finally { await envKey.stop(); }
}

/* ── 5c. SETTINGS SAVES AND REPORTS THE SECOND KEY ──────────────────────────── */
{
  const srv = await startDashboard({ models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'save-key2' });
  try {
    const none = await get(srv, '/api/settings/gemini-key');
    ok('save key 2: before — no second key, said plainly and as optional', none.body.key2.present === false && /optional/.test(none.body.key2.detail), none.body.key2.detail.slice(0, 100));
    const tooShort = await post(srv, '/api/settings/gemini-key', { key: 'short', slot: 2 });
    ok('save key 2: a too-short key is refused', tooShort.status === 400, String(tooShort.body.error).slice(0, 80));
    const saved = await post(srv, '/api/settings/gemini-key', { key: KEY2, slot: 2 });
    const file = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'config', 'api_keys.json'), 'utf-8'));
    ok('save key 2: written as gemini_api_key_2 in config/api_keys.json', saved.status === 200 && saved.body.slot === 2 && file.gemini_api_key_2 === KEY2, JSON.stringify(saved.body).slice(0, 120));
    ok('save key 2: …without touching the first key or the names', file.gemini_api_key === KEY1 && file.assistant_name === 'Tessa', JSON.stringify(file).slice(0, 120));
    const after = await get(srv, '/api/settings/gemini-key');
    ok('save key 2: Settings reports it by its last four characters and source', after.body.key2.present === true && after.body.key2.tail === '3210' && after.body.key2.source === 'config/api_keys.json', JSON.stringify(after.body.key2));
    ok('save key 2: …and the first key is still the active one', after.body.activeKey.slot === 1 && after.body.quota.hasSecondKey === true, JSON.stringify(after.body.activeKey));
    const removed = await post(srv, '/api/settings/gemini-key', { slot: 2, clear: true });
    const fileAfter = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'config', 'api_keys.json'), 'utf-8'));
    ok('remove key 2: gone from the file, first key untouched', removed.status === 200 && removed.body.cleared === true && !('gemini_api_key_2' in fileAfter) && fileAfter.gemini_api_key === KEY1, JSON.stringify(removed.body).slice(0, 100));
    ok('remove key 2: …and Settings says there is none', (await get(srv, '/api/settings/gemini-key')).body.key2.present === false, 'none');
  } finally { await srv.stop(); }

  // A GEMINI_API_KEY_2 already in ./.env shadows a saved second key — and the save says so.
  const shadow = await startDashboard({
    models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    files: { '.env': 'GEMINI_API_KEY_2=harness-env-second-key-00aa\n' }, name: 'key2-shadowed',
  });
  try {
    // The saved key replaces the ./.env line as well (same rule as the first key), so it is in force.
    const saved = await post(shadow, '/api/settings/gemini-key', { key: KEY2, slot: 2 });
    ok('save key 2 with ./.env: the ./.env line is updated too, so the saved key is in force', saved.status === 200 && saved.body.savedTo.includes('.env') && saved.body.shadowed === false, JSON.stringify(saved.body).slice(0, 120));
    const envText = fs.readFileSync(path.join(shadow.cwd, '.env'), 'utf-8');
    ok('save key 2 with ./.env: …and the file now holds the new key', /GEMINI_API_KEY_2=harness-second-key-fedcba9876543210/.test(envText), envText.trim().slice(0, 80));
  } finally { await shadow.stop(); }
}

/* ── 5d. THE VOICE IS LOCAL: it never calls Gemini and never counts ─────────── */
{
  const srv = await startDashboard({ models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'voice-local' });
  try {
    await post(srv, '/api/voice/speak', { text: 'Good day, sir. All systems are online.' });
    await post(srv, '/api/voice/transcribe', { rate: 48000, pcm: Buffer.alloc(48000 * 2).toString('base64') });
    await post(srv, '/api/voice/stop', {});
    ok('voice: speaking and hearing never reach Gemini', srv.stub.calls.length === 0, `stub calls=${srv.stub.calls.length}`);
    ok('voice: …and never count', !fs.existsSync(path.join(srv.cwd, 'runtime', 'quota.json')), 'no runtime/quota.json was written');
    const settings = await get(srv, '/api/settings/gemini-key');
    ok('voice: Settings names the local voice, not a Gemini model', /Kokoro/.test(String(settings.body.voiceModel)) && /local_voice/.test(String(settings.body.voiceModelSource)), `${settings.body.voiceModel} — ${settings.body.voiceModelSource}`);
    const empty = await post(srv, '/api/voice/speak', { text: '   ' });
    ok('voice: empty text is refused politely', empty.body.code === 'empty', JSON.stringify(empty.body).slice(0, 80));
  } finally { await srv.stop(); }
}

/* ── 5e. OFFLINE MODE: quota spent means LOCAL ONLY, and the chat carries on ──
 * The owner's rule, proved end to end:
 *   - a 429 is a WARNING, never a block: the chat answers from this computer;
 *   - when every key is spent the app is OFFLINE and nothing is fetched from
 *     the internet — research and pictures are refused before a call is made;
 *   - everything local keeps working and costs nothing;
 *   - the owner can switch offline (and back) by chat, by API and by
 *     SUPPER_OFFLINE, and the switch survives a restart.                     */
{
  const readCounter = (srv) => (fs.existsSync(path.join(srv.cwd, 'runtime', 'quota.json'))
    ? JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'quota.json'), 'utf-8')) : { used: 0 });

  // (a) Google spent BOTH keys: the app is offline, local only, chat still answering.
  const spent = await startDashboard({
    models: { 'harness-text-model': { rateLimitedKeys: [KEY1, KEY2] }, 'harness-image-model': { picture: true } },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' },
    config: { gemini_api_key_2: KEY2 },
    name: 'offline-quota',
  });
  try {
    const chat = await post(spent, '/api/command', { text: 'explain how a transistor works' });
    const sentAfterQuota = spent.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').length;
    ok('offline: the chat answers instead of stopping', chat.status === 200 && /offline/i.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 90));
    const state = await get(spent, '/api/offline');
    ok('offline: /api/offline says offline, and why (Google\'s 429, not this app)', state.body.offline === true && state.body.reason === 'google-stopped' && /429/.test(String(state.body.why)), `${state.body.reason} — ${String(state.body.why).slice(0, 70)}`);
    ok('offline: …and lists what still works and what is refused', Array.isArray(state.body.works) && state.body.works.length > 3 && Array.isArray(state.body.refused) && state.body.refused.length > 2, `${state.body.works.length} work / ${state.body.refused.length} refused`);
    const status = await get(spent, '/api/system-status');
    ok('offline: telemetry carries the state, so the page can show a banner', status.body.offline && status.body.offline.offline === true && status.body.offline.reason === 'google-stopped', String(status.body.offline && status.body.offline.reason));
    const settings = await get(spent, '/api/settings/gemini-key');
    ok('offline: Settings carries it too', settings.body.offline && settings.body.offline.offline === true, String(settings.body.offline && settings.body.offline.summary).slice(0, 90));

    // Nothing that needs the internet may be fetched — and nothing is counted.
    const research = await post(spent, '/api/research/tasks', { question: 'What is the history of the steam engine?' });
    ok('offline: Internet Research is refused before anything is fetched', research.status === 503 && /offline/i.test(String(research.body.error)) && /Nothing was fetched/.test(String(research.body.error)), String(research.body.error).slice(0, 100));
    const picture = await post(spent, '/api/ai/image', { prompt: 'a teapot, glass, studio light' });
    ok('offline: …and so are AI pictures', picture.status === 503 && /offline/i.test(String(picture.body.error)), String(picture.body.error).slice(0, 100));
    const researchChat = await post(spent, '/api/command', { text: 'research the history of the steam engine' });
    ok('offline: …and by chat, before a task is queued', /needs the internet/.test(String(researchChat.body.reply)) && !/started/.test(String(researchChat.body.reply)), String(researchChat.body.reply).slice(0, 100));

    // Local work carries on, and costs nothing at all.
    const local = await post(spent, '/api/command', { text: 'what time is it' });
    ok('offline: local answers still work (the time)', /\d/.test(String(local.body.reply)) && !/offline/i.test(String(local.body.reply)), String(local.body.reply).slice(0, 70));
    const room = await post(spent, '/api/command', { text: 'open the files room' });
    ok('offline: …and local PC commands are not swallowed by a topic question', /files room/.test(String(room.body.reply)), String(room.body.reply).slice(0, 80));
    const learn = await post(spent, '/api/command', { text: 'learn: the coolant pump is in bay three' });
    const recall = await post(spent, '/api/command', { text: 'where is the coolant pump' });
    ok('offline: …and the knowledge base answers for free', /bay three/.test(String(recall.body.reply)) && /Learned/.test(String(learn.body.reply)), String(recall.body.reply).slice(0, 70));
    const draft = await post(spent, '/api/command', { text: 'draft an email to Pepper about the reactor review' });
    ok('offline: …and the drafting desk writes here', /draft/i.test(String(draft.body.reply)) && /no AI/i.test(String(draft.body.reply)), String(draft.body.reply).slice(0, 80));
    const small = await post(spent, '/api/command', { text: 'hello' });
    ok('offline: …and small talk stays small talk', /Good day/.test(String(small.body.reply)), String(small.body.reply).slice(0, 60));
    ok('offline: none of that reached Google or counted a call', spent.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').length === sentAfterQuota && readCounter(spent).used === 2, `stub=${spent.stub.calls.length} used=${readCounter(spent).used}`);
    ok('offline: the terminal announced it once, as a warning not a block', /OFFLINE — local only/.test(spent.log()) && /This is a warning, not a block/.test(spent.log()), (spent.log().match(/.*OFFLINE — local only.*/) || [''])[0].slice(0, 130));
    const who = await post(spent, '/api/command', { text: 'are you offline' });
    ok('offline: asking says so plainly, with what still works', /OFFLINE/.test(String(who.body.reply)) && /Still working/.test(String(who.body.reply)), String(who.body.reply).slice(0, 100));
    // The owner's switch is only half the decision: it cannot lift Google's 429.
    // (It used to — "come back online" reported ONLINE while both keys were
    // still stopped, so the next question was sent, 429'd, and the app kept
    // claiming to be online.)
    const undo = await post(spent, '/api/offline', { on: false });
    ok('offline: "come back online" cannot undo Google\'s 429', undo.body.offline === true && undo.body.reason === 'google-stopped', `${undo.body.offline} / ${undo.body.reason}`);
    ok('offline: …and says so instead of promising the keys', /still offline/.test(String(undo.body.message)) && /midnight/.test(String(undo.body.message)), String(undo.body.message).slice(0, 110));
  } finally { await spent.stop(); }

  // (b) The owner's own switch: offline on purpose, then back — no quota involved.
  const manual = await startDashboard({ models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'offline-manual' });
  try {
    const online = await get(manual, '/api/offline');
    ok('offline switch: online to begin with', online.body.offline === false && online.body.reason === null, `${online.body.offline} / ${online.body.reason}`);
    const before = manual.stub.calls.length;
    const on = await post(manual, '/api/offline', { on: true });
    ok('offline switch: switching offline says what still works', on.body.offline === true && on.body.reason === 'manual' && on.body.forced === true, `${on.body.reason}`);
    const chat = await post(manual, '/api/command', { text: 'explain how a transistor works' });
    ok('offline switch: the chat answers locally and calls nothing', /offline/i.test(String(chat.body.reply)) && manual.stub.calls.length === before, String(chat.body.reply).slice(0, 90));
    const research = await post(manual, '/api/research/tasks', { question: 'What is the history of the steam engine?' });
    ok('offline switch: …and the internet stays out of it', research.status === 503, String(research.body.error).slice(0, 80));
    ok('offline switch: …and nothing was counted', !fs.existsSync(path.join(manual.cwd, 'runtime', 'quota.json')), 'no counter file written');
    ok('offline switch: it is remembered in runtime/offline.json', fs.existsSync(path.join(manual.cwd, 'runtime', 'offline.json')) && JSON.parse(fs.readFileSync(path.join(manual.cwd, 'runtime', 'offline.json'), 'utf-8')).forced === true, 'runtime/offline.json');
    const byVoice = await post(manual, '/api/command', { text: 'come back online' });
    ok('offline switch: "come back online" returns to automatic', /back to automatic/.test(String(byVoice.body.reply)) && !fs.existsSync(path.join(manual.cwd, 'runtime', 'offline.json')), String(byVoice.body.reply).slice(0, 90));
    const after = await post(manual, '/api/command', { text: 'explain how a transistor works' });
    ok('offline switch: …and the next question reaches Gemini again', after.body.reply === 'answered by harness-text-model' && manual.stub.calls.length === before + 1, String(after.body.reply).slice(0, 70));
    const goOffline = await post(manual, '/api/command', { text: 'go offline' });
    ok('offline switch: "go offline" works by chat too', /Offline, sir/.test(String(goOffline.body.reply)), String(goOffline.body.reply).slice(0, 80));
  } finally { await manual.stop(); }

  // (c) SUPPER_OFFLINE=1: offline from boot, and the switch survives a restart.
  const boot = await startDashboard({ models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model', SUPPER_OFFLINE: '1' }, name: 'offline-boot' });
  try {
    const state = await get(boot, '/api/offline');
    ok('offline from boot: SUPPER_OFFLINE=1 means local only from the first moment', state.body.offline === true && state.body.reason === 'manual', `${state.body.reason}`);
    const chat = await post(boot, '/api/command', { text: 'explain how a transistor works' });
    ok('offline from boot: …and no call is made', /offline/i.test(String(chat.body.reply)) && boot.stub.calls.length === 0, `stub calls=${boot.stub.calls.length}`);
    ok('offline from boot: the terminal said so at startup', /OFFLINE — local only/.test(boot.log()), (boot.log().match(/.*OFFLINE — local only.*/) || [''])[0].slice(0, 110));
  } finally { await boot.stop(); }

  // (d) No key at all. The switch cannot invent one: "come back online" must
  // keep reporting offline, or the page would show Online while every question
  // is answered from this computer.
  const noKey = await startDashboard({ models: { 'harness-text-model': {} }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'offline-no-key', writeConfigFile: false });
  try {
    const state = await get(noKey, '/api/offline');
    ok('no key: the app says offline, not broken', state.body.offline === true && state.body.reason === 'no-key', `${state.body.offline} / ${state.body.reason}`);
    const chat = await post(noKey, '/api/command', { text: 'explain how a transistor works' });
    ok('no key: …and answers from this computer instead of failing', /offline/i.test(String(chat.body.reply)) && noKey.stub.calls.length === 0, `stub calls=${noKey.stub.calls.length}`);
    const undo = await post(noKey, '/api/offline', { on: false });
    ok('no key: "come back online" cannot invent a key', undo.body.offline === true && undo.body.reason === 'no-key', `${undo.body.offline} / ${undo.body.reason}`);
    ok('no key: …and the switch says so plainly', /still offline/.test(String(undo.body.message)), String(undo.body.message).slice(0, 110));
    const still = await get(noKey, '/api/offline');
    ok('no key: the page banner would still read Local only', still.body.offline === true, `${still.body.offline}`);
  } finally { await noKey.stop(); }
}

/* ── 6. Settings → "The Brain" and the voice check, in the real page ──────── */
{
  let JSDOM = null;
  if (!HTTP_ONLY) {
    try { ({ JSDOM } = await import('jsdom')); } catch { /* handled below */ }
  }
  if (!JSDOM) {
    console.log('      (page checks skipped — install jsdom in a scratch folder: npm i --no-save jsdom@24)');
  } else {
    const MODELS = { 'harness-text-model': { } };
    const srv = await startDashboard({ models: MODELS, name: 'page' });
    try {
      const pageHtml = await (await fetch(srv.url('/'))).text();
      ok('the server fills the assistant name into the page', pageHtml.includes('Tessa — Autonomous Workspace'), pageHtml.slice(0, 60).replace(/\n/g, ' '));
      const handScript = fs.readFileSync(path.join(REPO, 'dashboard/static/hand-gestures.js'), 'utf8');
      const html = pageHtml.replace('<script src="/static/hand-gestures.js"></script>', `<script>${handScript}</script>`);
      const { VirtualConsole } = await import('jsdom');
      const virtualConsole = new VirtualConsole();          // jsdom's canvas warning is not our business
      virtualConsole.on('jsdomError', () => {});
      const dom = new JSDOM(html, { url: srv.url('/'), runScripts: 'dangerously', pretendToBeVisual: false, virtualConsole });
      const { window } = dom;
      window.fetch = (input, init) => {
        const absolute = typeof input === 'string' ? new URL(input, srv.url('/')).toString() : input;
        return fetch(absolute, init);
      };
      window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
      window.scrollTo = () => {};
      await sleep(400);

      const buildLine = window.document.getElementById('jarvis-build-line');
      // The marker is only worth printing if it proves the PAGE and the SERVER
      // are the same build. Hard-coding the string here would pass on a stale
      // page and fail on every honest bump, so the server's own marker is asked
      // for and the two are compared.
      const serverBuild = (await get(srv, '/api/system-status')).body.build;
      ok('the server reports the build it is running', typeof serverBuild === 'string' && serverBuild.length > 0, String(serverBuild));
      ok('…and the folder it reads its settings from',
         /configRoot/.test(JSON.stringify((await get(srv, '/api/system-status')).body)), String((await get(srv, '/api/system-status')).body.configRoot));
      ok('Settings → Voice shows the build marker', /Build page/.test(buildLine.textContent), buildLine.textContent.slice(0, 90));
      ok('…with the assistant\'s configured name', /Tessa/.test(buildLine.textContent), buildLine.textContent.slice(0, 90));

      await window.refreshGeminiKeyStatus();
      await sleep(150);
      ok('…and once the server answers, the line compares the page with the server',
         new RegExp(`page and server both ${serverBuild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(buildLine.textContent),
         `server=${serverBuild} line=${buildLine.textContent.slice(0, 110)}`);
      ok('…so a stale page would be called out instead of silently lying',
         !/BUT THE SERVER IS/.test(buildLine.textContent), buildLine.textContent.slice(0, 110));
      ok('…and it names the folder the server reads its settings from',
         new RegExp(path.basename(srv.cwd)).test(buildLine.textContent), buildLine.textContent.slice(0, 170));
      const status = window.document.getElementById('gemini-key-status').textContent;
      ok('Settings → "The Brain" shows the key\'s source', /config\/api_keys\.json/.test(status), status.slice(0, 110));
      ok('…and the model in use', new RegExp(String((await get(srv, '/api/settings/gemini-key')).body.model)).test(status), status.slice(0, 140));
      ok('…and the day\'s count in the Voice line', /Gemini calls? today/.test(buildLine.textContent) && /key 1:/.test(buildLine.textContent), buildLine.textContent.slice(-160));
      const status2 = window.document.getElementById('gemini-key2-status').textContent;
      ok('Settings → "The Brain" has the second-key line, and says none is set (optional)', /no second key set/.test(status2) && /gemini_api_key_2/.test(status2), status2.slice(0, 120));
      const callsLine = window.document.getElementById('gemini-calls-status').textContent;
      ok('…and the count line names the active key, per-key counts and the warning level', /Active key: 1/.test(callsLine) && /key 1: \d+, key 2: \d+/.test(callsLine) && /Warning level 20/.test(callsLine) && /has not stopped any key/.test(callsLine), callsLine.slice(0, 200));
      ok('…and the second-key note about a different Google account/project is on the page', /different Google account\/project/.test(window.document.body.textContent), 'note present');
      ok('…and the second-key input and its Save/Remove buttons exist', Boolean(window.document.getElementById('gemini-key2-input')) && typeof window.clearGeminiKey2 === 'function', 'input + remove');
      // Save a second key THROUGH THE PAGE, and read the page's own report.
      window.document.getElementById('gemini-key2-input').value = KEY2;
      await window.saveGeminiKey(2);
      await sleep(300);
      const status2b = window.document.getElementById('gemini-key2-status').textContent;
      ok('the page saves the second key and reports it by its last four characters', /…3210/.test(status2b) && /standing by/.test(status2b) && /config\/api_keys\.json \(gemini_api_key_2\)/.test(status2b), status2b.slice(0, 140));
      await window.clearGeminiKey2();
      await sleep(300);
      ok('…and removes it again', /no second key set/.test(window.document.getElementById('gemini-key2-status').textContent), 'removed');

      await window.runVoiceCheck();
      await sleep(300);
      const bubbles = [...window.document.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent).join('\n');
      ok('the voice check measures the brain with a real call', /Brain call: OK/.test(bubbles), (bubbles.match(/Brain call:.*/) || [''])[0].slice(0, 120));
      ok('…and prints the model in use', /answered in \d+ ms/.test(bubbles) && new RegExp(String((await get(srv, '/api/settings/gemini-key')).body.model)).test(bubbles), (bubbles.match(/Brain call:.*/) || [''])[0].slice(0, 140));
      ok('…and the key\'s source in the senses check', /config\/api_keys\.json/.test(bubbles), (bubbles.match(/Brain key:.*/) || [''])[0].slice(0, 120));
      ok('…and a failed brain names the model, not the connection', /withdrawn|key is fine|FAILED/.test(bubbles), 'checked');

      // Diagnostics still measures the brain (the button is gone from the main
      // screen — the function stays for the voice command and this check).
      window.requestSystemDiagnostics();
      await sleep(400);
      const after = [...window.document.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent).join('\n');
      ok('diagnostics still measures the brain with a real call', /Brain call: OK/.test(after), (after.match(/Brain call:.*/) || [''])[0].slice(0, 110));
    } finally { await srv.stop(); }
  }
}

/* ── 8. SPEED: the answer is written as it is spoken, without the thinking wait ─
 * Two things decide whether a spoken assistant feels instant: whether Gemini is
 * made to think before every sentence (many seconds of silence per command), and
 * whether the first words reach the page before the whole answer exists. Both are
 * measured here against the real server: the stub records what settings travelled,
 * and a websocket client watches the answer arrive in pieces.                    */
{
  const MODELS = { 'harness-fast-model': { streamText: 'The time is ten past nine', words: true } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-fast-model' }, name: 'speed' });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${TOKEN}`);
    const frames = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); setTimeout(() => reject(new Error('the websocket never opened')), 5000); });

    const requestId = 'speed-harness-1';
    const reply = await post(srv, '/api/command', { text: 'explain the difference between a latch and a flip-flop', requestId });

    const waits = Date.now() + 4000;
    while (Date.now() < waits) {
      if (frames.some((f) => f.type === 'log' && f.id === requestId && f.speaker === 'jarvis')) break;
      await sleep(50);
    }
    ws.close();

    const deltas = frames.filter((f) => f.type === 'stream' && f.id === requestId);
    const final = frames.find((f) => f.type === 'log' && f.id === requestId && f.speaker === 'jarvis');
    const userEcho = frames.find((f) => f.type === 'log' && f.id === requestId && f.speaker === 'user');

    ok('speed: the answer is announced in pieces, not in one lump', deltas.length >= 2, `${deltas.length} deltas`);
    ok('speed: the pieces grow, so the page can print the first words at once',
       deltas.length > 1 && deltas[0].text.length < deltas[deltas.length - 1].text.length,
       JSON.stringify(deltas.map((d) => d.text.length)));
    ok('speed: the first piece already holds real words', !!deltas[0] && deltas[0].text.trim().length > 2, deltas[0] && deltas[0].text);
    ok('speed: the stream is closed with done:true', deltas.some((d) => d.done === true), JSON.stringify(deltas.at(-1)));
    ok('speed: the finished reply arrives after the pieces', !!final && final.text.trim().length > 0, final && final.text);
    ok('speed: the finished reply carries the same id as the pieces', final && deltas.length > 0 && final.id === deltas[0].id, final && final.id);
    ok('speed: the spoken command is echoed back with its id', !!userEcho, JSON.stringify(userEcho || {}).slice(0, 120));
    ok('speed: the HTTP reply names the same id (one reply, two paths)',
       reply.body.id === requestId && String(reply.body.reply).trim().length > 0, JSON.stringify({ id: reply.body.id, reply: reply.body.reply }).slice(0, 120));

    const streamCall = srv.stub.calls.filter((c) => c.kind === 'stream').pop();
    // The generation decides the parameter. gemini-3.8-flash is Gemini 3, and
    // Gemini 3 deprecated thinking_budget — it wants thinking_level. Sending the
    // 2.5 parameter here is what cost a failed round trip on every reply.
    ok('speed: a Gemini 3 model gets thinkingLevel, not the deprecated thinkingBudget',
       streamCall && streamCall.thinkingLevel === 'LOW' && streamCall.thinkingBudget === undefined,
       streamCall ? `thinkingLevel=${streamCall.thinkingLevel} thinkingBudget=${streamCall.thinkingBudget}` : 'no streaming call');
    ok('speed: the answer length is capped so it is written sooner',
       streamCall && streamCall.body && streamCall.body.generationConfig && streamCall.body.generationConfig.maxOutputTokens > 0,
       streamCall ? JSON.stringify(streamCall.body.generationConfig).slice(0, 100) : 'no call');

    // A model that refuses the thinking setting must still answer — with the
    // speed settings retried away, rather than the model written off.
    const picky = await startDashboard({ models: { 'harness-picky': { rejectsThinking: true, streamText: 'Noted, sir.' } }, env: { SUPPER_TEXT_MODEL: 'harness-picky' }, name: 'picky' });
    try {
      const reply3 = await post(picky, '/api/command', { text: 'explain what a flyback diode does' });
      ok('speed: a model that refuses thinkingConfig still answers', /Noted, sir\./.test(String(reply3.body.reply)), String(reply3.body.reply).slice(0, 80));
      const refused = picky.stub.calls.filter((c) => c.kind === 'stream');
      ok('speed: …after one refusal, retried without the setting', refused.length >= 2, `${refused.length} attempts`);
    } finally { await picky.stop(); }

    // A stale Gemini 2.5 setting must be migrated before thinking options are
    // selected. The replacement is Gemini 3.8 Flash, which uses thinkingLevel.
    const old25 = await startDashboard({ models: { 'gemini-3.8-flash': { streamText: 'Noted, sir.' } }, env: { SUPPER_TEXT_MODEL: 'gemini-2.5-flash' }, name: 'old-2.5' });
    try {
      await post(old25, '/api/command', { text: 'explain what a flyback diode does' });
      const call25 = old25.stub.calls.filter((c) => c.kind === 'stream').pop();
      ok('speed: a legacy Gemini 2.5 setting is migrated before the request',
         call25 && call25.model === 'gemini-3.8-flash',
         call25 ? `model=${call25.model}` : 'no call');
      ok('speed: the migrated Gemini 3.8 request uses thinkingLevel, not thinkingBudget',
         call25 && call25.thinkingLevel === 'LOW' && call25.thinkingBudget === undefined,
         call25 ? `thinkingBudget=${call25.thinkingBudget} thinkingLevel=${call25.thinkingLevel}` : 'no call');
      ok('speed: …and it is answered on the FIRST attempt, with nothing refused',
         old25.stub.calls.filter((c) => c.kind === 'stream').length === 1,
         `${old25.stub.calls.filter((c) => c.kind === 'stream').length} attempts`);
    } finally { await old25.stop(); }

    // A model whose name gives the generation away must not pay for a guess:
    // the first reply discovers the setting, every reply after it reuses it.
    const levelOnly = await startDashboard({ models: { 'harness-level': { rejectsThinking: true, streamText: 'Noted, sir.' } }, env: { SUPPER_TEXT_MODEL: 'harness-level' }, name: 'level-only' });
    try {
      await post(levelOnly, '/api/command', { text: 'explain what a flyback diode does' });
      const firstAttempts = levelOnly.stub.calls.filter((c) => c.kind === 'stream').length;
      await post(levelOnly, '/api/command', { text: 'explain semiconductor doping briefly' });
      const totalAttempts = levelOnly.stub.calls.filter((c) => c.kind === 'stream').length;
      ok('speed: the working thinking setting is remembered, so the refusal is paid for once — not on every reply',
         firstAttempts >= 2 && totalAttempts === firstAttempts + 1,
         `first reply ${firstAttempts} attempts, second reply +${totalAttempts - firstAttempts}`);
    } finally { await levelOnly.stop(); }

    // A model that refuses to stream must still answer, in one piece.
    const noStream = await startDashboard({ models: { 'harness-no-stream': { noStream: true } }, env: { SUPPER_TEXT_MODEL: 'harness-no-stream' }, name: 'no-stream' });
    try {
      const reply2 = await post(noStream, '/api/command', { text: 'explain semiconductor doping briefly' });
      ok('speed: a model that refuses streaming still answers', /answered by harness-no-stream/.test(String(reply2.body.reply)), String(reply2.body.reply).slice(0, 80));
    } finally { await noStream.stop(); }
  } finally { await srv.stop(); }
}

/* ── 9. (The server voice used to be checked here. The voice is local now —
 *      Kokoro speaks, faster-whisper hears — and section 5d proves it never
 *      calls Gemini and never counts.)                                        */

/* ── 10. THE LOCAL KNOWLEDGE BASE — the same one the previous JARVIS used ────
 * The owner's rule: the AI is used as little as possible. A question the store
 * can answer must not reach Gemini, and an answer Gemini gives must be kept so
 * the same question is never paid for twice. The store is the SAME file the
 * Python desktop app uses (runtime/knowledge.json), in the same format — and
 * that is proved here by asking the Python module to read what the dashboard
 * wrote, and the other way round.                                        */
{
  const MODELS = { 'harness-text-model': {}, '' : {} };
  // A throwaway working directory with the real starter file symlinked in.
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'knowledge' });
  try {
    // 1. the starter answers travel with the project — no AI, no budget unit
    const starter = await post(srv, '/api/command', { text: 'how do I undo my last git commit' });
    ok('knowledge: a starter answer is given locally', /git reset --soft HEAD~1/.test(String(starter.body.reply)), String(starter.body.reply).slice(0, 90));
    ok('knowledge: …marked as an unchecked starter answer', /starter answer written by the assistant/.test(String(starter.body.reply)), String(starter.body.reply).slice(-70));
    ok('knowledge: …and Gemini was never called', !srv.stub.calls.some((c) => c.kind === 'generate' || c.kind === 'stream'), `calls=${srv.stub.calls.length}`);

    // 2. teaching an answer, and getting it back — still no AI
    const taught = await post(srv, '/api/command', { text: 'learn: what is the office wifi password = the one on the fridge, sir' });
    ok('knowledge: an answer can be taught', /Learned, sir/.test(String(taught.body.reply)), String(taught.body.reply).slice(0, 90));
    const askedBack = await post(srv, '/api/command', { text: 'what is the office wifi password' });
    ok('knowledge: the taught answer comes back at once', /fridge/.test(String(askedBack.body.reply)), String(askedBack.body.reply).slice(0, 80));
    ok('knowledge: …with no Gemini call for it', !srv.stub.calls.some((c) => c.kind === 'generate' || c.kind === 'stream'));

    const listed = await post(srv, '/api/command', { text: 'what have you learned' });
    ok('knowledge: the list names the store and the desktop app', /runtime\/knowledge\.json/.test(String(listed.body.reply)) && /desktop app/.test(String(listed.body.reply)), String(listed.body.reply).slice(0, 120));

    // 3. an unknown question goes to Gemini ONCE, and the answer is kept
    const unknown = await post(srv, '/api/command', { text: 'explain what a quantum lever is' });
    ok('knowledge: an unknown question reaches Gemini', /answered by harness-text-model/.test(String(unknown.body.reply)), String(unknown.body.reply).slice(0, 80));
    const afterFirst = srv.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').length;
    const again = await post(srv, '/api/command', { text: 'explain what a quantum lever is' });
    ok('knowledge: asking the same question again costs nothing',
       /answered by harness-text-model/.test(String(again.body.reply)) && /saved from an earlier Gemini answer/.test(String(again.body.reply)),
       String(again.body.reply).slice(-70));
    ok('knowledge: …and no second call was made', srv.stub.calls.filter((c) => c.kind === 'generate' || c.kind === 'stream').length === afterFirst,
       `${afterFirst} calls`);

    // 4. the owner's own rules: time-sensitive and personal answers are never kept
    await post(srv, '/api/command', { text: 'what is the weather in Benoni' });
    await post(srv, '/api/command', { text: 'show me my calendar for tomorrow' });
    const store = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'knowledge.json'), 'utf-8'));
    const kept = store.entries.map((e) => e.question);
    ok('knowledge: time-sensitive questions are never kept', !kept.some((q) => /weather/.test(q)), JSON.stringify(kept.slice(-4)));
    ok('knowledge: questions about the owner are never kept', !kept.some((q) => /my calendar/i.test(q)), JSON.stringify(kept.slice(-4)));

    // 5. THE SHARED BASE: the Python desktop app reads what the dashboard wrote.
    const pyRead = spawnSync('python3', ['-c',
      `import json,sys; sys.path.insert(0, ${JSON.stringify(REPO)});\n` +
      `from backend.knowledge import KnowledgeStore\n` +
      `st = KnowledgeStore(path=${JSON.stringify(path.join(srv.cwd, 'runtime', 'knowledge.json'))})\n` +
      `hit = st.lookup('what is the office wifi password')\n` +
      `print(json.dumps({'found': bool(hit), 'answer': hit['answer'] if hit else '', 'kind': hit['kind'] if hit else '', 'count': len(st.list_entries())}))`,
    ], { encoding: 'utf-8' });
    let py = {};
    try { py = JSON.parse(String(pyRead.stdout).trim().split('\n').pop()); } catch { /* reported below */ }
    ok('shared base: the Python app reads the dashboard\'s taught answer',
       py.found === true && /fridge/.test(String(py.answer)), JSON.stringify(py).slice(0, 140));
    ok('shared base: …and sees the whole store (starters included)', Number(py.count) > 30, `entries=${py.count}`);

    // 6. and the other way round: the dashboard reads what Python wrote.
    const pyWrite = spawnSync('python3', ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(REPO)});\n` +
      `from backend.knowledge import KnowledgeStore\n` +
      `st = KnowledgeStore(path=${JSON.stringify(path.join(srv.cwd, 'runtime', 'knowledge.json'))})\n` +
      `st.teach('what colour is the front door', 'Green, sir — the one with the brass handle')\n` +
      `print('written')`,
    ], { encoding: 'utf-8' });
    ok('shared base: the Python app can teach an answer', /written/.test(String(pyWrite.stdout)), String(pyWrite.stderr).slice(0, 90) || String(pyWrite.stdout).trim());
    const readBack = await post(srv, '/api/command', { text: 'what colour is the front door' });
    ok('shared base: the dashboard reads the answer the desktop app taught', /brass handle/.test(String(readBack.body.reply)), String(readBack.body.reply).slice(0, 90));

    // 7. the local-first guard: a computer task with no local tool never silently spends a call
    const before = srv.stub.calls.length;
    const task = await post(srv, '/api/command', { text: 'install a printer driver and set the default paper size' });
    ok('local first: a computer task is answered honestly, not with an AI call', /no local tool/.test(String(task.body.reply)), String(task.body.reply).slice(0, 110));
    ok('local first: …and it offers the choice instead of spending the call', /use the AI/.test(String(task.body.reply)) && srv.stub.calls.length === before,
       `calls ${before} -> ${srv.stub.calls.length}`);
    const forced = await post(srv, '/api/command', { text: 'install a printer driver and set the default paper size — use the AI' });
    ok('local first: saying "use the AI" spends exactly one call', /answered by harness-text-model/.test(String(forced.body.reply)) && srv.stub.calls.length === before + 1,
       `calls ${before} -> ${srv.stub.calls.length}`);

    // 8. reminders live on this computer
    const setOne = await post(srv, '/api/command', { text: 'remind me to call the office at four' });
    ok('local: a reminder is kept on this computer', /Kept on this computer/.test(String(setOne.body.reply)), String(setOne.body.reply).slice(0, 80));
    const readIt = await post(srv, '/api/command', { text: 'what are my reminders' });
    ok('local: …and read back without any AI', /call the office at four/.test(String(readIt.body.reply)), String(readIt.body.reply).slice(0, 90));

    // 9. the personality file is used IN FULL — the owner's conduct rules are at its end
    const log = srv.log();
    ok('personality: the personality file is loaded in full', /personality: core\/prompt\.txt \(in full\)/.test(log), (log.match(/personality:.*/) || [''])[0].slice(0, 120));
    ok('personality: repeated blocks are collapsed, not the rules dropped', /kept after removing repeated blocks/.test(log), (log.match(/kept after removing repeated blocks.*/) || [''])[0].slice(0, 80));
    ok('knowledge: the startup line reports the store', /local knowledge: \d+ answers ready/.test(log), (log.match(/local knowledge:.*/) || [''])[0].slice(0, 110));
  } finally { await srv.stop(); }
}

/* ── 11. (The voice's own Gemini budget is no longer exercised: the local voice
 *       spends nothing. See 5d.)                                              */

/* ── 12. THE LOOK AND THE LOCAL DRAFTING DESK ───────────────────────────────
 * Two things the owner asked for, proved against the real server: (a) the gold
 * glass is ONE stylesheet, served to both surfaces, with the rounded face
 * vendored in the repo so it needs no internet, the camera layer in every room,
 * and the sliders that move the glass; and (b) an email or a letter is written
 * HERE — the drafting desk must never spend a Gemini call.                    */
{
  const MODELS = { 'harness-text-model': {} };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'gold-glass' });
  try {
    // (a) the shared look
    const cssRes = await fetch(srv.url('/static/jarvis-glass.css'));
    const css = await cssRes.text();
    ok('clear glass: the shared stylesheet is served', cssRes.status === 200, `status=${cssRes.status}`);
    ok('…and it carries the vendored rounded face', /JARVIS Rounded/.test(css) && /nunito-latin-400-normal\.woff2/.test(css), 'font-face');
    ok('…and the sand-blasted pane, the gold line and the bloom', /--jg-grit/.test(css) && /backdrop-filter: blur\(var\(--jg-frost\)\)/.test(css) && /--jg-glow-size/.test(css), 'tokens');

    const fontRes = await fetch(srv.url('/static/fonts/nunito-latin-400-normal.woff2'));
    const fontBuf = Buffer.from(await fontRes.arrayBuffer());
    ok('…and the font itself is in the repo (no internet needed)', fontRes.status === 200 && fontBuf.slice(0, 4).toString('latin1') === 'wOF2',
       `status=${fontRes.status} bytes=${fontBuf.length}`);

    const page = await (await fetch(srv.url('/'))).text();
    ok('the dashboard links the shared stylesheet', page.includes('/static/jarvis-glass.css'), 'link');

    // The owner asked for the buttons that only repeat what the voice already
    // does to be gone from the main screen: mic, voice, wake, diagnostics, and
    // the two suggestion chips. This is the guard against them creeping back.
    // Only the markup matters here: the speaker button in the message row STAYS
    // (the owner turns the voice on and off with it), and dead CSS names are not
    // a button on screen.
    const leftovers = ['id="hud-mic-btn"', 'id="mic-btn"', 'id="wake-btn"', 'id="btn-wake"', 'class="sugg-chip"', 'telemetry-actions']
      .filter((needle) => page.includes(needle));
    ok('simple HUD: the mic, wake, diagnostics and suggestion buttons are gone from the main screen',
       leftovers.length === 0, leftovers.length ? `still there: ${leftovers.join(', ')}` : 'top row: My Hands, Camera, Rooms, Settings');
    ok('…but the top row still carries what is used daily',
       /id="btn-toggle-hands"/.test(page) && /id="btn-toggle-cam"/.test(page) && /toggleRooms\(\)/.test(page) && /id="btn-toggle-settings"/.test(page),
       'My Hands, Camera, Rooms, Settings');
    ok('…and the two actions the buttons carried are still there by voice',
       /function doWake\(\)/.test(page) && /function requestSystemDiagnostics\(\)/.test(page), 'doWake + diagnostics kept');

    // Importing lives in the Files window, not in the typing row.
    ok('files: the typing row has no attach button left',
       !/for="file-upload-input"/.test(page) && !/id="file-upload-input"/.test(page), 'no 📎');
    ok('files: the Files window imports files and documents',
       /id="tree-import-input"/.test(page) && /tree-import-btn/.test(page) && /function importFiles\(/.test(page), '⬆ Import');
    ok('…and files can be dropped onto that window instead',
       /function wireFileImporting\(/.test(page) && /dataTransfer\.files/.test(page) && /dragover/.test(page), 'drag & drop');
    ok('…and an import says where the file landed',
       /function showImported\(/.test(page) && /uploads\//.test(page), 'name + size + path');
    const sliders = ['rng-win-alpha', 'rng-win-sand', 'rng-panel-alpha', 'rng-panel-sand', 'rng-room-alpha', 'rng-room-sand', 'rng-gl-line', 'rng-gl-bloom'];
    const missing = sliders.filter((id) => !page.includes(`id="${id}"`));
    ok('…and every surface has its own transparency and sand-blast slider', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'windows, HUD, rooms + line + bloom');
    ok('…and the sliders drive the glass engine', page.includes("updateGlass('win','alpha'") && /function applyGlassSettings\(\)/.test(page), 'updateGlass');
    ok('…and one thin gold line / bloom pair is shared by all of them', /--jg-line/.test(page) && /--jg-glow-size/.test(page), 'shared tokens');

    const rooms = await (await fetch(srv.url('/rooms.html'))).text();
    ok('the rooms link the same stylesheet', rooms.includes('/static/jarvis-glass.css'), 'link');
    ok('…and the rooms carry the camera layer behind the glass', /id="env-camera"/.test(rooms) && /id="env-camera-scrim"/.test(rooms), 'env-camera');
    ok('…and the camera is shared from the dashboard, not captured twice', /src="camera\.js"/.test(rooms), 'camera.js');
    ok('…and the rooms keep ONE switch — Tools; the camera switch is only on the main screen',
       /id="env-tools-toggle"/.test(rooms) && !/env-cam-toggle/.test(rooms), 'rooms bar');
    const cameraJs = await (await fetch(srv.url('/rooms-src/camera.js'))).text();
    ok('…and the hand-over asks the dashboard for the picture, then falls back only if refused',
       /jarvis-rooms-hello/.test(cameraJs) && /useShared/.test(cameraJs) && /getUserMedia/.test(cameraJs) && /api\/myhands\/preview/.test(cameraJs), 'three tiers');
    ok('…and the tools stay out of the way until they are asked for', /body:not\(\.show-tools\) \.env-tools/.test(await (await fetch(srv.url('/rooms-src/styles.css'))).text()), 'simplicity');

    const design = await (await fetch(srv.url('/rooms-src/environments/design.js'))).text();
    ok('Design: the picker accepts OBJ and STL and dispatches both to real parsers',
       /fileInput\.accept = [^;]*\.obj[^;]*\.stl/.test(design) && /new OBJLoader/.test(design) && /new STLLoader/.test(design), 'OBJLoader + STLLoader');
    ok('Design: the framing call uses Three.js Box3.getCenter, not the nonexistent getCentre',
       /box\.getCenter\(/.test(design) && !/box\.getCentre\(/.test(design), 'valid bounds centre');
    ok('Design: OBJ companion materials are parsed and the vendored MTL loader is served',
       /findObjMaterialLibrary/.test(design) && /new MTLLoader/.test(design) &&
         (await fetch(srv.url('/vendor/three/loaders/MTLLoader.js'))).status === 200, 'OBJ + MTL + local texture paths');
    ok('Design: My Hands cursor is mapped to the real viewport and moves on a camera-facing drag plane',
       /mapSharedCursorToRoom/.test(design) && /frameElement/.test(design) && /ray\.intersectPlane/.test(design), 'screen-to-room ray drag');
    ok('Design: the import prompt clears away after a model is framed',
       /host\.classList\.add\("has-model"\)/.test(design) && /\.d3\.has-model \.d3-drop \{ display: none; \}/.test(await (await fetch(srv.url('/rooms-src/styles.css'))).text()), 'clear model view');

    // (b) the drafting desk: written here, never by the AI
    const before = srv.stub.calls.length;
    const draft = await post(srv, '/api/command', { text: 'draft an email to the plumber about the leaking pipe in the kitchen' });
    const reply = String(draft.body.reply);
    ok('drafting: an email is written locally, with no AI call', srv.stub.calls.length === before && /no AI, no cost/.test(reply), `calls=${srv.stub.calls.length - before}`);
    ok('…and it uses the owner\'s own words', /leaking pipe in the kitchen/.test(reply), reply.split('\n').slice(0, 4).join(' | ').slice(0, 120));
    ok('…and says which details only the owner can fill in', /square brackets/.test(reply), 'brackets');
    ok('…and the subject line comes from those words', /Subject: The leaking pipe in the kitchen/.test(reply), (reply.match(/Subject:.*/) || [''])[0]);
    ok('…and the topic is said once, not twice', (reply.match(/leaking pipe/g) || []).length === 2, `mentions=${(reply.match(/leaking pipe/g) || []).length}`);
    ok('…and an unnamed trade gets a proper greeting, not "Dear the plumber"', /Hello,|Dear Sir or Madam,/.test(reply) && !/Dear the plumber/.test(reply), (reply.match(/^(?:Hello|Dear).*/m) || [''])[0]);

    const dir = path.join(srv.cwd, 'runtime', 'drafts');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
    ok('…and it is kept as a plain file on this computer', files.length === 1, files[0] || 'nothing written');
    const written = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    ok('…and the file says the AI was not used', /no AI was used to write this/.test(written), written.split('\n')[0].slice(0, 60));
    ok('…and it is signed with the owner\'s configured name', /Mr Owner/.test(written), 'user_name from config/api_keys.json');

    const second = await post(srv, '/api/command', { text: 'write a short friendly note to Sarah thanking her for the help' });
    ok('drafting: a short friendly note keeps its shape', /Hi Sarah,/.test(String(second.body.reply)) && /Warm regards,/.test(String(second.body.reply)),
       String(second.body.reply).split('\n').slice(0, 3).join(' | ').slice(0, 110));
    ok('…and the doing-word becomes a sentence, not a name', /I am writing to thank you for the help\./.test(String(second.body.reply)),
       (String(second.body.reply).match(/I am writing.*/) || [''])[0].slice(0, 90));
    ok('…and the subject is tidied from the same words', /Re: Thanks for the help/.test(String(second.body.reply)),
       (String(second.body.reply).match(/Re:.*/) || [''])[0]);
    ok('…and it is brief when brief was asked for', !/It is about/.test(String(second.body.reply)), 'no middle paragraph');

    const list = await post(srv, '/api/command', { text: 'read my drafts' });
    ok('drafting: the drafts are listed by number', /You have 2 drafts/.test(String(list.body.reply)) && /1\. email to the plumber/.test(String(list.body.reply)), String(list.body.reply).split('\n')[1] || '');
    const read = await post(srv, '/api/command', { text: 'read draft 1' });
    ok('drafting: a draft can be read back in full', /Hello,/.test(String(read.body.reply)) && /leaking pipe/.test(String(read.body.reply)), String(read.body.reply).split('\n')[1] || '');
    const blockedDelete = await post(srv, '/api/command', { text: 'delete draft 1' });
    ok('drafting: chat/voice deletion is refused until interface confirmation',
       /will not delete draft 1/.test(String(blockedDelete.body.reply)) && fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).length === 2,
       String(blockedDelete.body.reply).slice(0, 90));
    ok('…and both plain-text drafts remain intact', fs.readdirSync(dir).some((f) => f.includes('email')) && fs.readdirSync(dir).some((f) => f.includes('note')), fs.readdirSync(dir).join(','));

    const draftingStatus = await get(srv, '/api/system-status');
    ok('drafting: the status reports the desk', draftingStatus.body.drafts && draftingStatus.body.drafts.count === 2, 'drafts.count');
    ok('…and the honest guard now points at it', /drafting desk/.test(String((await post(srv, '/api/command', { text: 'book a flight to Durban for Friday' })).body.reply)), 'no local tool message');

    // (c) the camera and the tools, by voice, for nothing
    const beforeVoice = srv.stub.calls.length;
    const camOn = await post(srv, '/api/command', { text: 'camera on' });
    ok('camera: voice turns it on, in every room, with no AI', /Camera on, sir/.test(String(camOn.body.reply)) && /every room/.test(String(camOn.body.reply)), String(camOn.body.reply).slice(0, 80));
    const camOff = await post(srv, '/api/command', { text: 'camera off' });
    ok('…and off again', /Camera off, sir/.test(String(camOff.body.reply)), String(camOff.body.reply).slice(0, 60));
    const tools = await post(srv, '/api/command', { text: 'show the tools' });
    ok('rooms: the tools come out by voice, the room stays clear', /tools for this room are out/.test(String(tools.body.reply)), String(tools.body.reply).slice(0, 80));
    const toolsAway = await post(srv, '/api/command', { text: 'hide the tools' });
    ok('…and go away again', /Tools away, sir/.test(String(toolsAway.body.reply)), String(toolsAway.body.reply).slice(0, 60));
    ok('…and none of those four cost a call', srv.stub.calls.length === beforeVoice, `calls=${srv.stub.calls.length - beforeVoice}`);
  } finally { await srv.stop(); }
}

/* ── 13. (The Gemini voice model's retirement rules no longer apply: the voice
 *       is local. See 5d.)                                                    */

/* ── 14. A STORED ANSWER FROM ANOTHER MODEL NEVER ANSWERS SILENTLY ───────────
 * Every Gemini answer is kept with the model that produced it. An entry with no
 * record of its model (everything written before that existed) or from a different
 * model is stale: the model is asked first, and only if it cannot be reached are the
 * stored words used — said plainly to be out of date. Replacing one archives it.  */
{
  const question = 'what is a bloom filter';
  const legacy = (answer) => JSON.stringify({
    version: 1, next_id: 2,
    entries: [{ id: 1, kind: 'gemini', key: '', question, keywords: ['bloom', 'filter'], answer,
      created: '2026-01-01T00:00:00', last_used: '', uses: 0, expires: '' }],
    archive: [],
  });

  // (a) an answer kept from the model IN USE still answers directly, with no call
  const freshStore = JSON.stringify({
    version: 2, next_id: 2,
    entries: [{ id: 1, kind: 'gemini', key: '', question, keywords: ['bloom', 'filter'],
      answer: 'A space-saving set test, kept from the current model.', created: '2026-10-01T00:00:00',
      last_used: '', uses: 0, expires: '',
      provenance: { schema: 2, source: 'gemini', model: 'harness-text-model', recorded: '2026-10-01T00:00:00' } }],
    archive: [],
  });
  const fresh = await startDashboard({ models: { 'harness-text-model': {} },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'knowledge-fresh',
    files: { 'runtime/knowledge.json': freshStore } });
  try {
    const before = fresh.stub.calls.length;
    const reply = String((await post(fresh, '/api/command', { text: question })).body.reply);
    ok('fresh stored answer: still answered locally, with no Gemini call',
       /kept from the current model/.test(reply) && fresh.stub.calls.length === before, `calls=${fresh.stub.calls.length - before}`);
  } finally { await fresh.stop(); }

  // (b) a version 1 entry (no provenance): the current model answers, and the store is updated
  const stale = await startDashboard({ models: { 'harness-text-model': {} },
    env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'knowledge-stale',
    files: { 'runtime/knowledge.json': legacy('An old answer, kept before models were recorded.') } });
  try {
    const reply = String((await post(stale, '/api/command', { text: question })).body.reply);
    ok('stale stored answer: the current model is asked, not the old answer',
       /answered by harness-text-model/.test(reply), reply.slice(0, 90));
    const store = JSON.parse(fs.readFileSync(path.join(stale.cwd, 'runtime', 'knowledge.json'), 'utf-8'));
    const gemini = store.entries.filter((e) => e.kind === 'gemini');
    ok('stale stored answer: the fresh one records the model that made it',
       store.version === 2 && gemini.length === 1 && gemini[0].provenance && gemini[0].provenance.model === 'harness-text-model',
       JSON.stringify({ version: store.version, model: gemini[0] && gemini[0].provenance && gemini[0].provenance.model }));
    ok('stale stored answer: the superseded words are archived, not deleted',
       store.archive.length === 1 && /superseded by harness-text-model/.test(String(store.archive[0].archive_reason)),
       JSON.stringify(store.archive.map((a) => [a.answer.slice(0, 30), a.archive_reason])));
  } finally { await stale.stop(); }

  // (c) with no key the stored words ARE used — and labelled as not re-checked
  const offline = await startDashboard({ models: { 'harness-text-model': {} }, writeConfigFile: false,
    name: 'knowledge-offline', files: { 'runtime/knowledge.json': legacy('An old answer, kept before models were recorded.') } });
  try {
    const reply = String((await post(offline, '/api/command', { text: question })).body.reply);
    ok('offline stored answer: the saved words still help with no key',
       /An old answer, kept before models were recorded\./.test(reply), reply.slice(0, 90));
    ok('offline stored answer: …and are labelled out of date, with the model that made them named as unrecorded',
       /could not be reached just now/.test(reply) && /no longer records/.test(reply), reply.slice(-140));
  } finally { await offline.stop(); }
}

/* ── summary ─────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
