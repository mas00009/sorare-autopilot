import assert from 'node:assert/strict';
import { planDrops } from '../src/dupes.js';
let n = 0;
const card = (player, tier, o = {}) => ({ slug: `c${n++}`, rarityTyped: 'common', seasonYear: 2026, cardEditionName: 'glitch_standard_base', xp: 0, sealed: false,
  activeTaskAppearances: [], anyPlayer: { slug: player, displayName: player, gameplayTier: tier }, ...o });
const cards = [
  card('a', 'ROSTER'), card('a', 'ROSTER'), card('a', 'ROSTER', { xp: 50 }),          // 3 copies: keep the levelled one
  card('b', 'IMPACT'), card('b', 'IMPACT', { cardEditionName: 'glitch_shiny' }),     // different edition: both kept
  card('c', 'STAR'), card('c', 'STAR'),                                              // 4-star: never dropped
  card('d', 'GOAT'), card('d', 'GOAT'),                                              // 5-star: never dropped
  card('e', 'DNP'), card('e', 'DNP', { activeTaskAppearances: [{}] }),               // one in a lineup: the other goes
  card('f', 'ROSTER', { seasonYear: 2025 }), card('f', 'ROSTER'),                    // different season: both kept
];
const drop = planDrops(cards);
const by = (p) => drop.filter((c) => c.anyPlayer.slug === p);
assert.equal(by('a').length, 2);
assert.ok(!by('a').some((c) => c.xp === 50), 'the levelled copy stays');
assert.equal(by('b').length, 0, 'different editions are different cards');
assert.equal(by('c').length + by('d').length, 0, '4- and 5-star are never dropped');
assert.equal(by('e').length, 1);
assert.equal(by('e')[0].activeTaskAppearances.length, 0, 'the lineup copy stays');
assert.equal(by('f').length, 0);
// Two copies of playing keepers and top players, so both boards can use them.
const more = [
  card('gk', 'ROSTER', { anyPositions: ['Goalkeeper'], anyPlayer: { slug: 'gk', gameplayTier: 'ROSTER', averageScore: 52 } }),
  card('gk', 'ROSTER', { anyPositions: ['Goalkeeper'], anyPlayer: { slug: 'gk', gameplayTier: 'ROSTER', averageScore: 52 } }),
  card('gk', 'ROSTER', { anyPositions: ['Goalkeeper'], anyPlayer: { slug: 'gk', gameplayTier: 'ROSTER', averageScore: 52 } }),
  card('bench', 'DNP', { anyPositions: ['Goalkeeper'], anyPlayer: { slug: 'bench', gameplayTier: 'DNP', averageScore: 0 } }),
  card('bench', 'DNP', { anyPositions: ['Goalkeeper'], anyPlayer: { slug: 'bench', gameplayTier: 'DNP', averageScore: 0 } }),
  card('top', 'ROSTER', { anyPositions: ['Defender'], anyPlayer: { slug: 'top', gameplayTier: 'ROSTER', averageScore: 61 } }),
  card('top', 'ROSTER', { anyPositions: ['Defender'], anyPlayer: { slug: 'top', gameplayTier: 'ROSTER', averageScore: 61 } }),
  card('three', 'IMPACT'), card('three', 'IMPACT'), card('three', 'IMPACT'),
];
const d2 = planDrops(more);
const by2 = (p) => d2.filter((c) => c.anyPlayer.slug === p).length;
assert.equal(by2('gk'), 1, 'a playing keeper keeps two of three');
assert.equal(by2('bench'), 1, 'a keeper who never plays keeps one');
assert.equal(by2('top'), 0, 'a 55+ average player keeps two');
assert.equal(by2('three'), 1, 'a 3-star keeps two of three');
console.log('dupes assertions passed');
