import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IncomingHttpHeaders, RequestOptions } from 'node:http';

export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_PAGE_EXCERPT_CHARS = 1_800;
export const MAX_REDIRECTS = 3;
export const PAGE_TIMEOUT_MS = 8_000;
const MIN_USEFUL_TEXT = 160;

export type FetchFailureCode = 'unsafe-url' | 'timeout' | 'too-large' | 'bad-status' | 'bad-content-type' | 'malformed' | 'insufficient';

export class ResearchFetchError extends Error {
  code: FetchFailureCode;
  constructor(code: FetchFailureCode, message: string) {
    super(message);
    this.name = 'ResearchFetchError';
    this.code = code;
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new ResearchFetchError('timeout', 'The source page timed out.'));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ResearchFetchError('timeout', 'The source page timed out.')), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export interface PinnedAddress { address: string; family: 4 | 6; }
export interface PageResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: Buffer;
}
export interface ExtractedPage {
  finalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  excerpt: string;
  textLength: number;
}
export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Extra request headers — how a keyed API (Pexels, Pixabay) is authorised. */
  headers?: Record<string, string>;
  resolve?: (hostname: string) => Promise<PinnedAddress[]>;
  request?: (url: URL, address: PinnedAddress, limits: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }) => Promise<PageResponse>;
}

function inCidr4(address: string, network: string, prefix: number): boolean {
  const asNumber = (input: string): number => input.split('.').reduce((sum, octet) => ((sum << 8) | Number(octet)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (asNumber(address) & mask) === (asNumber(network) & mask);
}

const NON_PUBLIC_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv6Number(address: string): bigint | null {
  let input = address.toLowerCase();
  if (input.includes('%')) return null; // scoped/local interface address
  if (input.includes('.')) {
    const split = input.lastIndexOf(':');
    if (split < 0 || net.isIP(input.slice(split + 1)) !== 4) return null;
    const octets = input.slice(split + 1).split('.').map(Number);
    const left = ((octets[0] << 8) | octets[1]).toString(16);
    const right = ((octets[2] << 8) | octets[3]).toString(16);
    input = `${input.slice(0, split)}:${left}:${right}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8 || words.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inCidr6(address: string, network: string, prefix: number): boolean {
  const target = ipv6Number(address);
  const base = ipv6Number(network);
  if (target === null || base === null) return true; // malformed addresses fail closed
  const shift = BigInt(128 - prefix);
  return (target >> shift) === (base >> shift);
}

/** True only for globally routable unicast addresses; internal and special-use blocks fail closed. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.some(([network, prefix]) => inCidr4(address, network, prefix));
  if (family !== 6) return false;
  if (!inCidr6(address, '2000::', 3)) return false; // global unicast only
  const nonPublicV6: Array<[string, number]> = [
    ['2001::', 23], // IETF special-purpose assignments (Teredo, ORCHID)
    ['2001:db8::', 32], // IPv6 documentation prefix
    ['2002::', 16], // 6to4 transition addresses
    ['3fff::', 20], // additional documentation prefix
  ];
  return !nonPublicV6.some(([network, prefix]) => inCidr6(address, network, prefix));
}

function parseHttpUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2_048) {
    throw new ResearchFetchError('unsafe-url', 'The source URL is missing or exceeds the 2,048-character limit.');
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ResearchFetchError('unsafe-url', 'The source URL is malformed.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new ResearchFetchError('unsafe-url', 'Only public HTTP or HTTPS source URLs are allowed.');
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) {
    throw new ResearchFetchError('unsafe-url', 'Non-standard source ports are blocked.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      /\.(?:local|internal|test|invalid|example|onion)$/.test(hostname) ||
      (!hostname.includes('.') && net.isIP(hostname) === 0)) {
    throw new ResearchFetchError('unsafe-url', 'Local, private, or reserved source names are blocked.');
  }
  const family = net.isIP(hostname);
  if (family && !isPublicAddress(hostname)) {
    throw new ResearchFetchError('unsafe-url', 'Private or special-use IP addresses are blocked.');
  }
  url.hash = '';
  return url;
}

async function resolvePublic(hostname: string): Promise<PinnedAddress[]> {
  const family = net.isIP(hostname);
  if (family) return [{ address: hostname, family: family as 4 | 6 }];
  let records: Array<{ address: string; family: number }>;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new ResearchFetchError('unsafe-url', 'The source hostname could not be safely resolved.'); }
  if (!records.length || records.some((entry) => !isPublicAddress(entry.address))) {
    throw new ResearchFetchError('unsafe-url', 'The source resolves to a private or non-public network address; it was blocked.');
  }
  return records.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

export async function resolvePublicDestination(
  rawUrl: string,
  resolver: (hostname: string) => Promise<PinnedAddress[]> = resolvePublic,
  timeoutMs = PAGE_TIMEOUT_MS,
): Promise<{ url: URL; addresses: PinnedAddress[] }> {
  const url = parseHttpUrl(rawUrl);
  const addresses = await withTimeout(Promise.resolve().then(() => resolver(url.hostname)), timeoutMs);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ResearchFetchError('unsafe-url', 'The source resolves to a private or non-public network address; it was blocked.');
  }
  return { url, addresses };
}

export async function isSafePublicHttpUrl(rawUrl: string): Promise<boolean> {
  try { await resolvePublicDestination(rawUrl); return true; }
  catch { return false; }
}

function headerValue(headers: PageResponse['headers'], name: string): string {
  const value = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

async function requestPinned(url: URL, address: PinnedAddress, limits: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }): Promise<PageResponse> {
  const transport = url.protocol === 'https:' ? https : http;
  const lookup = ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
    callback(null, address.address, address.family);
  }) as RequestOptions['lookup'];
  return new Promise((resolve, reject) => {
    let done = false;
    let hardTimer: NodeJS.Timeout | undefined;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      if (hardTimer) clearTimeout(hardTimer);
      reject(error);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${url.pathname || '/'}${url.search}`,
      lookup,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      headers: {
        Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Supper-AI-Research/1.0',
        ...(limits.headers || {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const declared = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        response.destroy();
        request.destroy();
        fail(new ResearchFetchError('too-large', `The source page exceeds the ${limits.maxBytes}-byte fetch limit.`));
        return;
      }
      response.on('data', (chunk: Buffer | string) => {
        if (done) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limits.maxBytes) {
          response.destroy();
          request.destroy();
          fail(new ResearchFetchError('too-large', `The source page exceeds the ${limits.maxBytes}-byte fetch limit.`));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (done) return;
        done = true;
        if (hardTimer) clearTimeout(hardTimer);
        resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on('error', fail);
    });
    // The socket timeout is an idle timeout. The hard timer below makes the
    // request deadline absolute, even if a remote server trickles bytes.
    request.setTimeout(limits.timeoutMs, () => {
      request.destroy(new ResearchFetchError('timeout', 'The source page timed out.'));
    });
    request.on('error', fail);
    hardTimer = setTimeout(() => {
      request.destroy(new ResearchFetchError('timeout', 'The source page timed out.'));
    }, limits.timeoutMs);
    request.end();
  });
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™',
  };
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const number = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(number) || number < 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return '\uFFFD';
    try { return String.fromCodePoint(number); } catch { return '\uFFFD'; }
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let match = pattern.exec(tag); match; match = pattern.exec(tag)) {
    out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

function dateOnly(value: string): string | null {
  const clean = value.trim();
  if (!clean) return null;
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function extractReadablePage(html: string, finalUrl = ''): Omit<ExtractedPage, 'finalUrl'> {
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '';
  let title = decodeEntities(titleTag.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  let publisher = '';
  let publishedAt: string | null = null;
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attr = attrs(tag);
    const key = (attr.property || attr.name || attr.itemprop || '').toLowerCase();
    const content = attr.content || '';
    if (!title && (key === 'og:title' || key === 'twitter:title')) title = content.trim();
    if (!publisher && (key === 'og:site_name' || key === 'application-name')) publisher = content.trim();
    if (!publishedAt && /^(?:article:published_time|datepublished|datecreated|publish_date|pubdate)$/.test(key)) {
      publishedAt = dateOnly(content);
    }
  }
  if (!publishedAt) {
    const time = html.match(/<time\b[^>]*>/i)?.[0];
    if (time) publishedAt = dateOnly(attrs(time).datetime || '');
  }
  if (!publisher && finalUrl) {
    try { publisher = new URL(finalUrl).hostname.replace(/^www\./i, ''); } catch { /* optional */ }
  }

  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas|form|nav|footer|header|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas|form|nav|footer|header|template)\b[^>]*\/?\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(withoutNoise)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  title = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  publisher = publisher.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (text.length < MIN_USEFUL_TEXT) {
    throw new ResearchFetchError('insufficient', 'The accessible page did not contain enough readable text to verify useful details.');
  }
  return {
    title: title || 'Untitled page',
    publisher: publisher || 'Publisher not identified',
    publishedAt,
    excerpt: text.slice(0, MAX_PAGE_EXCERPT_CHARS),
    textLength: text.length,
  };
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(body).replace(/^\uFEFF/, ''); }
  catch { return body.toString('utf8').replace(/^\uFEFF/, ''); }
}

/** Fetch one public page with pinned public DNS, bounded redirects, response size, and timeout. */
/**
 * The one safe outbound GET: public-address pinning, redirect, size and time
 * limits, and an allow-list of content types. Returns the raw decoded body so
 * callers can read JSON APIs as well as HTML — the search engine uses this for
 * Wikipedia, Wikimedia Commons and Openverse, none of which need a key.
 */
export async function fetchPublicBody(
  rawUrl: string,
  options: FetchOptions & { allowedContentTypes?: string[] } = {},
): Promise<{ finalUrl: string; body: string; contentType: string; headers: PageResponse['headers'] }> {
  const timeoutCandidate = options.timeoutMs ?? PAGE_TIMEOUT_MS;
  const bytesCandidate = options.maxBytes ?? MAX_PAGE_BYTES;
  const redirectsCandidate = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = Number.isFinite(timeoutCandidate) ? Math.max(1, Math.min(timeoutCandidate, PAGE_TIMEOUT_MS)) : PAGE_TIMEOUT_MS;
  const maxBytes = Number.isFinite(bytesCandidate) ? Math.max(1, Math.min(bytesCandidate, MAX_PAGE_BYTES)) : MAX_PAGE_BYTES;
  const maxRedirects = Number.isFinite(redirectsCandidate) ? Math.max(0, Math.min(redirectsCandidate, MAX_REDIRECTS)) : MAX_REDIRECTS;
  const resolve = options.resolve || resolvePublic;
  const request = options.request || requestPinned;
  const deadline = Date.now() + timeoutMs;
  let url = parseHttpUrl(rawUrl);

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const remainingForResolve = deadline - Date.now();
    const destination = await resolvePublicDestination(url.toString(), resolve, remainingForResolve);
    url = destination.url;
    const remainingForRequest = deadline - Date.now();
    const response = await withTimeout(
      Promise.resolve().then(() => request(url, destination.addresses[0], { timeoutMs: remainingForRequest, maxBytes, headers: options.headers })),
      remainingForRequest,
    );
    const declaredBytes = Number(headerValue(response.headers, 'content-length'));
    if ((Number.isFinite(declaredBytes) && declaredBytes > maxBytes) || response.body.length > maxBytes) {
      throw new ResearchFetchError('too-large', `The source page exceeds the ${maxBytes}-byte fetch limit.`);
    }
    const location = headerValue(response.headers, 'location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirect === maxRedirects) throw new ResearchFetchError('bad-status', 'The source exceeded the redirect limit.');
      try { url = parseHttpUrl(new URL(location, url).toString()); }
      catch (err) {
        if (err instanceof ResearchFetchError) throw err;
        throw new ResearchFetchError('malformed', 'The source returned a malformed redirect.');
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ResearchFetchError('bad-status', `The source page returned HTTP ${response.status}.`);
    }
    const contentType = headerValue(response.headers, 'content-type').split(';')[0].trim().toLowerCase();
    const allowed = options.allowedContentTypes || ['text/html', 'application/xhtml+xml', 'text/plain'];
    if (!allowed.includes(contentType)) {
      throw new ResearchFetchError('bad-content-type', 'The source is not an HTML or plain-text page; it was not opened.');
    }
    const encoding = headerValue(response.headers, 'content-encoding').trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      throw new ResearchFetchError('bad-content-type', 'Compressed source responses are not accepted by this fetcher.');
    }
    return {
      finalUrl: url.toString(),
      body: decodeBody(response.body, headerValue(response.headers, 'content-type')),
      contentType,
      headers: response.headers,
    };
  }
  throw new ResearchFetchError('bad-status', 'The source could not be opened after redirects.');
}

export async function fetchPublicPage(rawUrl: string, options: FetchOptions = {}): Promise<ExtractedPage> {
  const fetched = await fetchPublicBody(rawUrl, options);
  let page: Omit<ExtractedPage, 'finalUrl'>;
  try { page = extractReadablePage(fetched.body, fetched.finalUrl); }
  catch (err) {
    if (err instanceof ResearchFetchError) throw err;
    throw new ResearchFetchError('malformed', 'The source page could not be safely parsed.');
  }
  return { ...page, finalUrl: fetched.finalUrl };
}
