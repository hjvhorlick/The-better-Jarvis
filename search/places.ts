/**
 * PLACES AND ADDRESSES — the key-free half of the map.
 *
 * Five suppliers, three of which need nothing at all. A key here only ever buys
 * a higher rate limit and cleaner structured address fields; it never decides
 * whether an address can be found. That is the same rule the media registry
 * follows, and it is the reason a missing key is not an error.
 *
 * GOOGLE IS NOT HERE ON PURPOSE. Its Geocoding API needs a Cloud billing
 * account, and its terms forbid using the coordinates with a non-Google map and
 * cap how long they may be cached. This app would break both rules.
 */
import { fetchPublicBody, type FetchOptions } from '../research/fetch.js';
import { resolveImageServiceKeys } from '../config.js';

export interface PlaceHit {
  /** The place as the supplier names it — "Benoni", "Carnival Mall". */
  name: string;
  /** The full address line, when the supplier gives one. */
  address: string;
  lat: number;
  lon: number;
  source: string;
  /** What kind of thing it is — city, suburb, street, amenity — as the source says. */
  placeType: string | null;
  /** A link to the place on a map. */
  page: string | null;
}

export interface PlaceOptions extends FetchOptions {
  fetchBody?: (url: string, options: FetchOptions & { allowedContentTypes?: string[] }) => Promise<{ body: string }>;
  maxResults?: number;
  skip?: string[];
}

const JSON_TYPES = ['application/json', 'text/json', 'text/plain'];

/**
 * Nominatim's own usage policy, written down because it asks for all three and
 * blocks callers that ignore them: at most one request a second, a descriptive
 * User-Agent, and cached results. The throttle below is deliberately simple —
 * this is one user asking a question, not a batch job.
 */
const NOMINATIM_MIN_GAP_MS = 1_100;
const NOMINATIM_USER_AGENT = 'Jarvis home assistant (single-user desktop; contact the machine owner)';
let lastNominatimCall = 0;

const PLACE_CACHE = new Map<string, { at: number; hits: PlaceHit[] }>();
const PLACE_CACHE_MS = 24 * 60 * 60 * 1000; // a day: addresses do not move
const PLACE_CACHE_MAX = 300;

function cached(query: string, kind: string): PlaceHit[] | null {
  const hit = PLACE_CACHE.get(`${kind}::${query.toLowerCase().trim()}`);
  if (!hit) return null;
  if (Date.now() - hit.at > PLACE_CACHE_MS) { PLACE_CACHE.delete(`${kind}::${query.toLowerCase().trim()}`); return null; }
  return hit.hits;
}

function remember(query: string, kind: string, hits: PlaceHit[]): void {
  if (PLACE_CACHE.size >= PLACE_CACHE_MAX) {
    const oldest = PLACE_CACHE.keys().next().value;
    if (oldest) PLACE_CACHE.delete(oldest);
  }
  PLACE_CACHE.set(`${kind}::${query.toLowerCase().trim()}`, { at: Date.now(), hits });
}

function num(value: unknown): number | null {
  // Number(null) is 0 and Number('') is 0. Left alone, a missing coordinate
  // would quietly become (0, 0) — a real spot in the Gulf of Guinea — and the
  // answer would look fine. Both are rejected before any conversion.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Clamp anything untrusted to a plausible coordinate, or drop it. */
function coords(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = num(lat);
  const lo = num(lon);
  if (la === null || lo === null) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lon: lo };
}

function text(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function getBody(url: string, options: PlaceOptions, extra?: FetchOptions & { allowedContentTypes?: string[] }) {
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

function jsonString(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

/* ── Nominatim (OpenStreetMap): no key, 1 request a second, cached ─────────── */
export function parseNominatim(payload: unknown): PlaceHit[] {
  if (!Array.isArray(payload)) return [];
  const out: PlaceHit[] = [];
  for (const raw of payload) {
    const item = raw as { display_name?: string; lat?: string | number; lon?: string | number; type?: string; place_id?: string | number };
    const point = coords(item.lat, item.lon);
    if (!point || !item.display_name) continue;
    out.push({
      name: text(item.display_name.split(',')[0], 120),
      address: text(item.display_name, 300),
      ...point,
      source: 'OpenStreetMap (Nominatim)',
      placeType: item.type ? text(item.type, 40) : null,
      page: `https://www.openstreetmap.org/search?query=${encodeURIComponent(text(item.display_name, 200))}`,
    });
  }
  return out;
}

async function nominatimSearch(query: string, options: PlaceOptions): Promise<PlaceHit[]> {
  const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - lastNominatimCall);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query.trim())}`
    + `&format=json&limit=${Math.min(options.maxResults ?? 6, 10)}`;
  const page = await getBody(url, options, { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
  lastNominatimCall = Date.now();
  return parseNominatim(jsonString(page.body));
}

/* ── Photon (komoot): no key, GeoJSON ─────────────────────────────────────── */
export function parsePhoton(payload: unknown): PlaceHit[] {
  const features = (payload as { features?: unknown[] })?.features || [];
  const out: PlaceHit[] = [];
  for (const raw of features) {
    const feature = raw as {
      geometry?: { coordinates?: unknown[] };
      properties?: {
        name?: string; city?: string; state?: string; country?: string;
        postcode?: string; street?: string; housenumber?: string; osm_value?: string;
      };
    };
    // GeoJSON is [longitude, latitude] — the order is easy to get backwards.
    const point = coords(feature.geometry?.coordinates?.[1], feature.geometry?.coordinates?.[0]);
    const props = feature.properties || {};
    if (!point || !props.name) continue;
    const address = [props.housenumber, props.street, props.postcode, props.city, props.state, props.country]
      .filter(Boolean).map((part) => text(part, 60)).join(', ');
    out.push({
      name: text(props.name, 120),
      address: address || text(props.name, 300),
      ...point,
      source: 'Photon (OpenStreetMap)',
      placeType: props.osm_value ? text(props.osm_value, 40) : null,
      page: `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lon}#map=16/${point.lat}/${point.lon}`,
    });
  }
  return out;
}

async function photonSearch(query: string, options: PlaceOptions): Promise<PlaceHit[]> {
  // Photon's public instance has been seen answering 403 to a generic
  // User-Agent, so it gets a descriptive one like Nominatim.
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query.trim())}`
    + `&limit=${Math.min(options.maxResults ?? 6, 10)}`;
  const page = await getBody(url, options, { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
  return parsePhoton(jsonString(page.body));
}

/* ── Open-Meteo: no key, place names rather than street addresses ─────────── */
export function parseOpenMeteo(payload: unknown): PlaceHit[] {
  const results = (payload as { results?: unknown[] })?.results || [];
  const out: PlaceHit[] = [];
  for (const raw of results) {
    const item = raw as {
      id?: number; name?: string; latitude?: number; longitude?: number;
      country?: string; admin1?: string; feature_code?: string; country_code?: string;
    };
    const point = coords(item.latitude, item.longitude);
    if (!point || !item.name) continue;
    out.push({
      name: text(item.name, 120),
      address: [item.name, item.admin1, item.country].filter(Boolean).map((p) => text(p, 60)).join(', '),
      ...point,
      source: 'Open-Meteo',
      placeType: item.feature_code ? text(item.feature_code, 40) : null,
      page: `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lon}#map=13/${point.lat}/${point.lon}`,
    });
  }
  return out;
}

async function openMeteoSearch(query: string, options: PlaceOptions): Promise<PlaceHit[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}`
    + `&count=${Math.min(options.maxResults ?? 6, 10)}&format=json`;
  const page = await getBody(url, options);
  return parseOpenMeteo(jsonString(page.body));
}

/* ── Geoapify: optional key, 3,000 credits a day ──────────────────────────── */
export function parseGeoapify(payload: unknown): PlaceHit[] {
  const results = (payload as { results?: unknown[] })?.results || [];
  const out: PlaceHit[] = [];
  for (const raw of results) {
    const item = raw as {
      lat?: number; lon?: number; formatted?: string; result_type?: string;
      address_line1?: string; address_line2?: string; city?: string; country?: string;
    };
    const point = coords(item.lat, item.lon);
    if (!point || !item.formatted) continue;
    out.push({
      name: text(item.address_line1 || item.city || item.formatted.split(',')[0], 120),
      address: text(item.formatted, 300),
      ...point,
      source: 'Geoapify',
      placeType: item.result_type ? text(item.result_type, 40) : null,
      page: `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lon}#map=17/${point.lat}/${point.lon}`,
    });
  }
  return out;
}

async function geoapifySearch(query: string, options: PlaceOptions): Promise<PlaceHit[]> {
  const key = resolveImageServiceKeys().geoapify.key;
  if (!key) return [];
  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(query.trim())}`
    + `&format=json&limit=${Math.min(options.maxResults ?? 6, 10)}&apiKey=${encodeURIComponent(key)}`;
  const page = await getBody(url, options);
  return parseGeoapify(jsonString(page.body));
}

/* ── LocationIQ: optional key, 5,000 a day, attribution required ──────────── */
async function locationiqSearch(query: string, options: PlaceOptions): Promise<PlaceHit[]> {
  const key = resolveImageServiceKeys().locationiq.key;
  if (!key) return [];
  const url = `https://us1.locationiq.com/v1/search.php?key=${encodeURIComponent(key)}`
    + `&q=${encodeURIComponent(query.trim())}&format=json&limit=${Math.min(options.maxResults ?? 6, 10)}`;
  const page = await getBody(url, options);
  // LocationIQ is Nominatim-compatible, so its answers parse the same way.
  return parseNominatim(jsonString(page.body)).map((hit) => ({ ...hit, source: 'LocationIQ (OpenStreetMap)' }));
}

/* ── the registry ─────────────────────────────────────────────────────────── */
export interface PlaceSource {
  id: string;
  label: string;
  needsKey: boolean;
  blurb: string;
  signup?: string;
  search: (query: string, options: PlaceOptions) => Promise<PlaceHit[]>;
}

/**
 * Keyed suppliers first, because a key buys a higher rate limit and structured
 * address fields — but every one of them has a key-free supplier behind it.
 */
const PLACE_SOURCES: PlaceSource[] = [
  {
    id: 'geoapify', label: 'Geoapify', needsKey: true,
    blurb: 'Addresses and places with parsed fields. Free plan: 3,000 credits a day at 5 requests a second, attribution required.',
    signup: 'https://www.geoapify.com/get-started/',
    search: geoapifySearch,
  },
  {
    id: 'locationiq', label: 'LocationIQ', needsKey: true,
    blurb: 'Addresses, autocomplete and reverse geocoding. Free plan: 5,000 requests a day at 2 a second, attribution required.',
    signup: 'https://locationiq.com/docs',
    search: locationiqSearch,
  },
  {
    id: 'nominatim', label: 'OpenStreetMap (Nominatim)', needsKey: false,
    blurb: 'The public OpenStreetMap geocoder. No key. Its own policy is enforced here: one request a second, a descriptive User-Agent, and every answer cached for a day.',
    signup: 'https://nominatim.org/',
    search: nominatimSearch,
  },
  {
    id: 'photon', label: 'Photon (komoot)', needsKey: false,
    blurb: 'A second key-free OpenStreetMap geocoder, with typo tolerance and search-as-you-type. No key.',
    signup: 'https://photon.komoot.io/',
    search: photonSearch,
  },
  {
    id: 'openmeteo', label: 'Open-Meteo', needsKey: false,
    blurb: 'Knows cities, towns and landmarks by name rather than street addresses — so a house number resolves to its town at best. No key, and useful when the other two are quiet.',
    signup: 'https://open-meteo.com/en/docs/geocoding-api',
    search: openMeteoSearch,
  },
];

/** The place suppliers, as the registration area shows them. */
export function describePlaceSources(): Array<{ id: string; label: string; needsKey: boolean; keyPresent: boolean; blurb: string; signup: string | null }> {
  const keys = resolveImageServiceKeys();
  return PLACE_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    needsKey: source.needsKey,
    keyPresent: source.id === 'geoapify' ? Boolean(keys.geoapify.key)
      : source.id === 'locationiq' ? Boolean(keys.locationiq.key)
        : true,
    blurb: source.blurb,
    signup: source.signup ?? null,
  }));
}

/**
 * Find a place. Answers are cached for a day, which Nominatim asks for and which
 * makes a repeated question instant. A supplier that fails is passed over
 * silently — the owner asked where something is, not for a status report.
 */
export async function searchPlaces(query: string, options: PlaceOptions = {}): Promise<PlaceHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const fromCache = cached(trimmed, 'place');
  if (fromCache) return fromCache;

  const skip = options.skip || [];
  for (const source of PLACE_SOURCES) {
    if (skip.includes(source.id)) continue;
    try {
      const hits = await source.search(trimmed, options);
      if (hits.length) {
        remember(trimmed, 'place', hits);
        return hits;
      }
    } catch { /* the next supplier gets its turn */ }
  }
  return [];
}

/**
 * Drop the cache so a repeated question is asked again. Deliberately does NOT
 * reset the Nominatim throttle: clearing cached answers is no reason to start
 * calling the public geocoder faster than its policy allows.
 */
export function clearPlaceCache(): void {
  PLACE_CACHE.clear();
}

/** Test-only: forget the throttle window. Production code never calls this. */
export function resetPlaceThrottle(): void {
  lastNominatimCall = 0;
}
