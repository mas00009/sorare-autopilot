import assert from 'node:assert/strict';
import { assertNbaGemSpend, assertCostAllowed } from '../src/guardrails.js';
const ok = { currency: 'COMMON_GEM', amount: 50, sport: 'NBA', account: '', budget: 60, packSlug: 'divination-nba-gold-pack' };
assert.equal(assertNbaGemSpend(ok), true);
assert.throws(() => assertNbaGemSpend({ ...ok, sport: 'FOOTBALL' }), /NBA side/);
assert.throws(() => assertNbaGemSpend({ ...ok, account: 'second' }), /main account/);
assert.throws(() => assertNbaGemSpend({ ...ok, budget: 40 }), /earned gems/);
assert.throws(() => assertNbaGemSpend({ ...ok, packSlug: 'divination-laliga-gold' }), /non-NBA/);
// Everywhere else, gems are still refused.
assert.throws(() => assertCostAllowed({ currency: 'COMMON_GEM', amount: 10 }), /Gems are off limits/);
console.log('gem budget assertions passed');
