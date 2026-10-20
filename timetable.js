// A stop's full timetable for one service day: every departure grouped by route + headsign.
const parseDate = (s) => {
  if (!/^\d{4}-\d\d-\d\d$/.test(s || '')) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : d; // rejects 2026-02-30
};

module.exports = ({ routes, trips, tripStops, stopTimesByStop, childrenOf }) => ({
  parseDate,
  // services: active service ids that day; midnight: epoch of that service day's local midnight (GTFS 24:xx+ times land after it)
  build(stopId, services, midnight) {
    const groups = new Map();
    for (const id of childrenOf[stopId] || [stopId]) {
      for (const st of stopTimesByStop[id] || []) {
        const t = trips[st.trip], sts = tripStops[st.trip], end = sts[sts.length - 1];
        if (!t || !services.has(t.service_id) || (end.stop === id && end.t === st.t)) continue; // a trip ending here only drops off
        const r = routes[t.route_id] || {}, k = `${r.route_short_name}|${t.trip_headsign}`;
        (groups.get(k) || groups.set(k, { route: r.route_short_name, color: r.route_color, headsign: t.trip_headsign, times: [] }).get(k)).times.push(midnight + st.t);
      }
    }
    for (const g of groups.values()) g.times.sort((a, b) => a - b);
    return [...groups.values()].sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }) || a.times[0] - b.times[0]);
  },
});
