const test = require('node:test');
const assert = require('node:assert');
const createSearch = require('../search');

const stop = (id, name, extra = {}) => ({ stop_id: id, stop_code: '', stop_name: name, stop_lat: '52.1', stop_lon: '-106.6', location_type: '0', ...extra });
const data = {
  stops: [stop('Hub1', 'Stonebridge Hub', { location_type: '1' }), stop('10', 'Stonebridge Mall'), stop('11', '60th Street / Miners'), stop('12', 'Clarence / University Drive'), stop('3296', 'Elm / Oak')],
  routes: { r60: { route_id: 'r60', route_short_name: '60', route_long_name: 'City Centre / Confederation', route_color: '000080' }, r6: { route_id: 'r6', route_short_name: '06', route_long_name: 'Cumberland', route_color: '000080' }, r17: { route_id: 'r17', route_short_name: '17', route_long_name: 'Stonebridge / Lawson', route_color: 'FF8040' } },
  trips: { a: { route_id: 'r60', trip_headsign: 'Confederation', service_id: 's' }, b: { route_id: 'r60', trip_headsign: 'City Centre', service_id: 's' }, c: { route_id: 'r17', trip_headsign: 'Stonebridge', service_id: 's' }, d: { route_id: 'r17', trip_headsign: 'Lawson', service_id: 's' } },
  tripStops: { a: [{ stop: '12', seq: 1 }, { stop: '10', seq: 2 }], b: [{ stop: '10', seq: 1 }], c: [{ stop: '12', seq: 1 }, { stop: '10', seq: 2 }, { stop: '3296', seq: 3 }], d: [{ stop: '3296', seq: 1 }] },
};
const search = createSearch(() => data);
delete process.env.GOOGLE_PLACES_KEY;

test('a bare route number finds that route only (60 is not 06, and not 60th Street)', async () => {
  const r = await search.suggest('60', ['route', 'stop', 'dest']);
  assert.deepStrictEqual(r.map((x) => x.kind + ':' + (x.short || x.name)), ['route:60']);
});

test('"6" matches route 06 by number', async () => {
  const r = await search.suggest('6', ['route']);
  assert.ok(r.some((x) => x.short === '06'));
});

test('a bare number is an exact stop number lookup', async () => {
  const r = await search.suggest('3296', ['stop']);
  assert.strictEqual(r[0].name, 'Elm / Oak');
});

test('text query finds routes, stops (hubs first) and a bus destination resolved to a stop', async () => {
  const r = await search.suggest('stonebridge', ['route', 'stop', 'dest']);
  assert.strictEqual(r[0].kind, 'route');
  const stops = r.filter((x) => x.kind === 'stop');
  assert.strictEqual(stops[0].name, 'Stonebridge Hub');
  const dest = r.find((x) => x.kind === 'dest');
  assert.strictEqual(dest.name, 'Stonebridge');
  assert.strictEqual(dest.id, 'Hub1');
});

test('routeStops returns each direction with the longest trip, in order', () => {
  const dirs = search.routeStops('17');
  const stonebridge = dirs.find((d) => d.headsign === 'Stonebridge');
  assert.deepStrictEqual(stonebridge.stops.map((s) => s.id), ['12', '10', '3296']);
});

test('empty query returns nothing', async () => {
  assert.deepStrictEqual(await search.suggest('  ', ['route', 'stop']), []);
});
