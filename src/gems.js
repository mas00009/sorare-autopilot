/**
 * The gem ledger: every route from here to gems, and what to do about it.
 *
 * The owner's goal for this mode is gems - never spent here, banked for NBA
 * mode - with the ladder's cash steps as the long shot. Gems are scarce in Set
 * mode. An audit of every reward on both boards and all 360 seasonal tasks
 * found exactly these sources:
 *
 *   Hot Streaks L2 (360 pts)   10 gems
 *   Hot Streaks L3 (400 pts)   30 gems
 *   Hot Streaks L4 (440 pts)   $100 + 1000 essence
 *   Hot Streaks L5 (480 pts)   $1000 + 1000 essence
 *   Collect Spanish players in LaLiga   15 gems   (170/191 when written)
 *   Collect Big 3 LaLiga                10 gems   (33/37)
 *
 * Everything else pays essence, XP, craft clues or card packs. The two
 * collections are the only gem source the bot can steer: every essence pack
 * is bought from the league whose open gem collections it advances most, and
 * pulls are mostly new players (34 distinct in 35 pulls), so each LaLiga pack
 * moves both collections. The ladder gems depend on the lineup, which is the
 * rest of this codebase.
 */
import { gql } from './client.js';

const SPORT = 'FOOTBALL';

const Q_ROUTES = `
  query GemRoutes($sport: Sport!) {
    currentUser {
      balances: inGameCurrencyBalances(sport: $sport) { currency amount }
      board: setBoard(mode: CAREER, sport: $sport) {
        title
        myCurrentStep { level }
        steps {
          level state target
          rewardConfigs {
            __typename
            ... on InGameCurrencyRewardConfig { amount currency }
            ... on MonetaryRewardConfig { amount { usdCents } }
            ... on CardShardRewardConfig { quantity }
          }
        }
      }
      tasks(periodicity: SEASONAL, sport: $sport) {
        title aasmState
        ... on CardsCountTargetTask {
          progress target
          competitions { slug displayName }
          specifiedTeams { ... on TeamInterface { slug name } }
        }
        ... on TaskInterface {
          rewardConfigs { __typename ... on InGameCurrencyRewardConfig { amount currency } }
        }
      }
    }
    market {
      setSections(sport: $sport) {
        ... on CardPackGroup {
          slug title
          cardPacks { slug currency effectivePrice cardsCount canPurchase }
        }
      }
    }
  }
`;

/**
 * Which pack group serves a competition. Sorare's slugs for the pack groups
 * and for the competitions do not share a vocabulary, so this is spelled out.
 */
const GROUP_FOR_COMPETITION = {
  'laliga': 'glitch-laliga', 'primera-division': 'glitch-laliga', 'segunda-division': 'glitch-laliga',
  'premier-league': 'glitch-premier-league', 'championship': 'glitch-premier-league',
  'bundesliga': 'glitch-bundesliga', '2-bundesliga': 'glitch-bundesliga',
  'ligue-1': 'glitch-ligue-1', 'ligue-2': 'glitch-ligue-1',
};
const groupFor = (compSlug) => {
  if (!compSlug) return null;
  const k = compSlug.toLowerCase();
  for (const [needle, group] of Object.entries(GROUP_FOR_COMPETITION)) if (k.includes(needle)) return group;
  return null;
};

export async function gemLedger() {
  const d = await gql(Q_ROUTES, { sport: SPORT });
  const u = d.currentUser ?? {};
  const gems = (u.balances ?? []).find((b) => b.currency === 'COMMON_GEM')?.amount ?? null;

  // Ladder steps that pay gems or cash, from the current level up.
  const level = u.board?.myCurrentStep?.level ?? 0;
  const ladder = (u.board?.steps ?? [])
    .filter((s) => s.level >= level)
    .map((s) => {
      const gemsPaid = (s.rewardConfigs ?? []).filter((r) => r.__typename === 'InGameCurrencyRewardConfig' && r.currency === 'COMMON_GEM').reduce((n, r) => n + r.amount, 0);
      const cash = (s.rewardConfigs ?? []).find((r) => r.__typename === 'MonetaryRewardConfig')?.amount?.usdCents ?? 0;
      return { level: s.level, state: s.state, target: s.target, gems: gemsPaid, usd: cash / 100, current: s.level === level };
    })
    .filter((s) => s.gems || s.usd);

  // Collections that pay gems, with the pack group that advances them.
  const collections = (u.tasks ?? [])
    .filter((t) => t.aasmState !== 'CLAIMED' && (t.rewardConfigs ?? []).some((r) => r.currency === 'COMMON_GEM'))
    .map((t) => {
      const gemsPaid = t.rewardConfigs.filter((r) => r.currency === 'COMMON_GEM').reduce((n, r) => n + r.amount, 0);
      const comp = t.competitions?.[0];
      return {
        title: t.title, gems: gemsPaid, progress: t.progress ?? null, target: t.target ?? null,
        remaining: t.target != null ? Math.max(0, t.target - (t.progress ?? 0)) : null,
        competition: comp?.displayName ?? null, group: groupFor(comp?.slug),
        teams: (t.specifiedTeams ?? []).map((x) => x.name),
      };
    });

  // Gems per remaining card, summed by pack group: the pack that advances the
  // most gem value per card it might contain.
  const byGroup = {};
  for (const c of collections) {
    if (!c.group || !c.remaining) continue;
    byGroup[c.group] = (byGroup[c.group] ?? 0) + c.gems / c.remaining;
  }
  const groups = (d.market?.setSections ?? []).filter((g) => g?.cardPacks);
  const essencePacks = groups.flatMap((g) => g.cardPacks
    .filter((p) => p.currency === 'COMMON_ESSENCE' && p.canPurchase)
    .map((p) => ({ ...p, group: g.slug, groupTitle: g.title, gemValue: byGroup[g.slug] ?? 0 })));
  essencePacks.sort((a, b) => b.gemValue - a.gemValue || a.effectivePrice - b.effectivePrice);

  return {
    gems, level, ladder, collections,
    preferredPack: essencePacks[0] ?? null,
    packs: essencePacks,
    // What the ladder can still pay from here, if every step is passed.
    ladderGemsAhead: ladder.reduce((n, s) => n + s.gems, 0),
    ladderCashAhead: ladder.reduce((n, s) => n + s.usd, 0),
    collectionGemsOpen: collections.reduce((n, c) => n + c.gems, 0),
  };
}
