// Earliest-arrival trip planner (RAPTOR-style) over the static GTFS schedule.
const WALK_MPS = 1.2;
const MAX_ROUNDS = 4; // up to 3 transfers
const TRANSFER_M = 250;
const ACCESS_M = 800; // how far to walk to/from the first/last stop

const metres = (a, b) => {
  const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320;
  const dy = (a.lat - b.lat) * 111320;
  return Math.hypot(dx, dy);
};

module.exports = function createPlanner({ stops, tripStops, trips }) {
  const pts = stops.filter((s) => s.location_type !== '1').map((s) => ({ id: s.stop_id, lat: +s.stop_lat, lon: +s.stop_lon }));
  const byId = Object.fromEntries(pts.map((p) => [p.id, p]));

  // patterns: trips that share an identical stop sequence
  const patterns = new Map();
  for (const [tid, sts] of Object.entries(tripStops)) {
    const key = sts.map((s) => s.stop).join('>');
    if (!patterns.has(key)) patterns.set(key, { stops: sts.map((s) => s.stop), trips: [] });
    patterns.get(key).trips.push({ id: tid, service: trips[tid].service_id, times: sts.map((s) => s.t) });
  }
  const stopPatterns = {};
  for (const pat of patterns.values()) {
    pat.trips.sort((a, b) => a.times[0] - b.times[0]);
    pat.stops.forEach((s, i) => (stopPatterns[s] ||= []).push([pat, i]));
  }

  const near = (p, maxM) => pts.map((s) => ({ stop: s.id, m: metres(p, s) })).filter((x) => x.m <= maxM);
  const footCache = {};
  const footpaths = (id) => (footCache[id] ||= near(byId[id], TRANSFER_M).filter((x) => x.stop !== id).map((x) => ({ stop: x.stop, w: x.m / WALK_MPS })));

  // from/to are {lat, lon}; dep is seconds since local midnight; services is the active service-id Set
  const plan = function (from, to, dep, services, live = new Map()) {
    // effective trip: live-adjusted times when the realtime feed has predictions; null if cancelled
    const effCache = new Map();
    const eff = (tr) => {
      if (!live.has(tr.id)) return tr;
      if (!effCache.has(tr.id)) effCache.set(tr.id, live.get(tr.id) && { ...tr, times: live.get(tr.id), live: true });
      return effCache.get(tr.id);
    };
    const origins = near(from, ACCESS_M).map((x) => ({ stop: x.stop, w: x.m / WALK_MPS }));
    const dests = near(to, ACCESS_M).map((x) => ({ stop: x.stop, w: x.m / WALK_MPS }));
    if (!origins.length || !dests.length) return null;

    const best = {}, bestLabel = {};
    let marked = new Set();
    let prevRound = {};
    for (const o of origins) {
      const t = dep + o.w;
      if (t < (best[o.stop] ?? Infinity)) { best[o.stop] = t; prevRound[o.stop] = bestLabel[o.stop] = { t, via: { type: 'access', stop: o.stop, w: o.w } }; marked.add(o.stop); }
    }

    for (let k = 1; k <= MAX_ROUNDS; k++) {
      const queue = new Map();
      for (const s of marked) for (const [pat, i] of stopPatterns[s] || []) queue.set(pat, Math.min(queue.get(pat) ?? Infinity, i));
      const round = {};
      const improved = new Set();
      for (const [pat, start] of queue) {
        let trip = null, boardIdx = 0, boardLabel = null;
        for (let j = start; j < pat.stops.length; j++) {
          const s = pat.stops[j];
          if (trip && trip.times[j] < (best[s] ?? Infinity)) {
            const label = { t: trip.times[j], via: { type: 'ride', trip, pat, from: boardIdx, to: j, prev: boardLabel } };
            best[s] = label.t; bestLabel[s] = round[s] = label; improved.add(s);
          }
          const prev = prevRound[s];
          if (prev && (!trip || prev.t <= trip.times[j])) {
            let cand = null;
            for (const tr of pat.trips) {
              if (cand && tr.times[j] > cand.times[j] + 3600) break; // trips are sorted; delays rarely exceed an hour
              const e = services.has(tr.service) && eff(tr);
              if (e && e.times[j] >= prev.t && (!cand || e.times[j] < cand.times[j])) cand = e;
            }
            if (cand && (!trip || cand.times[j] < trip.times[j])) { trip = cand; boardIdx = j; boardLabel = prev; }
          }
        }
      }
      for (const s of [...improved]) {
        for (const f of footpaths(s)) {
          const t = round[s].t + f.w;
          if (t < (best[f.stop] ?? Infinity)) {
            best[f.stop] = t; bestLabel[f.stop] = round[f.stop] = { t, via: { type: 'walk', from: s, to: f.stop, w: f.w, prev: round[s] } }; improved.add(f.stop);
          }
        }
      }
      if (!improved.size) break;
      marked = improved;
      prevRound = { ...prevRound, ...round };
    }

    let end = null;
    for (const d of dests) {
      if (best[d.stop] == null) continue;
      const t = best[d.stop] + d.w;
      if (!end || t < end.t) end = { t, stop: d.stop, w: d.w };
    }
    if (!end) return null;

    const legs = [];
    for (let l = bestLabel[end.stop]; l; l = l.via.prev) {
      const v = l.via;
      if (v.type === 'access') legs.push({ type: 'walk', secs: v.w, to: v.stop });
      else if (v.type === 'walk') legs.push({ type: 'walk', secs: v.w, from: v.from, to: v.to });
      else legs.push({ type: 'ride', live: !!v.trip.live, trip: v.trip.id, stops: v.pat.stops, from: v.from, to: v.to, times: v.trip.times });
    }
    legs.reverse();
    return { arrive: end.t, finalWalk: end.w, legs };
  };

  // The next few itineraries: after each one, plan again from just after its first boarding so the following bus/connection is found.
  // An option that arrives no later than the previous one but leaves later replaces it. Each has `leave` (seconds, when to set out).
  plan.options = (from, to, dep, services, live, n = 4) => {
    const out = [];
    for (let t = dep; out.length < n && t < dep + 3 * 3600;) {
      const r = plan(from, to, t, services, live);
      if (!r) break;
      const ride = r.legs.find((l) => l.type === 'ride');
      if (!ride) { if (!out.length) out.push({ ...r, leave: t }); break; }
      const leave = ride.times[ride.from] - (r.legs[0].type === 'walk' ? r.legs[0].secs : 0);
      if (out.length && r.arrive <= out[out.length - 1].arrive) out.pop();
      out.push({ ...r, leave });
      t = leave + 60;
    }
    return out;
  };
  return plan;
};
