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
