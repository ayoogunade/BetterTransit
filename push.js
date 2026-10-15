// "Notify me when this bus is N minutes away": Web Push with VAPID keys, watches persisted to disk.
// Two kinds of watch: one trip at a stop (dropped once it has fired), or a standing stop watch ({standing: true, routes}) that
// fires once for every bus of the chosen routes at that stop and stays until removed.
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

  let watches = loadJson(WATCHES, []); // {sub, stopId, tripId, minutes, route, headsign, stopName} or {sub, stopId, standing, routes, minutes, stopName, sent}
  const same = (a, b) => a.sub.endpoint === b.sub.endpoint && a.stopId === b.stopId && a.tripId === b.tripId;

  // true when the push service says this subscription no longer exists (the app was uninstalled or permission revoked)
  async function send(w, payload) {
    try { await webpush.sendNotification(w.sub, JSON.stringify(payload)); } catch (e) { if ([404, 410].includes(e.statusCode)) return true; console.error('push failed', e.statusCode || e.message); }
    return false;
  }

  // Standing stop watch: notify once per trip when a bus on the chosen routes comes within the window. Returns false if the watch should be dropped.
  async function pingStop(w, list, now) {
    w.sent ||= {};
    for (const [trip, at] of Object.entries(w.sent)) if (now - at > 6 * 3600) delete w.sent[trip];
    for (const a of list) {
      if (w.routes && !w.routes.includes(a.route)) continue;
      if (a.cancelled || a.skipped || a.gone || a.ends) continue; // not coming, or not boardable here
      if (w.sent[a.trip] || a.time - now > w.minutes * 60 || a.time < now - 60) continue;
      w.sent[a.trip] = now;
      const mins = Math.max(0, Math.round((a.time - now) / 60));
      if (await send(w, { title: `Route ${a.route} ${mins <= 0 ? 'is due' : `in ${mins} min`}`, body: `${a.headsign || ''} at ${w.stopName}${a.live ? '' : ' (scheduled)'}` })) return false;
    }
    return true;
  }

  async function check() {
    const now = Date.now() / 1000;
    const stopIds = [...new Set(watches.map((w) => w.stopId))];
    const arr = Object.fromEntries(await Promise.all(stopIds.map(async (s) => [s, await arrivals(s).catch(() => null)])));
    const keep = [];
    for (const w of watches) {
      if (w.standing) { if (!arr[w.stopId] || (await pingStop(w, arr[w.stopId], now))) keep.push(w); continue; }
      const hit = (arr[w.stopId] || []).find((a) => a.trip === w.tripId);
      if (!arr[w.stopId]) { keep.push(w); continue; } // feed hiccup: try again next tick
      if (!hit) { if (!w.missing) w.missing = now; if (now - w.missing < 300) keep.push(w); continue; } // trip left the feed: give up after 5 min
      delete w.missing;
      if (hit.gone) continue; // it already passed the stop
      if (hit.cancelled || hit.skipped) { // tell them now so they don't keep waiting
        await send(w, { title: `Route ${w.route} ${hit.cancelled ? 'cancelled' : 'not stopping here'}`, body: `${w.headsign || ''} at ${w.stopName}${hit.cancelled ? ' was cancelled' : ' is skipping this stop (detour)'}` });
        continue;
      }
      if (hit.time - now > w.minutes * 60) { keep.push(w); continue; }
      const mins = Math.max(0, Math.round((hit.time - now) / 60));
      await send(w, { title: `Route ${w.route} ${mins <= 0 ? 'is due' : `in ${mins} min`}`, body: `${w.headsign || ''} at ${w.stopName}${hit.live ? '' : ' (scheduled)'}` });
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
