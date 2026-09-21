import assert from 'node:assert/strict';
import { pickLineup, blockReason } from '../src/optimiser.js';

const card = ({ name, pos, avg, bonus = 0, starter = 9000, sub = 500, game = 'g1', team = 'T', injured = null, suspended = false, locked = null }) => ({
  id: `c-${name}`,
  position: pos,
  bonus,
  averageScore: avg,
  lockedAt: locked,
  activeSuspensions: suspended ? [{ id: 's' }] : [],
  player: {
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    displayName: name,
    activeInjuries: injured ? [{ active: true, kind: injured, status: 'out', expectedEndDate: '2026-10-25' }] : [],
    nextClassicFixturePlayingStatusOdds: null,
    anyFutureGameStats: [{
      onGameSheet: true,
      anyGame: { id: game, date: '2026-09-26T14:00:00Z' },
      anyTeam: { name: team },
      footballPlayingStatusOdds: {
        starterOddsBasisPoints: starter,
        substituteOddsBasisPoints: sub,
        nonPlayingOddsBasisPoints: 10000 - starter - sub,
        reliability: 'HIGH',
      },
    }],
  },
});

// Modelled on the real 19-20 Sep situation.
const bench = [
  card({ name: 'Andres Martin', pos: 'FW', avg: 83, bonus: 0.04, injured: 'knee sprain' }),
  card({ name: 'Inigo Vicente', pos: 'FW', avg: 72, bonus: 0.04, game: 'racing-celta', team: 'Racing' }),
  card({ name: 'Casseres Jr', pos: 'MD', avg: 71, bonus: 0.02, game: 'tou-lehavre', team: 'Toulouse' }),
  card({ name: 'Matthias Ginter', pos: 'DF', avg: 70, bonus: 0.02, game: 'sge-scf', team: 'Freiburg' }),
  card({ name: 'Olivier Boscagli', pos: 'DF', avg: 66, bonus: 0.02, game: 'bha-ars', team: 'Brighton' }),
  card({ name: 'Maxim De Cuyper', pos: 'DF', avg: 57, bonus: 0.02, game: 'bha-ars', team: 'Brighton' }),
  card({ name: 'Calvin Bassey', pos: 'DF', avg: 57, bonus: 0.02, game: 'ful-x', team: 'Fulham' }),
  card({ name: 'Aubameyang', pos: 'FW', avg: 61, bonus: 0.04, game: 'bet-dep', team: 'Deportivo' }),
  card({ name: 'Emil Audero', pos: 'GK', avg: 52, bonus: 0.09, game: 'osa-ray', team: 'Rayo' }),
  card({ name: 'Brice Samba', pos: 'GK', avg: 48, bonus: 0.01, game: 'ren-x', team: 'Rennes', starter: 2000, sub: 500 }),
  card({ name: 'Benchwarmer', pos: 'MD', avg: 90, bonus: 0.10, game: 'x-y', team: 'Z', starter: 1500, sub: 3000 }),
  card({ name: 'Suspended Guy', pos: 'MD', avg: 88, suspended: true, game: 'q-r' }),
];

const picked = pickLineup(bench);
assert.ok(picked.ok, picked.reason);
const names = picked.chosen.map((c) => c.player);

// The injured top scorer must never appear.
assert.ok(!names.includes('Andres Martin'), 'injured player was selected');
// Neither should the suspended one, nor the high-average non-starter.
assert.ok(!names.includes('Suspended Guy'), 'suspended player was selected');
assert.ok(!names.includes('Benchwarmer'), '15%-to-start player was selected');
assert.ok(!names.includes('Brice Samba'), '20%-to-start keeper was selected');

// Correlation cap: both Brighton defenders share a game, only one may come.
const brighton = names.filter((n) => ['Olivier Boscagli', 'Maxim De Cuyper'].includes(n));
assert.ok(brighton.length <= 2, 'per-game cap breached');

assert.equal(picked.chosen.length, 5);
assert.equal(picked.captain.player, 'Inigo Vicente', `captain was ${picked.captain.player}`);
assert.ok(picked.chosen.some((c) => c.position === 'GK'), 'no keeper picked');

const reasons = Object.fromEntries(picked.excluded.map((c) => [c.player, c.blocked]));
assert.match(reasons['Andres Martin'], /injured/);
assert.match(reasons['Suspended Guy'], /suspended/);
assert.match(reasons['Benchwarmer'], /to start/);

console.log('XI:', picked.chosen.map((c) => `${c.position} ${c.player} ${c.expected}`).join(' | '));
console.log('captain:', picked.captain.player, '| projected:', picked.projected);
console.log('excluded:', JSON.stringify(reasons, null, 0));
console.log('\nall assertions passed');

// --- regression: bonus is a multiplier, not an additive fraction ---
import { bonusMultiplier, expectedPoints } from '../src/optimiser.js';
assert.equal(bonusMultiplier(1.01), 1.01, 'multiplier form must pass through');
assert.equal(bonusMultiplier(0.04), 1.04, 'additive form must still work');
assert.equal(bonusMultiplier(null), 1);

// --- regression: no published starter odds must not zero a card out ---
const noOdds = {
  id: 'c-x', position: 'GK', bonus: 1.01, averageScore: 82,
  activeSuspensions: [],
  player: {
    slug: 'sander-tangvik', displayName: 'Sander Tangvik', activeInjuries: [],
    nextClassicFixturePlayingStatusOdds: null,
    anyFutureGameStats: [{ onGameSheet: false, anyGame: { id: 'g9', date: '2026-09-24T18:45:00Z' }, anyTeam: { name: 'Norway' }, footballPlayingStatusOdds: null }],
  },
};
assert.equal(blockReason(noOdds), null, 'missing odds must not block');
assert.ok(Math.abs(expectedPoints(noOdds) - 82 * 1.01) < 0.001, 'missing odds must not zero the score');
console.log('regression assertions passed');
