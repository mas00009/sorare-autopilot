/**
 * Drop exact duplicate Set cards for essence.
 *
 * The owner's rules, 16 Oct 2026:
 *   - only exact duplicates: same player, rarity, season and edition. A
 *     different edition of the same player is a different card and is kept;
 *   - keep one of each - the one with the most XP;
 *   - never a 4-star or 5-star player, duplicate or not;
 *   - never a card in a lineup or sealed;
 *   - keep TWO of a playing keeper (recent average 40+) or a top player
 *     (3-star, or recent average 55+), so the personal set and the team set
 *     can both field him. With one copy, a card in one board's lineup is
 *     missing from the other's bench, and on 19 Oct the team set could not
 *     make a full five and entered nothing.
 *
 * Dropping pays the essence Sorare quotes on the card (5 / 20 / 200 by tier)
 * and charges nothing. Gem collections count players, not copies, so keeping
 * one copy keeps every collection's progress (checked on the first drop).
 */
import { gql } from './client.js';

const PROTECTED_TIERS = new Set(['STAR', 'GOAT']);   // 4-star, 5-star
const BATCH = 20;

const Q_CARDS = `query Cards($after: String) { currentUser { cards(sport: FOOTBALL, first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { slug rarityTyped seasonYear cardEditionName xp sealed anyPositions
    anyPlayer { slug displayName ... on Player { gameplayTier averageScore(type: LAST_FIFTEEN_SO5_AVERAGE_SCORE) } }
    activeTaskAppearances { __typename }
  } } } }`;

const Q_PRICES = `query Prices($slugs: [String!]) { currentUser { cards(sport: FOOTBALL, first: 100, slugs: $slugs) {
  nodes { slug signedDropCardPrice { price signedPrice } } } } }`;

const M_DROP = `mutation Drop($input: dropAndAddCardsInput!) {
  dropAndAddCards(input: $input) { errors { message } droppedCards { slug } } }`;

async function allCards() {
  const out = [];
  let after = null;
  do {
    const d = await gql(Q_CARDS, { after });
    const c = d.currentUser.cards;
    out.push(...c.nodes);
    after = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** How many copies of this card to keep. */
export function keepCount(card) {
  const p = card.anyPlayer ?? {};
  const avg = p.averageScore ?? 0;
  const keeper = /^goalkeeper$/i.test(card.anyPositions?.[0] ?? '');
  if (keeper && avg >= 40) return 2;
  if (p.gameplayTier === 'IMPACT' || avg >= 55) return 2;
  return 1;
}

/** Which cards go. Pure, so the rules can be tested without Sorare. */
export function planDrops(cards) {
  const groups = new Map();
  for (const c of cards) {
    if (c.rarityTyped !== 'common') continue;              // Set cards only
    const k = [c.anyPlayer?.slug, c.rarityTyped, c.seasonYear, c.cardEditionName].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const drop = [];
  for (const copies of groups.values()) {
    if (copies.length <= keepCount(copies[0])) continue;
    if (PROTECTED_TIERS.has(copies[0].anyPlayer?.gameplayTier)) continue;
    // Keep the most-levelled copy, and any copy that is busy.
    const busy = (c) => c.sealed || (c.activeTaskAppearances ?? []).length > 0;
    const ranked = [...copies].sort((a, b) => Number(busy(b)) - Number(busy(a)) || (b.xp ?? 0) - (a.xp ?? 0));
    for (const c of ranked.slice(keepCount(copies[0]))) if (!busy(c)) drop.push(c);
  }
  return drop;
}

export async function dropDuplicates({ dryRun = false } = {}) {
  const cards = await allCards();
  const drop = planDrops(cards);
  const out = { cards: cards.length, toDrop: drop.length, dropped: 0, essence: 0, errors: [], players: {} };
  for (const c of drop) out.players[c.anyPlayer?.displayName] = (out.players[c.anyPlayer?.displayName] ?? 0) + 1;
  for (let i = 0; i < drop.length; i += BATCH) {
    const slugs = drop.slice(i, i + BATCH).map((c) => c.slug);
    // Prices are signed and expire, so fetch them right before each batch.
    const p = await gql(Q_PRICES, { slugs });
    const priced = (p.currentUser.cards.nodes ?? []).filter((n) => n.signedDropCardPrice?.signedPrice);
    if (dryRun) { out.essence += priced.reduce((s, n) => s + n.signedDropCardPrice.price, 0); continue; }
    const r = await gql(M_DROP, { input: { droppedCards: priced.map((n) => ({ cardSlug: n.slug, signedPrice: n.signedDropCardPrice.signedPrice })) } },
      { mutationName: 'dropAndAddCards' });
    const errs = r.dropAndAddCards?.errors ?? [];
    if (errs.length) { out.errors.push(errs.map((e) => e.message).join('; ')); continue; }
    const done = new Set((r.dropAndAddCards?.droppedCards ?? []).map((d) => d.slug));
    out.dropped += done.size;
    out.essence += priced.filter((n) => done.has(n.slug)).reduce((s, n) => s + n.signedDropCardPrice.price, 0);
  }
  return out;
}
