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
console.log('dupes assertions passed');
