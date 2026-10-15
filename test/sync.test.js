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
