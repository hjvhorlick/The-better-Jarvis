/**
 * THE OPEN WEB — search, facts, pictures, video and sound WITHOUT Gemini.
 *
 * This is the answer to "why spend quota to find out something the internet
 * already says". None of it touches Google, none of it counts against any
 * budget, and none of it can be switched off by a 429: a quota running out
 * means "no Gemini", it does not mean "no internet".
 *
 * Sources, in the order they are tried:
 *   Web search   DuckDuckGo's HTML endpoint          — no key
 *   Facts        Wikipedia's own API                 — no key
 *   Pictures     Pexels → Pixabay (free keys, if set)
 *                → Wikimedia Commons → Openverse     — no key
 *   Video        Pexels → Pixabay (free keys, if set)
 *                → the Internet Archive              — no key
 *   Sound        Wikimedia Commons → Openverse
 *                → the Internet Archive              — no key
 *
 * Every request goes through research/fetch.ts, so it inherits the protections
 * already proven there: public-address pinning (no private network can be
 * reached), redirect, size and time limits, and a content-type allow-list.
 * A key is never logged and never leaves this machine.
 *
 * The engines are ordered so that a missing key degrades instead of failing:
 * with no Pexels and no Pixabay key, pictures still come from Commons.
 */
import { fetchPublicBody, fetchPublicPage, type ExtractedPage, type FetchOptions } from '../research/fetch.js';
import { resolveImageServiceKeys, listCustomSuppliers, type ImageService, type CustomSupplier } from '../config.js';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'book' | 'model';

export interface MediaHit {
  kind: MediaKind;
  title: string;
  /** The file itself — what an <img>/<video>/<audio> tag points at. */
  url: string;
  /** A small preview, when the source offers one. */
  thumb: string | null;
  /** The page to credit, and where the licence is written down. */
  page: string;
  source: string;
  author: string | null;
  license: string | null;
}

export interface FactHit {
  title: string;
  extract: string;
  url: string;
  source: string;
}

export interface EngineOptions extends FetchOptions {
  /** Injected for tests: no test here reaches the network. */
  fetchBody?: (url: string, options: FetchOptions & { allowedContentTypes?: string[] }) => Promise<{ body: string }>;
  maxResults?: number;
  /** Turn one engine off without touching the others. */
  skip?: string[];
}

const JSON_TYPES = ['application/json', 'text/json', 'text/plain', 'text/html'];
const MAX_SNIPPET = 320;
const MAX_EXTRACT = 900;

/* ── small HTML hygiene ──────────────────────────────────────────────────────
 * These parsers read public HTML with regular expressions on purpose: no parser
 * dependency, no DOM, no script execution. Everything extracted is treated as
 * untrusted text — tags stripped, entities decoded, length capped — and it is
 * only ever displayed, never interpreted.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', copy: '©', reg: '®', trade: '™', middot: '·',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Strip tags and collapse whitespace: untrusted HTML becomes plain text. */
export function toPlainText(html: string, limit = MAX_SNIPPET): string {
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim();
}

function jsonString(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** DuckDuckGo wraps real destinations in a redirect; this unwraps them. */
export function unwrapDuckLink(href: string): string {
  if (!href) return '';
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  const wrapped = /[?&]uddg=([^&]+)/.exec(absolute);
  if (wrapped) {
    try { return decodeURIComponent(wrapped[1]); } catch { return absolute; }
  }
  return absolute;
}

async function getBody(url: string, options: EngineOptions = {}, extra?: FetchOptions & { allowedContentTypes?: string[] }) {
  const merged: FetchOptions & { allowedContentTypes?: string[] } = {
    allowedContentTypes: JSON_TYPES,
    ...options,
    ...extra,
  };
  delete (merged as { fetchBody?: unknown }).fetchBody;
  delete (merged as { skip?: unknown }).skip;
  delete (merged as { maxResults?: unknown }).maxResults;
  if (options.fetchBody) return options.fetchBody(url, merged);
  return fetchPublicBody(url, merged);
}

/* ── WEB SEARCH: DuckDuckGo's HTML endpoint, no key, no account ──────────── */
export function parseDuckResults(html: string, limit = 8): WebHit[] {
  const hits: WebHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = unwrapDuckLink(attr(link[0], 'href'));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = toPlainText(link[1], 160);
    const snippetMatch = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</i.exec(block);
    const snippet = snippetMatch ? toPlainText(snippetMatch[1]) : '';
    if (!title) continue;
    hits.push({ title, url, snippet, source: 'DuckDuckGo' });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Turn a transport failure into one honest sentence. The owner does not need a
 * stack trace; they need to know whether it was this machine's connection or
 * the source. Nothing here mentions a quota, because none of these paths use
 * one.
 */
export function explainFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || '');
  const code = (err as { code?: string })?.code || '';
  if (/ENOTFOUND|EAI_AGAIN|Invalid IP address|getaddrinfo/i.test(`${message} ${code}`)) {
    return 'this computer could not resolve the address — the network or DNS is not answering';
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(`${message} ${code}`)) {
    return 'the connection to the source was refused or timed out';
  }
  if (/unsafe-url|private or non-public/i.test(message)) {
    return 'that address is on a private network, so it was not opened';
  }
  if (/too-large/i.test(message)) return 'the source was larger than the fetch limit';
  if (/timeout/i.test(message)) return 'the source took too long to answer';
  return message || 'an unknown network error';
}

/**
 * The open web, searched without an API key and without Gemini.
 */
export async function searchWeb(query: string, options: EngineOptions = {}): Promise<WebHit[]> {
  const limit = options.maxResults ?? 8;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
  const page = await getBody(url, options, { allowedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'] });
  return parseDuckResults(page.body, limit);
}

/* ── FACTS: Wikipedia's own API, no key, attribution built in ────────────── */
export function parseWikiFact(payload: unknown): FactHit | null {
  const pages = (payload as { query?: { pages?: Record<string, unknown> } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return null;
  const first = Object.values(pages)[0] as
    | { title?: string; extract?: string; fullurl?: string; canonicalurl?: string }
    | undefined;
  if (!first) return null;
  const extract = toPlainText(String(first.extract || ''), MAX_EXTRACT);
  if (!extract) return null;
  const url = first.fullurl || first.canonicalurl
    || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(first.title || '').replace(/ /g, '_'))}`;
  return { title: String(first.title || 'Wikipedia'), extract, url, source: 'Wikipedia' };
}

/** A short, sourced answer to a factual question — no model, no quota. */
export async function wikiFact(query: string, options: EngineOptions = {}): Promise<FactHit | null> {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2'
    + '&prop=extracts|info&inprop=url&exintro=1&explaintext=1&redirects=1'
    + '&generator=search&gsrnamespace=0&gsrlimit=1'
    + `&gsrsearch=${encodeURIComponent(query.trim())}`;
  const page = await getBody(url, options);
  return parseWikiFact(jsonString(page.body));
}

/* ── PICTURES, VIDEO AND SOUND ───────────────────────────────────────────── */
function pexelsHeaders(key: string): Record<string, string> {
  return { Authorization: key, Accept: 'application/json' };
}

export function parsePexels(payload: unknown, kind: 'image' | 'video'): MediaHit[] {
  const items = (kind === 'image'
    ? (payload as { photos?: unknown[] })?.photos
    : (payload as { videos?: unknown[] })?.videos) || [];
  const hits: MediaHit[] = [];
  for (const raw of items) {
    const item = raw as {
      url?: string; photographer?: string; user?: { name?: string }; alt?: string; width?: number; height?: number;
      src?: Record<string, string>; image?: string; video_files?: Array<{ link?: string; width?: number; height?: number; quality?: string | null }>;
    };
    const author = item.photographer || item.user?.name || null;
    if (kind === 'image') {
      const file = item.src?.large2x || item.src?.large || item.src?.original;
      if (!file) continue;
      hits.push({
        kind: 'image', title: toPlainText(item.alt || 'Pexels picture', 120), url: file,
        thumb: item.src?.medium || item.src?.small || null, page: item.url || file,
        source: 'Pexels', author, license: 'Pexels licence (free to use)',
      });
    } else {
      // The docs warn that `quality` may be null on newer video files, so the
      // rendition is chosen by resolution, with `quality` only as a tie-breaker.
      const files = (item.video_files || []).filter((f) => f.link);
      const best = [...files].sort((a, b) => {
        const res = (b.width || 0) - (a.width || 0);
        if (res !== 0) return res;
        return (b.quality === 'hd' ? 1 : 0) - (a.quality === 'hd' ? 1 : 0);
      })[0];
      if (!best?.link) continue;
      hits.push({
        kind: 'video', title: toPlainText(item.alt || 'Pexels video', 120), url: best.link,
        thumb: item.image || null, page: item.url || best.link,
        source: 'Pexels', author, license: 'Pexels licence (free to use)',
      });
    }
  }
  return hits;
}

export function parsePixabay(payload: unknown, kind: 'image' | 'video'): MediaHit[] {
  const hits = (payload as { hits?: unknown[] })?.hits || [];
  const out: MediaHit[] = [];
  for (const raw of hits) {
    const item = raw as {
      pageURL?: string; tags?: string; user?: string; previewURL?: string; webformatURL?: string;
      largeImageURL?: string; videos?: Record<string, { url?: string; size?: number; thumbnail?: string }>; picture_id?: string;
    };
    const title = toPlainText(item.tags || 'Pixabay picture', 120);
    if (kind === 'image') {
      const file = item.largeImageURL || item.webformatURL;
      if (!file) continue;
      out.push({
        kind: 'image', title, url: file, thumb: item.previewURL || item.webformatURL || null,
        page: item.pageURL || file, source: 'Pixabay', author: item.user || null,
        license: 'Pixabay content licence (free to use)',
      });
    } else {
      const video = item.videos?.medium?.url || item.videos?.small?.url || item.videos?.tiny?.url;
      if (!video) continue;
      out.push({
        kind: 'video', title, url: video,
        thumb: item.videos?.medium?.thumbnail || item.videos?.small?.thumbnail
          || item.videos?.tiny?.thumbnail || null,
        page: item.pageURL || video, source: 'Pixabay', author: item.user || null,
        license: 'Pixabay content licence (free to use)',
      });
    }
  }
  return out;
}

export function parseCommons(payload: unknown, kind: 'image' | 'video' | 'audio'): MediaHit[] {
  const pages = (payload as { query?: { pages?: unknown[] } })?.query?.pages || [];
  const out: MediaHit[] = [];
  for (const raw of pages) {
    const item = raw as {
      title?: string; imageinfo?: Array<{
        url?: string; thumburl?: string; descriptionurl?: string; mime?: string;
        extmetadata?: Record<string, { value?: string }>;
      }>;
    };
    const info = item.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata || {};
    const clean = (value?: string) => (value ? toPlainText(value, 120) : null);
    out.push({
      kind,
      title: toPlainText(String(item.title || '').replace(/^File:/i, ''), 120),
      url: info.url,
      thumb: info.thumburl || null,
      page: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(item.title || ''))}`,
      source: 'Wikimedia Commons',
      author: clean(meta.Artist?.value),
      license: clean(meta.LicenseShortName?.value),
    });
  }
  return out;
}

export function parseOpenverse(payload: unknown, kind: 'image' | 'audio'): MediaHit[] {
  const results = (payload as { results?: unknown[] })?.results || [];
  const out: MediaHit[] = [];
  for (const raw of results) {
    const item = raw as {
      title?: string; url?: string; thumbnail?: string; foreign_landing_url?: string;
      creator?: string; license?: string; license_version?: string;
    };
    if (!item.url) continue;
    out.push({
      kind,
      title: toPlainText(item.title || 'Untitled', 120),
      url: item.url,
      thumb: item.thumbnail || null,
      page: item.foreign_landing_url || item.url,
      source: 'Openverse',
      author: item.creator || null,
      license: item.license ? `${item.license}${item.license_version ? ` ${item.license_version}` : ''}`.toUpperCase() : null,
    });
  }
  return out;
}

export function parseArchive(payload: unknown, kind: 'video' | 'audio'): MediaHit[] {
  const docs = (payload as { response?: { docs?: unknown[] } })?.response?.docs || [];
  const out: MediaHit[] = [];
  for (const raw of docs) {
    const item = raw as { identifier?: string; title?: string; creator?: string; licenseurl?: string };
    if (!item.identifier) continue;
    const page = `https://archive.org/details/${encodeURIComponent(item.identifier)}`;
    out.push({
      kind,
      title: toPlainText(String(item.title || item.identifier), 120),
      // The details page is what is handed back: archive.org serves many files
      // per item, and guessing a filename would hand over a broken link.
      url: page,
      thumb: `https://archive.org/services/img/${encodeURIComponent(item.identifier)}`,
      page,
      source: 'Internet Archive',
      author: typeof item.creator === 'string' ? item.creator : null,
      license: item.licenseurl || null,
    });
  }
  return out;
}

async function pexelsSearch(query: string, kind: 'image' | 'video', options: EngineOptions): Promise<MediaHit[]> {
  const key = resolveImageServiceKeys().pexels.key;
  if (!key) return [];
  const perPage = Math.min(options.maxResults ?? 6, 15);
  const q = encodeURIComponent(query);
  // Pexels documents video search at /v1/videos/search, while several guides and
  // SDKs use /videos/search. Rather than guess, the documented path is tried
  // first and the other is a fallback — a 404 on one is not an error to report.
  const candidates = kind === 'image'
    ? [`https://api.pexels.com/v1/search?query=${q}&per_page=${perPage}`]
    : [`https://api.pexels.com/v1/videos/search?query=${q}&per_page=${perPage}`,
       `https://api.pexels.com/videos/search?query=${q}&per_page=${perPage}`];
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const page = await getBody(url, options, { headers: pexelsHeaders(key) });
      const hits = parsePexels(jsonString(page.body), kind);
      if (hits.length) return hits;
    } catch (err) { lastError = err; }
  }
  if (lastError) throw lastError;
  return [];
}

async function pixabaySearch(query: string, kind: 'image' | 'video', options: EngineOptions): Promise<MediaHit[]> {
  const key = resolveImageServiceKeys().pixabay.key;
  if (!key) return [];
  const base = kind === 'image' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/';
  const url = `${base}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}`
    + `&per_page=${Math.max(3, Math.min(options.maxResults ?? 6, 200))}&safesearch=true`;
  const page = await getBody(url, options);
  return parsePixabay(jsonString(page.body), kind);
}

async function commonsSearch(query: string, kind: 'image' | 'video' | 'audio', options: EngineOptions): Promise<MediaHit[]> {
  const type = kind === 'image' ? 'bitmap' : kind === 'video' ? 'video' : 'audio';
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + '&generator=search&gsrnamespace=6&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=640'
    + `&gsrlimit=${Math.min(options.maxResults ?? 6, 20)}`
    + `&gsrsearch=${encodeURIComponent(`filetype:${type} ${query.trim()}`)}`;
  const page = await getBody(url, options);
  return parseCommons(jsonString(page.body), kind);
}

async function openverseSearch(query: string, kind: 'image' | 'audio', options: EngineOptions): Promise<MediaHit[]> {
  const url = `https://api.openverse.org/v1/${kind === 'audio' ? 'audio' : 'images'}/`
    + `?q=${encodeURIComponent(query.trim())}&page_size=${Math.min(options.maxResults ?? 6, 20)}`;
  const page = await getBody(url, options);
  return parseOpenverse(jsonString(page.body), kind);
}

export function parseJamendo(payload: unknown): MediaHit[] {
  const headers = (payload as { headers?: { status?: string; error_message?: string } })?.headers;
  if (headers && headers.status !== 'success') return [];
  const results = (payload as { results?: unknown[] })?.results || [];
  const out: MediaHit[] = [];
  for (const raw of results) {
    const item = raw as {
      id?: string; name?: string; artist_name?: string; album_name?: string;
      audio?: string; audiodownload?: string; image?: string; shareurl?: string;
      license_ccurl?: string; duration?: number;
    };
    // `audio` is a streamable URL and the docs promise it; without it there is
    // nothing to play, so the track is not offered as a result.
    if (!item.audio) continue;
    const licence = item.license_ccurl ? toPlainText(item.license_ccurl, 90) : null;
    out.push({
      kind: 'audio',
      title: toPlainText([item.name, item.album_name].filter(Boolean).join(' — ') || String(item.name || item.id || 'Track'), 120),
      url: item.audio,
      thumb: item.image || null,
      page: item.shareurl || `https://www.jamendo.com/track/${encodeURIComponent(String(item.id || ''))}`,
      source: 'Jamendo',
      author: item.artist_name ? toPlainText(item.artist_name, 90) : null,
      // Read per track: Jamendo's catalogue is Creative Commons but the terms
      // differ between tracks, and the API says which applies.
      license: licence ? `Creative Commons — ${licence}` : 'Creative Commons (see the track page)',
    });
  }
  return out;
}

async function jamendoSearch(query: string, options: EngineOptions): Promise<MediaHit[]> {
  const clientId = resolveImageServiceKeys().jamendo.key;
  if (!clientId) return [];
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json`
    + `&limit=${Math.min(options.maxResults ?? 6, 50)}&audioformat=mp32`
    + `&search=${encodeURIComponent(query.trim())}`;
  const page = await getBody(url, options);
  return parseJamendo(jsonString(page.body));
}

/**
 * Gutendex — Project Gutenberg's public JSON API. No key at all, and the whole
 * catalogue is public domain, which matters for a book that will be re-used in
 * something else: there is no per-title licence to hunt down.
 *
 * The response is `{ count, next, previous, results: [...] }` and each result
 * carries a `formats` map of MIME type to the actual file, so the download link
 * is read rather than built out of the book id.
 */
export function parseGutendex(payload: unknown): MediaHit[] {
  const results = (payload as { results?: unknown[] })?.results || [];
  const out: MediaHit[] = [];
  for (const raw of results) {
    const item = raw as {
      id?: number; title?: string; download_count?: number;
      authors?: Array<{ name?: string; birth_year?: number; death_year?: number }>;
      formats?: Record<string, string>;
    };
    if (!item.title || !item.id) continue;
    const formats = item.formats || {};
    // Prefer a plain-text file: it is the one a book-building app can actually
    // parse, re-flow and re-typeset. EPUB and Kindle are kept as the fallback.
    const file = formats['text/plain; charset=utf-8'] || formats['text/plain']
      || formats['application/epub+zip'] || formats['application/x-mobipocket-ebook']
      || formats['text/html; charset=utf-8'] || formats['text/html'];
    const author = item.authors?.[0]?.name;
    out.push({
      kind: 'book',
      title: toPlainText(item.title, 160),
      // A book is still worth offering by its page when a file link is absent —
      // the page lists every format.
      url: file || `https://www.gutenberg.org/ebooks/${item.id}`,
      thumb: null,
      page: `https://www.gutenberg.org/ebooks/${item.id}`,
      source: 'Project Gutenberg',
      author: author ? toPlainText(author, 120) : null,
      license: 'Public domain (Project Gutenberg) — see the licence note in the file',
    });
  }
  return out;
}

async function gutenbergSearch(query: string, options: EngineOptions): Promise<MediaHit[]> {
  const url = `https://gutendex.com/books?search=${encodeURIComponent(query.trim())}`;
  const page = await getBody(url, options);
  return parseGutendex(jsonString(page.body));
}

async function archiveSearch(query: string, kind: 'video' | 'audio', options: EngineOptions): Promise<MediaHit[]> {
  const mediatype = kind === 'video' ? 'movies' : 'audio';
  const url = 'https://archive.org/advancedsearch.php?q='
    + encodeURIComponent(`${query.trim()} AND mediatype:(${mediatype})`)
    + `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=licenseurl&rows=${Math.min(options.maxResults ?? 6, 20)}`
    + '&page=1&output=json';
  const page = await getBody(url, options);
  return parseArchive(jsonString(page.body), kind);
}

type Engine = { name: string; run: () => Promise<MediaHit[]> };

/**
 * Try each source in order and return the first that produces anything.
 * A source that fails — no key, unreachable, changed its markup — is skipped
 * rather than reported: the owner asked for a picture, not a status report.
 */
async function firstWorking(engines: Engine[], skip: string[] = []): Promise<MediaHit[]> {
  for (const engine of engines) {
    if (skip.includes(engine.name)) continue;
    try {
      const hits = await engine.run();
      if (hits.length) return hits;
    } catch { /* the next source gets its turn */ }
  }
  return [];
}

/**
 * Thingiverse — 3D printable models. A free App Token from the developer portal
 * is enough to read; the full OAuth dance is only for writing.
 *
 * HONEST NOTE ON THE SHAPE: the search path and its query parameter are the one
 * part of this file not confirmed against a live response, because this sandbox
 * cannot reach api.thingiverse.com. Working code in the wild calls
 * GET /search/ with `type=things`, `sort`, `page` and `per_page`, and answers
 * either with a bare array or with a `hits` wrapper — so both are read, and both
 * spellings of the query parameter are tried. A live search on the owner's
 * machine is what settles it.
 */
export function parseThingiverse(payload: unknown): MediaHit[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { hits?: unknown[] })?.hits || [];
  const out: MediaHit[] = [];
  for (const raw of list) {
    const item = raw as {
      id?: number | string; name?: string; public_url?: string; thumbnail?: string;
      creator?: { name?: string }; like_count?: number;
    };
    if (!item.name) continue;
    const page = item.public_url || (item.id ? `https://www.thingiverse.com/thing:${item.id}` : null);
    out.push({
      kind: 'model',
      title: toPlainText(item.name, 160),
      // The listing gives the thing's page, not the STL. Pointing at the page is
      // honest; inventing a download URL from the id is not.
      url: page || `https://www.thingiverse.com/thing:${item.id}`,
      thumb: item.thumbnail || null,
      page,
      source: 'Thingiverse',
      author: item.creator?.name ? toPlainText(item.creator.name, 90) : null,
      license: 'See the licence on the model page — Thingiverse models are not all alike',
    });
  }
  return out;
}

async function thingiverseSearch(query: string, options: EngineOptions): Promise<MediaHit[]> {
  const token = resolveImageServiceKeys().thingiverse.key;
  if (!token) return [];
  const perPage = Math.min(options.maxResults ?? 6, 30);
  // Both spellings, documented path first: `q=` as a parameter, then the
  // path form. Whichever the API is currently serving, one of these answers.
  const candidates = [
    `https://api.thingiverse.com/search/?q=${encodeURIComponent(query.trim())}&type=things&sort=relevant&per_page=${perPage}`,
    `https://api.thingiverse.com/search/${encodeURIComponent(query.trim())}/things?per_page=${perPage}`,
  ];
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const page = await getBody(url, options, { headers: { Authorization: `Bearer ${token}` } });
      const hits = parseThingiverse(jsonString(page.body));
      if (hits.length) return hits;
    } catch (err) { lastError = err; }
  }
  if (lastError) throw lastError;
  return [];
}

/**
 * Commons hosts STL files of its own — File:Dawn 3D Model.stl is one, served as
 * application/sla. They sit under MediaWiki's "drawing" file type, which also
 * covers SVG, so the parser keeps only the formats a printer can actually use.
 */
export function parseCommonsModels(payload: unknown): MediaHit[] {
  const printable = /stl|sla|obj|3mf|amf|ply/i;
  const pages = (payload as { query?: { pages?: unknown[] } })?.query?.pages || [];
  const out: MediaHit[] = [];
  for (const raw of pages) {
    const item = raw as {
      title?: string; imageinfo?: Array<{
        url?: string; thumburl?: string; descriptionurl?: string; mime?: string;
        extmetadata?: Record<string, { value?: string }>;
      }>;
    };
    const info = item.imageinfo?.[0];
    // An SVG is a drawing, not something you can print. Filtered here rather than
    // left for the owner to discover at the slicer.
    if (!info?.url || !printable.test(String(info.mime || ''))) continue;
    const meta = info.extmetadata || {};
    const clean = (value?: string) => (value ? toPlainText(value, 120) : null);
    out.push({
      kind: 'model',
      title: toPlainText(String(item.title || '').replace(/^File:/i, ''), 160),
      url: info.url,
      thumb: info.thumburl || null,
      page: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(item.title || ''))}`,
      source: 'Wikimedia Commons',
      author: clean(meta.Artist?.value),
      license: clean(meta.LicenseShortName?.value),
    });
  }
  return out;
}

async function commonsModelSearch(query: string, options: EngineOptions): Promise<MediaHit[]> {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + '&generator=search&gsrnamespace=6&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=320'
    + `&gsrlimit=${Math.min(options.maxResults ?? 6, 20)}`
    + `&gsrsearch=${encodeURIComponent(`filetype:drawing ${query.trim()} (stl OR 3d OR model)`)}`;
  const page = await getBody(url, options);
  return parseCommonsModels(jsonString(page.body));
}

/* ── the supplier registry ───────────────────────────────────────────────────
 * A supplier is a row of data, not a chain of code. Each one declares which
 * kinds of file it can hand over and, if it wants a key, which key. Order in
 * this array is the order sources are tried for a given kind.
 *
 * That is what makes "eventually there will be a source for every type of file"
 * cheap rather than a rewrite: a new supplier is one entry here, and a whole new
 * type of file is one word added to MediaKind plus one search function. Nothing
 * else in the app has to know which suppliers exist.
 */
export interface MediaSource {
  /** Stable id: what `skip` refers to and what Settings stores a key under. */
  id: string;
  label: string;
  /** Which kinds of file this supplier can actually deliver. */
  kinds: MediaKind[];
  /** The key it needs, if it needs one at all. */
  key?: ImageService;
  /** One line for the registration area — what it is good for. */
  blurb: string;
  signup?: string;
  search: (query: string, kind: MediaKind, options: EngineOptions) => Promise<MediaHit[]>;
}

const KINDS = {
  pics: ['image'] as MediaKind[],
  film: ['video'] as MediaKind[],
  picsFilm: ['image', 'video'] as MediaKind[],
  sound: ['audio'] as MediaKind[],
  reads: ['book'] as MediaKind[],
  solid: ['model'] as MediaKind[],
};

const MEDIA_SOURCES: MediaSource[] = [
  {
    id: 'pexels', label: 'Pexels', kinds: KINDS.picsFilm, key: 'pexels',
    blurb: 'Stock photographs and video clips. Free key; 200 requests an hour. Pexels has paused new key issuance, so an existing key is worth keeping.',
    signup: 'https://www.pexels.com/api/',
    search: (q, kind, o) => (kind === 'image' || kind === 'video' ? pexelsSearch(q, kind, o) : Promise.resolve([])),
  },
  {
    id: 'pixabay', label: 'Pixabay', kinds: KINDS.picsFilm, key: 'pixabay',
    blurb: 'Stock photographs, illustrations and video clips. Free key, 100 requests a minute. No audio endpoint in its public API.',
    signup: 'https://pixabay.com/api/docs/',
    search: (q, kind, o) => (kind === 'image' || kind === 'video' ? pixabaySearch(q, kind, o) : Promise.resolve([])),
  },
  {
    id: 'jamendo', label: 'Jamendo', kinds: KINDS.sound, key: 'jamendo',
    blurb: 'Music. A free client ID, 35,000 requests a month, every track Creative Commons with its own licence named in the response.',
    signup: 'https://developer.jamendo.com/v3.0/docs',
    search: (q, _kind, o) => jamendoSearch(q, o),
  },
  {
    // Key-free, and first for books: the whole catalogue is public domain, so
    // a downloaded book can be re-used in anything without reading a licence.
    id: 'gutenberg', label: 'Project Gutenberg', kinds: KINDS.reads,
    blurb: 'Over 75,000 public-domain books, each offered as plain text, HTML, EPUB and Kindle. No key, and no terms to read per title.',
    signup: 'https://gutendex.com/',
    search: (q, _kind, o) => gutenbergSearch(q, o),
  },
  {
    id: 'thingiverse', label: 'Thingiverse', kinds: KINDS.solid, key: 'thingiverse',
    blurb: '3D printable models — the largest legacy library. A free App Token from the developer portal reads it; the licence is per model, so it is read on the page.',
    signup: 'https://www.thingiverse.com/developers',
    search: (q, kind, o) => (kind === 'model' ? thingiverseSearch(q, o) : Promise.resolve([])),
  },
  {
    id: 'commons', label: 'Wikimedia Commons', kinds: [...KINDS.picsFilm, 'audio', 'model'] as MediaKind[],
    blurb: 'Pictures, video, sound and STL files with no key at all. Every file carries its own licence, which is read and kept.',
    signup: 'https://commons.wikimedia.org/',
    search: (q, kind, o) => (kind === 'model'
      ? commonsModelSearch(q, o)
      : kind === 'book' ? Promise.resolve([]) : commonsSearch(q, kind, o)),
  },
  {
    id: 'openverse', label: 'Openverse', kinds: [...KINDS.pics, ...KINDS.sound] as MediaKind[],
    blurb: 'Hundreds of millions of openly licensed pictures and audio recordings, gathered from museums and collections. No key.',
    signup: 'https://api.openverse.org/',
    search: (q, kind, o) => (kind === 'image' || kind === 'audio' ? openverseSearch(q, kind, o) : Promise.resolve([])),
  },
  {
    id: 'archive', label: 'Internet Archive', kinds: [...KINDS.film, ...KINDS.sound] as MediaKind[],
    blurb: 'Video and sound, plus books and scanned documents. No key. Answers with the item\u2019s own page, so the file is never guessed at.',
    signup: 'https://archive.org/',
    search: (q, kind, o) => (kind === 'video' || kind === 'audio' ? archiveSearch(q, kind, o) : Promise.resolve([])),
  },
];

/* ── suppliers the owner registered themselves ──────────────────────────────
 * These are data in config/suppliers.json, not entries in the table above, so
 * an application becomes a supplier without an edit here or a restart. They are
 * tried FIRST, because the owner just registered them and that is the answer
 * they are expecting; the built-ins still catch anything they miss.
 *
 * The endpoint is fetched through getBody, so it inherits the same public
 * address pinning, redirect, size and timeout limits as every built-in. There
 * is no separate rule for custom endpoints and no separate hole to leave in one.
 */

/** Read `a.b.c` out of an untrusted answer. Never throws; absent is null. */
function dig(value: unknown, dotPath: string): unknown {
  if (!dotPath) return value;
  let cursor: unknown = value;
  for (const part of dotPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? null;
}

/**
 * Turn one registered supplier's answer into hits. Everything read from the
 * response is treated as untrusted text and only ever displayed.
 */
export function parseCustomSupplier(payload: unknown, supplier: CustomSupplier, kind: MediaKind): MediaHit[] {
  const listValue = supplier.listPath ? dig(payload, supplier.listPath) : payload;
  const rows = Array.isArray(listValue) ? listValue : [];
  const out: MediaHit[] = [];
  for (const raw of rows) {
    const title = dig(raw, supplier.titlePath);
    const url = dig(raw, supplier.urlPath);
    // A row with no title or no address is not a result. Dropping it is better
    // than showing a blank line the owner has to interpret.
    if (typeof title !== 'string' && typeof title !== 'number') continue;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const thumb = dig(raw, supplier.thumbPath || '');
    const author = dig(raw, supplier.authorPath || '');
    const license = dig(raw, supplier.licensePath || '');
    out.push({
      kind,
      title: toPlainText(String(title), 160),
      url,
      thumb: typeof thumb === 'string' && /^https?:\/\//i.test(thumb) ? thumb : null,
      page: url,
      source: supplier.label,
      author: typeof author === 'string' ? toPlainText(author, 90) : null,
      license: typeof license === 'string' ? toPlainText(license, 120) : null,
    });
  }
  return out;
}

async function customSupplierSearch(supplier: CustomSupplier, query: string, kind: MediaKind, options: EngineOptions): Promise<MediaHit[]> {
  const limit = Math.min(options.maxResults ?? 6, 50);
  const url = supplier.endpoint
    .split('{query}').join(encodeURIComponent(query.trim()))
    .split('{limit}').join(String(limit));
  const headers: Record<string, string> = {};
  if (supplier.key && supplier.keyHeader) {
    headers[supplier.keyHeader] = `${supplier.keyPrefix || ''}${supplier.key}`;
  }
  const page = await getBody(url, options, { headers });
  return parseCustomSupplier(jsonString(page.body), supplier, kind);
}

/** The registered suppliers as MediaSources, so the one chain serves both. */
function customSources(): MediaSource[] {
  return listCustomSuppliers().map((supplier) => ({
    id: supplier.id,
    label: supplier.label,
    kinds: supplier.kinds.filter((k): k is MediaKind => MEDIA_KINDS.includes(k as MediaKind)),
    blurb: supplier.note || `Registered by the owner — ${supplier.endpoint.replace(/\{query\}/g, '…').slice(0, 90)}`,
    signup: null,
    search: (q, kind, o) => customSupplierSearch(supplier, q, kind, o),
  }));
}

/**
 * The registry as the owner sees it: every supplier, what it covers, and whether
 * the key it wants is present. Nothing here is a gate — a supplier with no key
 * is simply further down the order, and the key-free ones always answer.
 */
export function describeSources(): Array<{ id: string; label: string; kinds: MediaKind[]; needsKey: boolean; keyPresent: boolean; blurb: string; signup: string | null; custom?: boolean }> {
  const keys = resolveImageServiceKeys();
  const registered = customSources().map((source) => ({
    id: source.id,
    label: source.label,
    kinds: [...source.kinds],
    needsKey: false,
    keyPresent: true,
    blurb: source.blurb,
    signup: null,
    custom: true,
  }));
  return [...registered, ...MEDIA_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    kinds: [...source.kinds],
    needsKey: Boolean(source.key),
    keyPresent: source.key ? Boolean(keys[source.key].key) : true,
    blurb: source.blurb,
    signup: source.signup ?? null,
  }))];
}

/** The kinds of file this build knows how to go and fetch. */
export const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'audio', 'book', 'model'];

/**
 * Find any kind of file. Walks the registry in order for that kind and returns
 * the first supplier that produced anything — so a supplier that is down, has no
 * key, or changed its markup is simply passed over, never reported.
 */
export async function searchMedia(kind: MediaKind, query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  // Registered suppliers first: the owner just added them, so they are the
  // answer being asked for. The built-ins run afterwards and catch anything the
  // registered one does not have.
  const chain = [...customSources(), ...MEDIA_SOURCES]
    .filter((source) => source.kinds.includes(kind))
    .map((source) => ({ name: source.id, run: () => source.search(query, kind, options) }));
  return firstWorking(chain, options.skip);
}

/** Pictures: the owner's Pexels/Pixabay keys first, Commons and Openverse after. */
export async function searchImages(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return searchMedia('image', query, options);
}

/** Video: Pexels and Pixabay first, then the Internet Archive. */
export async function searchVideos(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return searchMedia('video', query, options);
}

/**
 * Sound. Neither Pexels nor Pixabay serves audio through its public API — that
 * is in both sets of documentation — so Jamendo leads and the key-free Commons,
 * Openverse and Internet Archive cover it when there is no client ID.
 */
export async function searchAudio(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return searchMedia('audio', query, options);
}

/** Books: Project Gutenberg through Gutendex. No key, and public domain. */
export async function searchBooks(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return searchMedia('book', query, options);
}

/** 3D printable models: Thingiverse when a token is loaded, Commons STL otherwise. */
export async function searchModels(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return searchMedia('model', query, options);
}

/**
 * The keyed suppliers that could serve THIS kind and have no key yet — so a
 * reply can suggest the right ones. Naming a music or mapping key after a failed
 * picture search is noise, and it is the registry's job to know the difference.
 *
 * This is a suggestion, never a gate: the key-free suppliers behind them already
 * ran, and their silence is what is being reported.
 */
export function missingKeysFor(kind: MediaKind): string[] {
  const keys = resolveImageServiceKeys();
  return MEDIA_SOURCES
    .filter((source) => source.key && source.kinds.includes(kind) && !keys[source.key].key)
    .map((source) => source.label);
}

/** Which of the optional keys are set — for Settings, never the key itself. */
export function imageKeyStatus(): Array<{ service: ImageService; label: string; present: boolean; tail: string | null; detail: string }> {
  const keys = resolveImageServiceKeys();
  return (Object.keys(keys) as ImageService[]).map((service) => ({
    service,
    label: keys[service].label,
    present: Boolean(keys[service].key),
    tail: keys[service].tail,
    detail: keys[service].detail,
  }));
}

/** Read one page as text, with the same protections as Internet Research. */
export async function readUrl(url: string, options: EngineOptions = {}): Promise<ExtractedPage> {
  return fetchPublicPage(url, options);
}

/* ── the answer the owner actually wants ─────────────────────────────────────
 * Facts first (Wikipedia, structured and attributed), then the open web. No
 * model is involved, so there is nothing to wait for and nothing to spend.
 */
export interface WebAnswer {
  reply: string;
  hits: WebHit[];
  fact: FactHit | null;
  sources: string[];
}

export async function answerFromWeb(query: string, options: EngineOptions = {}): Promise<WebAnswer> {
  const limit = options.maxResults ?? 5;
  const [fact, hits] = await Promise.all([
    wikiFact(query, options).catch(() => null),
    searchWeb(query, { ...options, maxResults: limit }).catch(() => [] as WebHit[]),
  ]);
  const sources = [...new Set([...(fact ? [fact.source] : []), ...hits.map((h) => h.source)])];
  const lines: string[] = [];
  if (fact) {
    lines.push(`${fact.extract}\n\n— ${fact.title}, Wikipedia: ${fact.url}`);
  }
  if (hits.length) {
    const list = hits.slice(0, limit).map((hit, i) =>
      `${i + 1}. ${hit.title} — ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`).join('\n');
    lines.push(`${fact ? 'And from the open web' : 'From the open web'}:\n${list}`);
  }
  if (!lines.length) {
    return {
      reply: `I searched the open web for “${query.trim()}” and got nothing usable back. No model was involved and nothing was counted.`,
      hits, fact: null, sources,
    };
  }
  return { reply: lines.join('\n\n'), hits, fact, sources };
}
