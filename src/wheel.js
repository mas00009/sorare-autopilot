/**
 * The NBA wheel: one free spin a day.
 *
 * Sorare gives a free WHEEL_TICKET every 24 hours through a daily task
 * ("Free Wheel Ticket") on the wheel. claimMarketTasks-style claiming gets the
 * ticket; this spins it and opens what it pays.
 *
 * Fails closed. A spin is sent only when all of these hold:
 *   - the wheel is live and the spin is a STANDARD one (never GOLDEN),
 *   - Sorare prices it in WHEEL_TICKET, and the guardrail agrees,
 *   - the account holds at least that many tickets.
 * Gems cannot pay for a spin here: the price is read from Sorare and vetted
 * before anything is sent.
 */
import { gql } from './client.js';
import { assertCostAllowed } from './guardrails.js';
import { M_CLAIM_TASK } from './queries.js';

const SPORT = 'NBA';
const RARITY = 'limited';

const Q_WHEEL = `
  query NbaWheel($sport: Sport!, $rarity: Rarity!) {
    market {
      activeWheelConfig(rarity: $rarity, sport: $sport) {
        slug title endDate
        cost: wheelCost(wheelType: STANDARD) { currency quantity }
      }
      myWheelTasks(sport: $sport, rarity: $rarity) { id name title aasmState }
    }
    currentUser { inGameCurrencyBalances(sport: $sport) { currency amount } }
  }
`;

const Q_NBA_BUNDLES = `
  query NbaBundles {
    currentUser {
      myWheelRewards(sport: NBA) {
        nodes { probabilisticBundle { id isOpenable opened openableAt } }
      }
    }
  }
`;

// Its own open mutation so the prizes are readable: the football one only
// names cards, and the wheel mostly pays essence and currency.
const M_OPEN = `
  mutation OpenNbaBundle($input: probabilisticBundlesOpenInput!) {
    probabilisticBundlesOpen(input: $input) {
      errors { message }
      probabilisticBundle {
        items {
          __typename
          ... on ProbabilisticBundleSlotCardItem { card { anyPlayer { displayName } } }
          ... on ProbabilisticBundleSlotCardShardItem { quantity rarity }
          ... on ProbabilisticBundleSlotInGameCurrencyItem { amount currency }
        }
      }
    }
  }
`;

const M_SPIN = `
  mutation SpinWheel($input: spinWheelInput!) {
    spinWheel(input: $input) {
      errors { message }
      reward { id opened }
    }
  }
`;

const ITEM = (i) => {
  if (i.__typename === 'ProbabilisticBundleSlotCardItem') return i.card?.anyPlayer?.displayName ?? 'a card';
  if (i.quantity != null) return `${i.quantity} ${String(i.rarity).toLowerCase()} essence`;
  if (i.amount != null) return `${i.amount} ${String(i.currency).toLowerCase().replace(/_/g, ' ')}`;
  return i.__typename.replace(/^ProbabilisticBundleSlot|Item$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
};

async function openNbaBundles(out) {
  const d = await gql(Q_NBA_BUNDLES, {});
  const ready = (d.currentUser?.myWheelRewards?.nodes ?? [])
    .map((n) => n.probabilisticBundle)
    .filter((b) => b && !b.opened && b.isOpenable !== false)
    .filter((b) => !b.openableAt || new Date(b.openableAt) <= new Date());
  for (const b of ready.slice(0, 3)) {
    const r = await gql(M_OPEN, { input: { probabilisticBundleId: b.id } },
                        { mutationName: 'probabilisticBundlesOpen' });
    const errs = r.probabilisticBundlesOpen?.errors ?? [];
    if (errs.length) { out.errors.push(errs.map((e) => e.message).join('; ')); continue; }
    out.won.push(...(r.probabilisticBundlesOpen?.probabilisticBundle?.items ?? []).map(ITEM));
  }
}

export async function spinNbaWheel({ dryRun = false } = {}) {
  const out = { claimed: false, spun: false, won: [], errors: [], reason: null };
  const read = async () => gql(Q_WHEEL, { sport: SPORT, rarity: RARITY });
  let d = await read();
  const wheel = d.market?.activeWheelConfig;
  if (!wheel) { out.reason = 'no NBA wheel running'; return out; }
  out.wheel = wheel.title;

  // 1. The free ticket.
  const daily = (d.market?.myWheelTasks ?? []).find((t) => t.name === 'DAILY_CLAIM');
  if (daily?.aasmState === 'COMPLETED') {
    if (dryRun) out.claimed = 'dry run';
    else {
      const r = await gql(M_CLAIM_TASK, { input: { taskId: daily.id } }, { mutationName: 'claimTask' });
      const errs = r.claimTask?.errors ?? [];
      if (errs.length) out.errors.push(`free ticket: ${errs.map((e) => e.message).join('; ')}`);
      else { out.claimed = true; d = await read(); }
    }
  }

  // 2. The spin, only on a ticket actually held.
  const cost = wheel.cost;
  const held = (d.currentUser?.inGameCurrencyBalances ?? []).find((b) => b.currency === cost?.currency)?.amount ?? 0;
  if (!cost || cost.currency !== 'WHEEL_TICKET') {
    out.reason = `spin priced in ${cost?.currency ?? 'unknown'} - not spinning`;
    return out;
  }
  assertCostAllowed({ currency: cost.currency, amount: cost.quantity });
  if (held < cost.quantity) {
    out.reason = daily?.aasmState === 'CLAIMED' ? 'already spun today - next free ticket in 24 hours' : 'no ticket yet';
  } else if (dryRun) {
    out.reason = 'dry run - would spin';
  } else {
    const r = await gql(M_SPIN, { input: { sport: SPORT, rarity: RARITY, wheelType: 'STANDARD' } },
                        { mutationName: 'spinWheel' });
    const errs = r.spinWheel?.errors ?? [];
    if (errs.length) out.errors.push(`spin: ${errs.map((e) => e.message).join('; ')}`);
    else out.spun = true;
  }

  // 3. Open whatever the wheel paid.
  if (!dryRun) {
    try { await openNbaBundles(out); } catch (err) { out.errors.push(`open: ${err.message}`); }
  }
  return out;
}
