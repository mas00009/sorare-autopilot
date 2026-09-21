/**
 * Hard spend limits.
 *
 * The rule from the account owner is absolute: never spend gems, ever.
 * Essence and other soft currencies are fine. Real money is never in scope.
 *
 * This is enforced structurally rather than by convention - every mutation goes
 * through assertMutationAllowed(), and anything that could debit gems or money
 * is refused by name before it is ever sent. Adding a new mutation to the app
 * without listing it here fails closed.
 */

/** Currencies the autopilot may spend. Anything not listed is refused. */
export const ALLOWED_CURRENCIES = new Set([
  'COMMON_ESSENCE',
]);

/** Currencies that must never be debited. */
export const FORBIDDEN_CURRENCIES = new Set([
  'COMMON_GEM',
  // Any future *_GEM currency is caught by the pattern check below too.
]);

const GEM_PATTERN = /GEM/i;

/** Mutations that can debit gems or real money. Never callable. */
export const BLOCKED_MUTATIONS = new Set([
  'prepareBuyInGameCurrencyPackWithCreditCard',
  'verifyInGameCurrencyPackMobilePurchase',
  'verifyMobilePurchase',
  'storeApplePurchaseToken',
  'cancelMobilePurchase',
  'claimDeliverableItemOrder',
]);

/** Mutations the autopilot is allowed to call unattended. */
export const ALLOWED_MUTATIONS = new Set([
  // Lineups
  'upsertStepLineup',
  'upsertTaskLineup',
  'upsertTaskPreparedLineup',
  'swapTaskAppearances',
  'upsertTaskAppearances',
  'deleteTaskLineup',
  // Restarting a failed ladder. Free - restartTasksTrackInput carries no price.
  'restartTasksTrack',
  // Claiming things already earned - never costs anything
  'claimTask',
  'claimStep',          // deprecated server-side; kept so the error is legible
  'acknowledgeStep',    // the replacement - returns the rewards it granted
  'claimReward',
  'claimRewards',
  'claimAnyReward',
  'claimCardsFromPack',
  'claimAllSetRaffleTasks',
  // One-off setup: create this app's own OAuth credentials. Costs nothing.
  'createOAuthApplication',
  // Packs. buyCardPack is reachable ONLY after assertCostAllowed() has vetted
  // the pack's own `currency` field - COMMON_ESSENCE passes, COMMON_GEM never does.
  'buyCardPack',
  // Opening a bundle you already hold. ProbabilisticBundle carries no price
  // field - any cost was paid when it was acquired, so opening is free. This is
  // the daily pack.
  'probabilisticBundlesOpen',
  // Free daily pack pull flow
  'pullCards',
  'confirmCardPull',
  'pickPulledCard',
  'rejectCardPull',
]);

export class GuardrailError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GuardrailError';
    this.detail = detail;
  }
}

function truthy(v) {
  return String(v).toLowerCase() === 'true';
}

/**
 * Called before every mutation. Throws rather than returning false, so a
 * caller that forgets to check the result still cannot spend.
 */
export function assertMutationAllowed(name, { env = process.env } = {}) {
  if (BLOCKED_MUTATIONS.has(name)) {
    throw new GuardrailError(
      `Refusing to call "${name}": it can debit gems or real money.`,
      { mutation: name, reason: 'blocked-by-name' },
    );
  }
  if (!ALLOWED_MUTATIONS.has(name)) {
    throw new GuardrailError(
      `Refusing to call "${name}": not on the allow-list. ` +
      `Add it to ALLOWED_MUTATIONS in guardrails.js only after checking what it costs.`,
      { mutation: name, reason: 'not-allow-listed' },
    );
  }
  if (truthy(env.ALLOW_MONEY_SPEND)) {
    throw new GuardrailError(
      'ALLOW_MONEY_SPEND is set. This app has no money-spending path by design; ' +
      'unset it rather than adding one.',
      { reason: 'money-spend-flag-set' },
    );
  }
  return true;
}

/**
 * Called before entering anything with a price attached.
 * `cost` is { currency: InGameCurrency, amount: number }.
 */
export function assertCostAllowed(cost, { env = process.env } = {}) {
  if (!cost) return true;
  const { currency, amount } = cost;

  if (currency == null) {
    throw new GuardrailError(
      'Refusing an entry with an unidentified cost currency. Fail closed.',
      { cost, reason: 'unknown-currency' },
    );
  }
  if (FORBIDDEN_CURRENCIES.has(currency) || GEM_PATTERN.test(currency)) {
    if (!truthy(env.ALLOW_GEM_SPEND)) {
      throw new GuardrailError(
        `Refusing to spend ${amount} ${currency}. Gems are off limits.`,
        { cost, reason: 'gem-spend' },
      );
    }
    // Even with the override set, refuse. The override exists so that setting it
    // by accident does not silently unlock gem spending.
    throw new GuardrailError(
      `ALLOW_GEM_SPEND is set, but gem spending is disabled at the code level. ` +
      `If you genuinely want this, remove the currency from FORBIDDEN_CURRENCIES ` +
      `deliberately - do not rely on an env var.`,
      { cost, reason: 'gem-spend-hard-block' },
    );
  }
  if (!ALLOWED_CURRENCIES.has(currency)) {
    throw new GuardrailError(
      `Refusing to spend ${amount} ${currency}: not an approved currency. ` +
      `Only ${[...ALLOWED_CURRENCIES].join(', ')} may be spent.`,
      { cost, reason: 'currency-not-approved' },
    );
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new GuardrailError('Refusing an entry with a non-numeric cost.', { cost });
  }
  return true;
}

/** Summarise what the guardrails blocked, for the morning report. */
export function describeSkip(err) {
  if (!(err instanceof GuardrailError)) return null;
  return { skipped: true, reason: err.detail?.reason ?? 'guardrail', message: err.message };
}
