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

test('a commute push adds the feels-like temperature only when it is cold, and survives the weather being down', async () => {
  for (const [id, wx, tail] of [['w1', { feels: -35, cold: true }, / · feels like -35°F$/], ['w2', { feels: -5, cold: false }, /Confederation from Clarence at [^·]*· arrive [^·]*$/], ['w3', null, /arrive [^·]*$/]]) {
    sent.length = 0;
    const push = createPush({ arrivals: async () => [], plan: async () => option(now() + 200), weather: async () => wx, checkEveryMs: 1e9 });
    push.watch(commute({ commuteId: id }));
    await push.check();
    assert.match(sent[0].body, tail);
  }
  sent.length = 0;
  const push = createPush({ arrivals: async () => [], plan: async () => option(now() + 200), weather: async () => { throw new Error('x'); }, checkEveryMs: 1e9 });
  push.watch(commute({ commuteId: 'w4' }));
  await push.check();
  assert.strictEqual(sent.length, 1);
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

test('alerts watch: primes on registration, then pushes each new matching alert once, and forgets ended ones', async () => {
  sent.length = 0;
  let list = [{ id: 'a1', routes: ['60'], stops: [], header: 'Old detour' }];
  const push = createPush({ arrivals: async () => [], alerts: async () => list, checkEveryMs: 1e9 });
  const aw = () => ({ sub: { endpoint: 'e9' }, alerts: true, routes: ['60'], stopIds: ['S9'], minutes: 1 });
  const good = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } };
  assert.strictEqual(push.invalid({ ...aw(), sub: good }), null);
  assert.strictEqual(push.invalid({ ...aw(), sub: good, routes: 'x' }), 'bad alerts');
  push.watch(aw());
  await push.check();
  assert.strictEqual(sent.length, 0); // already-active alerts are not announced
  list = [...list, { id: 'a2', routes: ['17'], stops: [], header: 'Not mine' }, { id: 'a3', routes: [], stops: ['S9'], header: 'Stop closed' }, { id: 'a4', routes: ['60', '17'], stops: [], header: 'Snow' }];
  await push.check(); await push.check();
  assert.deepStrictEqual(sent.map((s) => [s.title, s.body]), [['Alert: stop', 'Stop closed'], ['Alert: Route 60', 'Snow']]);
  push.watch(aw()); // the app re-registers on launch: nothing is repeated
  await push.check();
  assert.strictEqual(sent.length, 2);
  list = [list[3]]; // a1, a2 and a3 ended
  await push.check();
  list = [{ id: 'a3', routes: [], stops: ['S9'], header: 'Stop closed' }, list[0]];
  await push.check();
  assert.strictEqual(sent.length, 3); // a3 came back after ending, so it is new again; a4 stayed remembered
});

test('alerts watch: changing routes re-primes instead of announcing old alerts', async () => {
  sent.length = 0;
  const list = [{ id: 'b1', routes: ['17'], stops: [], header: 'Old on 17' }];
  const push = createPush({ arrivals: async () => [], alerts: async () => list, checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'e10' }, alerts: true, routes: ['60'], stopIds: [], minutes: 1 });
  await push.check();
  push.watch({ sub: { endpoint: 'e10' }, alerts: true, routes: ['60', '17'], stopIds: [], minutes: 1 });
  await push.check();
  assert.strictEqual(sent.length, 0);
});

test('an empty alert list (feed never downloaded) does not make an alerts watch forget, so nothing is re-announced', async () => {
  sent.length = 0;
  let list = [{ id: 'a1', routes: ['60'], stops: [], header: 'Detour' }];
  const push = createPush({ arrivals: async () => [], alerts: async () => list, checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'al' }, alerts: true, routes: ['60'], stopIds: [], minutes: 1 });
  await push.check(); // primes: a1 is already active, not announced
  list = []; await push.check();
  list = [{ id: 'a1', routes: ['60'], stops: [], header: 'Detour' }]; await push.check();
  assert.strictEqual(sent.length, 0);
});

// ---------- quiet hours (one window, Saskatoon wall-clock minutes; 2026-10-16 is a Friday) ----------
const { quietAt } = createPush;
const at = (d, h, m) => Date.UTC(2026, 9, d, h, m) / 1000 + 6 * 3600;
const TZ = -6 * 3600;
const win = (extra = {}) => ({ on: true, startMin: 540, endMin: 720, days: [1, 2, 3, 4, 5], ...extra });

test('quietAt: a same-day window is quiet from its start up to but not including its end, on its days', () => {
  const q = win();
  assert.strictEqual(quietAt(q, at(16, 9, 0), TZ), true); // start inclusive
  assert.strictEqual(quietAt(q, at(16, 11, 59), TZ), true);
  assert.strictEqual(quietAt(q, at(16, 12, 0), TZ), false); // end exclusive
  assert.strictEqual(quietAt(q, at(16, 8, 59), TZ), false);
  assert.strictEqual(quietAt(q, at(17, 10, 0), TZ), false); // Saturday is not in days
});

test('quietAt: a window that crosses midnight belongs to the day it starts on', () => {
  const q = win({ startMin: 1380, endMin: 420, days: [5] }); // Fri 23:00 to 07:00
  assert.strictEqual(quietAt(q, at(16, 23, 30), TZ), true); // Fri 23:30
  assert.strictEqual(quietAt(q, at(17, 6, 59), TZ), true); // Sat 06:59 is still Friday's window
  assert.strictEqual(quietAt(q, at(17, 7, 0), TZ), false);
  assert.strictEqual(quietAt(q, at(16, 22, 59), TZ), false);
  assert.strictEqual(quietAt(q, at(15, 23, 30), TZ), false); // Thu
  assert.strictEqual(quietAt(q, at(17, 23, 30), TZ), false); // Sat night: Sat is not in days
});

test('quietAt: off, equal start and end, and malformed settings are never quiet, and never throw', () => {
  const t = at(16, 10, 0); // inside the window if it were valid
  assert.strictEqual(quietAt(win(), t, TZ), true);
  assert.strictEqual(quietAt(win({ on: false }), t, TZ), false);
  assert.strictEqual(quietAt(win({ startMin: 600, endMin: 600 }), t, TZ), false);
  for (const bad of [null, undefined, {}, 'x', win({ days: 5 }), win({ days: [] }), win({ days: [1, 9] }), win({ startMin: 2000 }), win({ endMin: '600' }), win({ startMin: 1.5 })]) assert.strictEqual(quietAt(bad, t, TZ), false);
});

// a window that covers the current minute, so the check() tests do not depend on the clock
const localMin = () => { const d = new Date(Date.now() - 6 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const quietNow = () => { const m = localMin(); return { on: true, startMin: (m + 1435) % 1440, endMin: (m + 5) % 1440, days: [0, 1, 2, 3, 4, 5, 6] }; };

test('quiet hours: a standing stop watch sends nothing while quiet, and the same bus notifies once quiet ends', async () => {
  sent.length = 0;
  let q = quietNow(), calls = 0;
  const push = createPush({ arrivals: async () => { calls++; return [{ trip: 'Q', route: '60', time: now() + 200, live: true }]; }, quiet: () => q, checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'q1' }, stopId: 'SQ', standing: true, routes: null, minutes: 5, stopName: 'X' });
  await push.check();
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(calls, 0); // its stop's arrivals are not even fetched
  q = null; // quiet ends: the bus is still in the window, so it was never marked as sent
  await push.check();
  assert.strictEqual(sent.length, 1);
});

test('quiet hours: alerts prime as usual, a new match is held until quiet ends, and one that ends in quiet is never sent', async () => {
  sent.length = 0;
  let q = quietNow();
  let list = [{ id: 'o1', routes: ['60'], stops: [], header: 'Old' }];
  const push = createPush({ arrivals: async () => [], alerts: async () => list, quiet: () => q, checkEveryMs: 1e9 });
  push.watch({ sub: { endpoint: 'qa' }, alerts: true, routes: ['60'], stopIds: [], minutes: 1 });
  await push.check(); // primes during quiet: 'Old' is recorded, not sent
  list = [...list, { id: 'n1', routes: ['60'], stops: [], header: 'Held' }, { id: 'n2', routes: ['60'], stops: [], header: 'Gone by morning' }];
  await push.check();
  assert.strictEqual(sent.length, 0);
  list = list.filter((a) => a.id !== 'n2'); // n2 ends during the night
  q = null;
  await push.check();
  assert.deepStrictEqual(sent.map((s) => s.body), ['Held']);
  await push.check();
  assert.strictEqual(sent.length, 1); // once
});

test('quiet hours: one-off bus bells, commutes and ride watches still send', async () => {
  sent.length = 0;
  const push = createPush({ arrivals: async () => [{ trip: 'T', route: '17', time: now() + 200, live: true }], plan: async () => option(now() + 200), progress: async () => prog(9), quiet: () => quietNow(), checkEveryMs: 1e9 });
  push.watch(w());
  push.watch(commute({ commuteId: 'qc' }));
  push.watch(ride());
  await push.check();
  assert.deepStrictEqual(sent.map((s) => s.title).sort(), ['Leave in 3 min for To Work', 'Route 17 in 3 min', 'Your stop is next']);
});

test('quiet hours: a quiet() getter that throws or returns junk never stops notifications', async () => {
  for (const quiet of [() => { throw new Error('db'); }, () => ({ on: true, startMin: 'x', endMin: 0, days: 'all' }), () => 'junk']) {
    sent.length = 0;
    const push = createPush({ arrivals: async () => [{ trip: 'T', route: '17', time: now() + 200, live: true }], quiet, checkEveryMs: 1e9 });
    push.watch(w());
    await push.check();
    assert.strictEqual(sent.length, 1);
  }
});
