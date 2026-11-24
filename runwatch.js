// Follows each of the service day's scheduled runs and, once a run is over, adds what happened to the history (history.tally):
//   ghost: it was due but no bus ever showed up · bus: it got an articulated bus · crowd: it was standing room or fuller at some point
// A no-show is only counted while we were watching with a working vehicle feed from before the run was due, so a restart or a
// city outage never reads as a day of ghost buses. Announced cancellations aren't no-shows (the app already says Cancelled).
const { isArtic } = require('./fleet');

const SHOW_BY = 25 * 60; // no bus 25 min after the start time: it never came (a late bus is still on its previous trip until then)
const END_GRACE = 15 * 60; // a run is over this long after its last stop's time
const LEAD = 5 * 60; // the feed must have been watched (and up) from this long before a run was due

module.exports = function createRunWatch(history) {
  let day = null, byStart = [], byEnd = [], i = 0, j = 0, from = 0, downAt = -Infinity;
  const seen = new Map(); // trip -> {label, occ: the fullest it was seen}
  const cancelled = new Set();
  return {
    day: () => day,
    // runs: [{trip, key, start, end}] (epoch seconds) for service day d. Starting mid-day only judges no-shows for runs due from now on.
    startDay(d, runs, now) {
      day = d; byStart = [...runs].sort((a, b) => a.start - b.start); byEnd = [...runs].sort((a, b) => a.end - b.end);
      i = j = 0; from = now; seen.clear(); cancelled.clear();
    },
    // a bus is on this trip (label: fleet number, occ: GTFS-rt occupancy or null)
    saw(trip, label, occ) {
      const s = seen.get(trip) || {};
      if (label) s.label = label;
      if (occ != null) s.occ = Math.max(s.occ ?? -1, occ);
      seen.set(trip, s);
    },
    cancel(trip) { cancelled.add(trip); },
    // Judge every run whose time has come. feedUp: the vehicle feed downloaded recently; coming(trip): a bus is out on an earlier
    // run of its block (late, but on its way), so it isn't a no-show yet.
    tick(now, feedUp, coming = () => false) {
      if (!feedUp) downAt = now;
      for (; i < byStart.length && byStart[i].start + SHOW_BY <= now; i++) {
        const r = byStart[i];
        if (r.start - LEAD < from || r.start - LEAD <= downAt || cancelled.has(r.trip)) continue;
        history.tally('ghost', r.key, !seen.has(r.trip) && !coming(r.trip));
      }
      for (; j < byEnd.length && byEnd[j].end + END_GRACE <= now; j++) {
        const r = byEnd[j], s = seen.get(r.trip);
        if (!s) continue;
        if (s.label) history.tally('bus', r.key, isArtic(s.label));
        if (s.occ != null) history.tally('crowd', r.key, s.occ >= 3);
      }
    },
  };
};
