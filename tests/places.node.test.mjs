/**
 * Places and addresses — fixture tests. Nothing here reaches the network.
 *
 * Every fixture below is the documented response shape of that supplier, and the
 * assertions are about the things that are easy to get wrong: GeoJSON puts
 * longitude first, Nominatim returns coordinates as strings, and a supplier that
 * fails must be passed over rather than reported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchPlaces, parseNominatim, parsePhoton, parseOpenMeteo, parseGeoapify,
  describePlaceSources, clearPlaceCache, resetPlaceThrottle,
} from '../search/places.ts';

function stubFetch(routes) {
  const seen = [];
  const fetchBody = async (url, _options) => {
    seen.push(url);
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

const NOMINATIM = [{
  place_id: 123, display_name: 'Benoni, City of Ekurhuleni, Gauteng, 1501, South Africa',
  lat: '-26.1883', lon: '28.3208', type: 'city',
}];

const PHOTON = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    // GeoJSON order: longitude, then latitude.
    geometry: { type: 'Point', coordinates: [28.3208, -26.1883] },
    properties: {
      name: 'Benoni', state: 'Gauteng', country: 'South Africa',
      osm_key: 'place', osm_value: 'city', osm_type: 'R', osm_id: 1234567,
    },
  }],
};

const OPEN_METEO = {
  results: [{
    id: 1016400, name: 'Benoni', latitude: -26.18848, longitude: 28.32078,
    country: 'South Africa', admin1: 'Gauteng', feature_code: 'PPL', country_code: 'za',
  }],
};

const GEOAPIFY = {
  results: [{
    lat: -26.1883, lon: 28.3208, formatted: 'Benoni, 1501, Gauteng, South Africa',
    address_line1: 'Benoni', address_line2: '1501, Gauteng, South Africa',
    city: 'Benoni', country: 'South Africa', result_type: 'city',
  }],
};

/* ── parsing, where the mistakes live ─────────────────────────────────────── */
test('Nominatim: coordinates arrive as strings and must still be numbers', () => {
  const [place] = parseNominatim(NOMINATIM);
  assert.equal(place.name, 'Benoni');
  assert.equal(place.lat, -26.1883);
  assert.equal(place.lon, 28.3208);
  assert.equal(typeof place.lat, 'number');
  assert.match(place.address, /Gauteng/);
  assert.equal(place.source, 'OpenStreetMap (Nominatim)');
});

test('Photon: GeoJSON is longitude-first, so the order must be swapped', () => {
  const [place] = parsePhoton(PHOTON);
  assert.equal(place.lat, -26.1883, 'latitude, not the longitude that comes first');
  assert.equal(place.lon, 28.3208);
  assert.equal(place.placeType, 'city');
  // A coordinate pair the wrong way round would put Benoni in the sea.
  assert.ok(place.lat < 0 && place.lon > 0, 'Benoni is south and east');
});

test('Open-Meteo: a place name, with the town it belongs to', () => {
  const [place] = parseOpenMeteo(OPEN_METEO);
  assert.equal(place.name, 'Benoni');
  assert.match(place.address, /Gauteng/);
  assert.equal(place.placeType, 'PPL');
});

test('Geoapify: the formatted address is kept whole', () => {
  const [place] = parseGeoapify(GEOAPIFY);
  assert.equal(place.address, 'Benoni, 1501, Gauteng, South Africa');
  assert.equal(place.name, 'Benoni');
  assert.equal(place.placeType, 'city');
});

test('impossible coordinates are dropped rather than shown', () => {
  assert.deepEqual(parseNominatim([{ display_name: 'Nowhere', lat: '999', lon: '0' }]), []);
  assert.deepEqual(parseNominatim([{ display_name: 'Nowhere', lat: 'abc', lon: '0' }]), []);
  assert.deepEqual(parsePhoton({ features: [{ geometry: { coordinates: [null, null] }, properties: { name: 'X' } }] }), []);
});

/* ── the registry: order, keys, and never blocking ────────────────────────── */
test('a keyed supplier leads, but three suppliers need no key at all', () => {
  const sources = describePlaceSources();
  assert.equal(sources.length, 5);
  const keyFree = sources.filter((s) => !s.needsKey);
  assert.equal(keyFree.length, 3, 'Nominatim, Photon and Open-Meteo');
  assert.ok(keyFree.every((s) => s.keyPresent), 'a key-free supplier is always available');
  assert.equal(sources[0].id, 'geoapify', 'the keyed ones are tried first');
});

test('with no keys at all, an address is still found', async (t) => {
  t.after(() => { delete process.env.GEOAPIFY_API_KEY; delete process.env.LOCATIONIQ_API_KEY; });
  clearPlaceCache();
  resetPlaceThrottle();
  const stub = stubFetch([['nominatim.openstreetmap.org', NOMINATIM]]);
  const hits = await searchPlaces('Benoni', stub);
  assert.equal(hits[0].name, 'Benoni');
  assert.equal(hits[0].source, 'OpenStreetMap (Nominatim)');
  assert.ok(!stub.seen.some((u) => u.includes('geoapify.com') || u.includes('locationiq.com')),
    'no keyed supplier is called when there is no key');
});

test('a supplier that fails is passed over, not reported', async () => {
  clearPlaceCache();
  resetPlaceThrottle();
  const stub = stubFetch([
    ['nominatim.openstreetmap.org', new Error('ENOTFOUND nominatim.openstreetmap.org')],
    ['photon.komoot.io', PHOTON],
  ]);
  const hits = await searchPlaces('Benoni', stub);
  assert.equal(hits[0].source, 'Photon (OpenStreetMap)', 'the next supplier answered');
});

test('a keyed supplier is used first when its key is loaded', async (t) => {
  t.after(() => { delete process.env.GEOAPIFY_API_KEY; });
  clearPlaceCache();
  process.env.GEOAPIFY_API_KEY = 'geoapify-test-key';
  const stub = stubFetch([['api.geoapify.com', GEOAPIFY], ['nominatim.openstreetmap.org', NOMINATIM]]);
  const hits = await searchPlaces('Benoni', stub);
  assert.equal(hits[0].source, 'Geoapify');
  assert.ok(!stub.seen.some((u) => u.includes('nominatim')), 'Nominatim was not needed');
  clearPlaceCache();
});

test('the answer is cached, because Nominatim asks for it', async () => {
  clearPlaceCache();
  resetPlaceThrottle();
  const first = stubFetch([['nominatim.openstreetmap.org', NOMINATIM]]);
  await searchPlaces('Benoni', first);
  const second = stubFetch([['nominatim.openstreetmap.org', NOMINATIM]]);
  const hits = await searchPlaces('Benoni', second);
  assert.equal(hits[0].name, 'Benoni');
  assert.deepEqual(second.seen, [], 'the second question was answered from the cache');
  clearPlaceCache();
});

test('Nominatim is not called more than once a second', async () => {
  clearPlaceCache();
  resetPlaceThrottle();
  const stub = stubFetch([['nominatim.openstreetmap.org', NOMINATIM]]);
  await searchPlaces('Benoni', stub);
  // The cache is cleared so the question is asked again — but the throttle is
  // not, because dropping cached answers is no reason to speed up.
  clearPlaceCache();
  const started = Date.now();
  await searchPlaces('Springs', stub);
  assert.ok(Date.now() - started >= 1000, 'the second call waited, as the usage policy requires');
  clearPlaceCache();
  resetPlaceThrottle();
});

test('too short a question is not sent anywhere', async () => {
  clearPlaceCache();
  const stub = stubFetch([['nominatim.openstreetmap.org', NOMINATIM]]);
  assert.deepEqual(await searchPlaces('a', stub), []);
  assert.deepEqual(stub.seen, []);
});
