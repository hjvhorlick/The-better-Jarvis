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
  searchImages, searchVideos, searchAudio, searchWeb, wikiFact, answerFromWeb, imageKeyStatus,
  explainFetchError,
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
