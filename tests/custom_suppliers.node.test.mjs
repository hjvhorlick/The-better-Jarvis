/**
 * Registering a supplier of your own.
 *
 * The point of this feature is that a website becomes a source of files without
 * an edit to any code and without a restart — so what is tested here is exactly
 * that: a supplier described as data is searched, is tried before the built-ins,
 * and can be taken away again.
 *
 * Nothing here reaches the network. The store is exercised against a temporary
 * file so the tests do not touch the real config.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveCustomSupplier, listCustomSuppliers, removeCustomSupplier, customSupplierStatus,
} from '../config.ts';
import { parseCustomSupplier, searchMedia } from '../search/engine.ts';

let tempDir;

// SUPPER_SUPPLIERS_FILE, not SUPPER_HOME: REPO_ROOT is process.cwd(), so a home
// override would not have moved anything and the suite would have written five
// invented suppliers into the owner's real config/suppliers.json.
test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'jarvis-suppliers-'));
  process.env.SUPPER_SUPPLIERS_FILE = join(tempDir, 'suppliers.json');
});

test.afterEach(() => {
  delete process.env.SUPPER_SUPPLIERS_FILE;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* already gone */ }
});

function stubFetch(routes) {
  const seen = [];
  const fetchBody = async (url, options) => {
    seen.push({ url, headers: options.headers });
    for (const [match, payload] of routes) {
      if (url.includes(match)) {
        if (payload instanceof Error) throw payload;
        return { body: JSON.stringify(payload) };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchBody, seen };
}

const BOOK_APP = {
  hits: [
    { title: 'Quarterly Report', url: 'https://my.app/files/q3.pdf', thumb: 'https://my.app/t/q3.png', author: 'Finance' },
    { title: 'Brand Guide', url: 'https://my.app/files/brand.pdf' },
  ],
};

/* ── registering ──────────────────────────────────────────────────────────── */
test('a supplier can be registered, listed and removed', () => {
  assert.deepEqual(listCustomSuppliers(), [], 'nothing registered to start with');

  const saved = saveCustomSupplier({
    id: 'My-Book-App', label: 'My Book App', kinds: ['book'],
    endpoint: 'https://my.app/api/search?q={query}&limit={limit}',
    titlePath: 'title', urlPath: 'url', listPath: 'hits',
  });
  assert.equal(saved.id, 'my-book-app', 'the id is normalised');

  const [listed] = listCustomSuppliers();
  assert.equal(listed.label, 'My Book App');
  assert.deepEqual(listed.kinds, ['book']);

  assert.equal(removeCustomSupplier('my-book-app'), true);
  assert.deepEqual(listCustomSuppliers(), []);
  assert.equal(removeCustomSupplier('my-book-app'), false, 'removing twice is not an error, just nothing to do');
});

test('a supplier with no {query}, no title or no url is refused', () => {
  const base = { id: 'broken', label: 'Broken', kinds: ['image'], titlePath: 'title', urlPath: 'url' };
  assert.throws(() => saveCustomSupplier({ ...base, endpoint: 'https://my.app/api' }), /\{query\}/);
  assert.throws(() => saveCustomSupplier({ ...base, endpoint: 'ftp://my.app/{query}' }), /http/);
  assert.throws(() => saveCustomSupplier({ ...base, endpoint: 'https://my.app/{query}', titlePath: '' }), /title/i);
  assert.throws(() => saveCustomSupplier({ ...base, endpoint: 'https://my.app/{query}', urlPath: '' }), /address|url/i);
  assert.throws(() => saveCustomSupplier({ ...base, endpoint: 'https://my.app/{query}', kinds: ['spaceship'] }), /kind/i);
  assert.deepEqual(listCustomSuppliers(), [], 'a refused supplier is not written');
});

test('the key is stored but never returned by the status route', () => {
  saveCustomSupplier({
    id: 'secret', label: 'Secret', kinds: ['image'],
    endpoint: 'https://my.app/{query}', titlePath: 'title', urlPath: 'url',
    keyHeader: 'Authorization', keyPrefix: 'Bearer ', key: 'a-very-secret-key-1234',
  });
  const [status] = customSupplierStatus();
  assert.equal(status.hasKey, true);
  assert.equal(status.keyTail, '1234', 'the last four, which is what Settings shows');
  assert.ok(!JSON.stringify(status).includes('a-very-secret-key'), 'the key itself is not in the status');
});

/* ── searching through a registered supplier ──────────────────────────────── */
test('a registered supplier is searched, and its answer is read from the paths given', async () => {
  saveCustomSupplier({
    id: 'book-app', label: 'My Book App', kinds: ['book'],
    endpoint: 'https://my.app/api/search?q={query}&limit={limit}',
    titlePath: 'title', urlPath: 'url', thumbPath: 'thumb', authorPath: 'author', listPath: 'hits',
  });
  const stub = stubFetch([['my.app', BOOK_APP]]);
  const hits = await searchMedia('book', 'quarterly report', stub);

  assert.equal(hits.length, 2);
  assert.equal(hits[0].source, 'My Book App');
  assert.equal(hits[0].title, 'Quarterly Report');
  assert.equal(hits[0].url, 'https://my.app/files/q3.pdf');
  assert.equal(hits[0].thumb, 'https://my.app/t/q3.png');
  assert.equal(hits[0].author, 'Finance');

  // {query} and {limit} were substituted into the endpoint, and encoded.
  const called = stub.seen[0].url;
  assert.match(called, /q=quarterly%20report/, 'the question was substituted and encoded');
  assert.match(called, /limit=\d+/, 'the limit was substituted');
});

test('a registered supplier is tried before the built-ins', async () => {
  saveCustomSupplier({
    id: 'stock', label: 'Our Stock Library', kinds: ['image'],
    endpoint: 'https://stock.internal.example/{query}', titlePath: 'title', urlPath: 'url',
  });
  const stub = stubFetch([
    ['stock.internal.example', [{ title: 'Our own photo', url: 'https://stock.internal.example/1.jpg' }]],
    ['commons.wikimedia.org', { query: { pages: [{ title: 'File:Other.jpg', imageinfo: [{ url: 'https://up/other.jpg' }] }] } }],
  ]);
  const hits = await searchMedia('image', 'ocean', stub);
  assert.equal(hits[0].source, 'Our Stock Library', 'the registered supplier answered first');
  assert.ok(!stub.seen.some((s) => s.url.includes('commons.wikimedia.org')), 'the built-ins were not needed');
});

test('when a registered supplier fails, the built-ins still answer', async () => {
  saveCustomSupplier({
    id: 'flaky', label: 'Flaky App', kinds: ['image'],
    endpoint: 'https://flaky.example/{query}', titlePath: 'title', urlPath: 'url',
  });
  const commons = { query: { pages: [{ title: 'File:Ocean.jpg', imageinfo: [{ url: 'https://up/ocean.jpg', mime: 'image/jpeg' }] }] } };
  const stub = stubFetch([
    ['flaky.example', new Error('ECONNREFUSED')],
    ['commons.wikimedia.org', commons],
  ]);
  const hits = await searchMedia('image', 'ocean', stub);
  assert.equal(hits[0].source, 'Wikimedia Commons', 'a registered supplier that is down is passed over, not reported');
});

test('the key is sent in the header asked for, and only then', async () => {
  saveCustomSupplier({
    id: 'keyed', label: 'Keyed App', kinds: ['image'],
    endpoint: 'https://keyed.example/{query}', titlePath: 'title', urlPath: 'url',
    keyHeader: 'Authorization', keyPrefix: 'Bearer ', key: 'the-key',
  });
  const stub = stubFetch([['keyed.example', [{ title: 'A', url: 'https://keyed.example/a.jpg' }]]]);
  await searchMedia('image', 'thing', stub);
  assert.equal(stub.seen[0].headers?.Authorization, 'Bearer the-key');
});

/* ── reading an untrusted answer ──────────────────────────────────────────── */
test('rows without a usable address are dropped, not shown as blanks', () => {
  const supplier = { id: 'x', label: 'X', kinds: ['image'], endpoint: 'https://x/{query}', titlePath: 'title', urlPath: 'url' };
  const hits = parseCustomSupplier([
    { title: 'Good', url: 'https://x/1.jpg' },
    { title: 'No address' },
    { title: 'Not a URL', url: 'javascript:alert(1)' },
    { title: 'Localhost', url: 'http://127.0.0.1/x.jpg' },
    { url: 'https://x/2.jpg' },
  ], supplier, 'image');
  // The javascript: and localhost rows are refused: a link that executes script
  // or points at this machine is not a result to hand over.
  assert.deepEqual(hits.map((h) => h.title), ['Good', 'Localhost'],
    'script URLs are dropped; an ordinary http address is kept and left to the fetcher');
});

test('a nested answer is read with a dot path', () => {
  const supplier = {
    id: 'x', label: 'X', kinds: ['book'], endpoint: 'https://x/{query}',
    listPath: 'data.items', titlePath: 'meta.name', urlPath: 'links.file',
  };
  const hits = parseCustomSupplier({
    data: { items: [{ meta: { name: 'Deep Title' }, links: { file: 'https://x/deep.pdf' } }] },
  }, supplier, 'book');
  assert.equal(hits[0].title, 'Deep Title');
  assert.equal(hits[0].url, 'https://x/deep.pdf');
  assert.equal(hits[0].kind, 'book');
});

test('a broken answer yields nothing rather than throwing', () => {
  const supplier = { id: 'x', label: 'X', kinds: ['image'], endpoint: 'https://x/{query}', titlePath: 'title', urlPath: 'url' };
  assert.deepEqual(parseCustomSupplier(null, supplier, 'image'), []);
  assert.deepEqual(parseCustomSupplier({ nope: 1 }, supplier, 'image'), []);
  assert.deepEqual(parseCustomSupplier('not json at all', supplier, 'image'), []);
  assert.deepEqual(parseCustomSupplier([{ title: 'x', url: 'https://x/1' }], { ...supplier, listPath: 'missing.path' }, 'image'), []);
});

test('the store survives a file it cannot read', () => {
  // A truncated or hand-edited file must not stop the app from starting.
  writeFileSync(process.env.SUPPER_SUPPLIERS_FILE, '{ this is not json', 'utf-8');
  assert.deepEqual(listCustomSuppliers(), []);
});

test('the tests never touch the real config/suppliers.json', () => {
  // The guard for the mistake these tests made on their first run.
  assert.ok(process.env.SUPPER_SUPPLIERS_FILE?.startsWith(tempDir),
    'the store is not pointed at the temp dir — this suite would edit the real config');
  assert.ok(!process.env.SUPPER_SUPPLIERS_FILE?.includes(`${process.cwd()}/config`),
    'the override must not resolve back into the repository');
});
