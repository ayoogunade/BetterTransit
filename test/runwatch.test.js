const test = require('node:test');
const assert = require('node:assert');
const createRunWatch = require('../runwatch');

const fakeHistory = () => { const log = []; return { log, tally: (kind, run, hit) => log.push([kind, run, hit]) }; };
const T = 100000; // "now" when watching starts
const run = (trip, start, end = start + 1800) => ({ trip, key: trip + '-key', start, end });

test('a run nobody showed up for is a no-show; one that got a bus is not', () => {
  const h = fakeHistory(), w = createRunWatch(h);
  w.startDay('d', [run('a', T + 600), run('b', T + 600)], T);
  w.saw('b', '2412', null);
  w.tick(T + 600 + 24 * 60, true);
  assert.deepStrictEqual(h.log, []); // not judged until 25 min after the start
  w.tick(T + 600 + 25 * 60, true);
  assert.deepStrictEqual(h.log, [['ghost', 'a-key', true], ['ghost', 'b-key', false]]);
});

test('no-shows are not counted for runs due before we started watching, during a feed outage, cancelled, or with a late bus on its way', () => {
  const h = fakeHistory(), w = createRunWatch(h);
  w.startDay('d', [run('early', T + 60), run('down', T + 3600), run('gone', T + 600), run('late', T + 900)], T);
  w.cancel('gone');
  w.tick(T + 900 + 1500, true, (trip) => trip === 'late');
  w.tick(T + 3500, false); // the vehicle feed is down shortly before 'down' is due
  w.tick(T + 3600 + 1500, true);
  assert.deepStrictEqual(h.log, [['ghost', 'late-key', false]]);
});

test('once a run is over: which kind of bus it got and whether it was ever crowded', () => {
  const h = fakeHistory(), w = createRunWatch(h);
  w.startDay('d', [run('a', T + 600, T + 2400), run('b', T + 600, T + 2400)], T);
  w.saw('a', '2512', 1); w.saw('a', '2512', 3); w.saw('a', null, 2);
  w.saw('b', '712', null);
  w.tick(T + 2400 + 15 * 60, true);
  assert.deepStrictEqual(h.log.filter((x) => x[0] !== 'ghost'), [['bus', 'a-key', true], ['crowd', 'a-key', true], ['bus', 'b-key', false]]);
});

test('a new service day starts fresh', () => {
  const h = fakeHistory(), w = createRunWatch(h);
  w.startDay('d1', [run('a', T + 600)], T);
  w.saw('a', '712', null);
  w.startDay('d2', [run('a', T + 90000)], T + 86400);
  w.tick(T + 90000 + 1500, true);
  assert.deepStrictEqual(h.log, [['ghost', 'a-key', true]]);
  assert.strictEqual(w.day(), 'd2');
});
