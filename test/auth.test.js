const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const createAuth = require('../auth');

const hash = bcrypt.hashSync('hunter2', 4);
const secretFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 'auth-secret');
const req = (cookie) => ({ headers: cookie ? { cookie } : {} });
const value = (setCookie) => setCookie.split(';')[0];

test('off without a hash: everything goes through', () => {
  const a = createAuth({ hash: '' });
  assert.strictEqual(a.enabled, false);
  assert.strictEqual(a.check(req(), '/'), true);
});

test('signed out: the app and API are blocked, the login page and install files are not', () => {
  const a = createAuth({ hash, secretFile: secretFile() });
  assert.strictEqual(a.check(req(), '/'), false);
  assert.strictEqual(a.check(req(), '/api/arrivals/1'), false);
  assert.strictEqual(a.check(req('bt_auth=forged'), '/'), false);
  for (const p of ['/login', '/sw.js', '/manifest.json', '/icon-180.png']) assert.strictEqual(a.check(req(), p), true, p);
});

test('the right password returns a long-lived cookie that lets requests through', async () => {
  const a = createAuth({ hash, secretFile: secretFile() });
  assert.strictEqual(await a.login('wrong', '1.2.3.4'), null);
  const c = await a.login('hunter2', '1.2.3.4', true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /Max-Age=34560000/);
  assert.strictEqual(a.check(req(`other=1; ${value(c)}`), '/'), true);
});

test('the cookie survives a server restart and dies when the password changes', async () => {
  const f = secretFile();
  const c = value(await createAuth({ hash, secretFile: f }).login('hunter2', 'ip'));
  assert.strictEqual(createAuth({ hash, secretFile: f }).check(req(c), '/'), true);
  assert.strictEqual(createAuth({ hash: bcrypt.hashSync('new-pass', 4), secretFile: f }).check(req(c), '/'), false);
});

test('too many wrong passwords from one address locks it out, even with the right one', async () => {
  const a = createAuth({ hash, secretFile: secretFile(), maxFails: 3 });
  for (let i = 0; i < 3; i++) assert.strictEqual(await a.login('nope', 'bad'), null);
  assert.strictEqual(await a.login('hunter2', 'bad'), 'locked');
  assert.match(await a.login('hunter2', 'other'), /^bt_auth=/);
});
