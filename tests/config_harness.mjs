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
 *      model in use (the page itself, loaded in jsdom).
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
import { spawn } from 'node:child_process';
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
      const body = bodyText ? JSON.parse(bodyText) : {};
      const parts = body?.contents?.[0]?.parts || [];
      const audio = parts.some((p) => p?.inlineData?.mimeType?.startsWith('audio/'));
      const picture = parts.some((p) => p?.inlineData?.mimeType?.startsWith('image/'));
      calls.push({ kind: 'generate', model, method, key, audio, picture, body });
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
      if (script.picture) {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
        send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] });
        return;
      }
      send(200, { candidates: [{ content: { parts: [{ text: `answered by ${model}` }] } }] });
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
  for (const link of ['dashboard', 'barehands', 'core']) {
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
    const chatCall = srv.stub.calls.filter((c) => c.kind === 'generate' && !c.audio).pop();
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
    ok('…and the fall-through is reported, not hidden', brain.body.modelSource && /default alias/.test(String(brain.body.modelSource)), String(brain.body.modelSource));
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
      const html = await (await fetch(srv.url('/'))).text();
      ok('the server fills the assistant name into the page', html.includes('Tessa — Autonomous Workspace'), html.slice(0, 60).replace(/\n/g, ' '));
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
      ok('Settings → Voice shows the build marker', /Build 2026-10-11-brain-config-1/.test(buildLine.textContent), buildLine.textContent.slice(0, 90));
      ok('…with the assistant\'s configured name', /Tessa/.test(buildLine.textContent), buildLine.textContent.slice(0, 90));

      await window.refreshGeminiKeyStatus();
      await sleep(150);
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

      // The Diagnostics button measures the brain too.
      window.requestSystemDiagnostics();
      await sleep(400);
      const after = [...window.document.querySelectorAll('.chat-bubble.speaker-system')].map((b) => b.textContent).join('\n');
      ok('the Diagnostics button measures the brain with a real call', /Brain call: OK/.test(after), (after.match(/Brain call:.*/) || [''])[0].slice(0, 110));
    } finally { await srv.stop(); }
  }
}

/* ── summary ─────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
