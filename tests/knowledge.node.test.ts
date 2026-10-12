/**
 * The shared knowledge store, as the dashboard's own half of it: which model made
 * a stored answer, and what happens when that is not the model in use now.
 *
 * The rule these tests protect: an old answer must never quietly stand in for a fresh
 * one. A starter or taught answer is answered directly (no model made it, so it cannot
 * be out of date); a Gemini answer is answered directly only when it records the model
 * that IS in use; anything else is stale — the model is asked first, and the stored
 * words are used only when it cannot be reached, said to be out of date. Nothing is
 * deleted: a superseded answer goes to the archive.
 *
 * Run:  node --import tsx --test tests/knowledge.node.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore, KNOWLEDGE_VERSION } from '../knowledge.js';

const PYTHON = process.env.JARVIS_PYTHON || 'python3';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run the desktop (Python) half of the knowledge store against the same file. */
function engineRoom(file: string, source: string): string {
  return execFileSync(PYTHON, ['-c', source, REPO_ROOT, file], { encoding: 'utf-8', cwd: REPO_ROOT });
}

const CURRENT = 'gemini-3.8-flash';
const OLDER = 'gemini-2.5-flash';

function fixture(): { dir: string; file: string; store: KnowledgeStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-knowledge-'));
  const file = path.join(dir, 'knowledge.json');
  // A store with no starter file: these tests are about entries, not the shipped set.
  const store = new KnowledgeStore(file, path.join(dir, 'no-starters.json'));
  return { dir, file, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const legacyEntry = (over: Record<string, unknown> = {}) => ({
  id: 1, kind: 'gemini', key: '', question: 'what is a bloom filter',
  keywords: ['bloom', 'filter'], answer: 'A space-saving set membership test.',
  created: '2026-01-01T00:00:00', last_used: '', uses: 0, expires: '', ...over,
});

function writeLegacyStore(file: string, entries: unknown[], archive: unknown[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Exactly what the Python engine room wrote before provenance existed: version 1,
  // no `provenance` on an entry.
  const highest = [...entries, ...archive].reduce((max: number, e) => Math.max(max, Number((e as { id?: number }).id) || 0), 0);
  fs.writeFileSync(file, JSON.stringify({ version: 1, next_id: highest + 1, entries, archive }, null, 2));
}

test('a new Gemini answer records which model produced it', () => {
  const { store, file, cleanup } = fixture();
  try {
    const kept = store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT);
    assert.ok(kept);
    assert.equal(kept.provenance?.model, CURRENT);
    assert.equal(kept.provenance?.schema, 2);
    assert.equal(kept.provenance?.source, 'gemini');
    assert.ok(String(kept.provenance?.recorded).length >= 10);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.version, KNOWLEDGE_VERSION);
    assert.equal(onDisk.entries[0].provenance.model, CURRENT);
  } finally { cleanup(); }
});

test('how staleness is decided: kind, recorded model, model in use', () => {
  const { store, cleanup } = fixture();
  try {
    const fresh = legacyEntry({ provenance: { schema: 2, source: 'gemini', model: CURRENT, recorded: '2026-10-12T00:00:00' } });
    assert.equal(store.isStale(fresh, CURRENT), false, 'the model in use made it: answer directly');
    assert.equal(store.isStale(fresh, 'gemini-3.9-flash'), true, 'a different model made it: stale');
    assert.equal(store.isStale(legacyEntry(), CURRENT), true, 'no record of the model: stale');
    assert.equal(store.isStale(legacyEntry({ provenance: { schema: 2, source: 'gemini', model: '', recorded: '' } }), CURRENT), true,
      'an empty model is an unrecorded one');
    assert.equal(store.isStale(legacyEntry({ kind: 'owner' }), CURRENT), false, 'the owner’s own words cannot be stale');
    assert.equal(store.isStale(legacyEntry({ kind: 'starter' }), CURRENT), false, 'starter answers are the assistant’s own');
    assert.equal(store.isStale(fresh, ''), false, 'no model to compare against: cannot be called out of date');
  } finally { cleanup(); }
});

test('a stale stored answer says what it is when it has to be used', () => {
  const { store, cleanup } = fixture();
  try {
    const text = store.describeStale(legacyEntry(), CURRENT);
    assert.match(text, /A space-saving set membership test\./);
    assert.match(text, /saved from an earlier Gemini answer on 2026-01-01/);
    assert.match(text, /a model this app no longer records/);
    assert.match(text, new RegExp(`not re-checked with ${CURRENT}`));
    assert.match(text, /could not be reached just now/);

    const withModel = store.describeStale(legacyEntry({ provenance: { schema: 2, source: 'gemini', model: OLDER, recorded: '' } }), '');
    assert.match(withModel, new RegExp(`made by ${OLDER}`));
    assert.match(withModel, /not re-checked —/);
  } finally { cleanup(); }
});

test('the same model’s answer is never paid for twice, and is not rewritten', () => {
  const { store, cleanup } = fixture();
  try {
    const first = store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT);
    assert.ok(first);
    assert.equal(store.learn('what is a bloom filter', 'Another wording entirely.', CURRENT), null,
      'the same model already answered this: keep the stored one');
    assert.equal(store.listEntries().length, 1);
    assert.equal(store.learn('what is a bloom filter', 'No model named.', ''), null,
      'with no model named there is nothing to say the new answer is newer');
  } finally { cleanup(); }
});

test('a fresh answer from the current model supersedes a stale one — and archives it, never deletes it', () => {
  const { store, file, cleanup } = fixture();
  try {
    writeLegacyStore(file, [legacyEntry()]);
    const entries = store.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(store.isStale(entries[0], CURRENT), true, 'version 1 entry: no provenance, so stale');

    const kept = store.learn('what is a bloom filter', 'A probabilistic set test, from the current model.', CURRENT);
    assert.ok(kept);
    assert.equal(kept.provenance?.model, CURRENT);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.entries.filter((e: { kind: string }) => e.kind === 'gemini').length, 1);
    assert.equal(onDisk.entries[0].answer, 'A probabilistic set test, from the current model.');
    assert.equal(onDisk.archive.length, 1, 'the old answer is kept in the archive');
    assert.equal(onDisk.archive[0].answer, 'A space-saving set membership test.');
    assert.match(String(onDisk.archive[0].archive_reason), /superseded by gemini-3\.8-flash/);
  } finally { cleanup(); }
});

test('an answer the owner taught is never replaced by a model’s', () => {
  const { store, file, cleanup } = fixture();
  try {
    store.teach('how do I brew tea', 'Steep it for three minutes.');
    assert.equal(store.learn('how do I brew tea', 'The model says something else.', CURRENT), null);
    assert.equal(store.lookup('how do I brew tea')?.answer, 'Steep it for three minutes.');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.archive.length, 0);
    assert.equal(onDisk.entries.filter((e: { kind: string }) => e.kind === 'owner').length, 1);
  } finally { cleanup(); }
});

test('a stored answer from the current model still answers directly (the AI is used as little as possible)', () => {
  const { store, cleanup } = fixture();
  try {
    store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT);
    const hit = store.lookup('what is a bloom filter');
    assert.ok(hit);
    assert.equal(store.isStale(hit, CURRENT), false);
    assert.match(store.describe(hit), /^A space-saving set membership test\./);
    assert.match(store.describe(hit), /saved from an earlier Gemini answer/);
  } finally { cleanup(); }
});

test('the engine room’s version 1 file is read whole — entries, archive and numbering survive a save', () => {
  const { store, file, cleanup } = fixture();
  try {
    const archived = legacyEntry({ id: 7, archive_reason: 'expired', archived_at: '2026-02-01T00:00:00' });
    writeLegacyStore(file, [legacyEntry({ id: 3, kind: 'owner', answer: 'Taught, not model-made.' })], [archived]);
    assert.equal(store.listEntries().length, 1);
    // Any write re-reads and merges: the archive and the numbering must come through.
    store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.archive.length, 1);
    assert.equal(onDisk.archive[0].id, 7);
    assert.ok(Number(onDisk.next_id) > 3, `next_id=${onDisk.next_id}`);
    assert.equal(onDisk.entries.some((e: { answer: string }) => e.answer === 'Taught, not model-made.'), true);
  } finally { cleanup(); }
});

test('both halves share one file: an answer either half kept is still there after the other saves', (t) => {
  const { file, store, cleanup } = fixture();
  try {
    // 1. The desktop app (backend/knowledge.py) keeps an answer first.
    try {
      engineRoom(file, `
import sys
from pathlib import Path
repo, file = sys.argv[1], sys.argv[2]
sys.path.insert(0, repo)
from backend.knowledge import KnowledgeStore
store = KnowledgeStore(Path(file), starter_path=Path(file).with_name('no-starters.json'))
kept = store.learn('what is a python decorator', 'A function that wraps another function.', model='gemini-3.8-flash')
assert kept is not None, 'the engine room did not keep its answer'
`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('no python3 available'); return; }
      throw err;
    }

    // 2. The dashboard reads that file through its own half: the answer and its model are there.
    const theirs = store.lookup('what is a python decorator');
    assert.ok(theirs, 'the dashboard cannot see the answer the engine room kept');
    assert.equal(theirs.provenance?.model, CURRENT);
    assert.equal(store.isStale(theirs, CURRENT), false);

    // 3. The dashboard keeps an answer of its own — its save must not erase the other half's.
    assert.ok(store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.entries.some((e: { question: string }) => e.question === 'what is a python decorator'), true);

    // 4. And the engine room still sees both, with numbering past them.
    const seen = JSON.parse(engineRoom(file, `
import json, sys
from pathlib import Path
repo, file = sys.argv[1], sys.argv[2]
sys.path.insert(0, repo)
from backend.knowledge import KnowledgeStore
store = KnowledgeStore(Path(file), starter_path=Path(file).with_name('no-starters.json'))
print(json.dumps({'entries': store.list_entries(), 'next_id': store._next_id}))
`));
    const questions = seen.entries.map((e: { question: string }) => e.question);
    assert.ok(questions.includes('what is a python decorator'), 'the engine room lost its own answer');
    assert.ok(questions.includes('what is a bloom filter'), 'the engine room cannot see the dashboard\'s answer');
    assert.ok(seen.entries.every((e: { kind: string; provenance?: { model?: string } }) => e.kind !== 'gemini' || e.provenance?.model), 'an answer without a recorded model was written');
    assert.ok(Number(seen.next_id) > 2, `next_id=${seen.next_id}`);
  } finally { cleanup(); }
});

test('a verified copy of a version 1 store is taken before the first version 2 write', () => {
  const { dir, file, store, cleanup } = fixture();
  try {
    writeLegacyStore(file, [legacyEntry({ id: 3, kind: 'owner', answer: 'Steep it for three minutes.',
      question: 'how do I brew tea', keywords: ['brew', 'tea'] })],
      [legacyEntry({ id: 7, archived_at: '2026-02-01T00:00:00', archive_reason: 'expired' })]);
    const original = fs.readFileSync(file);
    store.learn('what is a bloom filter', 'A space-saving set membership test.', CURRENT);

    const backupDir = path.join(dir, 'backups');
    const copies = fs.readdirSync(backupDir).filter((n) => n.startsWith('knowledge.v1-') && !n.includes('.manifest.'));
    assert.equal(copies.length, 1, 'no verified backup was taken before the version 2 write');
    assert.deepEqual(fs.readFileSync(path.join(backupDir, copies[0])), original);   // byte-for-byte
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir,
      fs.readdirSync(backupDir).find((n) => n.includes('.manifest.')) as string), 'utf-8'));
    assert.equal(manifest.backup, copies[0]);
    assert.equal(manifest.sha256, crypto.createHash('sha256').update(original).digest('hex'));
    assert.equal(manifest.size_bytes, original.length);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.version, KNOWLEDGE_VERSION);
    assert.ok(onDisk.entries.some((e: { answer: string }) => e.answer === 'Steep it for three minutes.'));
    assert.equal(onDisk.archive.length, 1);

    // Whatever else the store does, it must not keep copying the same old file.
    store.learn('what is a python decorator', 'A function that wraps another function.', CURRENT);
    assert.equal(fs.readdirSync(backupDir).filter((n) => n.startsWith('knowledge.v1-') && !n.includes('.manifest.')).length, 1);
  } finally { cleanup(); }
});
