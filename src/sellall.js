/**
 * Owner's "sell everything, keep opening packs" run (26 Oct 2026).
 * Drops every Set card not in a lineup or sealed, then opens essence packs,
 * and repeats until packs stop. Gems unreachable (openPacksUntilThreeStar vets currency).
 */
import { gql } from './client.js';
import { openPacksUntilThreeStar, readEssence } from './essence.js';

const BATCH = 20;
const Q_CARDS = `query Cards($after: String) { currentUser { cards(sport: FOOTBALL, first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { slug rarityTyped sealed activeTaskAppearances { __typename } } } } }`;
const Q_PRICES = `query Prices($slugs: [String!]) { currentUser { cards(sport: FOOTBALL, first: 100, slugs: $slugs) {
  nodes { slug signedDropCardPrice { price signedPrice } } } } }`;
const M_DROP = `mutation Drop($input: dropAndAddCardsInput!) {
  dropAndAddCards(input: $input) { errors { message } droppedCards { slug } } }`;

async function droppable() {
  const out = []; let after = null, total = 0;
  do {
    const c = (await gql(Q_CARDS, { after })).currentUser.cards;
    total += c.nodes.length;
    out.push(...c.nodes.filter((n) => n.rarityTyped === 'common' && !n.sealed && !(n.activeTaskAppearances ?? []).length));
    after = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
  } while (after);
  return { total, cards: out };
}

async function sell(dry) {
  const { total, cards } = await droppable();
  const r = { total, eligible: cards.length, dropped: 0, essence: 0, errors: [] };
  for (let i = 0; i < cards.length; i += BATCH) {
    const slugs = cards.slice(i, i + BATCH).map((c) => c.slug);
    const p = await gql(Q_PRICES, { slugs });
    const priced = (p.currentUser.cards.nodes ?? []).filter((n) => n.signedDropCardPrice?.signedPrice);
    if (dry) { r.essence += priced.reduce((s, n) => s + n.signedDropCardPrice.price, 0); continue; }
    const d = await gql(M_DROP, { input: { droppedCards: priced.map((n) => ({ cardSlug: n.slug, signedPrice: n.signedDropCardPrice.signedPrice })) } }, { mutationName: 'dropAndAddCards' });
    const errs = d.dropAndAddCards?.errors ?? [];
    if (errs.length) { r.errors.push(errs.map((e) => e.message).join('; ')); continue; }
    const done = new Set((d.dropAndAddCards?.droppedCards ?? []).map((x) => x.slug));
    r.dropped += done.size;
    r.essence += priced.filter((n) => done.has(n.slug)).reduce((s, n) => s + n.signedDropCardPrice.price, 0);
  }
  return r;
}

const dry = process.argv.includes('--dry');
if (dry) { console.log(JSON.stringify(await sell(true))); console.log('essence now', (await readEssence()).amount); process.exit(0); }
for (let round = 1; round <= 200; round += 1) {
  const s = await sell(false);
  const p = await openPacksUntilThreeStar({ untilEmpty: true, maxPacks: 10 });
  console.log(`round ${round}: sold ${s.dropped}/${s.eligible} (+${s.essence} essence) errs=${s.errors.length ? s.errors.join('|') : 0}; packs ${p.opened.length}, essence ${p.essenceBefore}->${p.essenceAfter}; ${p.stopped}`);
  if (!p.opened.length || p.opened.some((o) => o.claimError) || /not purchasable|floor|no pack|could not|buy failed/.test(p.stopped ?? '')) {
    if (!(s.dropped > 0 && p.opened.length)) { console.log('STOP:', p.stopped); break; }
  }
}
const f = await sell(true); console.log('left', JSON.stringify(f), 'essence', (await readEssence()).amount);
