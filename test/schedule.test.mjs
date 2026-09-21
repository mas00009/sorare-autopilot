import assert from 'node:assert/strict';
import { cadenceFor, decide, FLOOR_MIN } from '../src/schedule.js';

assert.equal(cadenceFor(30), 5,    'final hour must be 5 min');
assert.equal(cadenceFor(120), 15,  '2h out must be 15 min');
assert.equal(cadenceFor(600), 60,  'same day must be hourly');
assert.equal(cadenceFor(5000), 180);
assert.equal(cadenceFor(null), FLOOR_MIN, 'unknown kickoff falls back to the floor');
assert.equal(cadenceFor(-10), FLOOR_MIN, 'past kickoff falls back to the floor');

const now = Date.parse('2026-09-24T12:00:00Z');
const ko = (m) => new Date(now + m * 60000).toISOString();

// 40 min to kickoff, ran 6 min ago -> go.
assert.equal(decide({ nextKickoff: ko(40), lastRunAt: now - 6 * 60000, now }).run, true);
// 40 min to kickoff, ran 2 min ago -> wait.
assert.equal(decide({ nextKickoff: ko(40), lastRunAt: now - 2 * 60000, now }).run, false);
// Days away, ran 30 min ago -> wait (no point).
assert.equal(decide({ nextKickoff: ko(5000), lastRunAt: now - 30 * 60000, now }).run, false);
// Days away, ran 4h ago -> go, so missions still get claimed.
assert.equal(decide({ nextKickoff: ko(5000), lastRunAt: now - 240 * 60000, now }).run, true);
// Never run before -> always go.
assert.equal(decide({ nextKickoff: ko(5000), lastRunAt: null, now }).run, true);

console.log('schedule assertions passed');

// --- lock buffer ---
import { LOCK_BUFFER_MIN } from '../src/schedule.js';
const t0 = Date.parse('2026-09-24T12:00:00Z');
const at = (m) => new Date(t0 + m * 60000).toISOString();

// The real lock wins over kickoff when both are present.
const d1 = decide({ nextKickoff: at(600), nextLock: at(70), lastRunAt: null, now: t0 });
assert.equal(d1.cadence, 5, 'must follow the lock, not the later kickoff');

// 70 min to lock, minus a 10 min buffer = 60 usable -> final-hour cadence.
assert.equal(cadenceFor(70 - LOCK_BUFFER_MIN), 5);
// Without the buffer 70 min would have fallen into the slower 15 min band.
assert.equal(cadenceFor(70), 15, 'buffer is what pulls this into the dense band');

// Inside the buffer the deadline has effectively passed; do not thrash.
const d2 = decide({ nextLock: at(4), lastRunAt: t0 - 60 * 60000, now: t0 });
assert.ok(d2.minsToKickoff < 0, 'inside the buffer counts as past');

// Buffer is overridable.
assert.equal(decide({ nextLock: at(100), lastRunAt: null, now: t0, buffer: 45 }).cadence, 5);
console.log('lock-buffer assertions passed');
