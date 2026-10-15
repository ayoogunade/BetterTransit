// Search-as-you-type over the schedule (routes, stops, destinations) plus Photon (OSM) for addresses/places.
const TTL = 10 * 60 * 1000;

module.exports = function createSearch(data) {
  const placeCache = new Map();
  let built = null, routeList, headsigns;

  const num = (s) => (/^\d+/.test(s) ? parseInt(s, 10) : Infinity);
  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const hasAll = (text, ws) => ws.every((w) => text.toLowerCase().includes(w));

  function index() {
    const d = data();
    if (built === d.trips) return d;
    routeList = Object.values(d.routes)
      .map((r) => ({ id: r.route_id, short: r.route_short_name, long: r.route_long_name, color: r.route_color }))
      .sort((a, b) => num(a.short) - num(b.short) || a.short.localeCompare(b.short));
    headsigns = [...new Set(Object.values(d.trips).map((t) => t.trip_headsign).filter(Boolean))];
    built = d.trips;
    return d;
  }

  const routes = (q) => {
    index();
    const ws = words(q), n = /^\d+$/.test(q.trim()) ? parseInt(q, 10) : null;
    const hit = routeList.filter((r) => (n != null ? num(r.short) === n || r.short.startsWith(q.trim()) : hasAll(`${r.short} ${r.long}`, ws)));
    return hit.slice(0, 6).map((r) => ({ kind: 'route', ...r }));
  };

  const stopItem = (s) => ({ kind: 'stop', id: s.stop_id, name: s.stop_name, sub: s.location_type === '1' ? 'Hub' : `Stop #${s.stop_id}`, lat: +s.stop_lat, lon: +s.stop_lon });

  const stops = (q, limit = 6) => {
    const { stops: all } = index();
    const ws = words(q);
    const exact = all.filter((s) => s.stop_id === q.trim() || s.stop_code === q.trim());
    if (/^\d+$/.test(q.trim())) return exact.map(stopItem); // a bare number is a route or stop number, not a street name
    const rank = (s) => (s.location_type === '1' ? 0 : 1) + (s.stop_name.toLowerCase().startsWith(ws[0]) ? 0 : 2);
    const hit = all.filter((s) => hasAll(s.stop_name, ws)).sort((a, b) => rank(a) - rank(b));
    return [...new Set([...exact, ...hit])].slice(0, limit).map(stopItem);
  };

  // a "destination" is a bus headsign (e.g. "Stonebridge"); resolve it to the best matching stop/hub
  const dests = (q) => {
    const { stops: all } = index();
    const ws = words(q);
    return headsigns.filter((h) => hasAll(h, ws)).slice(0, 4).flatMap((h) => {
      const hw = words(h.replace(/[^\w\s]/g, ' '));
      const match = all.filter((s) => hasAll(s.stop_name, hw)).sort((a, b) => (b.location_type === '1') - (a.location_type === '1'))[0];
      return match ? [{ kind: 'dest', name: h, sub: `Bus destination · ${match.stop_name}`, id: match.stop_id, lat: +match.stop_lat, lon: +match.stop_lon }] : [];
    });
  };

  // Google Places (New) autocomplete when GOOGLE_PLACES_KEY is set. A session token groups the keystrokes and the final
  // details lookup into one billing session, so autocomplete itself is free.
  const BOX = { rectangle: { low: { latitude: 52.0, longitude: -106.9 }, high: { latitude: 52.3, longitude: -106.4 } } };
  async function googlePlaces(q, session) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_PLACES_KEY },
        body: JSON.stringify({ input: q, sessionToken: session || undefined, locationRestriction: BOX, includedRegionCodes: ['ca'] }),
      });
      if (!res.ok) return null;
      return ((await res.json()).suggestions || []).filter((x) => x.placePrediction).slice(0, 6).map(({ placePrediction: p }) => ({
        kind: 'place', placeId: p.placeId,
        name: p.structuredFormat.mainText.text,
        sub: (p.structuredFormat.secondaryText || {}).text?.replace(/, (SK|Saskatchewan)(, Canada)?$/, '') || '',
      }));
    } catch (e) { return null; }
  }
  const latLonCache = new Map();
  async function placeLatLon(id, session) {
    if (latLonCache.has(id)) return latLonCache.get(id);
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(session || '')}`, {
      signal: AbortSignal.timeout(5000), headers: { 'x-goog-api-key': process.env.GOOGLE_PLACES_KEY, 'x-goog-fieldmask': 'location' },
    });
    if (!res.ok) throw new Error('place lookup failed');
    const { location } = await res.json();
    const out = { lat: location.latitude, lon: location.longitude };
    latLonCache.set(id, out);
    return out;
  }

  async function places(q, session) {
    if (process.env.GOOGLE_PLACES_KEY) { const g = await googlePlaces(q, session); if (g) return g; } // else fall through to Photon
    const hit = placeCache.get(q);
    if (hit && Date.now() - hit.at < TTL) return hit.items;
    const url = 'https://photon.komoot.io/api/?limit=6&lang=en&lat=52.13&lon=-106.66&bbox=-106.9,52.0,-106.4,52.3&q=' + encodeURIComponent(q);
    try {
      let res;
      for (let attempt = 0; attempt < 2 && !(res && res.ok); attempt++) { // the public Photon server occasionally drops a request
        res = await fetch(url, { headers: { 'user-agent': 'BetterTransit-personal/1.0' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      }
      const items = (await res.json()).features.map((f) => {
        const p = f.properties;
        const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
        const name = p.name || street;
        const sub = [name !== street ? street : null, p.district || p.locality, p.city].filter(Boolean).join(', ');
        return { kind: 'place', name, sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      }).filter((x) => x.name);
      placeCache.set(q, { at: Date.now(), items });
      return items;
    } catch (e) { return []; }
  }

  async function suggest(q, kinds, session) {
    q = q.trim();
    if (!q) return [];
    const want = new Set(kinds);
    const placeP = want.has('place') && q.length >= 3 ? places(q, session) : Promise.resolve([]);
    const local = [
      ...(want.has('route') ? routes(q) : []),
      ...(want.has('stop') ? stops(q) : []),
      ...(want.has('dest') ? dests(q) : []),
    ];
    return [...local, ...(await placeP)];
  }

  // ordered stops per direction (headsign) for a route, using the longest trip of each direction
  function routeStops(short) {
    const d = index();
    const ids = new Set(Object.values(d.routes).filter((r) => r.route_short_name === short || num(r.route_short_name) === num(short)).map((r) => r.route_id));
    const best = new Map();
    for (const [tid, t] of Object.entries(d.trips)) {
      if (!ids.has(t.route_id)) continue;
      const n = (d.tripStops[tid] || []).length;
      if (n > (best.get(t.trip_headsign)?.n || 0)) best.set(t.trip_headsign, { n, tid });
    }
    const byId = Object.fromEntries(d.stops.map((s) => [s.stop_id, s]));
    return [...best].map(([headsign, { tid }]) => ({ headsign, stops: d.tripStops[tid].map((s) => stopItem(byId[s.stop])) }));
  }

  return { suggest, placeLatLon, routeStops, routeList: () => (index(), routeList) };
};
