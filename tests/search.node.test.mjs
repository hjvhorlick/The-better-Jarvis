/**
 * The open-web engine, tested without a network.
 *
 * Every source is fed a recorded payload, so these tests prove the parsing and
 * the fallback order — the parts that live in this repository. The live
 * endpoints themselves cannot be reached from a sandbox that only allows
 * GitHub, npm and PyPI, so the first real search has to happen on the owner's
 * PC. Nothing here spends a quota unit, because none of it goes near Gemini.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuckResults, unwrapDuckLink, toPlainText, decodeEntities,
  parseWikiFact, parsePexels, parsePixabay, parseCommons, parseOpenverse, parseArchive,
  searchImages, searchVideos, searchAudio, searchBooks, searchMedia, searchWeb,
  wikiFact, answerFromWeb, imageKeyStatus, explainFetchError, parseJamendo,
  parseGutendex, describeSources, MEDIA_KINDS,
  searchModels, parseThingiverse, parseCommonsModels, missingKeysFor,
} from '../search/engine.ts';

/* ── DuckDuckGo: the exact shape its HTML endpoint returns ───────────────── */
const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a"
    href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbloom&amp;rut=abc">Bloom &amp; filter</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbloom">
    A <b>bloom filter</b> is a space-efficient probabilistic set.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="https://second.example/page">Second result</a></h2>
  <a class="result__snippet">Another <i>snippet</i>.</a>
</div>
<div class="result"><h2 class="result__title"><a class="result__a" href="javascript:alert(1)">Bad scheme</a></h2></div>`;

test('the open web is searched without a key, and links are unwrapped', () => {
  const hits = parseDuckResults(DDG_HTML);
  assert.equal(hits.length, 2, 'the javascript: link is dropped, not followed');
  assert.equal(hits[0].title, 'Bloom & filter');
  assert.equal(hits[0].url, 'https://example.com/bloom', 'the DDG redirect is unwrapped');
  assert.match(hits[0].snippet, /space-efficient probabilistic set/);
  assert.equal(hits[0].source, 'DuckDuckGo');
  assert.ok(!hits[0].snippet.includes('<b>'), 'markup is stripped from the snippet');
});

test('unwrapDuckLink leaves an ordinary https link alone', () => {
  assert.equal(unwrapDuckLink('https://example.com/x'), 'https://example.com/x');
  assert.equal(unwrapDuckLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2F'), 'https://a.test/');
  assert.equal(unwrapDuckLink(''), '');
});

test('untrusted HTML is flattened to plain text, never interpreted', () => {
  assert.equal(toPlainText('<script>alert(1)</script>Safe &amp; sound'), 'Safe & sound');
  assert.equal(decodeEntities('&#65;&#x42;&nbsp;C'), 'AB C');
  // A very long body is capped, so one page cannot flood the chat.
  assert.equal(toPlainText('x'.repeat(5000)).length, 320);
});

/* ── Wikipedia: facts with their source attached ─────────────────────────── */
const WIKI = {
  query: {
    pages: [{
      title: 'Bloom filter',
      extract: 'A bloom filter is a space-efficient probabilistic data structure.',
      fullurl: 'https://en.wikipedia.org/wiki/Bloom_filter',
    }],
  },
};

test('a fact comes back with its title and its URL, not as bare prose', () => {
  const fact = parseWikiFact(WIKI);
  assert.equal(fact.title, 'Bloom filter');
  assert.equal(fact.url, 'https://en.wikipedia.org/wiki/Bloom_filter');
  assert.match(fact.extract, /space-efficient probabilistic/);
  assert.equal(parseWikiFact({ query: {} }), null, 'an empty answer is null, not a guess');
});

/* ── Pexels and Pixabay: the owner's free keys ───────────────────────────── */
const PEXELS_IMG = {
  photos: [{
    url: 'https://www.pexels.com/photo/1/', photographer: 'Ada Lovelace', alt: 'A calm ocean',
    src: { large2x: 'https://img/large2x.jpg', large: 'https://img/large.jpg', medium: 'https://img/medium.jpg' },
  }],
};
const PEXELS_VID = {
  videos: [{
    url: 'https://www.pexels.com/video/9/', user: { name: 'Grace Hopper' },
    image: 'https://img/poster.jpg',
    video_files: [{ link: 'https://vid/sd.mp4', quality: 'sd' }, { link: 'https://vid/hd.mp4', quality: 'hd' }],
  }],
};
const PIXABAY_IMG = {
  hits: [{
    pageURL: 'https://pixabay.com/photos/1/', tags: 'ocean, waves', user: 'Alan',
    previewURL: 'https://pix/prev.jpg', webformatURL: 'https://pix/web.jpg', largeImageURL: 'https://pix/large.jpg',
  }],
};
const PIXABAY_VID = {
  hits: [{
    pageURL: 'https://pixabay.com/videos/2/', tags: 'forest', user: 'Bo',
    picture_id: '123', videos: { medium: { url: 'https://pix/vid.mp4' } },
  }],
};

test('Pexels pictures and video are read, with the photographer credited', () => {
  const [img] = parsePexels(PEXELS_IMG, 'image');
  assert.equal(img.url, 'https://img/large2x.jpg');
  assert.equal(img.author, 'Ada Lovelace');
  assert.equal(img.title, 'A calm ocean');
  const [vid] = parsePexels(PEXELS_VID, 'video');
  assert.equal(vid.url, 'https://vid/hd.mp4', 'the HD file is preferred over SD');
  assert.equal(vid.author, 'Grace Hopper');
});

test('Pixabay pictures and video are read, with tags as the title', () => {
  const [img] = parsePixabay(PIXABAY_IMG, 'image');
  assert.equal(img.url, 'https://pix/large.jpg');
  assert.equal(img.title, 'ocean, waves');
  assert.equal(img.thumb, 'https://pix/prev.jpg');
  const [vid] = parsePixabay(PIXABAY_VID, 'video');
  assert.equal(vid.url, 'https://pix/vid.mp4');
});

/* ── the key-free sources ────────────────────────────────────────────────── */
const COMMONS = {
  query: {
    pages: [{
      title: 'File:Ocean.jpg',
      imageinfo: [{
        url: 'https://commons/ocean.jpg', thumburl: 'https://commons/ocean_640.jpg',
        descriptionurl: 'https://commons/desc', mime: 'image/jpeg',
        extmetadata: { Artist: { value: '<a href="x">Marie</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } },
      }],
    }],
  },
};
const OPENVERSE = {
  results: [{
    title: 'Waves', url: 'https://ov/waves.mp3', thumbnail: 'https://ov/t.jpg',
    foreign_landing_url: 'https://ov/page', creator: 'Kai', license: 'by', license_version: '4.0',
  }],
};
const ARCHIVE = {
  response: { docs: [{ identifier: 'night_train', title: 'Night Train', creator: 'Someone', licenseurl: 'https://x/lic' }] },
};

test('Commons, Openverse and the Archive all work with no key at all', () => {
  const [c] = parseCommons(COMMONS, 'image');
  assert.equal(c.url, 'https://commons/ocean.jpg');
  assert.equal(c.author, 'Marie', 'the artist is credited, markup stripped');
  assert.equal(c.license, 'CC BY-SA 4.0');
  const [o] = parseOpenverse(OPENVERSE, 'audio');
  assert.equal(o.kind, 'audio');
  assert.equal(o.license, 'BY 4.0');
  const [a] = parseArchive(ARCHIVE, 'audio');
  assert.equal(a.url, 'https://archive.org/details/night_train', 'the item page, never a guessed filename');
});

/* ── the fallback order: a missing key degrades, it does not fail ────────── */
function stubFetch(routes) {
  const seen = [];
  return {
    seen,
    fetchBody: async (url) => {
      seen.push(url);
      for (const [needle, value] of routes) {
        if (url.includes(needle)) {
          if (value instanceof Error) throw value;
          return { body: JSON.stringify(value) };
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  };
}

test('pictures: with no Pexels or Pixabay key, Commons answers anyway', async (t) => {
  t.after(() => { delete process.env.PEXELS_API_KEY; delete process.env.PIXABAY_API_KEY; });
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  const stub = stubFetch([['commons.wikimedia.org', COMMONS]]);
  const hits = await searchImages('ocean', stub);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'Wikimedia Commons');
  assert.ok(!stub.seen.some((u) => u.includes('pexels.com')), 'Pexels is not called without a key');
  assert.ok(!stub.seen.some((u) => u.includes('pixabay.com')), 'and neither is Pixabay');
});

test('pictures: with a Pexels key set, Pexels is tried first', async (t) => {
  t.after(() => { delete process.env.PEXELS_API_KEY; });
  process.env.PEXELS_API_KEY = 'pexels-test-key';
  const stub = stubFetch([['api.pexels.com', PEXELS_IMG], ['commons.wikimedia.org', COMMONS]]);
  const hits = await searchImages('ocean', stub);
  assert.equal(hits[0].source, 'Pexels');
  assert.ok(!stub.seen.some((u) => u.includes('commons.wikimedia.org')), 'Commons is not needed');
});

test('pictures: a dead source is skipped, not reported to the owner', async (t) => {
  t.after(() => { delete process.env.PEXELS_API_KEY; });
  process.env.PEXELS_API_KEY = 'pexels-test-key';
  const stub = stubFetch([
    ['api.pexels.com', new Error('ECONNREFUSED')],
    ['pixabay.com', { hits: [] }],
    ['commons.wikimedia.org', COMMONS],
  ]);
  const hits = await searchImages('ocean', stub);
  assert.equal(hits.length, 1, 'the answer still arrives');
  assert.equal(hits[0].source, 'Wikimedia Commons');
});

test('video: Pexels, then Pixabay, then the Internet Archive', async () => {
  const stub = stubFetch([['archive.org', ARCHIVE]]);
  const hits = await searchVideos('night train', stub);
  assert.equal(hits[0].source, 'Internet Archive');
  assert.equal(hits[0].kind, 'video');
});

test('sound: neither Pexels nor Pixabay is asked, because neither serves audio', async () => {
  const stub = stubFetch([['api.openverse.org', OPENVERSE]]);
  const hits = await searchAudio('ocean waves', stub);
  assert.equal(hits[0].source, 'Openverse');
  assert.ok(!stub.seen.some((u) => /pexels|pixabay/.test(u)), 'no audio request is wasted on them');
});

test('the key status reports which keys exist, and never the key itself', () => {
  const before = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'super-secret-pexels';
  try {
    const status = imageKeyStatus();
    const pexels = status.find((s) => s.service === 'pexels');
    assert.equal(pexels.present, true);
    assert.equal(pexels.tail, 'xels', 'only the last four, as with the Gemini keys');
    const dumped = JSON.stringify(status);
    assert.ok(!dumped.includes('super-secret-pexels'), 'the key itself is never returned');
  } finally {
    if (before === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = before;
  }
});

/* ── the composed answer ─────────────────────────────────────────────────── */
test('a question is answered from the web with sources, and nothing is counted', async () => {
  const stub = stubFetch([
    ['en.wikipedia.org', WIKI],
    ['html.duckduckgo.com', { body: '' }],
  ]);
  const ddgStub = {
    ...stub,
    fetchBody: async (url) => {
      stub.seen.push(url);
      if (url.includes('en.wikipedia.org')) return { body: JSON.stringify(WIKI) };
      if (url.includes('duckduckgo')) return { body: DDG_HTML };
      throw new Error(`unexpected fetch: ${url}`);
    },
  };
  const answer = await answerFromWeb('what is a bloom filter', ddgStub);
  assert.match(answer.reply, /space-efficient probabilistic/);
  assert.match(answer.reply, /Wikipedia: https:\/\/en\.wikipedia\.org\/wiki\/Bloom_filter/);
  assert.match(answer.reply, /From the open web|And from the open web/);
  assert.match(answer.reply, /example\.com\/bloom/);
  assert.ok(answer.sources.includes('Wikipedia') && answer.sources.includes('DuckDuckGo'));
});

test('searchWeb and wikiFact go through the same injectable fetch', async () => {
  const stub = stubFetch([]);
  stub.fetchBody = async (url) => {
    stub.seen.push(url);
    if (url.includes('duckduckgo')) return { body: DDG_HTML };
    if (url.includes('wikipedia')) return { body: JSON.stringify(WIKI) };
    throw new Error('unexpected');
  };
  const hits = await searchWeb('tea prices', stub);
  assert.equal(hits.length, 2);
  const fact = await wikiFact('tea', stub);
  assert.equal(fact.title, 'Bloom filter');
  assert.ok(stub.seen[0].includes('q=tea+prices') || stub.seen[0].includes('q=tea%20prices'), 'the query is URL-encoded');
});

/* ── a network failure is explained, never dumped ────────────────────────── */
test('a dead connection is described in one plain sentence, with no quota talk', () => {
  const dns = explainFetchError(Object.assign(new Error('Invalid IP address: undefined'), { code: 'ENOTFOUND' }));
  assert.match(dns, /could not resolve the address/);
  assert.match(explainFetchError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), /refused or timed out/);
  assert.match(explainFetchError(new Error('The source resolves to a private or non-public network address')), /private network/);
  assert.equal(explainFetchError(new Error('something odd')), 'something odd');
  for (const message of [dns, explainFetchError(new Error('ECONNRESET'))]) {
    assert.doesNotMatch(message, /quota|429|budget/i, 'a network error is never blamed on a quota');
  }
});

/* ── Jamendo: the music source, because Pexels and Pixabay have no audio ──── */
const JAMENDO = {
  headers: { status: 'success', code: 0, results_count: 1 },
  results: [{
    id: '1630628', name: 'Rock_guard', album_name: 'Rock Vision', artist_name: 'Christian Petermann',
    duration: 202,
    license_ccurl: 'http://creativecommons.org/licenses/by-nc-nd/3.0/',
    audio: 'https://mp3l.jamendo.com/?trackid=1630628&format=mp31',
    audiodownload: 'https://mp3d.jamendo.com/download/track/1630628/mp32/',
    shareurl: 'https://www.jamendo.com/track/1630628',
    image: 'https://imgjam2.jamendo.com/albums/s183/183496/covers/1.200.jpg',
  }],
};

test('Jamendo returns playable audio, with that track\'s own licence', () => {
  const [track] = parseJamendo(JAMENDO);
  assert.equal(track.kind, 'audio');
  assert.equal(track.url, 'https://mp3l.jamendo.com/?trackid=1630628&format=mp31');
  assert.equal(track.author, 'Christian Petermann');
  assert.match(track.license, /by-nc-nd/, 'the per-track CC licence is kept, not assumed');
  assert.equal(track.source, 'Jamendo');
  // A track with nothing to play is not offered as a result.
  assert.deepEqual(parseJamendo({ headers: { status: 'success' }, results: [{ id: '1', name: 'silent' }] }), []);
  assert.deepEqual(parseJamendo({ headers: { status: 'error', error_message: 'bad client id' } }), []);
});

test('music: Jamendo first when a client ID is set, key-free sources otherwise', async (t) => {
  t.after(() => { delete process.env.JAMENDO_CLIENT_ID; });
  const noKey = stubFetch([['commons.wikimedia.org', COMMONS]]);
  delete process.env.JAMENDO_CLIENT_ID;
  const free = await searchAudio('ocean waves', noKey);
  assert.equal(free[0].source, 'Wikimedia Commons');
  assert.ok(!noKey.seen.some((u) => u.includes('jamendo.com')), 'Jamendo is not called without a client ID');

  process.env.JAMENDO_CLIENT_ID = 'jamendo-client-id';
  const withKey = stubFetch([['api.jamendo.com', JAMENDO], ['commons.wikimedia.org', COMMONS]]);
  const keyed = await searchAudio('rock', withKey);
  assert.equal(keyed[0].source, 'Jamendo');
  assert.ok(!withKey.seen.some((u) => u.includes('commons.wikimedia.org')), 'Commons is not needed');
});

/* ── the Pexels video path documented two ways ───────────────────────────── */
const PEXELS_VID_WIDE = {
  videos: [{
    url: 'https://www.pexels.com/video/9/', user: { name: 'Grace Hopper' },
    video_files: [
      { link: 'https://vid/sd.mp4', width: 960, quality: 'hd' },
      { link: 'https://vid/uhd.mp4', width: 3840, quality: null },
    ],
  }],
};

test('Pexels video: the documented /v1 path is tried, and resolution wins over "quality"', async (t) => {
  t.after(() => { delete process.env.PEXELS_API_KEY; });
  process.env.PEXELS_API_KEY = 'pexels-test-key';
  const stub = stubFetch([['api.pexels.com/v1/videos/search', PEXELS_VID_WIDE]]);
  const hits = await searchVideos('ocean', stub);
  assert.equal(hits[0].url, 'https://vid/uhd.mp4',
    'the widest file wins even when its "quality" is null, as the docs warn it can be');
  assert.equal(hits[0].source, 'Pexels');
});

test('Pexels video: when /v1 returns nothing, the other documented path is tried', async (t) => {
  t.after(() => { delete process.env.PEXELS_API_KEY; });
  process.env.PEXELS_API_KEY = 'pexels-test-key';
  const stub = stubFetch([
    ['api.pexels.com/v1/videos/search', { videos: [] }],
    ['api.pexels.com/videos/search', PEXELS_VID_WIDE],
  ]);
  const hits = await searchVideos('ocean', stub);
  assert.equal(hits[0].source, 'Pexels');
  assert.ok(stub.seen.some((u) => u.includes('api.pexels.com/videos/search')), 'the fallback path was reached');
});

test('Pixabay video takes its thumbnail from the API, not from a guessed CDN', () => {
  const [vid] = parsePixabay({
    hits: [{
      pageURL: 'https://pixabay.com/videos/2/', tags: 'forest', user: 'Bo',
      picture_id: '123',
      videos: { medium: { url: 'https://pix/vid.mp4', thumbnail: 'https://pix/thumb.jpg' } },
    }],
  }, 'video');
  assert.equal(vid.thumb, 'https://pix/thumb.jpg', 'the documented per-rendition thumbnail');
  assert.ok(!String(vid.thumb).includes('vimeocdn'), 'no invented Vimeo URL');
});

/* ── the supplier registry ──────────────────────────────────────────────────
 * The point of the registry is that a supplier is a row of data. These tests
 * hold that property: coverage is described from the same table the search
 * walks, and no kind is left without a supplier that needs nothing.
 */
test('the registry describes every supplier, and never calls a key "required"', () => {
  const sources = describeSources();
  assert.ok(sources.length >= 7, `expected at least 7 suppliers, saw ${sources.length}`);
  for (const source of sources) {
    assert.ok(source.id && source.label && source.blurb, 'every supplier is described');
    assert.ok(Array.isArray(source.kinds) && source.kinds.length, 'and says what it supplies');
    for (const kind of source.kinds) assert.ok(MEDIA_KINDS.includes(kind), `unknown kind ${kind}`);
    // A key narrows the choice of supplier; it must never be presented as a gate.
    assert.equal(typeof source.needsKey, 'boolean');
    if (!source.needsKey) assert.equal(source.keyPresent, true, 'a key-free supplier is always available');
  }
});

test('every kind of file has at least one supplier that needs no key', () => {
  const sources = describeSources();
  for (const kind of MEDIA_KINDS) {
    const keyFree = sources.filter((s) => s.kinds.includes(kind) && !s.needsKey);
    assert.ok(keyFree.length, `${kind} would depend entirely on a key — that is a gate`);
  }
});

test('books: Gutendex needs no key, and the download link is read, not invented', async () => {
  const payload = {
    count: 1,
    results: [{
      id: 1661, title: 'The Adventures of Sherlock Holmes',
      authors: [{ name: 'Doyle, Arthur Conan', birth_year: 1859, death_year: 1930 }],
      languages: ['en'], download_count: 50000,
      formats: {
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/files/1661/1661-0.txt',
        'application/epub+zip': 'https://www.gutenberg.org/ebooks/1661.epub3.images',
        'application/octet-stream': 'https://www.gutenberg.org/files/1661/1661-h.zip',
      },
    }],
  };
  const [book] = parseGutendex(payload);
  assert.equal(book.kind, 'book');
  assert.equal(book.url, 'https://www.gutenberg.org/files/1661/1661-0.txt',
    'plain text is preferred: it is what a book-building app can re-flow');
  assert.equal(book.author, 'Doyle, Arthur Conan');
  assert.equal(book.page, 'https://www.gutenberg.org/ebooks/1661');
  assert.match(book.license, /Public domain/);

  const stub = stubFetch([['gutendex.com', payload]]);
  const hits = await searchBooks('sherlock holmes', stub);
  assert.equal(hits[0].source, 'Project Gutenberg');
  assert.ok(!delete process.env.PEXELS_API_KEY === false); // keys are irrelevant here
});

test('searchMedia walks only the suppliers that cover that kind', async () => {
  const stub = stubFetch([['gutendex.com', { count: 0, results: [] }], ['commons.wikimedia.org', COMMONS]]);
  const pics = await searchMedia('image', 'ocean', stub);
  assert.equal(pics[0].source, 'Wikimedia Commons');
  assert.ok(!stub.seen.some((u) => u.includes('gutendex.com')), 'a book supplier is not asked for a picture');
});

/* ── 3D printable models ────────────────────────────────────────────────────
 * Thingiverse is the one supplier here whose live response shape I could not
 * confirm, because this sandbox cannot reach api.thingiverse.com. So the parser
 * is written to accept both shapes that real code in the wild reports — a bare
 * array and a `hits` wrapper — and both are asserted.
 */
const THINGIVERSE_ARRAY = [{
  id: 2238443, name: 'Cable clip', public_url: 'https://www.thingiverse.com/thing:2238443',
  thumbnail: 'https://cdn.thingiverse.com/thumb.png', creator: { name: 'maker' }, like_count: 12,
}];

test('Thingiverse: a bare array and a hits wrapper both parse', () => {
  const a = parseThingiverse(THINGIVERSE_ARRAY);
  const b = parseThingiverse({ hits: THINGIVERSE_ARRAY });
  for (const [model] of [a, b]) {
    assert.equal(model.kind, 'model');
    assert.equal(model.title, 'Cable clip');
    assert.equal(model.page, 'https://www.thingiverse.com/thing:2238443');
    assert.equal(model.author, 'maker');
  }
  assert.deepEqual(parseThingiverse({ hits: [] }), []);
  assert.deepEqual(parseThingiverse(null), []);
});

test('Thingiverse: the page is offered, never an invented download URL', () => {
  const [model] = parseThingiverse([{ id: 99, name: 'Bracket' }]);
  // The listing carries no STL link, and a file path built from the id would be
  // a guess. The page is the honest answer.
  assert.equal(model.url, 'https://www.thingiverse.com/thing:99');
  assert.equal(model.thumb, null);
  assert.match(model.license, /licence on the model page/i, 'the terms are per model, so they are not asserted here');
});

test('models: Commons needs no token, and SVG is not offered as printable', async (t) => {
  t.after(() => { delete process.env.THINGIVERSE_APP_TOKEN; });
  delete process.env.THINGIVERSE_APP_TOKEN;
  const payload = {
    query: { pages: [
      { title: 'File:Dawn 3D Model.stl', imageinfo: [{ url: 'https://up/Dawn.stl', mime: 'application/sla', descriptionurl: 'https://commons/Dawn' }] },
      { title: 'File:Logo.svg', imageinfo: [{ url: 'https://up/Logo.svg', mime: 'image/svg+xml' }] },
      { title: 'File:Part.obj', imageinfo: [{ url: 'https://up/Part.obj', mime: 'model/obj' }] },
    ] },
  };
  const parsed = parseCommonsModels(payload);
  assert.deepEqual(parsed.map((m) => m.title), ['Dawn 3D Model.stl', 'Part.obj'],
    'an SVG is a drawing, not something a printer can use');
  assert.equal(parsed[0].source, 'Wikimedia Commons');

  const stub = stubFetch([['commons.wikimedia.org', payload]]);
  const hits = await searchModels('spacecraft', stub);
  assert.equal(hits[0].source, 'Wikimedia Commons');
  assert.ok(!stub.seen.some((u) => u.includes('thingiverse')), 'no token, so Thingiverse is not called');
});

test('models: Thingiverse leads when its token is loaded', async (t) => {
  t.after(() => { delete process.env.THINGIVERSE_APP_TOKEN; });
  process.env.THINGIVERSE_APP_TOKEN = 'thingiverse-app-token';
  const stub = stubFetch([
    ['api.thingiverse.com/search/', THINGIVERSE_ARRAY],
    ['commons.wikimedia.org', { query: { pages: [] } }],
  ]);
  const hits = await searchModels('cable clip', stub);
  assert.equal(hits[0].source, 'Thingiverse');
  assert.ok(stub.seen.some((u) => u.includes('type=things')), 'the documented query form was used');
});

test('models: when the documented path gives nothing, the other form is tried', async (t) => {
  t.after(() => { delete process.env.THINGIVERSE_APP_TOKEN; });
  process.env.THINGIVERSE_APP_TOKEN = 'thingiverse-app-token';
  const stub = stubFetch([
    ['api.thingiverse.com/search/?q=', { hits: [] }],
    ['api.thingiverse.com/search/cable', THINGIVERSE_ARRAY],
  ]);
  const hits = await searchModels('cable', stub);
  assert.equal(hits[0].source, 'Thingiverse', 'the fallback path answered');
});

test('models is a kind in the registry, and Commons covers it with no key', () => {
  assert.ok(MEDIA_KINDS.includes('model'));
  const sources = describeSources();
  const keyFree = sources.filter((s) => s.kinds.includes('model') && !s.needsKey);
  assert.ok(keyFree.length, 'a missing Thingiverse token must not block a model search');
});

/* ── a suggestion must name only suppliers that can serve that kind ──────────
 * The bug this guards: a failed PICTURE search listed Jamendo (music), Geoapify
 * and LocationIQ (places) and Thingiverse (models) as keys to add. None of them
 * can serve a photograph, so the advice was noise that read like a gate.
 */
test('missingKeysFor names only the suppliers that can serve that kind', (t) => {
  t.after(() => {
    for (const k of ['PEXELS_API_KEY', 'PIXABAY_API_KEY', 'JAMENDO_CLIENT_ID',
                     'GEOAPIFY_API_KEY', 'LOCATIONIQ_API_KEY', 'THINGIVERSE_APP_TOKEN']) delete process.env[k];
  });
  for (const k of ['PEXELS_API_KEY', 'PIXABAY_API_KEY', 'JAMENDO_CLIENT_ID',
                   'GEOAPIFY_API_KEY', 'LOCATIONIQ_API_KEY', 'THINGIVERSE_APP_TOKEN']) delete process.env[k];

  const pics = missingKeysFor('image');
  assert.deepEqual(pics, ['Pexels', 'Pixabay'],
    'only picture suppliers — no music, mapping or model keys');

  const sound = missingKeysFor('audio');
  assert.deepEqual(sound, ['Jamendo'], 'neither Pexels nor Pixabay serves audio');

  const models = missingKeysFor('model');
  assert.deepEqual(models, ['Thingiverse']);

  // A kind with no keyed supplier suggests nothing at all.
  assert.deepEqual(missingKeysFor('book'), [], 'Gutenberg needs no key, so nothing to suggest');

  process.env.PEXELS_API_KEY = 'pexels-test-key';
  const after = missingKeysFor('image');
  assert.deepEqual(after, ['Pixabay'], 'a loaded key drops out of the suggestion');
});
