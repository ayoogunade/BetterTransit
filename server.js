const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const zlib = require('zlib');
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

const lastCache = new Map(); // service day|stop -> Map(route|headsign -> its last trip), see lastTrips
let stops, childrenOf, routes, trips, calendar, calDates, stopTimesByStop, tripStops, plan, shapes, routeMapCache;
function loadStatic() {
  stops = read('stops.txt'); // includes hubs (location_type 1); arrivals() merges a hub's child stops
  childrenOf = {};
  for (const s of stops) if (s.parent_station) (childrenOf[s.parent_station] ||= []).push(s.stop_id);
  routes = Object.fromEntries(read('routes.txt').map((r) => [r.route_id, r]));
  trips = Object.fromEntries(read('trips.txt').map((t) => [t.trip_id, t]));
  calendar = read('calendar.txt');
  calDates = read('calendar_dates.txt');
  lastCache.clear();
  stopTimesByStop = {};
  tripStops = {}; // trip -> ordered [{stop, t, seq}] for the planner
  for (const st of read('stop_times.txt')) {
    const t = toSecs(st.arrival_time);
    (stopTimesByStop[st.stop_id] ||= []).push({ trip: st.trip_id, t });
    (tripStops[st.trip_id] ||= []).push({ stop: st.stop_id, t, seq: +st.stop_sequence });
  }
  for (const sts of Object.values(tripStops)) sts.sort((a, b) => a.seq - b.seq);
  plan = require('./planner')({ stops, tripStops, trips });
  timetable = require('./timetable')({ routes, trips, tripStops, stopTimesByStop, childrenOf });
  shapes = {}; routeMapCache = new Map(); // shape_id -> [[lat, lon], ...] (rounded to ~1 m)
  const pts = {};
  for (const r of read('shapes.txt')) (pts[r.shape_id] ||= []).push([+r.shape_pt_sequence, +r.shape_pt_lat, +r.shape_pt_lon]);
  for (const [id, list] of Object.entries(pts)) shapes[id] = list.sort((a, b) => a[0] - b[0]).map(([, la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]);
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

// The last scheduled trip of each route+headsign that leaves this stop on a service day (a trip ending here doesn't count: nobody boards it).
// Cached per stop and day, so one pass over the stop's times serves every request that day.
const tripKey = (t) => `${t.route_id}|${t.trip_headsign}`;
const dayOf = (t) => new Date((t + TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
function lastTrips(stopId, services, day) {
  const k = `${day}|${stopId}`;
  if (lastCache.has(k)) return lastCache.get(k);
  if (lastCache.size > 2000) lastCache.clear();
  const out = new Map(), at = new Map();
  for (const st of stopTimesByStop[stopId] || []) {
    const t = trips[st.trip], sts = tripStops[st.trip], end = sts[sts.length - 1];
    if (!t || !services.has(t.service_id) || (end.stop === stopId && end.t === st.t)) continue;
    const key = tripKey(t);
    if (!(at.get(key) >= st.t)) { at.set(key, st.t); out.set(key, st.trip); }
  }
  lastCache.set(k, out);
  return out;
}

// ---------- realtime feeds (cached) ----------
const cache = {};
const STALE_MS = 60000; // while the last copy is this fresh a request never waits on the city (the warm loop keeps it well under)
async function feed(name) {
  const c = (cache[name] ||= { at: 0, msg: null, pending: null });
  const age = Date.now() - c.at;
  if (age < TTL_MS && c.msg) return c.msg;
  // one download at a time per feed (a page load asks for several stops at once), and never hang on a slow city server
  c.pending ||= (async () => {
    try {
      const res = await fetch(`${RT}/${name}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(res.status);
      c.msg = GtfsRt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
      c.at = Date.now();
    } catch (e) {
      console.error('feed error', name, e.message); // keep serving last good data
    } finally { c.pending = null; }
    return c.msg || { entity: [] };
  })();
  return age < STALE_MS && c.msg ? c.msg : c.pending;
}

// Seconds since each feed last downloaded (null: never). Logs once when one goes stale and once when it recovers.
const FEEDS = { tripUpdates: 'TripUpdate/TripUpdates.pb', vehicles: 'Vehicle/VehiclePositions.pb', alerts: 'Alert/Alerts.pb' };
const feedStale = {};
function status() {
  const out = {};
  for (const [k, f] of Object.entries(FEEDS)) {
    const at = cache[f] && cache[f].at, age = at ? Math.round((Date.now() - at) / 1000) : null, stale = age === null || age > 120;
    if (stale !== !!feedStale[k]) { console.log(`feed ${k} ${stale ? 'stale' : 'recovered'}${age === null ? '' : ` (${age}s old)`}`); feedStale[k] = stale; }
    out[k] = age;
  }
  return out;
}

// ---------- arrivals ----------
const lastGood = new Map(); // trip|stop -> {time, seen, tracked} so predictions don't flicker away
const recorded = new Set(); // trip|stop pairs whose delay has gone into the reliability history (once per bus)
// A bus that has left stays on the board as Gone for a minute from when we first saw it leave, not from its predicted
// time (a bus can sit at the stop as Due for a while). at: its time at the stop, which must be recent to start the minute.
const leftAt = new Map(); // trip|stop -> ms we first saw it gone
const justLeft = (key, at, now) => {
  if (!leftAt.has(key)) { if (at <= now - 180) return false; leftAt.set(key, Date.now()); }
  return Date.now() - leftAt.get(key) < 60000;
};
// A tracked bus has passed this stop (or arrived): its last prediction is how late it really was. Counted once per bus.
const noteDelay = (key, base, stopId, st, last, weekend) => {
  if (!last || !last.tracked || recorded.has(key)) return;
  recorded.add(key);
  history.record(base.route, stopId, weekend, Math.floor(st.t / 3600) % 24, last.time - base.sched);
};
// "This bus continues as the 14 to X": the next trip on the same bus (block), shown where a trip ends
const continuesAs = (tripId) => {
  const n = trips[plan.successor[tripId]], r = n && routes[n.route_id];
  return n && { route: r && r.route_short_name, headsign: n.trip_headsign };
};
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

// What the realtime feeds say about every trip, rebuilt once per feed message:
// tripId -> { cancelled, at: Map(stop index -> {time, skipped}), next: index of the first stop still ahead (null: trip finished), bus: a vehicle is on it,
//   label: that vehicle's fleet number, occ: how full it is (see occOf) }
// plus the blocks that have a bus out right now (blockId -> start time of the trip that bus is running).
const stateCache = new WeakMap();
// GTFS-rt occupancy: 0 empty ... 6 not accepting passengers. 7 (no data) and 8 (not boardable) say nothing about room, so they're dropped.
const occOf = (v) => (Object.hasOwn(v, 'occupancyStatus') && v.occupancyStatus <= 6 ? v.occupancyStatus : null);
async function realtimeState() {
  const msg = await feed('TripUpdate/TripUpdates.pb'), vmsg = await feed('Vehicle/VehiclePositions.pb');
  const hit = stateCache.get(msg);
  if (hit && hit.vmsg === vmsg) return hit;
  const now = Date.now() / 1000, byTrip = new Map(), blocks = new Map();
  for (const e of msg.entity) {
    const tu = e.tripUpdate, sts = tu && tripStops[tu.trip.tripId];
    if (!sts) continue; // ad-hoc trips with no route we can name
    const s = { cancelled: tu.trip.scheduleRelationship === 3, at: new Map(), next: null, bus: false };
    for (const u of tu.stopTimeUpdate || []) {
      // match by stop_sequence when given (a loop route visits a stop twice), else by stop id
      const i = u.stopSequence ? sts.findIndex((x) => x.seq === u.stopSequence) : sts.findIndex((x) => x.stop === u.stopId);
      if (i < 0) continue;
      const time = Number((u.arrival || u.departure || {}).time || 0);
      s.at.set(i, { time, skipped: u.scheduleRelationship === 1 });
    }
    for (const [i, x] of [...s.at].sort((a, b) => a[0] - b[0])) if (!x.skipped && x.time > now - 30) { s.next = i; break; }
    byTrip.set(tu.trip.tripId, s);
  }
  for (const e of vmsg.entity) {
    const id = e.vehicle && e.vehicle.trip && e.vehicle.trip.tripId, t = trips[id];
    if (!t) continue;
    if (byTrip.has(id)) Object.assign(byTrip.get(id), { bus: true, label: (e.vehicle.vehicle && e.vehicle.vehicle.label) || null, occ: occOf(e.vehicle) });
    const start = tripStops[id][0].t;
    if (t.block_id && !(blocks.get(t.block_id) <= start)) blocks.set(t.block_id, start);
  }
  const out = { vmsg, byTrip, blocks };
  stateCache.set(msg, out);
  return out;
}

// Where a trip is for a ride alert: next = index of the first stop still ahead (null: finished, undefined: no predictions), live = it is in the
// feed, time(i) = predicted epoch at stop i (the nearest earlier prediction carried forward, else the timetable)
async function rideProgress(tripId) {
  const sts = tripStops[tripId];
  if (!sts) return null;
  const s = (await realtimeState()).byTrip.get(tripId);
  const time = (i) => {
    for (let j = i; s && j >= 0; j--) { const p = s.at.get(j); if (p && p.time) return p.time + sts[i].t - sts[j].t; }
    return realTime(sts[i].t, Date.now() / 1000);
  };
  return { live: !!s, next: s && s.at.size ? s.next : undefined, cancelled: !!(s && s.cancelled), time };
}

// Arrivals at one stop, each with how much to trust it:
//   tracked: a bus is on this trip, or out on an earlier run of the same block (so it's coming); time is the prediction
//   sched: timetable time, so delay = time - sched (positive = late, negative = early); stopsAway and label (fleet number) when the bus is on this trip
//   cancelled / skipped (detour) are listed so you know not to wait; gone: just passed this stop (shown briefly)
//   stale: the feed dropped the trip, this is its last prediction; neither tracked nor stale = timetable only
//   ends: this is the trip's last stop (drop-off only); continuesAs: {route, headsign} when the same bus carries on as another trip
//   last: the last scheduled trip of this route+headsign from here today
async function arrivalsAt(stopId) {
  const now = Math.floor(Date.now() / 1000);
  const { byTrip, blocks } = await realtimeState();
  const localMidnight = Math.floor((now + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC;
  const local = new Date((now + TZ_OFFSET_SEC) * 1000), services = activeServices(local), weekend = [0, 6].includes(local.getUTCDay());
  const lastOf = lastTrips(stopId, services, dayOf(now)), out = [];
  for (const st of stopTimesByStop[stopId] || []) {
    const t = trips[st.trip];
    const sched = localMidnight + st.t;
    if (!t || !services.has(t.service_id) || sched < now - 3600 || sched > now + 3 * 3600) continue; // an hour back: late buses still count
    const sts = tripStops[st.trip], idx = sts.findIndex((x) => x.stop === stopId && x.t === st.t), s = byTrip.get(st.trip);
    const base = { ...shape(st.trip, sched, false), sched, ...(idx === sts.length - 1 && { ends: true, ...(continuesAs(st.trip) && { continuesAs: continuesAs(st.trip) }) }), ...(lastOf.get(tripKey(t)) === st.trip && { last: true }) }; // ends: last stop, you can't board it
    const usual = history.usual(base.route, stopId, weekend, Math.floor(st.t / 3600) % 24); // how this bus tends to run at this hour
    if (usual) base.usual = usual;
    if (s && s.cancelled) { if (sched > now - 60) out.push({ ...base, cancelled: true }); continue; }
    const p = s && s.at.get(idx);
    if (p && p.skipped) { if (sched > now - 60) out.push({ ...base, skipped: true }); continue; }
    const key = `${st.trip}|${stopId}`, last = lastGood.get(key);
    // the bus is past this stop: the trip's next stop is further on, or it finished (the feed may also drop the passed stop)
    const passed = s && s.at.size > 0 && (s.next == null || s.next > idx);
    if (passed) { noteDelay(key, base, stopId, st, last, weekend); const at = (p && p.time) || (last && last.time); if (at && justLeft(key, at, now)) out.push({ ...base, time: at, gone: true }); continue; }
    if (p && p.time) {
      const tracked = s.bus || (!!t.block_id && blocks.get(t.block_id) <= sts[0].t);
      lastGood.set(key, { time: p.time, seen: Date.now(), tracked });
      // stops away only once the bus has actually started this trip (it may be waiting at the first stop)
      const started = s.bus && (s.next > 0 || (s.at.get(0) || {}).time <= now);
      out.push({ ...base, time: p.time, live: tracked, tracked, delay: p.time - sched, ...(started && { stopsAway: idx - s.next }), ...(s.label && { label: s.label }), ...(s.occ != null && { occ: s.occ }) });
      continue;
    }
    // the feed dropped the trip. Trips leave the feed when the bus reaches its last stop, so one that was due has arrived;
    // otherwise keep its last prediction for 90s in case that's a hiccup
    if (last && Date.now() - last.seen < 90000 && (base.ends || last.time <= now + 60)) { noteDelay(key, base, stopId, st, last, weekend); if (justLeft(key, last.time, now)) out.push({ ...base, time: last.time, gone: true }); continue; }
    if (last && Date.now() - last.seen < 90000) { if (last.time > now - 60) out.push({ ...base, time: last.time, live: true, stale: true, delay: last.time - sched }); continue; }
    if (sched > now - 60) out.push(base); // timetable only
  }
  for (const [k, v] of lastGood) if (Date.now() - v.seen > 90000) { lastGood.delete(k); recorded.delete(k); }
  for (const [k, v] of leftAt) if (Date.now() - v > 600000) leftAt.delete(k);
  return out.sort((a, b) => a.time - b.time).slice(0, 12);
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
      route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign, occ: occOf(v),
      next: n && { stop: stopName(n.stop), time: n.time },
    });
  }
  return out;
}

async function alerts() {
  const text = (ts) => ts && ts.translation && ts.translation[0] && ts.translation[0].text;
  const now = Date.now() / 1000;
  const list = (await feed('Alert/Alerts.pb')).entity.filter((e) => e.alert).map((e) => ({
    id: e.id,
    stops: [...new Set((e.alert.informedEntity || []).map((i) => i.stopId).filter(Boolean))],
    start: Number(((e.alert.activePeriod || [])[0] || {}).start || 0),
    header: text(e.alert.headerText),
    description: text(e.alert.descriptionText),
    routes: (e.alert.informedEntity || []).map((i) => (routes[i.routeId] || {}).route_short_name).filter(Boolean),
  }));
  return list.filter((a) => a.start <= now).sort((a, b) => b.start - a.start); // newest first
}

// Stops within 800 m of a point (nearest first, max 5) that have buses coming. Hubs are skipped: their child stops are listed individually.
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111200, (a.lon - b.lon) * 111200 * Math.cos(a.lat * Math.PI / 180));
async function nearby(lat, lon, only = []) {
  const near = stops.filter((s) => s.location_type !== '1')
    .map((s) => ({ s, dist: Math.round(metres({ lat, lon }, { lat: +s.stop_lat, lon: +s.stop_lon })) }))
    .filter((x) => x.dist <= 800).sort((a, b) => a.dist - b.dist).slice(0, only.length ? 15 : 5); // with a route filter, look further down the list
  const out = await Promise.all(near.map(async ({ s, dist }) => {
    const arr = await arrivalsAt(s.stop_id);
    return { id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, dist, arrivals: only.length ? arr.filter((a) => only.includes(a.route)) : arr };
  }));
  return out.filter((p) => p.arrivals.length).slice(0, 5);
}

// Every stop of one trip with its (live-adjusted when available) time, so the app can show clock times and "+N min" offsets.
// next: index of the first stop the bus hasn't passed (null: finished; absent: no live data), for "3 stops to go" while riding.
async function tripTimeline(tripId) {
  const sts = tripStops[tripId], t = trips[tripId];
  if (!sts || !t) return null;
  const now = Math.floor(Date.now() / 1000), times = await liveTimes(), live = times.get(tripId), r = routes[t.route_id] || {};
  const rt = (await realtimeState()).byTrip.get(tripId);
  return {
    trip: tripId, label: (rt && rt.label) || null, occ: rt ? rt.occ ?? null : null, next: rt && rt.at.size ? rt.next : undefined, route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign, live: !!live, cancelled: times.get(tripId) === null, continuesAs: continuesAs(tripId) || null,
    stops: sts.map((st, i) => { const s = stopOf(st.stop); return { id: st.stop, name: s.stop_name, lat: +s.stop_lat || null, lon: +s.stop_lon || null, time: realTime(live ? live[i] : st.t, now) }; }), // lat/lon: "Show on map" draws the ride through them
  };
}

// A route's drawn path(s) and stops for the map. Each direction contributes its main shape, plus any variant that serves >= 25% as many trips.
function routeMap(short) {
  if (routeMapCache.has(short)) return routeMapCache.get(short);
  const ids = new Set(Object.values(routes).filter((r) => r.route_short_name === short).map((r) => r.route_id));
  const count = new Map();
  for (const t of Object.values(trips)) if (ids.has(t.route_id) && shapes[t.shape_id]) { const k = `${t.direction_id}|${t.shape_id}`; count.set(k, (count.get(k) || 0) + 1); }
  const byDir = {};
  for (const [k, n] of count) (byDir[k.split('|')[0]] ||= []).push([k.split('|')[1], n]);
  const lines = Object.values(byDir).flatMap((list) => { const top = Math.max(...list.map((x) => x[1])); return list.filter(([, n]) => n >= top * 0.25).map(([id]) => shapes[id]); });
  const seen = new Set(), stopList = [];
  for (const d of search.routeStops(short)) for (const st of d.stops) if (!seen.has(st.id)) { seen.add(st.id); stopList.push([st.id, st.name, st.lat, st.lon]); }
  const out = { color: (Object.values(routes).find((r) => r.route_short_name === short) || {}).route_color, lines, stops: stopList };
  routeMapCache.set(short, out);
  return out;
}

// ---------- trip planner / geocoding ----------
const stopOf = (id) => stops.find((s) => s.stop_id === id) || { stop_id: id, stop_name: id };
const nameOf = (id) => stopOf(id).stop_name;
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

async function planTrip(from, to, departAt, arriveBy = 0, accessible = false) {
  const now = Math.floor(Date.now() / 1000);
  const when = arriveBy ? Math.max(now, arriveBy - 2 * 3600) : departAt && departAt > now ? departAt : now;
  const localMidnight = Math.floor((when + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC;
  const services = activeServices(new Date((when + TZ_OFFSET_SEC) * 1000));
  const live = when - now < 2 * 3600 ? await liveTimes() : new Map(); // delays only matter for near-term trips
  const abs = (t) => localMidnight + t, day = dayOf(when);
  const opts = arriveBy ? plan.arriveBy(from, to, arriveBy - localMidnight, services, live, when - localMidnight, undefined, accessible) : plan.options(from, to, when - localMidnight, services, live, undefined, undefined, accessible);
  const weekend = [0, 6].includes(new Date((when + TZ_OFFSET_SEC) * 1000).getUTCDay());
  const routeOf = (tid) => (routes[trips[tid].route_id] || {}).route_short_name;
  const cold = ((await weather()) || {}).cold; // deep cold: among near-equal options, least time outside first, then the safe-transfer swap
  return plan.preferSafe(plan.preferWarm(opts.map((r) => {
    const x = plan.transfers(r.legs, { route: routeOf, usual: (rt, stop, hour) => history.usual(rt, stop, weekend, hour) }); // per leg: stayOn / risk
    return {
    leave: abs(r.leave),
    arrive: abs(r.arrive),
    legs: r.legs.map((l, i) => {
      if (l.type === 'walk') return { type: 'walk', mins: Math.max(1, Math.round(l.secs / 60)), to: l.to ? nameOf(l.to) : null };
      const t = trips[l.trip], rt = routes[t.route_id] || {};
      const b = stopOf(l.stops[l.from]), a = stopOf(l.stops[l.to]); // boarding stop, so the app can pin it or set an alert for this bus there; alighting stop for "get off" alerts
      return { type: 'ride', live: l.live, trip: l.trip, route: rt.route_short_name, color: rt.route_color, headsign: t.trip_headsign, from: nameOf(l.stops[l.from]), to: nameOf(l.stops[l.to]), dep: abs(l.times[l.from]), arr: abs(l.times[l.to]), stops: l.to - l.from,
        board: { id: b.stop_id, name: b.stop_name, lat: +b.stop_lat, lon: +b.stop_lon }, boardIdx: l.from,
        alight: { id: a.stop_id, name: a.stop_name, lat: +a.stop_lat, lon: +a.stop_lon, idx: l.to },
        ...(lastTrips(b.stop_id, services, day).get(tripKey(t)) === l.trip && { last: true }), ...x[i] };
    }),
    finalWalkMins: Math.round(r.finalWalk / 60),
  }; }), cold));
}

// What a shared-arrival page may see, and nothing more: the ride's route, where it ends up, when, and the bus's position.
// arrive/expiresAt are epoch seconds; left: stops from the next one through the destination (null: no predictions, 0: trip finished).
async function sharedArrival(link) {
  const t = await tripTimeline(link.tripId), st = t && t.stops[link.alightIdx];
  if (!st) return null;
  const [p, buses] = await Promise.all([rideProgress(link.tripId), vehicles([t.route])]), bus = buses.find((b) => b.trip === link.tripId);
  return { route: t.route, color: t.color, headsign: t.headsign, to: link.to || st.name, arrive: st.time, live: t.live, cancelled: t.cancelled,
    left: p && p.next === null ? 0 : p && p.next != null ? Math.max(1, link.alightIdx - p.next + 1) : null, bus: bus ? { lat: bus.lat, lon: bus.lon } : null, expiresAt: Math.floor(link.expiresAt / 1000) };
}

// One stop's departures on a local date (default today), grouped by route + headsign; hubs merge their children like arrivals()
function timetableFor(stopId, dateStr) {
  const day = dateStr ? timetable.parseDate(dateStr) : new Date(dayOf(Date.now() / 1000) + 'T00:00:00Z');
  if (!day) return { error: 'bad date' };
  if (!stops.some((s) => s.stop_id === stopId)) return { error: 'not found' };
  return { groups: timetable.build(stopId, activeServices(day), day.getTime() / 1000 - TZ_OFFSET_SEC) };
}

// ---------- chat tools ----------
// What the "Ask" chat (chat.js) may read and offer. Everything goes out in Saskatoon clock time so the model never does time zone math.
const clockAt = (t) => { const d = new Date((t + TZ_OFFSET_SEC) * 1000), h = d.getUTCHours(); return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const atLocal = (hhmm, date) => { // "17:30" (+ "2026-10-22", default today) -> epoch
  const m = /^(\d{1,2}):(\d\d)$/.exec(hhmm || ''); if (!m) throw new Error('times must be HH:MM');
  const day = date ? timetable.parseDate(date) : new Date(dayOf(Date.now() / 1000) + 'T00:00:00Z'); if (!day) throw new Error('dates must be YYYY-MM-DD');
  return day.getTime() / 1000 - TZ_OFFSET_SEC + +m[1] * 3600 + +m[2] * 60;
};
const ptOf = (p) => { if (!p || !Number.isFinite(+p.lat) || !Number.isFinite(+p.lon)) throw new Error('places need lat and lon (use find_place)'); return { lat: +p.lat, lon: +p.lon, name: String(p.name || 'Dropped pin') }; };
const optionText = (r) => {
  const rides = r.legs.filter((l) => l.type === 'ride');
  return {
    leave: clockAt(r.leave), arrive: clockAt(r.arrive), minutes: Math.round((r.arrive - r.leave) / 60), transfers: Math.max(0, rides.length - 1),
    walk_minutes: r.legs.filter((l) => l.type === 'walk').reduce((n, l) => n + l.mins, 0) + (r.finalWalkMins || 0),
    steps: r.legs.map((l) => (l.type === 'walk' ? `Walk ${l.mins} min${l.to ? ` to ${l.to}` : ''}` : {
      route: l.route, toward: l.headsign, board: l.from, board_stop_id: l.board.id, departs: clockAt(l.dep), get_off: l.to, arrives: clockAt(l.arr), stops: l.stops, trip_id: l.trip,
      live: !!l.live, ...(l.last && { last_bus: true }), ...(l.stayOn && { stay_on_same_bus: true }), ...(l.risk && { tight_transfer: `the ${l.risk.route} is 3+ min late ${l.risk.late}% of the time here` }) })),
  };
};
const planAction = (from, to, mode, time) => ({ type: 'plan', from, to, mode, time }); // "Show in Plan" button
const chatTools = {
  async find_place({ query }) {
    const q = String(query || '').trim(), saved = sync.get('saved') || {};
    const mine = Object.entries(saved).filter(([k, v]) => v && (q.toLowerCase().includes(k) || q.toLowerCase() === String(v.name).toLowerCase())).map(([k, v]) => ({ kind: `saved ${k}`, name: v.name, lat: v.lat, lon: v.lon }));
    if (mine.length) return mine;
    const hits = (await search.suggest(q, ['stop', 'dest', 'place'], null)).slice(0, 6);
    return Promise.all(hits.map(async (h) => {
      const ll = h.lat != null ? h : await search.placeLatLon(h.placeId).catch(() => null);
      return ll && { kind: h.kind, name: h.name, detail: h.sub, lat: ll.lat, lon: ll.lon, ...(h.kind === 'stop' && { stop_id: h.id }) };
    })).then((l) => (l.filter(Boolean).length ? l.filter(Boolean) : 'Nothing found'));
  },
  async plan_trip({ from, to, depart_time, arrive_by, date, accessible }) {
    const a = ptOf(from), b = ptOf(to), dep = depart_time ? atLocal(depart_time, date) : 0, arr = arrive_by ? atLocal(arrive_by, date) : 0;
    const opts = await planTrip(a, b, dep, arr, !!accessible);
    return { result: opts.length ? opts.slice(0, 3).map(optionText) : 'No trip found', action: planAction(a, b, arr ? 'arrive' : dep ? 'depart' : 'now', arr || dep) };
  },
  async compare_departures({ from, to, window_start, window_end, date }) {
    const a = ptOf(from), b = ptOf(to), start = Math.max(atLocal(window_start, date), Math.floor(Date.now() / 1000)), end = Math.min(atLocal(window_end, date), start + 3 * 3600);
    if (end <= start) throw new Error('that window is over or empty');
    const seen = new Map(), step = Math.max(600, Math.ceil((end - start) / 12 / 60) * 60);
    for (let t = start; t <= end; t += step) {
      for (const o of await planTrip(a, b, t)) {
        const k = o.legs.map((l) => l.trip || l.mins).join('>');
        if (o.leave >= start && o.leave <= end && !seen.has(k)) seen.set(k, o);
      }
    }
    const list = [...seen.values()].sort((x, y) => x.leave - y.leave).slice(0, 12).map(optionText);
    return { result: list.length ? list : 'No trips leave in that window', action: planAction(a, b, 'depart', start) };
  },
  async stop_arrivals({ stop_id }) {
    if (!stops.some((s) => s.stop_id === stop_id)) throw new Error('unknown stop');
    const now = Date.now() / 1000, u = (x) => x && (x.late >= 30 ? `late ${x.late}% of the time` : Math.abs(x.avg) < 1 ? 'usually on time' : x.avg > 0 ? `usually ${x.avg} min late` : `usually ${-x.avg} min early`);
    return { stop: nameOf(stop_id), arrivals: (await arrivals(stop_id)).map((a) => ({
      route: a.route, toward: a.headsign, time: clockAt(a.time), in_minutes: Math.round((a.time - now) / 60), trip_id: a.trip,
      status: a.cancelled ? 'cancelled' : a.skipped ? 'not stopping here (detour)' : a.gone ? 'just left' : a.stale ? 'signal lost' : a.tracked ? 'live' : 'scheduled only',
      ...(a.tracked && { delay_minutes: Math.round((a.delay || 0) / 60) }), ...(a.stopsAway != null && { stops_away: a.stopsAway }), ...(a.label && { bus: a.label }),
      ...(a.usual && { history: u(a.usual) }), ...(a.last && { last_bus: true }), ...(a.ends && { drop_off_only: true }) })) };
  },
  stop_timetable({ stop_id, date, route, after }) {
    const r = timetableFor(stop_id, date);
    if (r.error) throw new Error(r.error);
    const from = after ? atLocal(after, date) : 0;
    return r.groups.filter((g) => !route || g.route === String(route)).map((g) => ({ route: g.route, toward: g.headsign, times: g.times.filter((t) => t >= from).slice(0, 30).map(clockAt) })).filter((g) => g.times.length);
  },
  async route_buses({ route }) {
    const now = Date.now() / 1000, list = await vehicles([String(route)]);
    return list.length ? list.map((v) => ({ bus: v.label, toward: v.headsign, ...(v.next && { next_stop: v.next.stop, there_in_minutes: Math.max(0, Math.round((v.next.time - now) / 60)) }), position_age_seconds: v.age })) : 'No buses on that route right now';
  },
  async service_alerts({ route }) {
    const list = (await alerts()).filter((a) => !route || a.routes.includes(String(route)));
    return list.length ? list.slice(0, 8).map((a) => ({ header: a.header, details: (a.description || '').slice(0, 400), routes: [...new Set(a.routes)] })) : 'No current alerts';
  },
  weather: async () => (await weather()) || 'Weather unavailable',
  my_stuff: () => ({
    pinned_stops: (sync.get('pins') || []).map((p) => ({ stop_id: p.id, name: p.name })), pinned_routes: (sync.get('routePins') || []).map((r) => r.short),
    saved_places: sync.get('saved') || {}, commutes: (sync.get('commutes') || []).map((c) => ({ name: c.name, from: c.from.name, to: c.to.name, days: c.days, on: !c.off })),
  }),
  propose_pin_stop({ stop_id }) {
    const s = stops.find((x) => x.stop_id === stop_id); if (!s) throw new Error('unknown stop');
    return { result: 'Button shown; the user taps it to pin', action: { type: 'pin_stop', stop: { id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon } } };
  },
  propose_pin_route({ route }) {
    const r = search.routeList().find((x) => x.short === String(route)); if (!r) throw new Error('unknown route');
    return { result: 'Button shown; the user taps it to pin', action: { type: 'pin_route', route: { short: r.short, long: r.long, color: r.color } } };
  },
  propose_bus_alert({ stop_id, trip_id }) {
    const t = trips[trip_id], s = stops.find((x) => x.stop_id === stop_id); if (!t || !s) throw new Error('unknown stop or trip');
    const r = routes[t.route_id] || {};
    return { result: 'Button shown; the user taps it to turn the alert on', action: { type: 'bus_alert', watch: { stopId: s.stop_id, stopName: s.stop_name, tripId: trip_id, route: r.route_short_name, headsign: t.trip_headsign } } };
  },
  propose_commute({ from, to, name, days, start, end, minutes_before }) {
    const mins = (v) => { const m = /^(\d{1,2}):(\d\d)$/.exec(v || ''); if (!m) throw new Error('times must be HH:MM'); return +m[1] * 60 + +m[2]; };
    const c = { name: String(name || `To ${ptOf(to).name}`).slice(0, 40), from: ptOf(from), to: ptOf(to), days: [...new Set((days || []).map(Number).filter((d) => d >= 0 && d <= 6))],
      startMin: mins(start), endMin: mins(end), minutes: [3, 5, 10, 15].includes(+minutes_before) ? +minutes_before : 5 };
    if (!c.days.length || c.endMin <= c.startMin) throw new Error('need at least one day and an end after the start');
    return { result: 'Button shown; the user taps it to save', action: { type: 'commute', commute: c } };
  },
};
const chat = require('./chat')({ tools: chatTools });

// ---------- http ----------
const json =(res, data, code = 200, req) => {
  const body = Buffer.from(JSON.stringify(data));
  const gz = req && body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || ''); // the route map is ~700 KB raw
  res.writeHead(code, { 'content-type': 'application/json', ...(gz && { 'content-encoding': 'gzip' }) });
  res.end(gz ? zlib.gzipSync(body) : body);
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const search = require('./search')(() => ({ stops, routes, trips, tripStops }));
const sync = require('./sync')();
let timetable; // built after the schedule loads (see loadStatic)
const history = require('./history')();
const weather = require('./weather')();
const shares = require('./share')();
const push = require('./push')({ arrivals: (id) => arrivals(id), alerts, progress: rideProgress, weather, plan: (from, to, departAt) => planTrip(from, to, departAt || 0, 0), tzOffsetSec: TZ_OFFSET_SEC, quiet: () => sync.get('quietHours') });
const auth = require('./auth')();
const text = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => ok(b)); });
const body = async (req) => JSON.parse((await text(req)) || '{}');

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return json(res, { error: 'bad request' }, 400); } // e.g. a path of "//" must not crash the server
  const p = u.pathname;
  try {
    if (p === '/login' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress; // Caddy sets it
      const r = await auth.login(new URLSearchParams(await text(req)).get('password'), ip, req.headers['x-forwarded-proto'] === 'https', req.headers['user-agent']);
      res.writeHead(303, r && r !== 'locked' ? { location: '/', 'set-cookie': r } : { location: `/login?e=${r || 1}` });
      return res.end();
    }
    if (!auth.check(req, p)) {
      if (p.startsWith('/api/')) return json(res, { error: 'signed out' }, 401);
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    if (p === '/api/stops') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon');
      let list = stops;
      if (q) list = stops.filter((s) => s.stop_name.toLowerCase().includes(q) || s.stop_id === q || s.stop_code === q);
      else if (lat && lon) list = [...stops].sort((a, b) => (a.stop_lat - lat) ** 2 + (a.stop_lon - lon) ** 2 - ((b.stop_lat - lat) ** 2 + (b.stop_lon - lon) ** 2));
      return json(res, list.slice(0, 25).map((s) => ({ id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon })));
    }
    let m;
    if (p === '/api/weather') return json(res, (await weather()) || null);
    if (p === '/api/share' && req.method === 'POST') {
      const { tripId, alightIdx, toName } = await body(req).catch(() => ({})), sts = tripStops[tripId];
      if (!sts || !Number.isInteger(alightIdx) || alightIdx < 1 || alightIdx >= sts.length || (toName != null && typeof toName !== 'string')) return json(res, { error: 'bad share' }, 400);
      const token = shares.create({ tripId, alightIdx, to: (toName || '').trim().slice(0, 80) });
      return json(res, { url: `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}/s/${token}` });
    }
    // public, no login (auth.js): the share page and the only data it may read (sharedArrival)
    if ((m = p.match(/^\/(s|api\/shared)\/([^/]+)$/))) {
      const link = shares.get(m[2]);
      res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-robots-tag', 'noindex');
      if (m[1] !== 's') { const d = link && (await sharedArrival(link)); return d ? json(res, d) : json(res, { error: 'expired' }, 404); }
      res.writeHead(link ? 200 : 404, { 'content-type': 'text/html' });
      return fs.createReadStream(path.join(__dirname, 'public', 'share.html')).pipe(res);
    }
    if ((m = p.match(/^\/api\/arrivals\/(.+)$/))) return json(res, await arrivals(decodeURIComponent(m[1])));
    if ((m = p.match(/^\/api\/timetable\/(.+)$/))) { const r = timetableFor(decodeURIComponent(m[1]), u.searchParams.get('date')); return r.error ? json(res, r, r.error === 'bad date' ? 400 : 404) : json(res, r.groups, 200, req); }
    if (p === '/api/nearby') return json(res, await nearby(+u.searchParams.get('lat'), +u.searchParams.get('lon'), (u.searchParams.get('routes') || '').split(',').filter(Boolean)));
    if ((m = p.match(/^\/api\/trip\/(.+)$/))) { const t = await tripTimeline(decodeURIComponent(m[1])); return t ? json(res, t) : json(res, { error: 'not found' }, 404); }
    if (p === '/api/vehicles') return json(res, await vehicles((u.searchParams.get('routes') || '').split(',').filter(Boolean)));
    if (p === '/api/sync') return json(res, sync.merge(req.method === 'POST' ? await body(req) : {}));
    if (p === '/api/push/key') return json(res, { key: push.publicKey });
    if (p === '/api/push/watch' && req.method === 'POST') {
      const w = await body(req), bad = push.invalid(w);
      if (bad) return json(res, { error: bad }, 400);
      w.sid = auth.id(req); // ties the watch to this sign-in, so signing the device out also stops its notifications
      push.watch(w);
      return json(res, { ok: true });
    }
    if (p === '/api/push/unwatch' && req.method === 'POST') { push.unwatch(await body(req)); return json(res, { ok: true }); }
    if (p === '/api/sessions') return json(res, { enabled: auth.enabled, sessions: auth.list(req) });
    if (p === '/api/sessions/revoke' && req.method === 'POST') { const { id } = await body(req), ok = auth.revoke(id); if (ok) push.dropSession(id); return json(res, { ok }); }
    if (p === '/api/suggest') return json(res, await search.suggest(u.searchParams.get('q') || '', (u.searchParams.get('kinds') || 'route,stop').split(','), u.searchParams.get('session')));
    if (p === '/api/place') return json(res, await search.placeLatLon(u.searchParams.get('id'), u.searchParams.get('session')));
    if ((m = p.match(/^\/api\/route\/(.+)\/stops$/))) return json(res, search.routeStops(decodeURIComponent(m[1])));
    if (p === '/api/plan') {
      const ll = (k) => { const [lat, lon] = (u.searchParams.get(k) || '').split(',').map(Number); return { lat, lon }; };
      return json(res, await planTrip(ll('from'), ll('to'), +u.searchParams.get('depart') || 0, +u.searchParams.get('arrive') || 0, u.searchParams.get('accessible') === '1'));
    }
    if (p === '/api/chat' && req.method === 'POST') {
      if (!chat.enabled) return json(res, { error: 'Ask needs a GEMINI_API_KEY on the server' }, 503);
      const { history, message, here } = await body(req), now = Date.now() / 1000;
      if (typeof message !== 'string' || !message.trim()) return json(res, { error: 'empty question' }, 400);
      const today = new Date((now + TZ_OFFSET_SEC) * 1000).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const ctx = { now: clockAt(now), today: `${today}, ${dayOf(now)}`, here: here && Number.isFinite(+here.lat) && Number.isFinite(+here.lon) ? { lat: +here.lat, lon: +here.lon } : null };
      try { return json(res, await chat.ask(history, message, ctx)); }
      catch (e) { console.error('chat error', e.message); return json(res, { error: /^gemini (429|503)/.test(e.message) ? 'The assistant is busy right now. Try again in a minute.' : 'Could not reach the assistant' }, 502); }
    }
    if (p === '/api/status') return json(res, status());
    if (p === '/api/alerts') return json(res, await alerts());
    if (p === '/api/routemap') return json(res, Object.fromEntries((u.searchParams.get('routes') || '').split(',').filter(Boolean).slice(0, 80).map((r) => [r, routeMap(r)])), 200, req);
    if (p === '/api/routes') return json(res, search.routeList());
    const file = path.join(__dirname, 'public', p === '/' ? 'index.html' : p === '/login' ? 'login.html' : p);
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, { error: 'server error' }, 500);
  }
});

process.on('SIGTERM', () => { try { history.flush(); } finally { process.exit(0); } }); // systemd restarts on every deploy
refreshStatic().then(() => {
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`BetterTransit on http://${process.env.HOST || 'localhost'}:${PORT}`));
  setInterval(refreshStatic, 3600 * 1000); // hourly check; only downloads when >24h old
  // Keep the live feeds fresh even when nobody has the app open, so the first request after a quiet spell doesn't wait on the city
  const warm = () => ['TripUpdate/TripUpdates.pb', 'Vehicle/VehiclePositions.pb', 'Alert/Alerts.pb'].forEach((f) => feed(f));
  warm(); setInterval(() => { warm(); status(); }, 20000); // status() here so staleness is logged even if nobody asks
});
