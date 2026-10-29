/**
 * Claim the football starter pack once each new Set opens.
 *
 * A new Set (Divination from 30 Oct 2026, 13:00 UTC) starts everyone again
 * with no cards that count, so the bot has nothing to play with until the
 * free starter pack is claimed. The pick follows the owner-approved ranking
 * of 30 Oct: FC Barcelona has the highest-scoring squad in the Set's four
 * leagues (top-11 average 63.5, 13 players at 3-star or better) and its
 * Spanish players feed the LaLiga gem collections; Lamine Yamal (84) is the
 * top-scoring star player. Football only - the NBA side is the owner's.
 *
 * Free: the mutation takes a sport, a team and a player, and no price.
 */
import { gql, readState, writeState } from './client.js';

export const STARTER_PICK = {
  favoriteTeamSlug: process.env.AUTOPILOT_STARTER_TEAM ?? 'barcelona-barcelona',
  starPlayerSlug: process.env.AUTOPILOT_STARTER_PLAYER ?? 'lamine-yamal-nasraoui-ebana',
};

const Q_SET = `query { cardSets(first: 1) { nodes { slug name startDate } } }`;
const M_CLAIM = `mutation ClaimStarter($input: claimStarterPackInput!) {
  claimStarterPack(input: $input) { errors { message } cards { slug anyPlayer { displayName } } }
}`;

export async function claimFootballStarter({ dryRun = false } = {}) {
  const set = (await gql(Q_SET, {})).cardSets?.nodes?.[0];
  if (!set) return { reason: 'no card set listed' };
  if (set.startDate && Date.now() < Date.parse(set.startDate)) return { reason: `${set.name} opens ${set.startDate}` };
  const st = await readState();
  if (st.starterClaimed?.[set.slug]) return { reason: `${set.name} starter pack already claimed` };
  if (dryRun) return { reason: `would claim the ${set.name} starter pack (${STARTER_PICK.favoriteTeamSlug}, ${STARTER_PICK.starPlayerSlug})` };
  const r = await gql(M_CLAIM, { input: { sport: 'FOOTBALL', ...STARTER_PICK } }, { mutationName: 'claimStarterPack' });
  const errs = r.claimStarterPack?.errors ?? [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join('; ');
    // Sorare says it is already done: remember that, never ask again.
    if (/already/i.test(msg)) await writeState({ starterClaimed: { ...(st.starterClaimed ?? {}), [set.slug]: 'already' } });
    return { reason: `starter pack not claimed: ${msg}` };
  }
  const cards = (r.claimStarterPack?.cards ?? []).map((c) => c.anyPlayer?.displayName ?? c.slug);
  await writeState({ starterClaimed: { ...(st.starterClaimed ?? {}), [set.slug]: new Date().toISOString() } });
  return { claimed: true, set: set.name, cards };
}
