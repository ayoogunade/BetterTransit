const test = require('node:test');
const assert = require('node:assert');
const createPlanner = require('../planner');

// Line: A(0) -> B(1) -> C(2), ~1.1 km apart on a line of longitude; line2: C -> D
const mk = (id, lat) => ({ stop_id: id, stop_lat: String(lat), stop_lon: '-106.6', location_type: '0' });
const stops = [mk('A', 52.0), mk('B', 52.01), mk('C', 52.02), mk('D', 52.03), mk('Z', 53.0)];
const trips = { t1: { service_id: 's' }, t2: { service_id: 's' }, t3: { service_id: 's' }, t4: { service_id: 's' } };
const seq = (ids, times) => ids.map((stop, i) => ({ stop, t: times[i], seq: i }));
const tripStops = {
  t1: seq(['A', 'B', 'C'], [3600, 3900, 4200]), // 01:00 line 1
  t2: seq(['A', 'B', 'C'], [4200, 4500, 4800]), // 01:10 line 1 (later)
  t3: seq(['C', 'D'], [4500, 4800]),            // 01:15 line 2 connects at C
  t4: seq(['C', 'D'], [5400, 5700]),            // 01:30 line 2 (later)
};
const plan = createPlanner({ stops, tripStops, trips });
const services = new Set(['s']);
const at = (lat) => ({ lat, lon: -106.6 });

test('direct ride picks earliest trip', () => {
  const r = plan(at(52.0), at(52.02), 3500, services);
  assert.strictEqual(r.legs.filter((l) => l.type === 'ride').length, 1);
  assert.strictEqual(r.legs.find((l) => l.type === 'ride').trip, 't1');
});

test('transfer connects to the later line', () => {
  const r = plan(at(52.0), at(52.03), 3500, services);
  const rides = r.legs.filter((l) => l.type === 'ride');
  assert.deepStrictEqual(rides.map((l) => l.trip), ['t1', 't3']);
  assert.ok(r.arrive >= 4800);
});

test('live delay on first leg makes the planner catch the next line-2 bus', () => {
  // t1 runs 10 min late: reaches C at 4800, missing t3 (4500), so it must take t4
  const live = new Map([['t1', [4200, 4500, 4800]]]);
  const r = plan(at(52.0), at(52.03), 3500, services, live);
  assert.ok(r.legs.some((l) => l.live));
  assert.strictEqual(r.legs.filter((l) => l.type === 'ride').pop().trip, 't4');
});

test('cancelled trip is skipped', () => {
  const live = new Map([['t1', null]]);
  const r = plan(at(52.0), at(52.02), 3500, services, live);
  assert.strictEqual(r.legs.find((l) => l.type === 'ride').trip, 't2');
});

test('inactive service gives no route; far-away place gives null', () => {
  assert.strictEqual(plan(at(52.0), at(52.02), 3500, new Set(['other'])), null);
  assert.strictEqual(plan(at(52.0), at(50.0), 3500, services), null);
});
