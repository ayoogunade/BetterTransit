const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Stub web-push so no network/keys are needed, and keep watches out of the real data dir.
const sent = [];
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'web-push') return { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), setVapidDetails() {}, sendNotification: async (sub, payload) => { sent.push(JSON.parse(payload)); } };
  if (req === 'fs') { const fs = realLoad.call(this, req, ...rest); return { ...fs, writeFileSync() {}, mkdirSync() {}, readFileSync: () => { throw new Error('none'); } }; }
  return realLoad.call(this, req, ...rest);
};
const createPush = require('../push');
Module._load = realLoad;

const now = () => Date.now() / 1000;
const w = (extra = {}) => ({ sub: { endpoint: 'e1' }, stopId: 'S', tripId: 'T', minutes: 5, route: '17', headsign: 'Stonebridge', stopName: 'Clarence', ...extra });

test('notifies once when the bus comes within the window, then drops the watch', async () => {
  sent.length = 0;
  let eta = now() + 600;
  const push = createPush({ arrivals: async () => [{ trip: 'T', time: eta, live: true }], checkEveryMs: 1e9 });
  push.watch(w());
  await push.check();
  assert.strictEqual(sent.length, 0); // 10 min away > 5 min window
  assert.ok(push.has(w()));
  eta = now() + 240;
  await push.check();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].title, /Route 17 in [34] min/);
  await push.check();
  assert.strictEqual(sent.length, 1);
  assert.ok(!push.has(w()));
});

test('unwatch cancels, and a trip missing from the feed is kept briefly then dropped', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [], checkEveryMs: 1e9 });
  push.watch(w({ tripId: 'X' }));
  await push.check();
  assert.ok(push.has(w({ tripId: 'X' }))); // grace period
  push.unwatch(w({ tripId: 'X' }));
  assert.ok(!push.has(w({ tripId: 'X' })));
});

test('standing stop watch notifies once per bus, only for chosen routes, and keeps watching', async () => {
  sent.length = 0;
  const list = [
    { trip: 'A', route: '60', time: now() + 200, live: true, headsign: 'Confederation' },
    { trip: 'B', route: '17', time: now() + 200, live: true }, // route not chosen
    { trip: 'C', route: '60', time: now() + 3000, live: false }, // too far away
  ];
  const push = createPush({ arrivals: async () => list, checkEveryMs: 1e9 });
  const sw = { sub: { endpoint: 'e2' }, stopId: 'S2', standing: true, routes: ['60'], minutes: 5, stopName: 'Steeves' };
  push.watch(sw);
  await push.check();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].title, /Route 60 in [3] min/);
  await push.check();
  assert.strictEqual(sent.length, 1); // not again for the same bus
  list[2].time = now() + 120; // the next bus comes into range
  await push.check();
  assert.strictEqual(sent.length, 2);
  assert.ok(push.has(sw)); // still watching
  push.unwatch({ sub: { endpoint: 'e2' }, stopId: 'S2' });
  assert.ok(!push.has(sw));
});

test('a standing watch with routes=null covers every route', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [{ trip: 'Z', route: '99', time: now() + 60, live: true }], checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'e3' }, stopId: 'S3', standing: true, routes: null, minutes: 5, stopName: 'X' });
  await push.check();
  assert.strictEqual(sent.length, 1);
});

test('a watched bus that gets cancelled or detoured sends one heads-up and drops the watch', async () => {
  for (const flag of ['cancelled', 'skipped']) {
    sent.length = 0;
    const push = createPush({ arrivals: async () => [{ trip: 'T', time: now() + 900, [flag]: true }], checkEveryMs: 1e9 });
    push.watch(w());
    await push.check();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].title, flag === 'cancelled' ? /Route 17 cancelled/ : /not stopping here/);
    assert.ok(!push.has(w()));
  }
});

test('standing watches ignore cancelled, skipped and departed buses', async () => {
  sent.length = 0;
  const t = now() + 60;
  const list = [{ trip: 'A', route: '60', time: t, cancelled: true }, { trip: 'B', route: '60', time: t, skipped: true }, { trip: 'C', route: '60', time: t, gone: true }];
  const push = createPush({ arrivals: async () => list, checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'e4' }, stopId: 'S4', standing: true, routes: null, minutes: 5, stopName: 'X' });
  await push.check();
  assert.strictEqual(sent.length, 0);
});

test('standing watches skip buses whose trip ends at the stop', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [{ trip: 'E', route: '60', time: now() + 60, ends: true }], checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'e5' }, stopId: 'S5', standing: true, routes: null, minutes: 5, stopName: 'X' });
  await push.check();
  assert.strictEqual(sent.length, 0);
});
