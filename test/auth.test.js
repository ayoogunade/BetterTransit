const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const createAuth = require('../auth');

const hash = bcrypt.hashSync('hunter2', 4);
const sessionFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 'sessions.json');
const req = (cookie) => ({ headers: cookie ? { cookie } : {} });
const value = (setCookie) => setCookie.split(';')[0];

test('off without a hash: everything goes through', () => {
  const a = createAuth({ hash: '' });
  assert.strictEqual(a.enabled, false);
  assert.strictEqual(a.check(req(), '/'), true);
});

test('signed out: the app and API are blocked, the login page and install files are not', () => {
  const a = createAuth({ hash, file: sessionFile() });
  assert.strictEqual(a.check(req(), '/'), false);
  assert.strictEqual(a.check(req(), '/api/arrivals/1'), false);
  assert.strictEqual(a.check(req('bt_auth=forged'), '/'), false);
  for (const p of ['/login', '/sw.js', '/manifest.json', '/icon-180.png']) assert.strictEqual(a.check(req(), p), true, p);
});

test('the right password returns a long-lived cookie that lets requests through', async () => {
  const a = createAuth({ hash, file: sessionFile() });
  assert.strictEqual(await a.login('wrong', '1.2.3.4'), null);
  const c = await a.login('hunter2', '1.2.3.4', true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /Max-Age=34560000/);
  assert.doesNotMatch(c, /hunter2/);
  assert.strictEqual(a.check(req(`other=1; ${value(c)}`), '/'), true);
});

test('the cookie survives a server restart and dies when the password changes', async () => {
  const f = sessionFile();
  const c = value(await createAuth({ hash, file: f }).login('hunter2', 'ip'));
  assert.strictEqual(createAuth({ hash, file: f }).check(req(c), '/'), true);
  assert.strictEqual(createAuth({ hash: bcrypt.hashSync('new-pass', 4), file: f }).check(req(c), '/'), false);
});

test('too many wrong passwords from one address locks it out, even with the right one', async () => {
  const a = createAuth({ hash, file: sessionFile(), maxFails: 3 });
  for (let i = 0; i < 3; i++) assert.strictEqual(await a.login('nope', 'bad'), null);
  assert.strictEqual(await a.login('hunter2', 'bad'), 'locked');
  assert.match(await a.login('hunter2', 'other'), /^bt_auth=/);
});

test('each sign-in is its own session: they are listed by device, and one can be signed out without touching the others', async () => {
  const a = createAuth({ hash, file: sessionFile() });
  const phone = value(await a.login('hunter2', 'ip', false, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit Version/18 Mobile Safari/604.1'));
  const mac = value(await a.login('hunter2', 'ip', false, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130 Safari/537.36'));
  assert.notStrictEqual(phone, mac);
  const list = a.list(req(phone));
  assert.deepStrictEqual(list.map((s) => s.label).sort(), ['Mac · Chrome', 'iPhone · Safari']);
  assert.strictEqual(list.filter((s) => s.current).length, 1);
  assert.strictEqual(list.find((s) => s.current).label, 'iPhone · Safari');
  assert.ok(!JSON.stringify(list).includes(phone.split('=')[1].split('.')[1])); // the secret is never listed
  assert.strictEqual(a.revoke(list.find((s) => !s.current).id), true);
  assert.strictEqual(a.check(req(mac), '/'), false);
  assert.strictEqual(a.check(req(phone), '/'), true);
  assert.strictEqual(a.revoke('nope'), false);
  assert.strictEqual(a.id(req(phone)), list.find((s) => s.current).id);
  assert.strictEqual(a.id(req()), null);
});

test('a session cookie with a wrong secret, or one for a revoked id, is refused; sessions survive a restart', async () => {
  const f = sessionFile();
  const c = value(await createAuth({ hash, file: f }).login('hunter2', 'ip'));
  const [id] = c.split('=')[1].split('.');
  const b = createAuth({ hash, file: f });
  assert.strictEqual(b.check(req(c), '/'), true);
  assert.strictEqual(b.check(req(`bt_auth=${id}.wrong`), '/'), false);
  assert.strictEqual(b.check(req(`bt_auth=${id}`), '/'), false);
});

test('only the newest sessions are kept', async () => {
  const a = createAuth({ hash, file: sessionFile(), maxSessions: 2 });
  const first = value(await a.login('hunter2', 'ip'));
  await a.login('hunter2', 'ip'); await a.login('hunter2', 'ip');
  assert.strictEqual(a.list(req(first)).length, 2);
});

test('with auth off there are no sessions to list', () => {
  const a = createAuth({ hash: '' });
  assert.deepStrictEqual(a.list(req()), []);
  assert.strictEqual(a.revoke('x'), false);
});
