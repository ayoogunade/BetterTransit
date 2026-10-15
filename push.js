// "Notify me when this bus is N minutes away": Web Push with VAPID keys, watches persisted to disk.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DIR = path.join(__dirname, 'data');
const KEYS = path.join(DIR, 'vapid.json');
const WATCHES = path.join(DIR, 'watches.json');
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

module.exports = function createPush({ arrivals, checkEveryMs = 20000 }) {
  let keys = loadJson(KEYS, null);
  if (!keys) save(KEYS, (keys = webpush.generateVAPIDKeys()));
  webpush.setVapidDetails('mailto:local@localhost', keys.publicKey, keys.privateKey);

  let watches = loadJson(WATCHES, []); // {sub, stopId, tripId, minutes, route, headsign, stopName}
  const same = (a, b) => a.sub.endpoint === b.sub.endpoint && a.stopId === b.stopId && a.tripId === b.tripId;

  async function check() {
    const now = Date.now() / 1000;
    const stopIds = [...new Set(watches.map((w) => w.stopId))];
    const arr = Object.fromEntries(await Promise.all(stopIds.map(async (s) => [s, await arrivals(s).catch(() => null)])));
    const keep = [];
    for (const w of watches) {
      const hit = (arr[w.stopId] || []).find((a) => a.trip === w.tripId);
      if (!arr[w.stopId]) { keep.push(w); continue; } // feed hiccup: try again next tick
      if (!hit) { if (!w.missing) w.missing = now; if (now - w.missing < 300) keep.push(w); continue; } // trip left the feed: give up after 5 min
      delete w.missing;
      if (hit.time - now > w.minutes * 60) { keep.push(w); continue; }
      const mins = Math.max(0, Math.round((hit.time - now) / 60));
      try {
        await webpush.sendNotification(w.sub, JSON.stringify({
          title: `Route ${w.route} ${mins <= 0 ? 'is due' : `in ${mins} min`}`,
          body: `${w.headsign || ''} at ${w.stopName}${hit.live ? '' : ' (scheduled)'}`,
        }));
      } catch (e) { if (![404, 410].includes(e.statusCode)) console.error('push failed', e.statusCode || e.message); }
    }
    watches = keep;
    save(WATCHES, watches);
  }
  setInterval(() => check().catch((e) => console.error('push check', e.message)), checkEveryMs).unref();

  return {
    publicKey: keys.publicKey,
    watch(w) { watches = watches.filter((x) => !same(x, w)); watches.push(w); save(WATCHES, watches); },
    unwatch(w) { watches = watches.filter((x) => !same(x, w)); save(WATCHES, watches); },
    has: (w) => watches.some((x) => same(x, w)),
    check,
  };
};
