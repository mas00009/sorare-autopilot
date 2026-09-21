import assert from 'node:assert/strict';
import { digest, bigPulls, mailConfigured, ALERT_STARS } from '../src/report.js';

// 3 stars and up is an alert; 2 and below is not.
assert.equal(ALERT_STARS, 3);
assert.equal(bigPulls({ pulls: [{ name: 'A', stars: 3 }, { name: 'B', stars: 4 }, { name: 'C', stars: 5 }] }).length, 3);
assert.equal(bigPulls({ pulls: [{ name: 'A', stars: 2 }, { name: 'B', stars: 1 }] }).length, 0);
assert.equal(bigPulls({}).length, 0);

// Mail is opt-in; missing config must not throw.
assert.equal(mailConfigured({}), false);
assert.equal(mailConfigured({ SMTP_USER: 'a', SMTP_APP_PASSWORD: 'b', REPORT_TO: 'c' }), true);

const d = digest('2026-09-24', [
  { lineups: [{ surface: 'my set', action: 'submitted', in: ['dani-olmo'], out: ['emil-audero'], projected: 302 }],
    claimed: [{ name: 'DAILY_ACTION', description: 'Train Daily. Grow faster.' }],
    rewards: [{ currency: 'COMMON_XP', before: 0, after: 200, change: 200 }],
    stepClaims: [{ surface: 'team set', action: 'claimed', reason: 'Step was CLAIMABLE - reward claimed.' }],
    essenceSpent: 1000,
    pulls: [{ name: 'Marcos Alonso', stars: 3 }], errors: [] },
  { lineups: [{ surface: 'team set', action: 'restarted', reason: 'Step FAILED - ladder restarted', in: [], out: [] }],
    claimed: [], essenceSpent: 0, pulls: [], errors: ['boom'] },
]);
assert.match(d, /2 passes/);
assert.match(d, /out: emil-audero/);
assert.match(d, /in:  dani-olmo/);
assert.match(d, /LADDER RESTARTS/);
assert.match(d, /DAILY_ACTION - Train Daily/);
assert.match(d, /RECEIVED/);
assert.match(d, /COMMON_XP  \+200/);
assert.match(d, /\[team set\] Step was CLAIMABLE/);
// Old string-only claim entries must still render.
assert.match(digest('x', [{ lineups: [], claimed: ['LEGACY_TASK'], essenceSpent: 0, pulls: [], errors: [] }]), /LEGACY_TASK/);
assert.match(d, /spent 1000/);
assert.match(d, /Marcos Alonso 3\*/);
assert.match(d, /boom/);
assert.match(digest('x', [{ lineups: [], claimed: [], essenceSpent: 0, pulls: [], errors: [] }]), /1 pass\./);
console.log('report assertions passed');

// --- failure alerting ---
import { trackHealth } from '../src/report.js';
const mk = () => { const s = {}; return { s, write: async (p) => Object.assign(s, p) }; };
let st = { failStreak: 2 }, w = mk();
assert.deepEqual(await trackHealth({ errors: ['x'] }, st, w.write), { alert: true, streak: 3 }, 'third failure alerts');
assert.equal(w.s.failAlerted, true);
assert.deepEqual(await trackHealth({ errors: ['x'] }, { failStreak: 5, failAlerted: true }, mk().write), {}, 'no repeat spam');
assert.deepEqual(await trackHealth({ errors: [] }, { failStreak: 5, failAlerted: true }, mk().write), { recovered: true });
assert.deepEqual(await trackHealth({ errors: ['x'] }, { failStreak: 0 }, mk().write), {}, 'one failure is not an alert');
console.log('health assertions passed');
