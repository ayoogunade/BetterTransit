// Cross-device settings sync: a tiny last-write-wins store. Each key (pins, saved places, ...) is {v: value, t: ms timestamp};
// a device sends the keys it changed and gets back the merged whole. Persisted to data/sync.json.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'sync.json');
const KEYS = ['pins', 'routePins', 'saved', 'recents', 'shownRoutes'];

module.exports = function createSync(file = FILE) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    // merge incoming {key: {v, t}} (newer t wins) and return everything
    merge(incoming = {}) {
      let changed = false;
      for (const k of KEYS) {
        const c = incoming[k];
        if (c && typeof c.t === 'number' && 'v' in c && c.t > (state[k]?.t || 0)) { state[k] = { v: c.v, t: c.t }; changed = true; }
      }
      if (changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); }
      return state;
    },
    KEYS,
  };
};
