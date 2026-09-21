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

// Target reachable either way -> take the later lock, trading a couple of points.
const late = pickAcrossWindow(bench, { target: 300 });
assert.equal(late.ok, true);
assert.equal(late.clearsTarget, true);
assert.equal(late.lockDay, '2026-09-25', 'should avoid locking on day one for 2 points');
assert.ok(!late.chosen.some(c => c.player === 'EarlyStar'), 'day-one player excluded');
assert.ok(late.tradedPointsForTime > 0);

// Target out of reach -> report the best and flag it, do not pretend.
const short = pickAcrossWindow(bench, { target: 999 });
assert.equal(short.clearsTarget, false);
assert.ok(short.shortfall > 0);

// No target -> still returns a valid lineup.
assert.equal(pickAcrossWindow(bench, {}).ok, true);
console.log('window assertions passed  | lock', late.lockDay, '| traded', late.tradedPointsForTime, 'pts for a day');
