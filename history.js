// Reliability history: how late a route usually runs at a stop at a given hour. Each bus that passes a stop while tracked adds its
// final delay to a running {n, sum, late} per route / stop / weekday-or-weekend / hour, kept in data/history.json. Old samples fade
// (the totals shrink once n reaches CAP) so the numbers follow recent service changes.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'history.json');
const CAP = 200; // samples per slot before older ones start to fade
const MIN = 5; // samples a slot needs before we show anything
const LATE_SECS = 180; // "late" means three minutes or more behind the timetable
const BUS_CAP = 20, BUS_MIN = 3; // which kind of bus runs a trip: recent days count most, and 3 days are needed before we guess

module.exports = function createHistory(file = FILE, { flushMs = 5 * 60e3 } = {}) {
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let dirty = false;
  const key = (route, stop, weekend, hour) => `${route}|${stop}|${weekend ? 1 : 0}|${hour}`;

  function flush() {
    if (!dirty) return;
    dirty = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(stats));
    fs.renameSync(file + '.tmp', file); // a crash mid-write must not leave half a file
  }
  setInterval(() => { try { flush(); } catch (e) { console.error('history save', e.message); } }, flushMs).unref();

  return {
    // delay in seconds (positive = late)
    record(route, stop, weekend, hour, delay) {
      if (!route || !Number.isFinite(delay)) return;
      const s = (stats[key(route, stop, weekend, hour)] ||= { n: 0, sum: 0, late: 0 });
      if (s.n >= CAP) { s.n *= 0.9; s.sum *= 0.9; s.late *= 0.9; }
      s.n++; s.sum += delay; if (delay >= LATE_SECS) s.late++;
      dirty = true;
    },
    // {avg: minutes (negative = early), late: % of buses 3+ min late, n} or null when there isn't enough to say
    usual(route, stop, weekend, hour) {
      const s = stats[key(route, stop, weekend, hour)];
      return s && s.n >= MIN ? { avg: Math.round(s.sum / s.n / 60), late: Math.round((100 * s.late) / s.n), n: Math.round(s.n) } : null;
    },
    // One sighting of the bus running a scheduled trip (trip = a key that stays the same from day to day), at most once a day
    seenBus(trip, artic) {
      const s = (stats[`bus|${trip}`] ||= { n: 0, artic: 0 });
      if (s.n >= BUS_CAP) { s.n *= 0.9; s.artic *= 0.9; }
      s.n++; if (artic) s.artic++;
      dirty = true;
    },
    // Share (0-1) of days this trip got an articulated bus, or null when it hasn't been seen often enough
    articShare(trip) {
      const s = stats[`bus|${trip}`];
      return s && s.n >= BUS_MIN ? s.artic / s.n : null;
    },
    flush,
  };
};
