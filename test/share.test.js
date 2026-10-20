const test = require('node:test');
const assert = require('node:assert');
const createShare = require('../share');

test('a token resolves to its link for 2 hours, then not', () => {
  let t = 1000; const s = createShare({ now: () => t });
  const tok = s.create({ tripId: 'T', alightIdx: 4, to: 'Clarence' });
  assert.match(tok, /^[A-Za-z0-9_-]{22}$/);
  assert.deepStrictEqual(s.get(tok), { tripId: 'T', alightIdx: 4, to: 'Clarence', expiresAt: 1000 + 2 * 3600e3 });
  t += 2 * 3600e3 - 1; assert.ok(s.get(tok));
  t += 1; assert.strictEqual(s.get(tok), null);
});

test('unknown tokens give null and tokens are unique', () => {
  const s = createShare();
  assert.strictEqual(s.get('nope'), null);
  assert.notStrictEqual(s.create({}), s.create({}));
});

test('the map is capped: the oldest link is dropped first', () => {
  const s = createShare({ max: 3 });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => s.create({ tripId: x }));
  assert.strictEqual(s.get(a), null);
  for (const k of [b, c, d]) assert.ok(s.get(k));
});
