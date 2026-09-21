import assert from 'node:assert/strict';
import { accuracy } from '../src/results.js';

assert.deepEqual(accuracy([]), { n: 0 });

const rows = [
  { outcome: 'SUCCESSFUL', players: [ { projected: 60, actual: 70 }, { projected: 50, actual: 30 } ] },
  { outcome: 'FAILED',     players: [ { projected: 60, actual: 0 },  { projected: 40, actual: 45 }, { projected: 20, actual: null } ] },
];
const a = accuracy(rows);
assert.equal(a.n, 4, 'null actuals are excluded');
assert.equal(a.steps, 2);
assert.equal(a.hit, 1);
// errors: +10, -20, -60, +5 -> mean -16.25
assert.equal(a.bias, -16.3, 'negative bias means we over-project');
assert.equal(a.mae, 23.8);
assert.equal(a.blankRate, 0.25, 'one of four blanked');
console.log('results assertions passed');
