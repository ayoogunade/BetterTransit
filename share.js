// "Share your arrival": unguessable public links to one ride's arrival, valid for 2 hours. In memory only (a restart drops them),
// capped so a loop can't grow it without bound. The link holds just {tripId, alightIdx, to}; everything shown is looked up live.
const crypto = require('crypto');

module.exports = function createShare({ ttlMs = 2 * 3600e3, max = 200, now = Date.now } = {}) {
  const links = new Map(); // token -> {tripId, alightIdx, to, expiresAt}; Map keeps insertion order, so the first key is the oldest
  const live = (l) => l && l.expiresAt > now();
  return {
    create({ tripId, alightIdx, to }) {
      const token = crypto.randomBytes(16).toString('base64url'); // 22 chars
      for (const [k, l] of links) if (!live(l)) links.delete(k);
      while (links.size >= max) links.delete(links.keys().next().value);
      links.set(token, { tripId, alightIdx, to, expiresAt: now() + ttlMs });
      return token;
    },
    get(token) {
      const l = links.get(token);
      if (live(l)) return l;
      links.delete(token);
      return null;
    },
  };
};
