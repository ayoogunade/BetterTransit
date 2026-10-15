const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const GtfsRt = require('gtfs-realtime-bindings').transit_realtime;

const PORT = process.env.PORT || 3000;
const RT = 'https://saskprdtmgtfs.sasktrpcloud.com/TMGTFSRealTimeWebService';
const GTFS_DIR = path.join(__dirname, 'data', 'gtfs');
const TTL_MS = 15000; // feeds refresh every 20-30s; don't hammer the city
const TZ_OFFSET_SEC = -6 * 3600; // Saskatchewan: CST year-round, no DST

// ---------- static GTFS (auto-refreshed) ----------
const GTFS_URL = 'https://apps5.saskatoon.ca/data/gtfs/google_transit.zip';
const REFRESH_MS = 24 * 3600 * 1000;
const read = (f) =>
  parse(fs.readFileSync(path.join(GTFS_DIR, f)), { columns: true, skip_empty_lines: true, trim: true });
const toSecs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };

let stops, childrenOf, routes, trips, calendar, calDates, stopTimesByStop, tripStops, plan;
function loadStatic() {
  stops = read('stops.txt'); // includes hubs (location_type 1); arrivals() merges a hub's child stops
  childrenOf = {};
  for (const s of stops) if (s.parent_station) (childrenOf[s.parent_station] ||= []).push(s.stop_id);
  routes = Object.fromEntries(read('routes.txt').map((r) => [r.route_id, r]));
  trips = Object.fromEntries(read('trips.txt').map((t) => [t.trip_id, t]));
  calendar = read('calendar.txt');
  calDates = read('calendar_dates.txt');
  stopTimesByStop = {};
  tripStops = {}; // trip -> ordered [{stop, t, seq}] for the planner
  for (const st of read('stop_times.txt')) {
    const t = toSecs(st.arrival_time);
    (stopTimesByStop[st.stop_id] ||= []).push({ trip: st.trip_id, t });
    (tripStops[st.trip_id] ||= []).push({ stop: st.stop_id, t, seq: +st.stop_sequence });
  }
  for (const sts of Object.values(tripStops)) sts.sort((a, b) => a.seq - b.seq);
  plan = require('./planner')({ stops, tripStops, trips });
}

// Download the city's schedule zip if ours is missing or older than a day; reload only if it changed.
async function refreshStatic() {
  const marker = path.join(GTFS_DIR, '.fetched');
  const have = fs.existsSync(marker) && fs.existsSync(path.join(GTFS_DIR, 'stop_times.txt'));
  const old = have ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (have && Date.now() - old.at < REFRESH_MS) return !stops && (loadStatic(), true);
  try {
    const res = await fetch(GTFS_URL);
    if (!res.ok) throw new Error(res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const changed = !old || old.hash !== hash;
    if (changed) { fs.mkdirSync(GTFS_DIR, { recursive: true }); new AdmZip(buf).extractAllTo(GTFS_DIR, true); }
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), hash }));
    if (changed || !stops) { loadStatic(); console.log('schedule loaded', changed ? '(updated)' : ''); }
  } catch (e) {
    console.error('schedule refresh failed', e.message);
    if (!stops && have) loadStatic(); // fall back to what we have on disk
  }
}

function activeServices(date) {
  const ymd = Number(date.toISOString().slice(0, 10).replace(/-/g, ''));
  const dow = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getUTCDay()];
  const on = new Set(calendar.filter((c) => c[dow] === '1' && +c.start_date <= ymd && ymd <= +c.end_date).map((c) => c.service_id));
  for (const d of calDates) if (+d.date === ymd) d.exception_type === '1' ? on.add(d.service_id) : on.delete(d.service_id);
  return on;
}

// ---------- realtime feeds (cached) ----------
const cache = {};
async function feed(name) {
  const c = (cache[name] ||= { at: 0, msg: null });
  if (Date.now() - c.at < TTL_MS && c.msg) return c.msg;
  try {
    const res = await fetch(`${RT}/${name}`);
    if (!res.ok) throw new Error(res.status);
    c.msg = GtfsRt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    c.at = Date.now();
  } catch (e) {
    console.error('feed error', name, e.message); // keep serving last good data
  }
  return c.msg || { entity: [] };
}

// ---------- arrivals ----------
const lastGood = new Map(); // trip|stop -> {time, seen} so predictions don't flicker away
const shape = (tripId, time, live) => {
  const t = trips[tripId] || {};
  const r = routes[t.route_id] || {};
  return { trip: tripId, route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign, time, live };
};

async function arrivals(id) {
  const ids = childrenOf[id] || [id];
  const lists = await Promise.all(ids.map(arrivalsAt));
  return lists.flat().sort((a, b) => a.time - b.time).slice(0, 12);
}

async function arrivalsAt(stopId) {
  const now = Math.floor(Date.now() / 1000);
  const out = new Map();
  for (const e of (await feed('TripUpdate/TripUpdates.pb')).entity) {
    const tu = e.tripUpdate; if (!tu || !trips[tu.trip.tripId]) continue; // skip ad-hoc trips with no route we can name
    for (const u of tu.stopTimeUpdate || []) {
      if (u.stopId !== stopId) continue;
      const time = Number((u.arrival || u.departure || {}).time || 0);
      if (!time) continue;
      lastGood.set(`${tu.trip.tripId}|${stopId}`, { time, seen: Date.now() });
      out.set(tu.trip.tripId, shape(tu.trip.tripId, time, true));
    }
  }
  // keep a recently-seen prediction for 90s if the feed briefly drops it
  for (const [k, v] of lastGood) {
    const [trip, stop] = k.split('|');
    if (Date.now() - v.seen > 90000) lastGood.delete(k);
    else if (stop === stopId && !out.has(trip) && v.time > now - 60) out.set(trip, { ...shape(trip, v.time, true), stale: true });
  }
  // fill in scheduled-only trips, clearly marked live:false
  const localMidnight = Math.floor((now + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC;
  const services = activeServices(new Date((now + TZ_OFFSET_SEC) * 1000));
  for (const st of stopTimesByStop[stopId] || []) {
    const t = trips[st.trip]; if (!t || !services.has(t.service_id) || out.has(st.trip)) continue;
    const time = localMidnight + st.t;
    if (time > now - 60 && time < now + 3 * 3600) out.set(st.trip, shape(st.trip, time, false));
  }
  return [...out.values()].sort((a, b) => a.time - b.time).slice(0, 12);
}

// ---------- vehicles / alerts ----------
const lastBearing = new Map(); // vehicle id -> last known heading, for buses that report 0 while stopped
const nextStopCache = new WeakMap();
async function nextStops() { // tripId -> {stop, time} of the first upcoming stop prediction
  const msg = await feed('TripUpdate/TripUpdates.pb');
  if (nextStopCache.has(msg)) return nextStopCache.get(msg);
  const now = Date.now() / 1000, out = new Map();
  for (const e of msg.entity) {
    const tu = e.tripUpdate; if (!tu) continue;
    const u = (tu.stopTimeUpdate || []).find((x) => Number((x.arrival || x.departure || {}).time) > now - 30);
    if (u) out.set(tu.trip.tripId, { stop: u.stopId, time: Number((u.arrival || u.departure).time) });
  }
  nextStopCache.set(msg, out);
  return out;
}

async function vehicles(routeFilter) {
  const next = await nextStops();
  const stopName = (id) => (stops.find((x) => x.stop_id === id) || {}).stop_name;
  const out = [];
  for (const e of (await feed('Vehicle/VehiclePositions.pb')).entity) {
    const v = e.vehicle; if (!v || !v.position) continue;
    const t = trips[v.trip && v.trip.tripId] || {};
    const r = routes[t.route_id] || routes[v.trip && v.trip.routeId] || {};
    if (routeFilter.length && !routeFilter.includes(r.route_short_name)) continue;
    const id = v.vehicle && v.vehicle.id;
    const { bearing, speed } = v.position;
    if (bearing || speed > 0.5) lastBearing.set(id, bearing || 0);
    const n = next.get(v.trip && v.trip.tripId);
    out.push({
      id, label: v.vehicle && v.vehicle.label, trip: v.trip && v.trip.tripId, lat: v.position.latitude, lon: v.position.longitude,
      age: Number(v.timestamp) ? Math.max(0, Math.round(Date.now() / 1000 - Number(v.timestamp))) : null, // seconds since the bus last reported
      bearing: lastBearing.has(id) ? lastBearing.get(id) : null,
      route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign,
      next: n && { stop: stopName(n.stop), time: n.time },
    });
  }
  return out;
}

async function alerts() {
  const text = (ts) => ts && ts.translation && ts.translation[0] && ts.translation[0].text;
  const now = Date.now() / 1000;
  const list = (await feed('Alert/Alerts.pb')).entity.filter((e) => e.alert).map((e) => ({
    start: Number(((e.alert.activePeriod || [])[0] || {}).start || 0),
    header: text(e.alert.headerText),
    description: text(e.alert.descriptionText),
    routes: (e.alert.informedEntity || []).map((i) => (routes[i.routeId] || {}).route_short_name).filter(Boolean),
  }));
  return list.filter((a) => a.start <= now).sort((a, b) => b.start - a.start); // newest first
}

// Stops within 800 m of a point (nearest first, max 5) that have buses coming. Hubs are skipped: their child stops are listed individually.
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111200, (a.lon - b.lon) * 111200 * Math.cos(a.lat * Math.PI / 180));
async function nearby(lat, lon) {
  const near = stops.filter((s) => s.location_type !== '1')
    .map((s) => ({ s, dist: Math.round(metres({ lat, lon }, { lat: +s.stop_lat, lon: +s.stop_lon })) }))
    .filter((x) => x.dist <= 800).sort((a, b) => a.dist - b.dist).slice(0, 5);
  const out = await Promise.all(near.map(async ({ s, dist }) => ({ id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, dist, arrivals: await arrivalsAt(s.stop_id) })));
  return out.filter((p) => p.arrivals.length);
}

// Every stop of one trip with its (live-adjusted when available) time, so the app can show clock times and "+N min" offsets.
async function tripTimeline(tripId) {
  const sts = tripStops[tripId], t = trips[tripId];
  if (!sts || !t) return null;
  const now = Math.floor(Date.now() / 1000), times = await liveTimes(), live = times.get(tripId), r = routes[t.route_id] || {};
  return {
    trip: tripId, route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign, live: !!live, cancelled: times.get(tripId) === null,
    stops: sts.map((st, i) => ({ id: st.stop, name: nameOf(st.stop), time: realTime(live ? live[i] : st.t, now) })),
  };
}

// ---------- trip planner / geocoding ----------
const nameOf = (id) => (stops.find((s) => s.stop_id === id) || {}).stop_name || id;
// tripId -> adjusted stop times (seconds since service-day midnight) from the realtime feed; null = cancelled
async function liveTimes() {
  const out = new Map();
  for (const e of (await feed('TripUpdate/TripUpdates.pb')).entity) {
    const tu = e.tripUpdate; const sts = tu && tripStops[tu.trip.tripId];
    if (!sts) continue;
    if (tu.trip.scheduleRelationship === 3) { out.set(tu.trip.tripId, null); continue; } // CANCELED
    const byStop = new Map((tu.stopTimeUpdate || []).map((u) => [u.stopId, u]));
    if (!byStop.size) continue;
    let delay = 0, seen = false;
    out.set(tu.trip.tripId, sts.map((st) => {
      const u = byStop.get(st.stop), ev = u && (u.arrival || u.departure);
      const abs = ev && Number(ev.time);
      if (abs) { delay = abs - realTime(st.t, abs); seen = true; } // absolute prediction beats the delay field
      else if (ev && ev.delay) { delay = Number(ev.delay); seen = true; }
      return st.t + delay;
    }));
    if (!seen) out.delete(tu.trip.tripId);
  }
  return out;
}
// scheduled time-of-day -> absolute epoch on the same service day as `near`
const realTime = (t, near) => {
  const mid = Math.floor((near + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC;
  return [mid + t, mid + t - 86400, mid + t + 86400].sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0];
};

async function planTrip(from, to, departAt) {
  const now = Math.floor(Date.now() / 1000);
  const when = departAt && departAt > now ? departAt : now;
  const localMidnight = Math.floor((when + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC;
  const services = activeServices(new Date((when + TZ_OFFSET_SEC) * 1000));
  const live = when - now < 2 * 3600 ? await liveTimes() : new Map(); // delays only matter for near-term trips
  const r = plan(from, to, when - localMidnight, services, live);
  if (!r) return null;
  const abs = (t) => localMidnight + t;
  return {
    arrive: abs(r.arrive),
    legs: r.legs.map((l) => {
      if (l.type === 'walk') return { type: 'walk', mins: Math.max(1, Math.round(l.secs / 60)), to: l.to ? nameOf(l.to) : null };
      const t = trips[l.trip], rt = routes[t.route_id] || {};
      return { type: 'ride', live: l.live, route: rt.route_short_name, color: rt.route_color, headsign: t.trip_headsign, from: nameOf(l.stops[l.from]), to: nameOf(l.stops[l.to]), dep: abs(l.times[l.from]), arr: abs(l.times[l.to]), stops: l.to - l.from };
    }),
    finalWalkMins: Math.round(r.finalWalk / 60),
  };
}

// ---------- http ----------
const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const search = require('./search')(() => ({ stops, routes, trips, tripStops }));
const push = require('./push')({ arrivals: (id) => arrivals(id) });
const body = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/api/stops') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon');
      let list = stops;
      if (q) list = stops.filter((s) => s.stop_name.toLowerCase().includes(q) || s.stop_id === q || s.stop_code === q);
      else if (lat && lon) list = [...stops].sort((a, b) => (a.stop_lat - lat) ** 2 + (a.stop_lon - lon) ** 2 - ((b.stop_lat - lat) ** 2 + (b.stop_lon - lon) ** 2));
      return json(res, list.slice(0, 25).map((s) => ({ id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon })));
    }
    let m;
    if ((m = p.match(/^\/api\/arrivals\/(.+)$/))) return json(res, await arrivals(decodeURIComponent(m[1])));
    if (p === '/api/nearby') return json(res, await nearby(+u.searchParams.get('lat'), +u.searchParams.get('lon')));
    if ((m = p.match(/^\/api\/trip\/(.+)$/))) { const t = await tripTimeline(decodeURIComponent(m[1])); return t ? json(res, t) : json(res, { error: 'not found' }, 404); }
    if (p === '/api/vehicles') return json(res, await vehicles((u.searchParams.get('routes') || '').split(',').filter(Boolean)));
    if (p === '/api/push/key') return json(res, { key: push.publicKey });
    if (p === '/api/push/watch' && req.method === 'POST') { push.watch(await body(req)); return json(res, { ok: true }); }
    if (p === '/api/push/unwatch' && req.method === 'POST') { push.unwatch(await body(req)); return json(res, { ok: true }); }
    if (p === '/api/suggest') return json(res, await search.suggest(u.searchParams.get('q') || '', (u.searchParams.get('kinds') || 'route,stop').split(','), u.searchParams.get('session')));
    if (p === '/api/place') return json(res, await search.placeLatLon(u.searchParams.get('id'), u.searchParams.get('session')));
    if ((m = p.match(/^\/api\/route\/(.+)\/stops$/))) return json(res, search.routeStops(decodeURIComponent(m[1])));
    if (p === '/api/plan') {
      const ll = (k) => { const [lat, lon] = (u.searchParams.get(k) || '').split(',').map(Number); return { lat, lon }; };
      return json(res, await planTrip(ll('from'), ll('to'), +u.searchParams.get('depart') || 0));
    }
    if (p === '/api/alerts') return json(res, await alerts());
    if (p === '/api/routes') return json(res, search.routeList());
    const file = path.join(__dirname, 'public', p === '/' ? 'index.html' : p);
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, { error: 'server error' }, 500);
  }
});

refreshStatic().then(() => {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`BetterTransit on http://${process.env.HOST || 'localhost'}:${PORT}`));
  setInterval(refreshStatic, 3600 * 1000); // hourly check; only downloads when >24h old
});
