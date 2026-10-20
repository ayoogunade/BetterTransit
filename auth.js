// Password gate with a long-lived cookie. Replaces Caddy's Basic Auth: iOS Home Screen apps don't keep Basic Auth
// credentials between launches (white screen on reopen), but they do keep cookies. Off unless a bcrypt hash is set
// (LOGIN_HASH, e.g. the one from `caddy hash-password`), so local dev is unchanged.
// Every sign-in creates its own session (a random secret, stored only as a hash in data/sessions.json), so a lost phone can be
// signed out from another device without changing the password.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const FILE = path.join(__dirname, 'data', 'sessions.json');
const COOKIE = 'bt_auth';
const MAX_AGE = 400 * 86400; // the longest browsers allow
const TOUCH_MS = 3600e3; // "last active" is only rewritten to disk this often
// reachable signed out: the login page, and what iOS fetches without cookies when adding to the Home Screen
const OPEN = new Set(['/login', '/sw.js', '/manifest.json', '/favicon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/style.css']);

// A shared-arrival link and the data behind it: exactly one 22-char token segment, nothing after it (see share.js)
const SHARED = /^\/(s|api\/shared)\/[A-Za-z0-9_-]{22}$/;

const sha =(s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// "iPhone · Safari": enough to tell your own devices apart in the list
const deviceLabel = (ua = '') => {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return app ? `${os} · ${app}` : os;
};

module.exports = function createAuth({ hash = process.env.LOGIN_HASH, file = FILE, maxFails = 10, failWindowMs = 15 * 60e3, maxSessions = 50 } = {}) {
  if (!hash) return { enabled: false, check: () => true, login: async () => null, list: () => [], revoke: () => false, id: () => null };
  // tied to the hash, so changing the password signs every device out
  const fp = sha(hash);
  let sessions = []; // {id, th: sha256 of the secret, label, created, lastSeen}
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d.fp === fp) sessions = d.sessions; } catch {}
  const fails = new Map(); // ip -> [timestamps]

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ fp, sessions }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  const alive = (s, now = Date.now()) => now - s.created < MAX_AGE * 1000;
  const readCookie = (req) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  const cookie = (value, secure) => `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const find = (req) => {
    const [id, secret] = readCookie(req).split('.');
    const s = secret && sessions.find((x) => x.id === id);
    return s && alive(s) && same(sha(secret), s.th) ? s : null;
  };

  return {
    enabled: true,
    // true when this request may go through
    check(req, pathname) {
      if (OPEN.has(pathname) || SHARED.test(pathname)) return true;
      const s = find(req), now = Date.now();
      if (s && now - s.lastSeen > TOUCH_MS) { s.lastSeen = now; save(); }
      return !!s;
    },
    // returns the Set-Cookie value on success, null on a wrong password, 'locked' after too many recent failures
    async login(password, ip, secure, userAgent) {
      const now = Date.now(), recent = (fails.get(ip) || []).filter((t) => now - t < failWindowMs);
      if (recent.length >= maxFails) return 'locked';
      if (typeof password === 'string' && password && (await bcrypt.compare(password, hash))) {
        fails.delete(ip);
        const id = crypto.randomBytes(9).toString('base64url'), secret = crypto.randomBytes(32).toString('base64url');
        sessions = [...sessions, { id, th: sha(secret), label: deviceLabel(userAgent), created: now, lastSeen: now }]
          .filter((s) => alive(s, now)).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxSessions);
        save();
        return cookie(`${id}.${secret}`, secure);
      }
      fails.set(ip, [...recent, now]);
      return null;
    },
    // the signed-in devices, most recently active first; current marks the one making this request
    list(req) {
      const mine = find(req);
      return [...sessions].sort((a, b) => b.lastSeen - a.lastSeen).map(({ id, label, created, lastSeen }) => ({ id, label, created, lastSeen, current: !!mine && mine.id === id }));
    },
    // the session id behind this request's cookie, or null
    id: (req) => find(req)?.id || null,
    // sign one device out; true if it existed
    revoke(id) {
      const had = sessions.some((s) => s.id === id);
      if (had) { sessions = sessions.filter((s) => s.id !== id); save(); }
      return had;
    },
  };
};
