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
import { resolveImageServiceKeys, type ImageService } from '../config.js';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface MediaHit {
  kind: 'image' | 'video' | 'audio';
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
      src?: Record<string, string>; image?: string; video_files?: Array<{ link?: string; width?: number; quality?: string }>;
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
      const files = (item.video_files || []).filter((f) => f.link);
      const best = files.find((f) => f.quality === 'hd') || files[0];
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
      largeImageURL?: string; videos?: Record<string, { url?: string; size?: number }>; picture_id?: string;
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
        thumb: item.picture_id ? `https://i.vimeocdn.com/video/${item.picture_id}_295x166.jpg` : null,
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
  const url = kind === 'image'
    ? `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Math.min(options.maxResults ?? 6, 15)}`
    : `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${Math.min(options.maxResults ?? 6, 15)}`;
  const page = await getBody(url, options, { headers: pexelsHeaders(key) });
  return parsePexels(jsonString(page.body), kind);
}

async function pixabaySearch(query: string, kind: 'image' | 'video', options: EngineOptions): Promise<MediaHit[]> {
  const key = resolveImageServiceKeys().pixabay.key;
  if (!key) return [];
  const base = kind === 'image' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/';
  const url = `${base}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}`
    + `&per_page=${Math.max(3, Math.min(options.maxResults ?? 6, 20))}&safesearch=true`;
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

/** Pictures: the owner's Pexels/Pixabay keys first, Commons and Openverse after. */
export async function searchImages(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return firstWorking([
    { name: 'pexels', run: () => pexelsSearch(query, 'image', options) },
    { name: 'pixabay', run: () => pixabaySearch(query, 'image', options) },
    { name: 'commons', run: () => commonsSearch(query, 'image', options) },
    { name: 'openverse', run: () => openverseSearch(query, 'image', options) },
  ], options.skip);
}

/** Video: Pexels and Pixabay first, then the Internet Archive. */
export async function searchVideos(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return firstWorking([
    { name: 'pexels', run: () => pexelsSearch(query, 'video', options) },
    { name: 'pixabay', run: () => pixabaySearch(query, 'video', options) },
    { name: 'archive', run: () => archiveSearch(query, 'video', options) },
  ], options.skip);
}

/**
 * Sound. Neither Pexels nor Pixabay serves audio through its public API, so the
 * key-free sources are the ones that actually work: Commons, Openverse, Archive.
 */
export async function searchAudio(query: string, options: EngineOptions = {}): Promise<MediaHit[]> {
  return firstWorking([
    { name: 'commons', run: () => commonsSearch(query, 'audio', options) },
    { name: 'openverse', run: () => openverseSearch(query, 'audio', options) },
    { name: 'archive', run: () => archiveSearch(query, 'audio', options) },
  ], options.skip);
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
