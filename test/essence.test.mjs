import assert from 'node:assert/strict';
import { GOOD_TIERS, TIER_STARS } from '../src/essence.js';
import { assertCostAllowed, assertMutationAllowed } from '../src/guardrails.js';

// "3-star or better" must mean exactly IMPACT, STAR, GOAT.
assert.ok(GOOD_TIERS.has('IMPACT') && GOOD_TIERS.has('STAR') && GOOD_TIERS.has('GOAT'));
assert.ok(!GOOD_TIERS.has('ROSTER') && !GOOD_TIERS.has('DNP'));
assert.equal(TIER_STARS.IMPACT, 3);

// Essence may be spent. Nothing else may.
assert.doesNotThrow(() => assertCostAllowed({ currency: 'COMMON_ESSENCE', amount: 1000 }));
for (const bad of ['COMMON_GEM', 'RARE_GEM', 'SOMETHING_NEW', null]) {
  assert.throws(() => assertCostAllowed({ currency: bad, amount: 1 }), /Refusing/, `${bad} must be refused`);
}

// buyCardPack is reachable, money paths never are.
assert.doesNotThrow(() => assertMutationAllowed('buyCardPack'));
for (const m of ['prepareBuyInGameCurrencyPackWithCreditCard', 'verifyMobilePurchase', 'storeApplePurchaseToken', 'somethingNew']) {
  assert.throws(() => assertMutationAllowed(m), /Refusing/, `${m} must be refused`);
}
console.log('essence + guardrail assertions passed');
