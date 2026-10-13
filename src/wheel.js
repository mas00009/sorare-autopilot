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
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql, writeState } from './client.js';
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
    currentUser { nickname inGameCurrencyBalances(sport: $sport) { currency amount } }
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

// Every prize kind the wheel can pay, so the mail names what was won.
// The card sits on `anyCard`; asking for `card` is a 422 that used to make
// every prize come back blank.
export const PRIZE_ITEMS = `
  items {
    __typename
    ... on ProbabilisticBundleSlotCardItem { anyCard { anyPlayer { displayName } } }
    ... on ProbabilisticBundleSlotCardShardItem { quantity rarity }
    ... on ProbabilisticBundleSlotInGameCurrencyItem { amount currency }
    ... on ProbabilisticBundleSlotArenaTicketItem { quantity }
    ... on ProbabilisticBundleSlotPackItem { count }
    ... on ProbabilisticBundleSlotConversionCreditItem { percentageDiscount }
  }
`;

const M_OPEN = `
  mutation OpenNbaBundle($input: probabilisticBundlesOpenInput!) {
    probabilisticBundlesOpen(input: $input) {
      errors { message }
      probabilisticBundle { ${PRIZE_ITEMS} }
    }
  }
`;

const M_SPIN = `
  mutation SpinWheel($input: spinWheelInput!) {
    spinWheel(input: $input) {
      errors { message }
      reward { id opened ${PRIZE_ITEMS} }
    }
  }
`;

const CURRENCY = { WHEEL_TICKET: 'wheel ticket', GOLDEN_WHEEL_TICKET: 'golden wheel ticket', COMMON_GEM: 'gems' };
export const ITEM = (i) => {
  switch (i.__typename) {
    case 'ProbabilisticBundleSlotCardItem': return `card: ${i.anyCard?.anyPlayer?.displayName ?? 'unknown player'}`;
    case 'ProbabilisticBundleSlotCardShardItem': return `${i.quantity} ${String(i.rarity).toLowerCase()} essence`;
    case 'ProbabilisticBundleSlotInGameCurrencyItem': {
      const name = CURRENCY[i.currency] ?? String(i.currency).toLowerCase().replace(/_/g, ' ');
      return `${i.amount} ${name}${i.amount === 1 || name.endsWith('s') ? '' : 's'}`;
    }
    case 'ProbabilisticBundleSlotArenaTicketItem': return `${i.quantity} arena ticket${i.quantity === 1 ? '' : 's'}`;
    case 'ProbabilisticBundleSlotPackItem': return `${i.count} pack${i.count === 1 ? '' : 's'}`;
    case 'ProbabilisticBundleSlotConversionCreditItem': return `${Math.round(i.percentageDiscount * 100)}% conversion credit`;
    default: return i.__typename.replace(/^ProbabilisticBundleSlot|Item$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }
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

/**
 * One line per spin in state/reports/nba-<UTC date>.jsonl, the same day key
 * the daily mail uses. Both accounts write here, so one section of the mail
 * can show them side by side.
 */
const REPORTS = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state', 'reports');
async function journal(row) {
  const day = new Date().toISOString().slice(0, 10);
  await fs.mkdir(REPORTS, { recursive: true });
  await fs.appendFile(path.join(REPORTS, `nba-${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

export async function spinNbaWheel({ dryRun = false } = {}) {
  const out = { claimed: false, spun: false, won: [], errors: [], reason: null };
  const read = async () => gql(Q_WHEEL, { sport: SPORT, rarity: RARITY });
  let d = await read();
  const wheel = d.market?.activeWheelConfig;
  out.account = d.currentUser?.nickname ?? null;
  // Remembered in this account's own state so the mail can name an account
  // even on a day it did not spin.
  if (out.account && !dryRun) await writeState({ nickname: out.account }).catch(() => {});
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
    else {
      out.spun = true;
      // Sorare opens the prize as part of the spin, so read it from here;
      // the open step below then finds nothing, which is why it was blank.
      if (r.spinWheel?.reward?.opened) out.won.push(...(r.spinWheel.reward.items ?? []).map(ITEM));
    }
  }

  // 3. Open whatever the wheel paid.
  if (!dryRun) {
    try { await openNbaBundles(out); } catch (err) { out.errors.push(`open: ${err.message}`); }
    if (out.spun || out.won.length || out.errors.length) {
      await journal({ account: out.account, spun: out.spun, won: out.won, errors: out.errors }).catch(() => {});
    }
  }
  return out;
}
