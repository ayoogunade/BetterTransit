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

test('options lists the next departures, each leaving later and arriving later', () => {
  const opts = plan.options(at(52.0), at(52.02), 3500, services);
  assert.deepStrictEqual(opts.map((o) => o.legs.find((l) => l.type === 'ride').trip), ['t1', 't2']);
  assert.ok(opts[0].leave >= 3500 && opts[1].leave > opts[0].leave && opts[1].arrive > opts[0].arrive);
});

test('arriveBy lists only options that make it in time, latest departure first', () => {
  const trip = (o) => o.legs.find((l) => l.type === 'ride').trip;
  assert.deepStrictEqual(plan.arriveBy(at(52.0), at(52.02), 4800, services).map(trip), ['t2', 't1']);
  assert.deepStrictEqual(plan.arriveBy(at(52.0), at(52.02), 4500, services).map(trip), ['t1']);
  assert.deepStrictEqual(plan.arriveBy(at(52.0), at(52.02), 4000, services), []);
  assert.deepStrictEqual(plan.arriveBy(at(52.0), at(52.02), 4800, services, undefined, 3700).map(trip), ['t2']); // t1 already left
});

test('arriveBy never starts before now', () => {
  assert.deepStrictEqual(plan.arriveBy(at(52.0), at(52.02), 4800, services, undefined, 4300), []);
});

test('options is empty when there is no route', () => {
  assert.deepStrictEqual(plan.options(at(52.0), at(50.0), 3500, services), []);
});

// ---- accessibility, block successors and risky transfers ----
const wc = (id, lat, wb, parent) => ({ ...mk(id, lat), wheelchair_boarding: wb, parent_station: parent || '' });
const net = (stopList, tripList, tripStopList) => createPlanner({ stops: stopList, trips: tripList, tripStops: tripStopList });
const rideTrips = (r) => r.legs.filter((l) => l.type === 'ride').map((l) => l.trip);

test('accessible skips trips marked wheelchair_accessible 2', () => {
  const p = net([wc('A', 52.0, '1'), wc('C', 52.02, '1')],
    { u1: { service_id: 's', wheelchair_accessible: '2' }, u2: { service_id: 's', wheelchair_accessible: '1' } },
    { u1: seq(['A', 'C'], [3600, 4200]), u2: seq(['A', 'C'], [4200, 4800]) });
  assert.deepStrictEqual(rideTrips(p(at(52.0), at(52.02), 3500, services)), ['u1']);
  assert.deepStrictEqual(rideTrips(p(at(52.0), at(52.02), 3500, services, undefined, true)), ['u2']);
  assert.deepStrictEqual(p.options(at(52.0), at(52.02), 3500, services, undefined, 4, undefined, true).map((o) => rideTrips(o)[0]), ['u2']);
  assert.deepStrictEqual(p.arriveBy(at(52.0), at(52.02), 5000, services, undefined, undefined, 3, true).map((o) => rideTrips(o)[0]), ['u2']);
});

test('accessible uses only stops confirmed accessible, inheriting from the parent when unknown', () => {
  const hub = { stop_id: 'P', stop_lat: '52.02', stop_lon: '-106.6', location_type: '1', wheelchair_boarding: '2' };
  const tr = { u: { service_id: 's' } }, ts = { u: seq(['A', 'C'], [3600, 4200]) };
  const p = net([wc('A', 52.0, '1'), hub, wc('C', 52.02, '0', 'P')], tr, ts);
  assert.strictEqual(rideTrips(p(at(52.0), at(52.02), 3500, services)).length, 1);
  assert.strictEqual(p(at(52.0), at(52.02), 3500, services, undefined, true), null); // C inherits the hub's 2
  const own = net([wc('A', 52.0, '1'), hub, wc('C', 52.02, '1', 'P')], tr, ts);
  assert.strictEqual(rideTrips(own(at(52.0), at(52.02), 3500, services, undefined, true)).length, 1); // its own 1 wins
  const unknown = net([wc('A', 52.0, '1'), wc('C', 52.02, '0')], tr, ts);
  assert.strictEqual(unknown(at(52.0), at(52.02), 3500, services, undefined, true), null); // unknown, no parent: not confirmed, so avoided
  assert.strictEqual(rideTrips(unknown(at(52.0), at(52.02), 3500, services)).length, 1);
});

test('successor links a trip to the next one in its block on the same service', () => {
  const b = { service_id: 's', block_id: 'X' };
  const p = net([mk('A', 52.0), mk('B', 52.01), mk('C', 52.02)],
    { b1: b, b2: b, b3: { ...b, service_id: 'other' }, b4: { service_id: 's', block_id: 'Y' } },
    { b1: seq(['A', 'B'], [3600, 3900]), b2: seq(['B', 'C'], [3900, 4200]), b3: seq(['B', 'C'], [5000, 5200]), b4: seq(['B', 'C'], [5000, 5200]) });
  assert.deepStrictEqual(p.successor, { b1: 'b2' });
});

test('transfers: a block successor boarded where you got off is a stay-on, not a transfer', () => {
  const b = { service_id: 's', block_id: 'X' };
  const p = net([mk('A', 52.0), mk('B', 52.01), mk('C', 52.02)], { b1: b, b2: b },
    { b1: seq(['A', 'B'], [3600, 3900]), b2: seq(['B', 'C'], [3900, 4200]) });
  const r = p(at(52.0), at(52.02), 3500, services);
  const x = p.transfers(r.legs, { route: () => '1', usual: () => null });
  assert.deepStrictEqual(r.legs.map((l, i) => l.type === 'ride' && !!(x[i] && x[i].stayOn)).filter((_, i) => r.legs[i].type === 'ride'), [false, true]);
});

test('transfers: a tight connection on a route that runs late is risky, a roomy one is not', () => {
  const ride = (trip, stopIds, times) => ({ type: 'ride', trip, stops: stopIds, from: 0, to: 1, times });
  const legs = (slack) => [ride('t1', ['A', 'C'], [3600, 4200]), { type: 'walk', secs: 60, from: 'C', to: 'D' }, ride('t3', ['D', 'E'], [4260 + slack, 4800 + slack])];
  const route = (t) => (t === 't1' ? '8' : '14');
  const calls = [];
  const usual = (r, s, h) => (calls.push([r, s, h]), { avg: 2, late: 35, n: 9 });
  const check = (l, u = usual) => plan.transfers(l, { route, usual: u });
  assert.deepStrictEqual(check(legs(120))[2].risk, { late: 35, slackMins: 2, route: '8' });
  assert.deepStrictEqual(calls[0], ['8', 'C', 1]); // incoming route, where you get off, hour of arrival
  assert.strictEqual(check(legs(600))[2], undefined);
  assert.strictEqual(check(legs(120), () => ({ avg: 0, late: 10, n: 9 }))[2], undefined); // reliable route
  assert.strictEqual(check(legs(120), () => null)[2], undefined); // no history
  assert.ok(check(legs(200), () => ({ avg: 5, late: 20, n: 9 }))[2]); // slack under the usual delay
});

test('preferSafe puts a non-risky option first when two arrive within 5 minutes', () => {
  const o = (arrive, risk) => ({ arrive, legs: [{ type: 'ride', ...(risk && { risk: { late: 40, slackMins: 1 } }) }] });
  const [a, b, c] = [o(1000, true), o(1200), o(2000)];
  assert.deepStrictEqual(plan.preferSafe([a, b, c]), [b, a, c]);
  const [d, e] = [o(1000, true), o(1400)];
  assert.deepStrictEqual(plan.preferSafe([d, e]), [d, e]); // 400 s apart: keep the order
  assert.deepStrictEqual(plan.preferSafe([e, d]), [e, d]);
});
