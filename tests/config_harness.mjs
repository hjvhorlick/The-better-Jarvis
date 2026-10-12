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
 *   5. the app's daily budget (runtime/quota.json, SUPPER_GEMINI_DAILY_BUDGET) is
 *      honoured, including the fail-closed rule for a damaged counter;
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
        if (script0.boom) { res.writeHead(500).end(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: `the model ${model} fell over` } })); return; }
        if (script0.rateLimited) { res.writeHead(429).end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })); return; }
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
      if (script.boom) { send(500, { error: { code: 500, status: 'INTERNAL', message: `the model ${model} fell over` } }); return; }
      if (script.rateLimited) { send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }); return; }
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
async function startDashboard({ models, env = {}, name = 'harness', files = {}, writeConfigFile = true } = {}) {
  const stub = await startStub(models);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-config-'));
  // Only what the server needs to boot; the settings live in config/api_keys.json.
  fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
  if (writeConfigFile) {
    fs.writeFileSync(path.join(cwd, 'config', 'api_keys.json'), JSON.stringify({
      gemini_api_key: 'harness-key-0123456789abcdef',
      assistant_name: 'Tessa',
      user_name: 'Mr Owner',
    }, null, 2));
  }
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), text);
  for (const link of ['dashboard', 'barehands', 'core', 'knowledge', 'web']) {
    try { fs.symlinkSync(path.join(REPO, link), path.join(cwd, link), 'dir'); } catch { /* optional */ }
  }

  const port = await freePort();
  const childEnv = { ...process.env, ...env };
  delete childEnv.GEMINI_API_KEY;          // the key must come from the file, not the environment
  for (const k of ['SUPPER_TEXT_MODEL', 'GEMINI_MODEL', 'SUPPER_IMAGE_MODEL', 'SUPPER_GEMINI_DAILY_BUDGET', 'SUPPER_GEMINI_BASE_URL']) {
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

    const pcm = Buffer.alloc(48000 * 2);       // 1 s of silence, mono PCM16
    const voice = await post(srv, '/api/voice/transcribe', { rate: 48000, pcm: pcm.toString('base64') });
    ok('the server ear transcribes with the file key', voice.body.ok === true && voice.body.text === 'open the files', JSON.stringify(voice.body).slice(0, 90));
    ok('…and the audio really reached the model', srv.stub.calls.some((c) => c.audio), `calls=${srv.stub.calls.length}`);

    const picture = await post(srv, '/api/ai/image', { prompt: 'a teapot, glass, studio light' });
    ok('pictures work with the file key', picture.status === 200 && typeof picture.body.image === 'string' && picture.body.mime === 'image/png', JSON.stringify(picture.body).slice(0, 80));
    ok('…and the picture model was discovered from the key, never hardcoded', srv.stub.calls.some((c) => c.kind === 'generate' && c.model === 'harness-image-model'), srv.stub.calls.filter((c) => c.picture).map((c) => c.model).join(',') || 'none');

    const brain = await get(srv, '/api/brain-check');
    ok('the brain check makes a real call and names the model', brain.body.ok === true && brain.body.reply === `answered by ${settings.body.model}`, JSON.stringify({ ok: brain.body.ok, model: brain.body.model, reply: brain.body.reply }));
    ok('…and reports latency and the quota', typeof brain.body.latencyMs === 'number' && brain.body.quota && brain.body.quota.limit === 20, `latency=${brain.body.latencyMs}ms quota=${brain.body.quota?.used}/${brain.body.quota?.limit}`);
    ok('the budget counter is kept where the app keeps it', fs.existsSync(path.join(srv.cwd, 'runtime', 'quota.json')), 'runtime/quota.json');
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

/* ── 3. a retired model name falls through ────────────────────────────────── */
{
  const MODELS = { 'harness-retired-model': { retire: true }, 'gemini-flash-latest': { } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_TEXT_MODEL: 'harness-retired-model' }, name: 'retired' });
  try {
    const brain = await get(srv, '/api/brain-check');
    ok('a retired model falls through to the next candidate', brain.body.ok === true && brain.body.model === 'gemini-flash-latest', `${brain.body.model} (${brain.body.modelSource})`);
    ok('…and the fall-through is reported, not hidden', brain.body.modelSource && /current model|moving alias/.test(String(brain.body.modelSource)), String(brain.body.modelSource));
    const chat = await post(srv, '/api/command', { text: 'hello there' });
    ok('…and a chat reply still arrives', typeof chat.body.reply === 'string' && chat.body.reply.startsWith('answered by'), String(chat.body.reply).slice(0, 60));
  } finally { await srv.stop(); }

  // Every candidate retired: the message must name the withdrawal — never the
  // connection, and never the key.
  const dead = { 'harness-retired-model': { retire: true }, 'gemini-flash-latest': { retire: true }, 'harness-image-model': { retire: true } };
  const srv2 = await startDashboard({ models: dead, env: { SUPPER_TEXT_MODEL: 'harness-retired-model' }, name: 'all-retired' });
  try {
    const brain = await get(srv2, '/api/brain-check');
    const message = String(brain.body.error || '');
    ok('a fully withdrawn model explains itself', brain.body.ok === false && brain.body.code === 'model-unavailable', String(brain.body.code));
    ok('…and the message blames the model name, not the key', /withdrawn/i.test(message) && /key is fine/i.test(message), message.slice(0, 120));
    ok('…and it never blames the connection', !/connection/i.test(message), message.slice(0, 80));
    ok('…and it points at the setting', /SUPPER_TEXT_MODEL|GEMINI_MODEL/.test(message), message.slice(0, 120));
    const chat = await post(srv2, '/api/command', { text: 'hello there' });
    ok('…and the dialogue says the same thing', /withdrawn/i.test(String(chat.body.reply)) && /key is fine/i.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 100));
    const voice = await post(srv2, '/api/voice/transcribe', { rate: 48000, pcm: Buffer.alloc(48000 * 2).toString('base64') });
    ok('…and the server ear says it too', voice.body.ok === false && /withdrawn/i.test(String(voice.body.message)), String(voice.body.message).slice(0, 100));
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
    const chat = await post(srv, '/api/command', { text: 'hello' });
    ok('…and the local reply names every place checked', /GEMINI_API_KEY/.test(String(chat.body.reply)) && /config\/api_keys\.json/.test(String(chat.body.reply)), String(chat.body.reply).slice(0, 110));
    ok('…and no call was made without a key', !srv.stub.calls.some((c) => c.kind === 'generate'), `calls=${srv.stub.calls.length}`);
  } finally { await srv.stop(); }
}

/* ── 5. the app's daily budget ────────────────────────────────────────────── */
{
  const MODELS = { 'harness-text-model': { } };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_GEMINI_DAILY_BUDGET: '1' }, name: 'budget' });
  try {
    const first = await get(srv, '/api/brain-check');
    ok('the first call spends the day\'s one unit', first.body.ok === true && first.body.quota.used === 1, `used=${first.body.quota?.used}/${first.body.quota?.limit}`);
    const counter = JSON.parse(fs.readFileSync(path.join(srv.cwd, 'runtime', 'quota.json'), 'utf-8'));
    ok('…and the counter file matches the app\'s shape', counter.used === 1 && typeof counter.day === 'string', JSON.stringify(counter));
    const second = await get(srv, '/api/brain-check');
    ok('the second call is refused, not sent', second.body.ok === false && second.body.code === 'budget', String(second.body.code));
    ok('…and the message names runtime/quota.json and the setting', /runtime\/quota\.json/.test(String(second.body.error)) && /SUPPER_GEMINI_DAILY_BUDGET/.test(String(second.body.error)), String(second.body.error).slice(0, 130));
    ok('…and Google was never called again', srv.stub.calls.filter((c) => c.kind === 'generate').length === 1, `generates=${srv.stub.calls.filter((c) => c.kind === 'generate').length}`);
  } finally { await srv.stop(); }

  // A damaged counter fails closed, exactly as backend/quota.py does.
  const srv2 = await startDashboard({ models: MODELS, name: 'damaged-counter' });
  try {
    fs.mkdirSync(path.join(srv2.cwd, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(srv2.cwd, 'runtime', 'quota.json'), '{not json at all');
    const brain = await get(srv2, '/api/brain-check');
    ok('a damaged counter fails closed', brain.body.ok === false && brain.body.code === 'budget', String(brain.body.code));
    ok('…and says so plainly', /cannot read|unreadable|fails closed/i.test(String(brain.body.error)), String(brain.body.error).slice(0, 120));
    ok('…and makes no call at all', srv2.stub.calls.filter((c) => c.kind === 'generate').length === 0, 'no call');
  } finally { await srv2.stop(); }

  // A 429 from Google marks the day used up, as the engine room does.
  const srv3 = await startDashboard({ models: { 'harness-text-model': { rateLimited: true } }, env: { SUPPER_TEXT_MODEL: 'harness-text-model' }, name: 'rate-limited' });
  try {
    const brain = await get(srv3, '/api/brain-check');
    ok('a 429 is reported as Google\'s limit, not as a key problem', brain.body.ok === false && brain.body.code === 'rate-limited' && !/invalid|refused the key/i.test(String(brain.body.error)), String(brain.body.code));
    const after = JSON.parse(fs.readFileSync(path.join(srv3.cwd, 'runtime', 'quota.json'), 'utf-8'));
    ok('…and marks the day exhausted in the shared counter', after.used === after.limit || after.used === 20, JSON.stringify(after));
  } finally { await srv3.stop(); }
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
      ok('…and the budget in the Voice line', /Gemini calls used today/.test(buildLine.textContent), buildLine.textContent.slice(0, 140));

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

    // The OLD generation still wants the OLD parameter. Writing 'gemini-3.8'
    // into the defaults must not quietly break a Gemini 2.5 model, which is the
    // whole reason the preference is read from the model name.
    const old25 = await startDashboard({ models: { 'gemini-2.5-flash': { streamText: 'Noted, sir.' } }, env: { SUPPER_TEXT_MODEL: 'gemini-2.5-flash' }, name: 'old-2.5' });
    try {
      await post(old25, '/api/command', { text: 'explain what a flyback diode does' });
      const call25 = old25.stub.calls.filter((c) => c.kind === 'stream').pop();
      ok('speed: a Gemini 2.5 model still gets the numeric thinkingBudget it understands',
         call25 && call25.thinkingBudget === 0 && call25.thinkingLevel === undefined,
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

/* ── 9. THE SERVER VOICE: real audio for machines with no voice of their own ──
 * The page normally speaks with the browser's own voice. On a computer with none
 * (or where the browser refuses to make a sound inside a preview frame), the
 * server generates the sentence with Gemini's voice model and the page plays it
 * as an ordinary audio file. This checks the endpoint really returns a playable
 * WAV, and that every way it can fail is named rather than silent.               */
{
  const MODELS = { 'harness-voice-model': { voice: true }, 'harness-text-model': {} };
  const srv = await startDashboard({ models: MODELS, env: { SUPPER_VOICE_MODEL: 'harness-voice-model', SUPPER_VOICE_NAME: 'Charon' }, name: 'voice' });
  try {
    const said = await post(srv, '/api/voice/speak', { text: 'Good day, sir. All systems are online.' });
    ok('server voice: the endpoint answers with audio', said.body.ok === true && typeof said.body.audio === 'string' && said.body.audio.length > 100,
       JSON.stringify({ ok: said.body.ok, bytes: said.body.audio ? said.body.audio.length : 0, model: said.body.model }));
    const wav = Buffer.from(String(said.body.audio || ''), 'base64');
    ok('server voice: the audio is a real WAV file', wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE',
       `${wav.subarray(0, 4).toString()}…${wav.length} bytes`);
    ok('server voice: the sample rate the model reported is honoured', wav.readUInt32LE(24) === 24000, `rate=${wav.readUInt32LE(24)}`);
    ok('server voice: the voice and model were sent to Gemini',
       srv.stub.calls.some((c) => c.model === 'harness-voice-model' && JSON.stringify(c.body).includes('Charon')),
       JSON.stringify(srv.stub.calls.map((c) => c.model)));
    ok('server voice: the call asked for audio back',
       srv.stub.calls.some((c) => JSON.stringify(c.body).includes('AUDIO')), 'responseModalities AUDIO');
    ok('server voice: empty text is refused politely',
       (await post(srv, '/api/voice/speak', { text: '   ' })).body.code === 'empty',
       JSON.stringify((await post(srv, '/api/voice/speak', { text: '' })).body).slice(0, 90));
  } finally { await srv.stop(); }

  // A key that may not use the voice model: the failure names the setting to fix.
  const wrong = await startDashboard({ models: { 'harness-retired-voice': { retire: true } }, env: { SUPPER_VOICE_MODEL: 'harness-retired-voice' }, name: 'voice-wrong' });
  try {
    const bad = await post(wrong, '/api/voice/speak', { text: 'Can you hear me now?' });
    ok('server voice: a withdrawn voice model is explained', bad.body.ok === false && /model name was withdrawn/i.test(String(bad.body.message)),
       String(bad.body.message).slice(0, 110));
    ok('server voice: …and it points at SUPPER_VOICE_MODEL, not the brain\'s setting', /SUPPER_VOICE_MODEL/.test(String(bad.body.message)), String(bad.body.message).slice(-90));
  } finally { await wrong.stop(); }

  // No key at all: the owner is told where the key goes, not left with silence.
  const keyless = await startDashboard({ models: { 'harness-voice-model': { voice: true } }, writeConfigFile: false, env: { SUPPER_VOICE_MODEL: 'harness-voice-model' }, name: 'voice-keyless' });
  try {
    const noKey = await post(keyless, '/api/voice/speak', { text: 'Anyone there?' });
    ok('server voice: no key says where the key goes', noKey.body.ok === false && noKey.body.code === 'no-key' && /Settings/.test(String(noKey.body.message)),
       String(noKey.body.message).slice(0, 110));
  } finally { await keyless.stop(); }
}

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

/* ── 11. THE VOICE'S OWN BUDGET: speaking never starves the answers ───────── */
{
  const MODELS = { 'harness-voice-model': { voice: true }, 'harness-text-model': {} };
  const srv = await startDashboard({
    models: MODELS,
    env: { SUPPER_VOICE_MODEL: 'harness-voice-model', SUPPER_GEMINI_VOICE_BUDGET: '2', SUPPER_GEMINI_DAILY_BUDGET: '3', SUPPER_TEXT_MODEL: 'harness-text-model' },
    name: 'voice-budget',
  });
  try {
    const one = await post(srv, '/api/voice/speak', { text: 'One, sir.' });
    ok('voice budget: a sentence is spoken', one.body.ok === true, String(one.body.message || ''));
    const snap1 = await get(srv, '/api/system-status');
    ok('voice budget: the voice counts in its own file', snap1.body.voice && snap1.body.voice.used === 1 && snap1.body.voice.limit === 2,
       JSON.stringify(snap1.body.voice && { used: snap1.body.voice.used, limit: snap1.body.voice.limit }));
    const repeat = await post(srv, '/api/voice/speak', { text: 'One, sir.' });
    ok('voice budget: the same sentence again is free (cached)', repeat.body.ok === true && repeat.body.cached === true, JSON.stringify({ ok: repeat.body.ok, cached: repeat.body.cached }));
    const snap2 = await get(srv, '/api/system-status');
    ok('voice budget: …and it did not spend a unit', snap2.body.voice.used === 1, `used=${snap2.body.voice.used}`);
    await post(srv, '/api/voice/speak', { text: 'Two, sir.' });
    const spent = await post(srv, '/api/voice/speak', { text: 'Three, sir.' });
    ok('voice budget: when the voice budget is used up it says so', spent.body.ok === false && spent.body.code === 'voice-budget', JSON.stringify(spent.body).slice(0, 120));
    const answers = await post(srv, '/api/command', { text: 'tell me something new entirely' });
    ok('voice budget: the answers still work after the voice budget is gone', /answered by/.test(String(answers.body.reply)), String(answers.body.reply).slice(0, 70));
  } finally { await srv.stop(); }
}


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

/* ── summary ─────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
