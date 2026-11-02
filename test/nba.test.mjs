import assert from 'node:assert/strict';
import { pickLineup, NBA_OPTIONS, starsOf } from '../src/optimiser.js';

let n = 0;
const card = (name, tier, avg, game = `g${n}`) => ({ id: `c${n++}`, position: 'basketball_guard', bonus: 1, averageScore: avg, formL5: avg,
  activeSuspensions: [], startRate: 1, playRate: 1,
  player: { slug: name, displayName: name, gameplayTier: tier, activeInjuries: [],
    anyFutureGameStats: [{ anyGame: { id: game, date: '2026-11-03T00:30:00Z' }, anyTeam: { slug: 't' + game, name: 'T' + game } }] } });

// Three 5-stars would score most but cost 15 of the 16 stars; the cap forces a mix.
const bench = [
  card('goat1', 'GOAT', 55), card('goat2', 'GOAT', 54), card('goat3', 'GOAT', 53),
  card('imp1', 'IMPACT', 40), card('imp2', 'IMPACT', 39), card('ros1', 'ROSTER', 30), card('ros2', 'ROSTER', 29), card('dnp', 'DNP', 12),
];
const p = pickLineup(bench, { ...NBA_OPTIONS, calibration: 1 });
assert.equal(p.ok, true, p.reason);
assert.equal(p.chosen.length, 5);
const stars = p.chosen.reduce((s, c) => s + starsOf(c.tier), 0);
assert.ok(stars <= 16, `stars ${stars} over the cap`);
assert.equal(p.captain, null, 'NBA has no armband');
// Best legal five: 2 GOAT (10) + 2 ROSTER (4) + ... must fit 16 with the highest total.
const total = p.chosen.reduce((s, c) => s + c.expected, 0);
assert.ok(total >= 55 + 54 + 30 + 29 + 12 - 0.01, `total ${total}`);
// The owner's own valid lineup: STAR_PLUS + 3 IMPACT + ROSTER_PLUS = 16, accepted, so the cap is inclusive.
assert.equal(starsOf('STAR_PLUS') + 3 * starsOf('IMPACT') + starsOf('ROSTER_PLUS'), 16);
console.log('nba assertions passed');
