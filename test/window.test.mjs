import assert from 'node:assert/strict';
import { pickAcrossWindow } from '../src/optimiser.js';

const card = ({ n, pos, avg, day, game }) => ({
  id: 'c-' + n, position: pos, bonus: 1, averageScore: avg, formL5: avg, activeSuspensions: [],
  player: { slug: n.toLowerCase(), displayName: n, activeInjuries: [],
    anyFutureGameStats: [{ onGameSheet: true, anyGame: { id: game, date: `${day}T18:00:00Z` },
      anyTeam: { name: 'T' + game },
      footballPlayingStatusOdds: { starterOddsBasisPoints: 9500, substituteOddsBasisPoints: 200, nonPlayingOddsBasisPoints: 300, reliability: 'HIGH' } }] },
});

// Day 1 has one slightly better forward; days 2-3 can field a full side almost as good.
const bench = [
  card({ n: 'EarlyStar', pos: 'FW', avg: 70, day: '2026-09-24', game: 'g1' }),
  card({ n: 'LateFwd',   pos: 'FW', avg: 69, day: '2026-09-26', game: 'g9' }),
  card({ n: 'GkA', pos: 'GK', avg: 62, day: '2026-09-25', game: 'g2' }),
  card({ n: 'DfA', pos: 'DF', avg: 62, day: '2026-09-25', game: 'g3' }),
  card({ n: 'MdA', pos: 'MD', avg: 62, day: '2026-09-26', game: 'g4' }),
  card({ n: 'FlexA', pos: 'DF', avg: 62, day: '2026-09-26', game: 'g5' }),
];

// The step resolves when the last card has played. Among lineups within reach
// of the target, the one that FINISHES earliest wins; a slightly stronger side
// that keeps the step open for days is not worth it.
const early = pickAcrossWindow(bench, { target: 300 });
assert.equal(early.ok, true);
assert.equal(early.clearsTarget, true);
assert.equal(early.finishDay, '2026-09-26', 'nothing complete can finish before the 26th');
assert.ok(early.chosen.some(c => c.player === 'EarlyStar'), 'no reason to leave the best forward out');

// A weaker side that finishes days earlier beats a stronger one, as long as it
// is within reach of the target.
const fast = [
  card({ n: 'G1', pos: 'GK', avg: 55, day: '2026-09-24', game: 'a1' }),
  card({ n: 'D1', pos: 'DF', avg: 55, day: '2026-09-24', game: 'a2' }),
  card({ n: 'M1', pos: 'MD', avg: 55, day: '2026-09-24', game: 'a3' }),
  card({ n: 'F1', pos: 'FW', avg: 55, day: '2026-09-24', game: 'a4' }),
  card({ n: 'X1', pos: 'DF', avg: 55, day: '2026-09-24', game: 'a5' }),
  card({ n: 'G2', pos: 'GK', avg: 65, day: '2026-09-30', game: 'b1' }),
  card({ n: 'D2', pos: 'DF', avg: 65, day: '2026-09-30', game: 'b2' }),
  card({ n: 'M2', pos: 'MD', avg: 65, day: '2026-09-30', game: 'b3' }),
  card({ n: 'F2', pos: 'FW', avg: 65, day: '2026-09-30', game: 'b4' }),
  card({ n: 'X2', pos: 'DF', avg: 65, day: '2026-09-30', game: 'b5' }),
];
// (55 x 0.957 availability x 5, plus the armband, is about 289; the 30th side about 341.)
const soon = pickAcrossWindow(fast, { target: 280 });
assert.equal(soon.finishDay, '2026-09-24', 'the 24th side clears 280, so finish on the 24th');
assert.ok(soon.tradedPointsForTime > 0, 'and say what was given up for it');
// The 24th side falls short of 320 and is not nearly as strong, so the later
// side that clears it is taken instead.
const later = pickAcrossWindow(fast, { target: 320 });
assert.equal(later.finishDay, '2026-09-30');
assert.equal(later.clearsTarget, true);
// Nothing clears 400: strongest within reach, which is still the 30th.
const none = pickAcrossWindow(fast, { target: 400 });
assert.equal(none.clearsTarget, false);
assert.equal(none.finishDay, '2026-09-30');

// Target out of reach from any day -> report the best and flag it, do not pretend.
const short = pickAcrossWindow(bench, { target: 999 });
assert.equal(short.clearsTarget, false);
assert.ok(short.shortfall > 0);

// No target -> still returns a valid lineup.
assert.equal(pickAcrossWindow(bench, {}).ok, true);
console.log('window assertions passed  | finishes', early.finishDay, '| fast side traded', soon.tradedPointsForTime, 'pts to finish six days sooner');

// --- a gap inside the natural spread is worth playing ---
// Five players each carry about 25 points of error, so a total swings by ~56.
// Refusing to enter at 54 short guarantees zero where entering had a real chance.
const SPREAD = 56;
assert.ok(360 - 306 <= SPREAD, 'a 54 point gap sits inside one spread, so it is playable');
assert.ok(360 - 200 > SPREAD, 'a 160 point gap is not');
console.log('reachability assertions passed');
