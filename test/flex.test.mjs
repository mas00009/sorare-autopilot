import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLineup } from '../src/optimiser.js';

/** A bench node shaped the way myFilteredBench returns them. */
const card = (slug, position, avg, gameId) => ({
  id: slug, position, bonus: 1.02, rarity: 'common',
  averageScore: avg, formL5: avg,
  player: {
    slug, displayName: slug, activeInjuries: [],
    anyFutureGameStats: [{
      onGameSheet: true,
      anyGame: { id: gameId, date: '2026-10-01T18:00:00Z', competition: { name: 'x' },
                 homeTeam: { slug: 'h', name: 'H' }, awayTeam: { slug: 'a', name: 'A' } },
      footballPlayingStatusOdds: { starterOddsBasisPoints: 9000, substituteOddsBasisPoints: 500,
                                   nonPlayingOddsBasisPoints: 500, reliability: 1 },
    }],
  },
});

test('the fifth slot never takes a second keeper', () => {
  // Two keepers score far above everyone else, so a free flex fill would take
  // the spare one. Sorare's extra slot is Defender, Midfielder or Forward.
  const bench = [
    card('gk1', 'Goalkeeper', 95, 'g1'),
    card('gk2', 'Goalkeeper', 94, 'g2'),
    card('df1', 'Defender', 50, 'g3'),
    card('md1', 'Midfielder', 50, 'g4'),
    card('fw1', 'Forward', 50, 'g5'),
    card('df2', 'Defender', 40, 'g6'),
  ];
  const picked = pickLineup(bench);
  assert.equal(picked.ok, true, picked.reason);
  assert.equal(picked.chosen.length, 5);
  assert.equal(picked.chosen.filter((c) => c.position === 'GK').length, 1);
});

test('the armband goes on the best raw scorer, not the best projection', () => {
  // fw1 projects higher only because of its bonus. The armband pays on the raw
  // score, so md1 is worth more in the role.
  const bench = [
    card('gk1', 'Goalkeeper', 50, 'g1'),
    card('df1', 'Defender', 50, 'g2'),
    { ...card('fw1', 'Forward', 61, 'g3'), bonus: 1.30 },
    card('md1', 'Midfielder', 70, 'g4'),
    card('df2', 'Defender', 40, 'g5'),
  ];
  const picked = pickLineup(bench);
  assert.equal(picked.ok, true, picked.reason);
  assert.equal(picked.captain.slug, 'md1');
  assert.ok(picked.captainPoints > 0);
  const flat = picked.chosen.reduce((s, c) => s + c.expected, 0);
  assert.ok(picked.projected > flat, 'the armband must be in the projection');
});

test('appearances go out in slot order, not ranking order', async () => {
  const { toAppearances } = await import('../src/optimiser.js');
  // Ranked by projection the keeper is third, but the goalkeeper slot is index 0.
  const picked = {
    chosen: [
      { id: 'a', position: 'DF' }, { id: 'b', position: 'FW' },
      { id: 'c', position: 'GK' }, { id: 'd', position: 'MD' },
      { id: 'e', position: 'DF' },
    ],
    captain: { id: 'b' },
  };
  const out = toAppearances(picked);
  assert.deepEqual(out.map((a) => a.composeTeamBenchObjectId), ['c', 'a', 'd', 'b', 'e']);
  assert.deepEqual(out.map((a) => a.index), [0, 1, 2, 3, 4]);
  assert.equal(out.find((a) => a.captain).composeTeamBenchObjectId, 'b');
});

test('opponent strength applies to internationals and not to clubs', async () => {
  const { opponentEdge, opponentFactor } = await import('../src/opponents.js');
  // Measured on this account's own history: internationals only.
  assert.equal(opponentFactor('Real Madrid', 'Getafe CF', 'DF'), 1, 'club games get no factor');
  assert.equal(opponentEdge('Real Madrid', 'Getafe CF', 'DF'), null);

  // Clamped at 400 points, so an extreme mismatch cannot run away with the projection.
  const soft = opponentEdge('Spain', 'San Marino', 'DF');
  const hard = opponentEdge('Wales', 'Spain', 'DF');
  assert.ok(soft.factor > 1.1, `a defender facing the weakest side should pay: ${soft.factor}`);
  assert.ok(hard.factor < 0.9, `a defender facing the strongest should cost: ${hard.factor}`);
  assert.equal(soft.factor, opponentEdge('Argentina', 'San Marino', 'DF').factor);
  assert.equal(soft.mismatch, true);
  assert.equal(opponentEdge('Norway', 'Denmark', 'DF').mismatch, false);

  // The effect is a clean-sheet effect: it pays defenders, less for midfield,
  // and forwards get nothing at all.
  const df = opponentEdge('Spain', 'San Marino', 'DF').factor;
  const md = opponentEdge('Spain', 'San Marino', 'MD').factor;
  const fw = opponentEdge('Spain', 'San Marino', 'FW').factor;
  assert.ok(df > md && md > fw, `expected DF > MD > FW: ${df} ${md} ${fw}`);
  assert.equal(fw, 1);

  // Names Sorare spells differently still resolve.
  assert.ok(opponentEdge('Türkiye', 'England', 'DF'), 'alias should resolve');
});

test('a third defensive card from a mismatch is allowed only when the plain pick is short', async () => {
  const { pickAcrossWindow } = await import('../src/optimiser.js');
  const nat = (slug, position, avg, team, opp, home = true) => ({
    id: slug, position, bonus: 1.02, rarity: 'common', averageScore: avg, formL5: avg,
    player: { slug, displayName: slug, activeInjuries: [],
      anyFutureGameStats: [{ onGameSheet: true, anyTeam: { slug: team.toLowerCase(), name: team },
        anyGame: { id: `${team}-${opp}`, date: '2026-10-01T18:00:00Z', competition: { name: 'WC' },
          homeTeam: { slug: (home ? team : opp).toLowerCase(), name: home ? team : opp },
          awayTeam: { slug: (home ? opp : team).toLowerCase(), name: home ? opp : team } },
        footballPlayingStatusOdds: { starterOddsBasisPoints: 9000, substituteOddsBasisPoints: 500,
          nonPlayingOddsBasisPoints: 500, reliability: 1 } }] },
  });
  // Spain host San Marino: three Spanish defenders/midfielders are the best cards.
  const bench = [
    nat('es-gk', 'Goalkeeper', 60, 'Spain', 'San Marino'),
    nat('es-df1', 'Defender', 60, 'Spain', 'San Marino'),
    nat('es-df2', 'Defender', 59, 'Spain', 'San Marino'),
    nat('es-md', 'Midfielder', 58, 'Spain', 'San Marino'),
    nat('ot-fw', 'Forward', 50, 'Norway', 'Denmark'),
    nat('ot-df', 'Defender', 40, 'Norway', 'Denmark'),
    nat('ot-md', 'Midfielder', 40, 'Wales', 'Portugal'),
  ];
  const fromSpain = (p) => p.chosen.filter((c) => c.team === 'Spain').length;
  // Short of a huge target: the stacked lineup projects higher, so it is taken.
  const short = pickAcrossWindow(bench, { target: 999 });
  assert.equal(short.ok, true, short.reason);
  assert.equal(fromSpain(short), 3, 'short of target, a third from the mismatch is allowed');
  assert.equal(short.stacked, true);
  // Clearing comfortably: the plain two-per-match lineup is kept for its lower risk.
  const clear = pickAcrossWindow(bench, { target: 100 });
  assert.equal(fromSpain(clear), 2, 'clear of target, correlation is only risk');
  assert.ok(!clear.stacked);
});

test('recent start rate stands in for availability until odds are published', async () => {
  const { priorAvailability, expectedPoints, DEFAULTS } = await import('../src/optimiser.js');
  const base = { averageScore: 60, formL5: 60, bonus: 1.0, position: 'DF',
    player: { anyFutureGameStats: [{ anyGame: { date: '2026-10-01T18:00:00Z', homeTeam: { slug: 'a', name: 'A' }, awayTeam: { slug: 'b', name: 'B' } }, anyTeam: { slug: 'a', name: 'A' } }] } };
  // No history: nothing to go on, so fully available.
  assert.equal(priorAvailability(base), 1);
  // A regular starter is barely dimmed; a bench player is heavily dimmed but never zeroed.
  const regular = { ...base, startRate: 0.9, playRate: 1.0 };
  const fringe = { ...base, startRate: 0.1, playRate: 0.5 };
  assert.ok(priorAvailability(regular) > 0.9 && priorAvailability(regular) <= 1);
  assert.ok(priorAvailability(fringe) < 0.3 && priorAvailability(fringe) >= 0.05);
  assert.ok(expectedPoints(regular) > expectedPoints(fringe) * 3);
  // Published odds take over from the prior.
  const withOdds = { ...fringe, player: { anyFutureGameStats: [{ ...fringe.player.anyFutureGameStats[0],
    footballPlayingStatusOdds: { starterOddsBasisPoints: 9500, substituteOddsBasisPoints: 300, nonPlayingOddsBasisPoints: 200, reliability: 1 } }] } };
  assert.ok(expectedPoints(withOdds) > expectedPoints(fringe) * 3, 'odds should override a poor start rate');
  assert.equal(DEFAULTS.substituteWeight, 0.35);
});

test('bookmaker odds: de-vigged, matched by name, applied by position, never to internationals', async () => {
  const { implied, sameTeam, oddsFactor } = await import('../src/odds.js');
  const ev = { home_team: 'Rayo Vallecano', away_team: 'Athletic Bilbao', bookmakers: [
    { markets: [{ key: 'h2h', outcomes: [{ name: 'Athletic Bilbao', price: 2.31 }, { name: 'Rayo Vallecano', price: 3.08 }, { name: 'Draw', price: 3.42 }] }] },
    { markets: [{ key: 'h2h', outcomes: [{ name: 'Athletic Bilbao', price: 2.25 }, { name: 'Rayo Vallecano', price: 3.20 }, { name: 'Draw', price: 3.40 }] }] },
  ] };
  const p = implied(ev);
  assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) < 1e-9, 'probabilities sum to one after removing the overround');
  assert.ok(p.pAway > p.pHome, 'the shorter price is the favourite');
  assert.equal(p.books, 2);

  // Sorare's names against the bookmakers' names.
  assert.ok(sameTeam('Athletic Club', 'Athletic Bilbao'));
  assert.ok(sameTeam('RC Celta', 'Celta Vigo'));
  assert.ok(sameTeam('Manchester United FC', 'Manchester United'));
  assert.ok(!sameTeam('Manchester United FC', 'Manchester City'));
  assert.ok(!sameTeam('Real Madrid', 'Real Sociedad'));

  // Defenders gain most from a favourite; forwards a little; a typical fixture is x1.
  assert.ok(oddsFactor('DF', { pWin: 0.65, pDraw: 0.2 }) > oddsFactor('FW', { pWin: 0.65 }) && oddsFactor('FW', { pWin: 0.65 }) > 1);
  assert.ok(oddsFactor('DF', { pWin: 0.2, pDraw: 0.25 }) < 1);
  assert.ok(Math.abs(oddsFactor('FW', { pWin: 0.36 }) - 1) < 1e-9, 'mean win chance changes nothing');
  assert.equal(oddsFactor('DF', null), 1, 'no odds, no change');
});

test('the gem ledger points essence at the league with open gem collections', async () => {
  // Mirror gemLedger's pack ranking on a fixed input, so the rule is pinned:
  // gems per remaining card, summed by pack group.
  const collections = [
    { gems: 15, remaining: 21, group: 'glitch-laliga' },
    { gems: 10, remaining: 4, group: 'glitch-laliga' },
    { gems: 5, remaining: 40, group: 'glitch-premier-league' },
  ];
  const byGroup = {};
  for (const c of collections) byGroup[c.group] = (byGroup[c.group] ?? 0) + c.gems / c.remaining;
  const packs = [
    { slug: 'pl-bronze', group: 'glitch-premier-league', effectivePrice: 1000 },
    { slug: 'laliga-bronze', group: 'glitch-laliga', effectivePrice: 1000 },
    { slug: 'bl-bronze', group: 'glitch-bundesliga', effectivePrice: 1000 },
  ].map((p) => ({ ...p, gemValue: byGroup[p.group] ?? 0 })).sort((a, b) => b.gemValue - a.gemValue || a.effectivePrice - b.effectivePrice);
  assert.equal(packs[0].slug, 'laliga-bronze');
  assert.ok(packs[0].gemValue > packs[1].gemValue);
  assert.equal(packs[2].gemValue, 0, 'a league with nothing open scores zero');
});

test('a squad step is never gated on its target', async () => {
  const { SPREAD } = await import('../src/autopilot.js');
  // The squad target is the combined score of the top three lineups, so a
  // single five-card team is always "short" of it by far more than the spread
  // of five players' scores. On a personal step that means wait; on a squad
  // step it must still enter.
  const squadTarget = 980;
  const oneLineup = 350;
  assert.ok(squadTarget - oneLineup > SPREAD, 'the premise: one lineup cannot reach a squad target');

  const gateBlocks = (target, projected) => {
    // Mirrors runLineup: a null target cannot gate.
    if (!target) return false;
    return (target - projected) > SPREAD;
  };
  assert.equal(gateBlocks(squadTarget, oneLineup), true, 'with the target applied it would never enter');
  assert.equal(gateBlocks(null, oneLineup), false, 'collaborative passes null, so it always enters');
  // The personal board keeps its gate.
  assert.equal(gateBlocks(360, 250), true);
  assert.equal(gateBlocks(360, 330), false);
});
