// Password gate with a long-lived cookie. Replaces Caddy's Basic Auth: iOS Home Screen apps don't keep Basic Auth
// credentials between launches (white screen on reopen), but they do keep cookies. Off unless a bcrypt hash is set
// (LOGIN_HASH, e.g. the one from `caddy hash-password`), so local dev is unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DIR = path.join(__dirname, 'data');
const COOKIE = 'bt_auth';
const MAX_AGE = 400 * 86400; // the longest browsers allow
// reachable signed out: the login page, and what iOS fetches without cookies when adding to the Home Screen
const OPEN = new Set(['/login', '/sw.js', '/manifest.json', '/favicon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/style.css']);

module.exports = function createAuth({ hash = process.env.LOGIN_HASH, secretFile = path.join(DIR, 'auth-secret'), maxFails = 10, failWindowMs = 15 * 60e3 } = {}) {
  if (!hash) return { enabled: false, check: () => true, login: async () => null };
  let secret;
  try { secret = fs.readFileSync(secretFile, 'utf8'); } catch {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  // tied to the hash, so changing the password signs every device out
  const token = crypto.createHmac('sha256', secret).update(hash).digest('base64url');
  const fails = new Map(); // ip -> [timestamps]

  const readCookie = (req) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookie = (secure) => `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  return {
    enabled: true,
    // true when this request may go through
    check: (req, pathname) => OPEN.has(pathname) || same(readCookie(req), token),
    // returns the Set-Cookie value on success, null on a wrong password, 'locked' after too many recent failures
    async login(password, ip, secure) {
      const now = Date.now(), recent = (fails.get(ip) || []).filter((t) => now - t < failWindowMs);
      if (recent.length >= maxFails) return 'locked';
      if (typeof password === 'string' && password && (await bcrypt.compare(password, hash))) { fails.delete(ip); return cookie(secure); }
      fails.set(ip, [...recent, now]);
      return null;
    },
  };
};
