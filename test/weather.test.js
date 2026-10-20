const test = require('node:test');
const assert = require('node:assert');
const createWeather = require('../weather');

const ok = (feels, temp = feels + 8) => async () => ({ ok: true, json: async () => ({ current: { temperature_2m: temp, apparent_temperature: feels, wind_speed_10m: 14.4 } }) });
const clockAt = () => { const c = { t: 0, now: () => c.t }; return c; };

test('rounds the reading and flags cold at -4 °F feels-like or colder', async () => {
  assert.deepStrictEqual(await createWeather({ fetch: ok(-34.6, -27.2) })(), { temp: -27, feels: -35, wind: 14, cold: true });
  assert.strictEqual((await createWeather({ fetch: ok(-4) })()).cold, true);
  assert.strictEqual((await createWeather({ fetch: ok(-3.9) })()).cold, false);
});

test('caches for 15 minutes and shares one request in flight', async () => {
  const c = clockAt(); let calls = 0;
  const w = createWeather({ fetch: async (...a) => { calls++; return ok(-5)(...a); }, now: c.now });
  await Promise.all([w(), w(), w()]);
  assert.strictEqual(calls, 1);
  c.t = 14 * 60e3; await w(); assert.strictEqual(calls, 1);
  c.t = 16 * 60e3; await w(); assert.strictEqual(calls, 2);
});

test('a failure keeps the last reading, and null when there never was one; retries after a minute', async () => {
  const c = clockAt(); let calls = 0, fail = true;
  const w = createWeather({ fetch: async (...a) => { calls++; if (fail) throw new Error('down'); return ok(-30)(...a); }, now: c.now });
  assert.strictEqual(await w(), null);
  await w(); assert.strictEqual(calls, 1); // backing off
  c.t = 61e3; fail = false; assert.strictEqual((await w()).feels, -30);
  fail = true; c.t += 16 * 60e3;
  assert.strictEqual((await w()).feels, -30); // stale but kept
});

test('rejects a non-ok response and junk data', async () => {
  assert.strictEqual(await createWeather({ fetch: async () => ({ ok: false, status: 500 }) })(), null);
  assert.strictEqual(await createWeather({ fetch: async () => ({ ok: true, json: async () => ({ current: {} }) }) })(), null);
});

test('passes an abort signal so a hung server cannot stall planning', async () => {
  let sig;
  await createWeather({ fetch: async (u, o) => { sig = o.signal; return ok(0)(); } })();
  assert.ok(sig instanceof AbortSignal);
});
