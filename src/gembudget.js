/**
 * Mas's NBA gem budget.
 *
 * The owner's rule of 2 Nov 2026: Mas's goal is the $100 reward (level 4) on
 * either ladder; it may spend the gems it EARNS, in NBA only. So the budget
 * starts at zero - gems already held are never spent - and grows only by
 * gems won during Mas's own passes (football or NBA). It is spent on NBA gold
 * packs, the strongest cards for an NBA lineup under the stars cap, because
 * NBA's level 4 (280) is within reach of real lineups and football's (440)
 * is not.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql } from './client.js';
import { assertNbaGemSpend } from './guardrails.js';
import { M_BUY_PACK, M_CLAIM_PACK } from './queries.js';

const FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state', 'gem-budget.json');

export async function readBudget() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return { earned: 0, spent: 0, log: [] }; }
}
async function writeBudget(b) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(b, null, 2), { mode: 0o600 });
}
export const available = (b) => Math.max(0, (b.earned ?? 0) - (b.spent ?? 0));

/** Credit gems Mas won in a pass. Kobe never credits: its gems are the owner's. */
export async function creditEarned(amount, source) {
  if (process.env.SORARE_ACCOUNT || !(amount > 0)) return null;
  const b = await readBudget();
  b.earned = (b.earned ?? 0) + amount;
  b.log = [...(b.log ?? []), { at: new Date().toISOString(), earned: amount, source }].slice(-200);
  await writeBudget(b);
  return b;
}

const Q_NBA_PACKS = `query { market { setSections(sport: NBA) { ... on CardPackGroup { slug cardPacks { slug currency effectivePrice canPurchase } } } } }`;

/** Spend the budget on NBA gold packs (50 gems each). Called from Mas's NBA pass only. */
export async function spendOnNbaPacks({ dryRun = false, sport, account } = {}) {
  const out = { bought: [], cards: [], budgetBefore: null, budgetAfter: null, reason: null };
  if (sport !== 'NBA' || account) { out.reason = 'not the Mas NBA run'; return out; }
  const b = await readBudget();
  out.budgetBefore = available(b);
  const d = await gql(Q_NBA_PACKS, {});
  const packs = (d.market?.setSections ?? []).flatMap((g) => g?.cardPacks ?? []);
  const gold = packs.find((p) => p.currency === 'COMMON_GEM' && p.canPurchase && /gold/i.test(p.slug) && /nba/i.test(p.slug));
  if (!gold) { out.reason = 'no NBA gold pack on sale'; return out; }
  while (available(b) >= gold.effectivePrice && out.bought.length < 5) {
    assertNbaGemSpend({ currency: gold.currency, amount: gold.effectivePrice, sport, account, budget: available(b), packSlug: gold.slug });
    if (dryRun) { out.bought.push({ slug: gold.slug, price: gold.effectivePrice, dryRun: true }); break; }
    const r = await gql(M_BUY_PACK, { input: { cardPackSlug: gold.slug, sport: 'NBA' } }, { mutationName: 'buyCardPack' });
    const p = r.buyCardPack;
    if (p?.errors?.length) { out.reason = `buy failed: ${p.errors.map((e) => e.message).join('; ')}`; break; }
    b.spent = (b.spent ?? 0) + gold.effectivePrice;
    b.log = [...(b.log ?? []), { at: new Date().toISOString(), spent: gold.effectivePrice, pack: gold.slug }].slice(-200);
    await writeBudget(b);
    const cards = p?.cards ?? [];
    if (p?.pack?.id && cards.length) {
      await gql(M_CLAIM_PACK, { input: { packId: p.pack.id, chosenCardSlugs: cards.map((c) => c.slug) } }, { mutationName: 'claimCardsFromPack' }).catch(() => {});
    }
    out.bought.push({ slug: gold.slug, price: gold.effectivePrice });
    out.cards.push(...cards.map((c) => `${c.anyPlayer?.displayName} (${c.anyPlayer?.gameplayTier})`));
  }
  if (!out.bought.length && !out.reason) out.reason = `${available(b)} earned gems in the budget; a gold pack is ${gold.effectivePrice}`;
  out.budgetAfter = available(b);
  return out;
}
