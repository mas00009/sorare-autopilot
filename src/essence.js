/**
 * Essence pack opening.
 *
 * Buys essence-priced packs until a 3-star player drops, then stops.
 *
 * Three independent stops, deliberately. A bug in the tier check alone must not
 * be able to drain the essence balance:
 *   1. a 3-star (or better) card was pulled
 *   2. essence would fall below the reserve floor
 *   3. the per-run pack cap is hit
 *
 * Gems are unreachable from here: every purchase passes the pack's own
 * `currency` field through assertCostAllowed(), which only permits
 * COMMON_ESSENCE and refuses anything it does not recognise.
 */
import { gql, readState, writeState } from './client.js';
import { assertCostAllowed } from './guardrails.js';
import { Q_ESSENCE, Q_PACK, M_BUY_PACK, M_CLAIM_PACK } from './queries.js';

/**
 * Sorare's own daily reset, rather than our clock.
 *
 * The DAILY task keeps one id for a daily cycle and gets a fresh one when the
 * cycle rolls over. Gating on that id means pack buying happens exactly once
 * per Sorare day, whatever timezone the machine thinks it is in, and however
 * many times the autopilot polls in between.
 */
const Q_DAILY = `
  query Daily($sport: Sport!) {
    currentUser { dailyRunTask(sport: $sport) { id aasmState periodicity } }
  }
`;

async function dailyCycleId() {
  const d = await gql(Q_DAILY, { sport: SPORT });
  return d.currentUser?.dailyRunTask?.id ?? null;
}

const SPORT = 'FOOTBALL';

/** GameplayTier values that count as "3-star or better". */
export const GOOD_TIERS = new Set(['IMPACT', 'STAR', 'GOAT']);
export const TIER_STARS = { DNP: 0, ROSTER: 2, IMPACT: 3, STAR: 4, GOAT: 5 };

export const PACK_DEFAULTS = {
  /** Never spend essence below this. */
  essenceFloor: 4000,
  /** Hard cap on packs per cycle, whatever else happens. */
  maxPacks: 3,
};

export async function readEssence() {
  const d = await gql(Q_ESSENCE, { sport: SPORT });
  const chest = (d.currentUser?.cardShardsChests ?? []).find((c) => c.rarity === 'common');
  return { chestId: chest?.id ?? null, amount: chest?.cardShardsCount ?? 0 };
}

export async function readPack() {
  const d = await gql(Q_PACK, { sport: SPORT });
  return d.market?.recommendedCardPack ?? null;
}

/** gameplayTier lives on the player, not the card. */
const tierOf = (card) => card?.anyPlayer?.gameplayTier ?? null;
const nameOf = (card) => card?.anyPlayer?.displayName ?? card?.slug ?? '(unknown)';

function bestTier(cards = []) {
  let best = null;
  for (const c of cards) {
    if (!best || (TIER_STARS[tierOf(c)] ?? 0) > (TIER_STARS[tierOf(best)] ?? 0)) best = c;
  }
  return best;
}

/**
 * @returns a report of every pack opened and why the loop stopped.
 */
export async function openPacksUntilThreeStar({
  dryRun = false,
  essenceFloor = PACK_DEFAULTS.essenceFloor,
  maxPacks = PACK_DEFAULTS.maxPacks,
} = {}) {
  const out = { opened: [], stopped: null, essenceBefore: null, essenceAfter: null, spent: 0, found: null };

  // Buy at most once per Sorare daily cycle. Fails closed: if the cycle cannot
  // be read, nothing is bought.
  const cycle = await dailyCycleId();
  const state = await readState();
  out.cycle = cycle;

  if (!cycle) {
    out.stopped = 'could not read the daily cycle - not buying';
    out.essenceBefore = out.essenceAfter = (await readEssence()).amount;
    return out;
  }
  if (state.lastPackCycle === cycle) {
    out.stopped = state.lastThreeStarName
      ? `already done this daily cycle - found ${state.lastThreeStarName}. Next buy after the daily resets.`
      : 'already bought this daily cycle. Next buy after the daily resets.';
    out.essenceBefore = out.essenceAfter = (await readEssence()).amount;
    return out;
  }

  const start = await readEssence();
  out.essenceBefore = start.amount;
  let essence = start.amount;

  for (let i = 0; i < maxPacks; i += 1) {
    const pack = await readPack();
    if (!pack) { out.stopped = 'no pack on offer'; break; }

    // Stop 2: floor. Checked before the guardrail so the reason is specific.
    if (essence - pack.effectivePrice < essenceFloor) {
      out.stopped = `essence floor - ${essence} left, pack costs ${pack.effectivePrice}, floor is ${essenceFloor}`;
      break;
    }
    if (!pack.canPurchase) { out.stopped = 'Sorare says this pack is not purchasable'; break; }

    // The hard gate: the pack's own currency, vetted before anything is sent.
    assertCostAllowed({ currency: pack.currency, amount: pack.effectivePrice });

    if (dryRun) {
      out.opened.push({ slug: pack.slug, price: pack.effectivePrice, currency: pack.currency, dryRun: true });
      out.stopped = 'dry run - nothing bought';
      break;
    }

    const bought = await gql(
      M_BUY_PACK,
      { input: { cardPackSlug: pack.slug, sport: SPORT } },
      { mutationName: 'buyCardPack' },
    );
    const payload = bought.buyCardPack;
    if (payload?.errors?.length) {
      out.stopped = `buy failed: ${payload.errors.map((e) => e.message).join('; ')}`;
      break;
    }

    const cards = payload?.cards ?? [];
    essence -= pack.effectivePrice;
    out.spent += pack.effectivePrice;
    // Burn the cycle as soon as any essence is spent.
    if (out.spent === pack.effectivePrice) await writeState({ lastPackCycle: cycle });

    // Keep everything in the pack.
    if (payload?.pack?.id && cards.length) {
      try {
        await gql(
          M_CLAIM_PACK,
          { input: { packId: payload.pack.id, chosenCardSlugs: cards.map((c) => c.slug) } },
          { mutationName: 'claimCardsFromPack' },
        );
      } catch (err) {
        out.opened.push({ slug: pack.slug, claimError: err.message });
      }
    }

    const top = bestTier(cards);
    out.opened.push({
      slug: pack.slug,
      price: pack.effectivePrice,
      cards: cards.map((c) => ({ name: nameOf(c), tier: tierOf(c), stars: TIER_STARS[tierOf(c)] ?? 0 })),
      best: top ? { name: nameOf(top), tier: tierOf(top) } : null,
    });

    // Stop 1: got what we came for.
    if (top && GOOD_TIERS.has(tierOf(top))) {
      const tier = tierOf(top);
      out.found = { name: nameOf(top), tier, stars: TIER_STARS[tier] };
      out.stopped = `got a ${TIER_STARS[tier]}-star (${tier})`;
      await writeState({ lastPackCycle: cycle, lastThreeStarName: nameOf(top) });
      break;
    }
  }

  // Stop 3.
  if (!out.stopped) out.stopped = `pack cap reached (${maxPacks})`;

  out.essenceAfter = (await readEssence()).amount;
  return out;
}
