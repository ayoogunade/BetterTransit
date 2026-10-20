// Current conditions for Saskatoon from Open-Meteo (free, no key). Cached like the city feeds: one request in flight, a timeout,
// and a failure keeps the last good reading (null if there never was one).
const URL_ = 'https://api.open-meteo.com/v1/forecast?latitude=52.13&longitude=-106.67&current=temperature_2m,apparent_temperature,wind_speed_10m';
const COLD = -20; // feels-like, deg C: at or below this the planner favours less time outside

module.exports = function createWeather({ fetch: get = fetch, ttlMs = 15 * 60e3, retryMs = 60e3, timeoutMs = 5000, now = Date.now } = {}) {
  let cur = null, at = 0, failedAt = null, pending = null;
  return async function weather() {
    const t = now();
    if (cur && t - at < ttlMs) return cur;
    if (failedAt != null && t - failedAt < retryMs) return cur; // down: don't make every plan wait on the timeout
    pending ||= (async () => {
      try {
        const res = await get(URL_, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(res.status);
        const c = (await res.json()).current;
        if (!Number.isFinite(c.temperature_2m) || !Number.isFinite(c.apparent_temperature)) throw new Error('bad data');
        cur = { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), wind: Math.round(c.wind_speed_10m), cold: c.apparent_temperature <= COLD };
        at = now(); failedAt = null;
      } catch (e) { failedAt = now(); console.error('weather error', e.message); } // keep serving the last good reading
      finally { pending = null; }
      return cur;
    })();
    return pending;
  };
};
