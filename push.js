// "Notify me when this bus is N minutes away": Web Push with VAPID keys, watches persisted to disk.
// Three kinds of watch: one trip at a stop (dropped once it has fired), a standing stop watch ({standing: true, routes}) that
// fires once for every bus of the chosen routes at that stop and stays until removed, and a commute ({commute: true, from, to,
// days, startMin, endMin}) that plans the trip during its time window and says when to leave for the next bus.
// A fifth, {alerts: true, routes, stopIds}, pushes each new service alert that names one of those routes or stops (once per alert).
// A fourth, {ride: true, tripId, alightStopId, alightIdx, ...}, rides along with one bus: "your stop is next" when it nears the stop you get off at.
// With {next: {tripId, boardStopId, boardIdx, walkSecs, route}, to, alightAt} it also warns, once, if you will miss the connection, and re-plans.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DIR = path.join(__dirname, 'data');
const KEYS = path.join(DIR, 'vapid.json');
const WATCHES = path.join(DIR, 'watches.json');
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

// Browsers only hand out subscriptions on their vendor's push service. Anything else would make the server POST to an address of the caller's choosing.
const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'push.apple.com', 'notify.windows.com'];
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const point = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// A reason this watch request is unacceptable, or null. Checked by the server before watch().
function invalid(w) {
  try {
    const u = new URL(w.sub.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return 'unknown push service';
  } catch { return 'bad subscription'; }
  if (!w.sub.keys || typeof w.sub.keys.p256dh !== 'string' || typeof w.sub.keys.auth !== 'string') return 'bad subscription';
  if (!w.alerts && !int(w.minutes, 1, 120)) return 'bad minutes';
  if (w.alerts) {
    const strs = (a) => Array.isArray(a) && a.length <= 300 && a.every((x) => typeof x === 'string' && x.length < 40);
    if (!strs(w.routes) || !strs(w.stopIds)) return 'bad alerts';
  } else if (w.commute) {
    if (typeof w.commuteId !== 'string' || !w.commuteId) return 'bad commute';
    if (!point(w.from) || !point(w.to)) return 'bad places';
    if (!Array.isArray(w.days) || !w.days.length || !w.days.every((d) => int(d, 0, 6))) return 'bad days';
    if (!int(w.startMin, 0, 1439) || !int(w.endMin, 0, 1439) || w.endMin < w.startMin) return 'bad times';
  } else if (w.ride) {
    if (typeof w.tripId !== 'string' || !w.tripId || typeof w.alightStopId !== 'string' || !w.alightStopId) return 'bad ride';
    if (!int(w.alightIdx, 1, 500)) return 'bad ride';
    const n = w.next;
    if (n && !(typeof n.tripId === 'string' && n.tripId && typeof n.boardStopId === 'string' && int(n.boardIdx, 0, 500) && int(n.walkSecs, 0, 7200) && typeof n.route === 'string' && point(w.to) && point(w.alightAt))) return 'bad connection';
  } else if (typeof w.stopId !== 'string' || !w.stopId) return 'bad stop';
  return null;
}

module.exports = function createPush({ arrivals, alerts = async () => [], progress = async () => null, plan = async () => [], weather = async () => null, tzOffsetSec = -6 * 3600, checkEveryMs = 20000 }) {
  let keys = loadJson(KEYS, null);
  if (!keys) save(KEYS, (keys = webpush.generateVAPIDKeys()));
  // Apple's push service rejects a made-up contact like mailto:local@localhost (403 BadJwtToken), so use a real URL
  webpush.setVapidDetails(process.env.PUSH_SUBJECT || 'https://34-46-182-45.sslip.io', keys.publicKey, keys.privateKey);

  let watches = loadJson(WATCHES, []); // {sub, stopId, tripId, minutes, route, headsign, stopName} or {sub, stopId, standing, routes, minutes, stopName, sent}
  const same = (a, b) => a.sub.endpoint === b.sub.endpoint && (a.alightStopId || a.stopId) === (b.alightStopId || b.stopId) && !!a.ride === !!b.ride && !!a.alerts === !!b.alerts && a.tripId === b.tripId && a.commuteId === b.commuteId;
  const clock = (t) => { const d = new Date((t + tzOffsetSec) * 1000), h = d.getUTCHours(); return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  // watches that notify once per trip remember which ones, for six hours
  const prune = (w, now) => { w.sent ||= {}; for (const [trip, at] of Object.entries(w.sent)) if (now - at > 6 * 3600) delete w.sent[trip]; };

  // true when the push service says this subscription no longer exists (the app was uninstalled or permission revoked)
  async function send(w, payload) {
    try { await webpush.sendNotification(w.sub, JSON.stringify(payload)); } catch (e) { if ([404, 410].includes(e.statusCode)) return true; console.error('push failed', e.statusCode || e.message); }
    return false;
  }

  // Standing stop watch: notify once per trip when a bus on the chosen routes comes within the window. Returns false if the watch should be dropped.
  async function pingStop(w, list, now) {
    prune(w, now);
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

  // Alerts watch: push each active alert naming one of the watch's routes or stops, once. Alerts can stay up for days, so an id is
  // remembered while the alert is active (not for 6 h). The first pass, and any change of routes/stops, only records what is already
  // active so old alerts are not announced. Returns false if the watch should be dropped.
  async function pingAlerts(w, list, now) {
    const sig = [...w.routes, '|', ...w.stopIds].join(), live = new Set(list.map((a) => a.id)), prime = w.sig !== sig;
    w.sent ||= {}; w.sig = sig;
    // an empty list is what a never-downloaded feed looks like (e.g. a restart during a city outage): forgetting then would re-announce everything
    if (list.length) for (const id of Object.keys(w.sent)) if (!live.has(id)) delete w.sent[id];
    for (const a of list) {
      if (w.sent[a.id]) continue;
      const route = (a.routes || []).find((r) => w.routes.includes(r)), stop = (a.stops || []).find((s) => w.stopIds.includes(s));
      if (!prime && !route && !stop) continue;
      w.sent[a.id] = now;
      if (!prime && await send(w, { title: route ? `Alert: Route ${route}` : 'Alert: stop', body: a.header || 'Service alert' })) return false;
    }
    return true;
  }

  // Commute: while its window is open, plan the trip about once a minute and send one "leave in N min" per bus. Returns false if the watch should be dropped.
  async function pingCommute(w, now) {
    const local = new Date((now + tzOffsetSec) * 1000), min = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (!w.days.includes(local.getUTCDay()) || min < w.startMin || min > w.endMin || now - (w.checkedAt || 0) < 60) return true;
    w.checkedAt = now;
    const opts = await plan(w.from, w.to).catch(() => null);
    const o = opts && opts[0], ride = o && o.legs.find((l) => l.type === 'ride');
    prune(w, now);
    if (!ride || w.sent[ride.trip] || o.leave - now > w.minutes * 60) return true;
    w.sent[ride.trip] = now;
    const mins = Math.max(0, Math.round((o.leave - now) / 60)), wx = await weather().catch(() => null);
    return !(await send(w, { title: `${mins <= 0 ? 'Leave now' : `Leave in ${mins} min`} for ${w.name || 'your commute'}`, body: `Route ${ride.route} ${ride.headsign || ''} from ${ride.board.name} at ${clock(ride.dep)} · arrive ${clock(o.arrive)}${ride.live ? '' : ' (scheduled)'}${ride.last ? ' · last bus' : ''}${wx && wx.cold ? ` · feels like ${wx.feels}°F` : ''}` }));
  }

  // Ride watch: "your stop is next" once the bus is at the stop before yours. Returns false if the watch should be dropped.
  async function pingRide(w, now) {
    w.since ||= now;
    if (now - w.since > 3 * 3600) return false;
    let p;
    try { p = await progress(w.tripId); } catch { return true; } // feed hiccup: try again next tick
    // not in the feed: before it is due at your stop it may just not have started yet; after that, give up after 5 min
    if (!p || !p.live) { if (p && now < p.time(w.alightIdx)) return true; w.missing ||= now; return now - w.missing < 300; }
    delete w.missing;
    if (p.cancelled || p.next === null || p.next > w.alightIdx) return false; // cancelled, finished, or you are past your stop
    if (p.next === undefined) return true; // no predictions yet
    if (w.next && !w.rescued) await rescue(w, p);
    if (p.next < w.alightIdx - 1) return true;
    await send(w, { title: 'Your stop is next', body: `Get off at ${w.stopName}` });
    return false;
  }
  // Will the connection still be there when you've reached your stop and walked to it (plus a minute)? If not, re-plan from here, once.
  async function rescue(w, p) {
    const n = w.next, np = await progress(n.tripId).catch(() => null);
    if (!np) return;
    const arrive = p.time(w.alightIdx);
    if (!np.cancelled && arrive + n.walkSecs + 60 <= np.time(n.boardIdx)) return;
    const opts = await plan(w.alightAt, w.to, Math.ceil(arrive)).catch(() => null);
    if (!opts) return; // planner down: try again next tick
    w.rescued = true;
    const o = opts[0], r = o && o.legs.find((l) => l.type === 'ride');
    // the planner has no minute of margin, so it may still pick the same bus: that's a tight connection, not a missed one
    if (r && r.trip === n.tripId) return void (await send(w, { title: `Tight connection to the ${n.route}`, body: `Hurry to ${n.stopName || w.stopName}: it leaves at ${clock(r.dep)}` }));
    await send(w, { title: `You'll miss the ${n.route} at ${n.stopName || w.stopName}`, body: r ? `Take the ${r.route} ${r.headsign || ''} at ${clock(r.dep)} instead · arrive ${clock(o.arrive)}` : 'No other bus found from here' });
  }

  async function check() {
    const now = Date.now() / 1000;
    const stopIds = [...new Set(watches.filter((w) => !w.commute && !w.ride && !w.alerts).map((w) => w.stopId))];
    const arr = Object.fromEntries(await Promise.all(stopIds.map(async (s) => [s, await arrivals(s).catch(() => null)])));
    // Sends are slow, and watch()/unwatch() can run while we wait on them, so only remove the watches this pass finished with;
    // replacing the whole list would throw away anything added in the meantime.
    const drop = new Set();
    const al = watches.some((w) => w.alerts) ? await alerts().catch(() => null) : null; // one fetch shared by every alerts watch
    for (const w of [...watches]) {
      if (w.alerts) { if (al && !(await pingAlerts(w, al, now))) drop.add(w); continue; }
      if (w.commute) { if (!(await pingCommute(w, now))) drop.add(w); continue; }
      if (w.ride) { if (!(await pingRide(w, now))) drop.add(w); continue; }
      if (w.standing) { if (arr[w.stopId] && !(await pingStop(w, arr[w.stopId], now))) drop.add(w); continue; }
      const hit = (arr[w.stopId] || []).find((a) => a.trip === w.tripId);
      if (!arr[w.stopId]) continue; // feed hiccup: try again next tick
      if (!hit) { if (!w.missing) w.missing = now; if (now - w.missing >= 300) drop.add(w); continue; } // trip left the feed: give up after 5 min
      delete w.missing;
      if (hit.gone) { drop.add(w); continue; } // it already passed the stop
      if (hit.cancelled || hit.skipped) { // tell them now so they don't keep waiting
        await send(w, { title: `Route ${w.route} ${hit.cancelled ? 'cancelled' : 'not stopping here'}`, body: `${w.headsign || ''} at ${w.stopName}${hit.cancelled ? ' was cancelled' : ' is skipping this stop (detour)'}` });
        drop.add(w); continue;
      }
      if (hit.time - now > w.minutes * 60) continue;
      const mins = Math.max(0, Math.round((hit.time - now) / 60));
      await send(w, { title: `Route ${w.route} ${mins <= 0 ? 'is due' : `in ${mins} min`}`, body: `${w.headsign || ''} at ${w.stopName}${hit.live ? '' : ' (scheduled)'}` });
      drop.add(w);
    }
    watches = watches.filter((w) => !drop.has(w));
    save(WATCHES, watches);
  }
  let busy = false; // a slow pass must not overlap the next one, or the same bus would be announced twice
  setInterval(() => { if (busy) return; busy = true; check().catch((e) => console.error('push check', e.message)).finally(() => { busy = false; }); }, checkEveryMs).unref();

  return {
    publicKey: keys.publicKey,
    watch(w) { // the app re-registers its watches on every launch: keep what this one already announced
      const old = watches.find((x) => same(x, w));
      if (old) for (const k of ['sent', 'since', 'rescued', 'sig']) if (old[k]) w[k] = old[k];
      watches = watches.filter((x) => x !== old); watches.push(w); save(WATCHES, watches);
    },
    unwatch(w) { watches = watches.filter((x) => !same(x, w)); save(WATCHES, watches); },
    dropSession(sid) { watches = watches.filter((x) => !sid || x.sid !== sid); save(WATCHES, watches); }, // a signed-out device stops getting pushes
    has: (w) => watches.some((x) => same(x, w)),
    invalid,
    check,
  };
};
