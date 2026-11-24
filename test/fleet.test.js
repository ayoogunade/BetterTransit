const test = require('node:test');
const assert = require('node:assert');
const { isArtic } = require('../fleet');

test('fleet numbers in the articulated batches are accordion buses, others are not', () => {
  for (const n of ['1007', '2406', '2408', '2511', '2520', '2618', '2621']) assert.ok(isArtic(n), n);
  for (const n of ['1003', '2405', '2410', '2501', '2510', '2617', '712', '', null, undefined, 'abc']) assert.ok(!isArtic(n), String(n));
});
