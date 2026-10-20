const test = require('node:test');
const assert = require('node:assert');
const createTimetable = require('../timetable');

const H = 3600, MID = 1_000_000_000; // an arbitrary service-day midnight
const data = {
  routes: { r5: { route_id: 'r5', route_short_name: '5', route_color: 'FF0000' }, r14: { route_id: 'r14', route_short_name: '14', route_color: '0000FF' } },
  trips: {
    a: { route_id: 'r14', trip_headsign: 'North', service_id: 's' }, b: { route_id: 'r14', trip_headsign: 'North', service_id: 's' },
    c: { route_id: 'r5', trip_headsign: 'South', service_id: 's' }, d: { route_id: 'r5', trip_headsign: 'South', service_id: 'other' },
    e: { route_id: 'r5', trip_headsign: 'Here', service_id: 's' }, // ends at stop 1: drop-off only
  },
  tripStops: {
    a: [{ stop: '1', t: 8 * H }, { stop: '9', t: 9 * H }], b: [{ stop: '2', t: 25 * H }, { stop: '9', t: 26 * H }], // b: 1:00 the next morning, same service day
    c: [{ stop: '1', t: 7 * H }, { stop: '9', t: 8 * H }], d: [{ stop: '1', t: 7 * H }, { stop: '9', t: 8 * H }],
    e: [{ stop: '9', t: 5 * H }, { stop: '1', t: 6 * H }],
  },
  stopTimesByStop: { 1: [{ trip: 'a', t: 8 * H }, { trip: 'c', t: 7 * H }, { trip: 'd', t: 7 * H }, { trip: 'e', t: 6 * H }], 2: [{ trip: 'b', t: 25 * H }] },
  childrenOf: { hub: ['1', '2'] },
};
const tt = createTimetable(data);
const services = new Set(['s']);

test('groups by route and headsign, sorted by route then time, inactive services dropped', () => {
  const r = tt.build('1', services, MID);
  assert.deepStrictEqual(r, [
    { route: '5', color: 'FF0000', headsign: 'South', times: [MID + 7 * H] },
    { route: '14', color: '0000FF', headsign: 'North', times: [MID + 8 * H] },
  ]);
});

test('a trip ending at the stop (drop-off only) is left out', () => {
  assert.ok(!tt.build('1', services, MID).some((g) => g.headsign === 'Here'));
});

test('a hub merges its child stops, and after-midnight times stay on the service day', () => {
  const north = tt.build('hub', services, MID).find((g) => g.headsign === 'North');
  assert.deepStrictEqual(north.times, [MID + 8 * H, MID + 25 * H]);
});

test('date validation: real YYYY-MM-DD only', () => {
  assert.strictEqual(tt.parseDate('2026-03-07').toISOString().slice(0, 10), '2026-03-07');
  for (const bad of ['', 'x', '2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '2026-01-01T00']) assert.strictEqual(tt.parseDate(bad), null, bad);
});
