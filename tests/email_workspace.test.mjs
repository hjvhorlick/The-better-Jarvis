import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DraftDesk,
  composeDraft,
  emailFieldsFromDraft,
  parseDraftRequest,
  parseEmailDraftEdit,
} from '../drafts.ts';
import emailRoom from '../web/environments/email.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'jarvis-live-session-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const tempDir = (prefix = 'jarvis-email-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function basicEmail(overrides = {}) {
  return {
    to: 'alex@example.com', cc: 'team@example.com', bcc: '',
    subject: 'Friday plan', body: 'Please confirm Friday.\n\n[Add the time.]', ...overrides,
  };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('local Email draft lifecycle preserves fields and the stable ID', () => {
  const dir = tempDir();
  try {
    const desk = new DraftDesk(dir);
    assert.deepEqual(desk.load(), []);
    const createdAt = new Date('2026-10-01T10:00:00.000Z');
    const first = desk.createEmail(basicEmail(), 'Owner', createdAt);
    assert.equal(first.id, 1);
    assert.equal(first.kind, 'email');
    assert.deepEqual(emailFieldsFromDraft(first), basicEmail());
    assert.ok(fs.existsSync(path.join(dir, 'index.json')));
    assert.match(fs.readFileSync(path.resolve(first.file), 'utf8'), /Last edited:/);

    const editedAt = new Date('2026-10-02T12:34:00.000Z');
    const edited = desk.updateEmailDraft(first.id, { subject: 'Updated plan', bcc: 'private@example.com' }, 'Owner', editedAt);
    assert.ok(edited);
    assert.equal(edited.id, first.id);
    assert.equal(edited.created, first.created);
    assert.equal(edited.updated, editedAt.toISOString());
    assert.deepEqual(emailFieldsFromDraft(edited), {
      ...basicEmail(), subject: 'Updated plan', bcc: 'private@example.com',
    });
    const textFile = fs.readFileSync(path.resolve(edited.file), 'utf8');
    assert.match(textFile, /Cc: team@example.com/);
    assert.match(textFile, /Bcc: private@example.com/);
    assert.match(textFile, /Subject: Updated plan/);
    assert.match(textFile, /Please confirm Friday/);

    const duplicate = desk.duplicateEmail(first.id, 'Owner', new Date('2026-10-03T00:00:00.000Z'));
    assert.ok(duplicate);
    assert.equal(duplicate.id, 2);
    assert.notEqual(duplicate.id, first.id);
    assert.deepEqual(emailFieldsFromDraft(duplicate), emailFieldsFromDraft(edited));

    const reloaded = new DraftDesk(dir);
    const stored = reloaded.load();
    assert.equal(stored.length, 2);
    assert.equal(reloaded.getEmail(first.id)?.subject, 'Updated plan');
    assert.equal(reloaded.searchEmailDrafts('private@example.com').length, 2);
    assert.equal(reloaded.searchEmailDrafts('time.').length, 2);
    assert.equal(reloaded.searchEmailDrafts('not present').length, 0);

    const deleted = reloaded.forget(duplicate.id);
    assert.equal(deleted?.id, duplicate.id);
    assert.equal(fs.existsSync(path.resolve(duplicate.file)), false);
    assert.equal(reloaded.getEmail(duplicate.id), null);
  } finally { cleanup(dir); }
});

test('old drafting-desk email, note and letter records remain readable and editable', () => {
  const dir = tempDir();
  try {
    const desk = new DraftDesk(dir);
    desk.load();
    const request = parseDraftRequest('draft an email to Alex about the Friday plan');
    assert.ok(request);
    const oldText = composeDraft(request, 'Owner', new Date('2026-10-01T00:00:00.000Z'));
    const legacyEmail = desk.keep(request, oldText, 'Owner', new Date('2026-10-01T00:00:00.000Z'));
    const fields = emailFieldsFromDraft(legacyEmail);
    assert.equal(fields.to, request.to);
    assert.equal(fields.subject, request.subject);
    assert.ok(fields.body.trim().length > 0);
    assert.ok(!fields.body.startsWith('To:'));
    const changed = desk.updateEmailDraft(legacyEmail.id, { subject: 'New wording from owner' }, 'Owner');
    assert.equal(changed?.id, legacyEmail.id);
    assert.equal(changed?.subject, 'New wording from owner');

    const noteReq = {
      kind: 'note', to: 'Sam', topic: 'thanks', subject: '', tone: 'friendly', brief: true,
    };
    const note = desk.keep(noteReq, 'Thanks, Sam.', 'Owner');
    assert.equal(note.kind, 'note');
    assert.equal(desk.getEmail(note.id), null);
    assert.match(fs.readFileSync(path.resolve(note.file), 'utf8'), /Thanks, Sam\./);
    assert.equal(desk.list().length, 2);
  } finally { cleanup(dir); }
});

test('invalid IDs and unsafe index paths cannot read, update or delete outside drafts', () => {
  const dir = tempDir();
  const outside = path.join(dir, 'outside.txt');
  const draftDir = path.join(dir, 'drafts');
  fs.mkdirSync(draftDir);
  fs.writeFileSync(outside, 'untouched sentinel');
  const malicious = {
    id: 7, kind: 'email', to: '', subject: '', text: 'body', body: 'body',
    file: outside, created: new Date().toISOString(), updated: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(draftDir, 'index.json'), JSON.stringify([malicious]));
  try {
    const desk = new DraftDesk(draftDir);
    desk.load();
    assert.equal(desk.getEmail(0), null);
    assert.equal(desk.getEmail(-1), null);
    assert.equal(desk.getEmail(Number.MAX_SAFE_INTEGER + 1), null);
    assert.equal(desk.updateEmailDraft(0, { body: 'x' }), null);
    assert.equal(desk.forget(0), null);
    assert.throws(() => desk.updateEmailDraft(7, { body: 'changed' }), /outside the local drafts folder/);
    assert.throws(() => desk.forget(7), /outside the local drafts folder/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched sentinel');
    assert.equal(desk.getEmail(7)?.body, 'body');

    const linkPath = path.join(draftDir, 'linked.txt');
    fs.symlinkSync(outside, linkPath);
    malicious.file = linkPath;
    fs.writeFileSync(path.join(draftDir, 'index.json'), JSON.stringify([malicious]));
    const linkedDesk = new DraftDesk(draftDir);
    linkedDesk.load();
    assert.throws(() => linkedDesk.forget(7), /regular file/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched sentinel');

    assert.deepEqual(parseEmailDraftEdit('set subject of draft 7 to Revised'), {
      id: 7, field: 'subject', value: 'Revised', mode: 'set',
    });
    assert.deepEqual(parseEmailDraftEdit('append Add a time to body of draft 7'), {
      id: 7, field: 'body', value: 'Add a time', mode: 'append',
    });
    assert.equal(parseEmailDraftEdit('set subject of draft 0 to Bad'), null);
  } finally { cleanup(dir); }
});

test('malformed and partially invalid indexes are preserved before recovery', () => {
  const dir = tempDir();
  try {
    const index = path.join(dir, 'index.json');
    const damaged = '{not valid json';
    fs.writeFileSync(index, damaged);
    const desk = new DraftDesk(dir);
    assert.deepEqual(desk.load(), []);
    const backup = fs.readdirSync(dir).find((name) => name.startsWith('index.json.bad-'));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), damaged);
    const created = desk.createEmail(basicEmail(), 'Owner');
    assert.equal(created.id, 1);
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), damaged);

    const other = path.join(dir, 'partial');
    fs.mkdirSync(other);
    const valid = { ...created, id: 4, file: path.resolve(created.file) };
    const invalid = { ...created, id: 0 };
    fs.writeFileSync(path.join(other, 'index.json'), JSON.stringify([valid, invalid]));
    const recovery = new DraftDesk(other);
    assert.equal(recovery.load().length, 1);
    assert.ok(fs.readdirSync(other).some((name) => name.startsWith('index.json.recovered-')));
  } finally { cleanup(dir); }
});

test('failed index writes report failure and roll back both new and edited content', () => {
  const dir = tempDir();
  try {
    const desk = new DraftDesk(dir);
    desk.load();
    const original = desk.createEmail(basicEmail(), 'Owner');
    const indexBefore = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const textBefore = fs.readFileSync(path.resolve(original.file), 'utf8');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function (file, ...args) {
      if (String(file).startsWith(path.join(dir, '.index.'))) throw new Error('simulated index failure');
      return originalWrite.call(fs, file, ...args);
    };
    try {
      assert.throws(() => desk.createEmail(basicEmail({ subject: 'Should roll back' }), 'Owner'), /simulated index failure/);
      assert.throws(() => desk.updateEmailDraft(original.id, { body: 'Should roll back' }, 'Owner'), /simulated index failure/);
    } finally { fs.writeFileSync = originalWrite; }

    assert.equal(desk.list().length, 1);
    assert.equal(desk.getEmail(original.id)?.subject, 'Friday plan');
    assert.equal(desk.getEmail(original.id)?.body, basicEmail().body);
    assert.equal(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), indexBefore);
    assert.equal(fs.readFileSync(path.resolve(original.file), 'utf8'), textBefore);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.txt')).length, 1);
  } finally { cleanup(dir); }
});

test('mailto handoff encodes addresses, header delimiters, Unicode and body line breaks', async () => {
  const { mailtoForEmailDraft } = await import('../web/environments/email.js');
  const url = mailtoForEmailDraft({
    to: 'alex+work@example.com, team@example.com',
    cc: 'copy@example.com', bcc: 'hidden@example.com',
    subject: 'Plan & café? #2', body: 'Line one\nLine two & done',
  });
  assert.equal(url, 'mailto:alex%2Bwork%40example.com,team%40example.com?cc=copy%40example.com&bcc=hidden%40example.com&subject=Plan%20%26%20caf%C3%A9%3F%20%232&body=Line%20one%0ALine%20two%20%26%20done');
  assert.ok(!url.toLowerCase().includes('<script'));
  assert.match(url, /^mailto:/);
  assert.throws(() => mailtoForEmailDraft({ subject: 'Subject\r\nBcc: inject@example.com' }), /single-line/);
});

function jsonHeaders() {
  return { ...auth, 'Content-Type': 'application/json' };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startDashboard() {
  const cwd = tempDir('jarvis-email-server-');
  fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
  for (const link of ['dashboard', 'barehands', 'core', 'knowledge', 'web']) {
    fs.symlinkSync(path.join(ROOT, link), path.join(cwd, link), 'dir');
  }
  const port = await freePort();
  const env = { ...process.env, SUPPER_DASHBOARD_PORT: String(port), SUPPER_DRAFTS_DIR: path.join(cwd, 'runtime', 'drafts') };
  delete env.GEMINI_API_KEY;
  delete env.SUPPER_TEXT_MODEL;
  delete env.GEMINI_MODEL;
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'server.ts')], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let tries = 0; tries < 100; tries++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/email/drafts`, { headers: auth });
      if (response.ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await delay(100);
  }
  if (!ready) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    cleanup(cwd);
    throw new Error(`Dashboard test server did not start.\n${log}`);
  }
  return {
    cwd, base, child, get log() { return log; },
    async stop() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      cleanup(cwd);
    },
  };
}

async function request(server, route, method = 'GET', body, authenticated = true) {
  const headers = authenticated ? { ...auth } : {};
  const options = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${server.base}${route}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('authenticated Email API lifecycle, typed/voice command routing and no-send behavior', async () => {
  const server = await startDashboard();
  try {
    assert.equal((await request(server, '/api/email/drafts', 'GET', undefined, false)).status, 401);
    assert.equal((await request(server, '/api/email/drafts', 'POST', basicEmail(), false)).status, 401);
    const roomScript = await fetch(`${server.base}/rooms-src/environments/email.js`);
    const roomStyles = await fetch(`${server.base}/rooms-src/environments/email.css`);
    assert.equal(roomScript.status, 200);
    assert.equal(roomStyles.status, 200);
    assert.match(await roomScript.text(), /export function mailtoForEmailDraft/);
    assert.match(await roomStyles.text(), /\.email-workspace-grid/);

    const created = await request(server, '/api/email/drafts', 'POST', basicEmail());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.draft.id;
    assert.equal(id, 1);
    assert.equal(created.body.draft.bcc, '');

    const get = await request(server, `/api/email/drafts/${id}`);
    assert.equal(get.status, 200);
    assert.deepEqual(
      { to: get.body.draft.to, cc: get.body.draft.cc, bcc: get.body.draft.bcc, subject: get.body.draft.subject, body: get.body.draft.body },
      basicEmail(),
    );

    const searched = await request(server, '/api/email/drafts?q=Friday');
    assert.equal(searched.status, 200);
    assert.equal(searched.body.drafts.length, 1);
    assert.equal((await request(server, '/api/email/drafts?q=absent')).body.drafts.length, 0);

    const edited = await request(server, `/api/email/drafts/${id}`, 'PUT', { subject: 'Revised plan', body: 'Please confirm Saturday.' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.draft.id, id);
    assert.equal(edited.body.draft.to, basicEmail().to);
    assert.equal(edited.body.draft.cc, basicEmail().cc);
    assert.equal(edited.body.draft.subject, 'Revised plan');
    assert.equal(edited.body.draft.body, 'Please confirm Saturday.');

    const duplicate = await request(server, `/api/email/drafts/${id}/duplicate`, 'POST', {});
    assert.equal(duplicate.status, 201);
    assert.notEqual(duplicate.body.draft.id, id);
    assert.equal(duplicate.body.draft.body, edited.body.draft.body);

    for (const badId of ['0', '-1', 'not-an-id', '9007199254740992']) {
      assert.equal((await request(server, `/api/email/drafts/${badId}`)).status, 400, badId);
    }
    assert.equal((await request(server, '/api/email/drafts/9999')).status, 404);
    assert.equal((await request(server, `/api/email/drafts/${id}`, 'PUT', { to: 'valid@example.com\nBcc: injected@example.com' })).status, 400);
    assert.equal((await request(server, `/api/email/drafts/${id}`, 'PUT', { invented: 'ignored?' })).status, 400);

    const commandCreate = await request(server, '/api/command', 'POST', { text: 'draft an email to Alex about the Friday plan' });
    assert.equal(commandCreate.status, 200);
    assert.match(commandCreate.body.reply, /Draft 3, saved/);
    assert.match(commandCreate.body.reply, /has not been sent/);
    const afterCommand = await request(server, '/api/email/drafts');
    assert.equal(afterCommand.body.drafts.length, 3);

    const commandEdit = await request(server, '/api/command', 'POST', { text: 'set subject of draft 3 to Follow-up from chat' });
    assert.equal(commandEdit.status, 200);
    assert.match(commandEdit.body.reply, /same draft ID is kept/);
    const editedByCommand = await request(server, '/api/email/drafts/3');
    assert.equal(editedByCommand.body.draft.id, 3);
    assert.equal(editedByCommand.body.draft.subject, 'Follow-up from chat');
    const appendCommand = await request(server, '/api/command', 'POST', { text: 'append Please include the notes to body of draft 3' });
    assert.match(appendCommand.body.reply, /Updated the body of email draft 3/);
    const appended = await request(server, '/api/email/drafts/3');
    assert.match(appended.body.draft.body, /\n\nPlease include the notes/);

    const deleteCommand = await request(server, '/api/command', 'POST', { text: 'delete draft 3' });
    assert.match(deleteCommand.body.reply, /will not delete draft 3/);
    assert.equal((await request(server, '/api/email/drafts/3')).status, 200);

    const sendCommand = await request(server, '/api/command', 'POST', { text: 'send the email' });
    assert.match(sendCommand.body.reply, /Sending is not wired/);
    assert.equal((await request(server, '/api/email/send', 'POST', {})).status, 404);

    const opened = await request(server, '/api/command', 'POST', { text: 'open email workspace' });
    assert.match(opened.body.reply, /email room/);

    // The old command-based note desk still shares the same ID/index without
    // leaking notes into the Email room's email-only list.
    const note = await request(server, '/api/command', 'POST', { text: 'write a short note to Kim thanking her' });
    assert.match(note.body.reply, /Draft 4, saved/);
    const onlyEmail = await request(server, '/api/email/drafts');
    assert.equal(onlyEmail.body.drafts.length, 3);
    const readNote = await request(server, '/api/command', 'POST', { text: 'read draft 4' });
    assert.match(readNote.body.reply, /Thank/);

    const deleted = await request(server, `/api/email/drafts/${id}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.equal((await request(server, `/api/email/drafts/${id}`)).status, 404);
  } finally { await server.stop(); }
});

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* UI test is optional without the scratch jsdom install */ }

test('Email UI keeps provider/send claims honest and confirms deletion', { skip: !JSDOM }, async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="room"></div></body></html>', {
    url: 'http://127.0.0.1/rooms-src/rooms.html', pretendToBeVisual: true,
  });
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
  };
  let confirmAnswer = false;
  let deleteCalls = 0;
  let stored = { id: 1, kind: 'email', ...basicEmail(), created: '2026-10-01T10:00:00.000Z', updated: '2026-10-02T12:00:00.000Z' };
  const fetchMock = async (url, options = {}) => {
    const route = new URL(url, 'http://127.0.0.1').pathname;
    const method = options.method || 'GET';
    if (route === '/api/email/drafts' && method === 'GET') return new Response(JSON.stringify({ ok: true, drafts: stored ? [stored] : [] }), { status: 200 });
    if (route === '/api/email/drafts/1' && method === 'GET') return new Response(JSON.stringify({ ok: true, draft: stored }), { status: stored ? 200 : 404 });
    if (route === '/api/email/drafts/1' && method === 'PUT') {
      stored = { ...stored, ...JSON.parse(options.body), updated: '2026-10-03T12:00:00.000Z' };
      return new Response(JSON.stringify({ ok: true, draft: stored }), { status: 200 });
    }
    if (route === '/api/email/drafts/1' && method === 'DELETE') {
      deleteCalls++;
      stored = null;
      return new Response(JSON.stringify({ ok: true, id: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${route}` }), { status: 404 });
  };

  try {
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
    globalThis.fetch = fetchMock;
    dom.window.confirm = () => confirmAnswer;
    await emailRoom.mount(dom.window.document.querySelector('#room'), {});
    assert.match(dom.window.document.querySelector('.email-safety').textContent, /no email account connected/);
    assert.match(dom.window.document.querySelector('.email-safety').textContent, /nothing is sent/);
    assert.equal(dom.window.document.querySelector('.email-send'), null);
    assert.equal(dom.window.document.querySelector('[name="to"]').value, basicEmail().to);
    assert.match(dom.window.document.querySelector('.email-last-edited').textContent, /Last edited/);
    assert.equal(dom.window.localStorage.length, 0);

    const editor = dom.window.document.querySelector('.email-editor');
    dom.window.document.querySelector('[name="subject"]').value = 'Edited in room';
    dom.window.document.querySelector('[name="subject"]').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    editor.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await delay(20);
    assert.equal(stored.subject, 'Edited in room');
    assert.equal(stored.id, 1);

    const deleteButton = dom.window.document.querySelector('.email-danger');
    deleteButton.click();
    await delay(0);
    assert.equal(deleteCalls, 0, 'cancelled confirmation must not send DELETE');
    confirmAnswer = true;
    deleteButton.click();
    await delay(20);
    assert.equal(deleteCalls, 1);
    assert.equal(stored, null);
    assert.match(dom.window.document.querySelector('.email-status').textContent, /deleted from local storage/);
  } finally {
    dom.window.close();
    globalThis.document = prior.document;
    globalThis.window = prior.window;
    if (prior.navigator) Object.defineProperty(globalThis, 'navigator', prior.navigator);
    else delete globalThis.navigator;
    globalThis.fetch = prior.fetch;
  }
});
