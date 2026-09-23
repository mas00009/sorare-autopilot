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
