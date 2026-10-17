const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createHistory = require('../history');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'history.json');

test('says nothing until a slot has enough samples, then reports the average and how often it is late', () => {
  const h = createHistory(tmp());
  for (const d of [60, 120, 240, 300]) h.record('60', 'S1', false, 8, d);
  assert.strictEqual(h.usual('60', 'S1', false, 8), null);
  h.record('60', 'S1', false, 8, 180);
  assert.deepStrictEqual(h.usual('60', 'S1', false, 8), { avg: 3, late: 60, n: 5 }); // 180 s counts as late
  assert.strictEqual(h.usual('60', 'S1', true, 8), null); // weekends are tracked apart
  assert.strictEqual(h.usual('60', 'S1', false, 9), null); // and so is each hour
});

test('early buses give a negative average', () => {
  const h = createHistory(tmp());
  for (let i = 0; i < 5; i++) h.record('17', 'S2', false, 17, -120);
  assert.strictEqual(h.usual('17', 'S2', false, 17).avg, -2);
});

test('old samples fade once a slot is full, and bad input is ignored', () => {
  const h = createHistory(tmp());
  for (let i = 0; i < 400; i++) h.record('5', 'S3', false, 7, 600);
  assert.ok(h.usual('5', 'S3', false, 7).n <= 210);
  h.record('5', 'S4', false, 7, NaN);
  h.record(undefined, 'S4', false, 7, 60);
  assert.strictEqual(h.usual('5', 'S4', false, 7), null);
});

test('the history survives a restart', () => {
  const f = tmp();
  const h = createHistory(f);
  for (let i = 0; i < 5; i++) h.record('9', 'S5', true, 12, 360);
  h.flush();
  assert.strictEqual(createHistory(f).usual('9', 'S5', true, 12).avg, 6);
});
