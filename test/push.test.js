const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Stub web-push so no network/keys are needed, and keep watches out of the real data dir.
const sent = [];
let duringSend = null; // lets a test act while a notification is in flight
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'web-push') return { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), setVapidDetails() {}, sendNotification: async (sub, payload) => { await duringSend?.(); sent.push(JSON.parse(payload)); } };
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

// ---------- commutes ----------
const option = (leave, trip = 'T1') => [{ leave, arrive: leave + 1800, legs: [{ type: 'walk', mins: 5 }, { type: 'ride', trip, route: '60', headsign: 'Confederation', live: true, dep: leave + 300, board: { name: 'Clarence' } }] }];
const commute = (extra = {}) => ({ sub: { endpoint: 'c1' }, commute: true, commuteId: 'k1', name: 'To Work', from: { lat: 52.1, lon: -106.6 }, to: { lat: 52.15, lon: -106.7 }, minutes: 5, days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1439, ...extra });

test('a commute waits until the leave time is inside the lead time, and plans at most once a minute', async () => {
  sent.length = 0;
  let opts = option(now() + 900), calls = 0;
  const push = createPush({ arrivals: async () => [], plan: async () => { calls++; return opts; }, checkEveryMs: 1e9 });
  push.watch(commute());
  await push.check();
  assert.strictEqual(sent.length, 0); // 15 min until you need to leave
  opts = option(now() + 200); // now 3 min
  await push.check();
  assert.strictEqual(calls, 1); // planned less than a minute ago, so not again yet
  assert.strictEqual(sent.length, 0);
  assert.ok(push.has(commute()));
});

test('a commute notifies when the leave time is inside the lead time, with the bus and clock times', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [], plan: async () => option(now() + 200), checkEveryMs: 1e9 });
  push.watch(commute({ commuteId: 'k2' }));
  await push.check();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].title, /Leave in [34] min for To Work/);
  assert.match(sent[0].body, /Route 60 Confederation from Clarence at \d+:\d\d (AM|PM) · arrive \d+:\d\d (AM|PM)/);
  await push.check();
  assert.strictEqual(sent.length, 1); // same bus: not again
  assert.ok(push.has(commute({ commuteId: 'k2' }))); // and it keeps watching for tomorrow
});

test('a commute stays quiet outside its days and hours, and without a ride in the plan', async () => {
  sent.length = 0;
  let calls = 0;
  const plan = async () => { calls++; return option(now() + 60); };
  const push = createPush({ arrivals: async () => [], plan, checkEveryMs: 1e9 });
  const today = new Date(Date.now() - 6 * 3600e3).getUTCDay();
  push.watch(commute({ commuteId: 'k3', days: [(today + 1) % 7] })); // another day
  push.watch(commute({ commuteId: 'k4', startMin: 0, endMin: 0, days: [0, 1, 2, 3, 4, 5, 6] })); // window is over unless it is exactly midnight
  await push.check();
  assert.ok(calls <= 1);
  assert.strictEqual(sent.length, calls); // only the midnight minute could fire
  const walkOnly = createPush({ arrivals: async () => [], plan: async () => [{ leave: now(), arrive: now() + 60, legs: [{ type: 'walk', mins: 1 }] }], checkEveryMs: 1e9 });
  walkOnly.watch(commute({ commuteId: 'k5' }));
  sent.length = 0;
  await walkOnly.check();
  assert.strictEqual(sent.length, 0);
});

test('commutes and stop alerts from one device do not replace or cancel each other', () => {
  const push = createPush({ arrivals: async () => [], checkEveryMs: 1e9 });
  push.watch(commute({ commuteId: 'a' })); push.watch(commute({ commuteId: 'b' }));
  push.watch({ sub: { endpoint: 'c1' }, stopId: 'S', standing: true, minutes: 5 });
  push.unwatch({ sub: { endpoint: 'c1' }, commuteId: 'a' });
  assert.ok(!push.has(commute({ commuteId: 'a' })));
  assert.ok(push.has(commute({ commuteId: 'b' })));
  assert.ok(push.has({ sub: { endpoint: 'c1' }, stopId: 'S' }));
});

test('a watch added while a check is waiting on a send is not lost', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [{ trip: 'T', time: now() + 60, live: true }], checkEveryMs: 1e9 });
  push.watch(w());
  duringSend = () => push.watch(w({ tripId: 'LATER', sub: { endpoint: 'e9' } })); // the user sets another alert while T's push is in flight
  try { await push.check(); } finally { duringSend = null; }
  assert.strictEqual(sent.length, 1);
  assert.ok(!push.has(w())); // T fired, so it is done
  assert.ok(push.has(w({ tripId: 'LATER', sub: { endpoint: 'e9' } })));
});

test('invalid() only lets through real push services and well-formed watches', () => {
  const push = createPush({ arrivals: async () => [], checkEveryMs: 1e9 });
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'a', auth: 'b' } });
  const stop = (extra = {}) => ({ sub: sub('https://fcm.googleapis.com/fcm/send/abc'), stopId: 'S', minutes: 5, ...extra });
  assert.strictEqual(push.invalid(stop()), null);
  assert.strictEqual(push.invalid(stop({ sub: sub('https://web.push.apple.com/xyz') })), null);
  assert.strictEqual(push.invalid(stop({ sub: sub('https://updates.push.services.mozilla.com/wpush/v2/x') })), null);
  assert.ok(push.invalid(stop({ sub: sub('http://fcm.googleapis.com/x') })));
  assert.ok(push.invalid(stop({ sub: sub('https://169.254.169.254/latest') })));
  assert.ok(push.invalid(stop({ sub: sub('https://evilgoogleapis.com/x') })));
  assert.ok(push.invalid(stop({ sub: { endpoint: 'https://fcm.googleapis.com/x' } }))); // no keys
  assert.ok(push.invalid({ minutes: 5 }));
  assert.ok(push.invalid(stop({ minutes: 0 })));
  assert.ok(push.invalid(stop({ stopId: undefined })));
  const c = (extra = {}) => ({ ...commute(), sub: sub('https://fcm.googleapis.com/x'), ...extra });
  assert.strictEqual(push.invalid(c()), null);
  assert.ok(push.invalid(c({ days: [] })));
  assert.ok(push.invalid(c({ days: [7] })));
  assert.ok(push.invalid(c({ startMin: 600, endMin: 500 })));
  assert.ok(push.invalid(c({ from: { lat: 'x', lon: 1 } })));
  assert.ok(push.invalid(c({ commuteId: '' })));
});

test('re-registering a watch keeps what it already announced, and signing a device out drops its watches', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [], plan: async () => option(now() + 120), checkEveryMs: 1e9 });
  push.watch(commute({ commuteId: 'r1', sid: 'phone' }));
  await push.check();
  assert.strictEqual(sent.length, 1);
  push.watch(commute({ commuteId: 'r1', sid: 'phone' })); // the app opened again
  await push.check();
  assert.strictEqual(sent.length, 1); // not announced a second time
  push.watch(commute({ sub: { endpoint: 'other' }, commuteId: 'r1', sid: 'laptop' }));
  push.dropSession('phone');
  assert.ok(!push.has(commute({ commuteId: 'r1' })));
  assert.ok(push.has(commute({ sub: { endpoint: 'other' }, commuteId: 'r1' })));
  push.dropSession(null); // never matches "no session" watches
  assert.ok(push.has(commute({ sub: { endpoint: 'other' }, commuteId: 'r1' })));
});

// ---------- ride alerts ("get off at your stop") and missed-transfer rescue ----------
const ride = (extra = {}) => ({ sub: { endpoint: 'r1' }, ride: true, tripId: 'R', alightStopId: 'A', alightIdx: 10, stopName: 'University', route: '8', headsign: 'Market Mall', minutes: 1, ...extra });
const prog = (next, extra = {}) => ({ live: true, next, cancelled: false, time: () => now() + 300, ...extra });

test('a ride watch says your stop is next once, when the bus is at the stop before, then drops', async () => {
  sent.length = 0;
  let p = prog(5);
  const push = createPush({ arrivals: async () => assert.fail('ride watches do not poll arrivals'), progress: async () => p, checkEveryMs: 1e9 });
  push.watch(ride());
  await push.check();
  assert.strictEqual(sent.length, 0);
  p = prog(9);
  await push.check();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'Your stop is next');
  assert.match(sent[0].body, /Get off at University/);
  assert.ok(!push.has(ride()));
});

test('a ride watch is independent of a plain bell on the same bus and stop', () => {
  const push = createPush({ arrivals: async () => [], checkEveryMs: 1e9 });
  push.watch(ride());
  push.watch({ sub: { endpoint: 'r1' }, stopId: 'A', tripId: 'R', minutes: 5 });
  push.unwatch({ sub: { endpoint: 'r1' }, alightStopId: 'A', tripId: 'R', ride: true });
  assert.ok(!push.has(ride()));
  assert.ok(push.has({ sub: { endpoint: 'r1' }, stopId: 'A', tripId: 'R' }));
});

test('a ride watch is dropped silently when you are past the stop, the bus is cancelled, or the trip stays gone', async () => {
  for (const p of [prog(11), prog(null), prog(3, { cancelled: true })]) {
    sent.length = 0;
    const push = createPush({ arrivals: async () => [], progress: async () => p, checkEveryMs: 1e9 });
    push.watch(ride());
    await push.check();
    assert.strictEqual(sent.length, 0);
    assert.ok(!push.has(ride()));
  }
  const gone = createPush({ arrivals: async () => [], progress: async () => ({ live: false, next: undefined, cancelled: false, time: () => now() - 60 }), checkEveryMs: 1e9 });
  const w = ride({ tripId: 'GONE' });
  gone.watch(w);
  await gone.check();
  assert.ok(gone.has(w)); // grace period
  w.missing = now() - 301; // not in the feed for over 5 min (the watch object is the stored one)
  await gone.check();
  assert.ok(!gone.has(w));
});

test('a ride watch set before the trip is in the feed waits for it instead of giving up', async () => {
  const push = createPush({ arrivals: async () => [], progress: async () => ({ live: false, next: undefined, cancelled: false, time: () => now() + 1200 }), checkEveryMs: 1e9 });
  const w = ride({ tripId: 'LATER' });
  push.watch(w);
  w.missing = now() - 600; // even after a long absence: the bus isn't due at your stop for 20 min
  await push.check();
  assert.ok(push.has(w));
});

test('a ride watch gives up after three hours', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [], progress: async () => prog(1), checkEveryMs: 1e9 });
  push.watch(ride({ since: now() - 3 * 3600 - 5 }));
  await push.check();
  assert.ok(!push.has(ride()));
  assert.strictEqual(sent.length, 0);
});

test('invalid() checks ride watches', () => {
  const push = createPush({ arrivals: async () => [], checkEveryMs: 1e9 });
  const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } };
  const r = (extra = {}) => ({ ...ride({ sub }), ...extra });
  const next = { tripId: 'N', boardStopId: 'B', boardIdx: 2, walkSecs: 120, route: '60' };
  assert.strictEqual(push.invalid(r()), null);
  assert.strictEqual(push.invalid(r({ next, to: { lat: 52.1, lon: -106.6 }, alightAt: { lat: 52.2, lon: -106.7 } })), null);
  assert.ok(push.invalid(r({ tripId: '' })));
  assert.ok(push.invalid(r({ alightStopId: undefined })));
  assert.ok(push.invalid(r({ alightIdx: -1 })));
  assert.ok(push.invalid(r({ alightIdx: 1.5 })));
  assert.ok(push.invalid(r({ next, to: { lat: 52.1, lon: -106.6 } }))); // no alight point to re-plan from
  assert.ok(push.invalid(r({ next, alightAt: { lat: 52.2, lon: -106.7 } }))); // no destination
  assert.ok(push.invalid(r({ next: { ...next, walkSecs: -1 }, to: { lat: 1, lon: 1 }, alightAt: { lat: 1, lon: 1 } })));
  assert.ok(push.invalid(r({ next: { ...next, tripId: '' }, to: { lat: 1, lon: 1 }, alightAt: { lat: 1, lon: 1 } })));
});

// the bus reaches your stop in `arriveIn` s; the connection leaves `connIn` s from now and you need 2 min to walk
const rescue = (arriveIn, connIn, opts = {}) => {
  const times = { R: prog(3, { time: () => now() + arriveIn }), N: prog(undefined, { live: true, time: () => now() + connIn, ...opts.conn }) };
  const calls = [];
  const plan = async (from, to, at) => { calls.push({ from, to, at }); return opts.alt === undefined ? [{ leave: at, arrive: at + 1500, legs: [{ type: 'ride', route: '8', headsign: 'Market Mall', dep: at + 240, board: { name: 'University' } }] }] : opts.alt; };
  const push = createPush({ arrivals: async () => [], progress: async (id) => times[id], plan, checkEveryMs: 1e9 });
  push.watch(ride({ next: { tripId: 'N', boardStopId: 'B', boardIdx: 2, walkSecs: 120, route: '60', stopName: 'Broadway' }, to: { lat: 52.1, lon: -106.6 }, alightAt: { lat: 52.2, lon: -106.7 } }));
  return { push, calls };
};

test('a connection you can still make sends nothing; one you will miss re-plans and says what to take instead, once', async () => {
  sent.length = 0;
  const ok = rescue(300, 600); // arrive in 5 min + 2 walk + 1 margin = 8 < 10
  await ok.push.check();
  assert.strictEqual(sent.length + ok.calls.length, 0);
  const late = rescue(300, 400); // 8 min needed, leaves in 6.7
  await late.push.check();
  assert.strictEqual(late.calls.length, 1);
  assert.deepStrictEqual(late.calls[0].from, { lat: 52.2, lon: -106.7 });
  assert.deepStrictEqual(late.calls[0].to, { lat: 52.1, lon: -106.6 });
  assert.ok(Math.abs(late.calls[0].at - (now() + 300)) < 5); // departing when you arrive
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, "You'll miss the 60 at Broadway");
  assert.match(sent[0].body, /Take the 8 Market Mall at \d+:\d\d (AM|PM) instead · arrive \d+:\d\d (AM|PM)/);
  await late.push.check();
  assert.strictEqual(sent.length, 1); // only once
  assert.strictEqual(late.calls.length, 1);
  assert.ok(late.push.has(ride())); // still watching for the get-off alert
});

test('a cancelled connection counts as missed, and with no alternative the push says so', async () => {
  sent.length = 0;
  const r = rescue(300, 9999, { conn: { cancelled: true }, alt: [] });
  await r.push.check();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].title, /miss the 60/);
  assert.match(sent[0].body, /No other bus/);
});

test('when the re-plan still picks the same connection, the push says hurry instead of take something else', async () => {
  sent.length = 0;
  const r = rescue(300, 400, { alt: [{ leave: 0, arrive: now() + 1500, legs: [{ type: 'ride', trip: 'N', route: '60', dep: now() + 400 }] }] });
  await r.push.check();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'Tight connection to the 60');
  assert.match(sent[0].body, /Hurry to Broadway: it leaves at/);
});

test('commute pushes say when the bus is the last one', async () => {
  sent.length = 0;
  const plan = async () => { const o = option(now() + 200); o[0].legs[1].last = true; return o; };
  const push = createPush({ arrivals: async () => [], plan, checkEveryMs: 1e9 });
  push.watch(commute({ commuteId: 'last' }));
  await push.check();
  assert.match(sent[0].body, / · last bus$/);
});
