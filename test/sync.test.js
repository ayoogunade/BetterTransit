const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createSync = require('../sync');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'sync.json');

test('newer write wins per key, older is ignored, unknown keys are dropped', () => {
  const s = createSync(tmp());
  s.merge({ pins: { v: [1], t: 100 } });
  const r = s.merge({ pins: { v: [2], t: 50 }, recents: { v: ['a'], t: 10 }, evil: { v: 1, t: 999 } });
  assert.deepStrictEqual(r.pins, { v: [1], t: 100 });
  assert.deepStrictEqual(r.recents, { v: ['a'], t: 10 });
  assert.strictEqual(r.evil, undefined);
});

test('state survives a restart', () => {
  const f = tmp();
  createSync(f).merge({ saved: { v: { home: 1 }, t: 5 } });
  assert.deepStrictEqual(createSync(f).merge().saved, { v: { home: 1 }, t: 5 });
});

test('the pinned-stop sort choice syncs between devices', () => {
  const s = createSync(tmp());
  s.merge({ stopSort: { v: 'next', t: 7 } });
  assert.deepStrictEqual(s.merge().stopSort, { v: 'next', t: 7 });
});

test('quiet hours sync between devices like the other settings, and get() reads the current value', () => {
  const f = tmp();
  const s = createSync(f);
  const quiet = { on: true, startMin: 1320, endMin: 420, days: [0] };
  s.merge({ quietHours: { v: quiet, t: 9 } });
  assert.deepStrictEqual(createSync(f).merge().quietHours, { v: quiet, t: 9 });
  assert.deepStrictEqual(s.get('quietHours'), quiet);
  assert.strictEqual(s.get('nothingSetYet'), undefined);
});
