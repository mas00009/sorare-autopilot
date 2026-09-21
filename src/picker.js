/**
 * Decisive Player Picker.
 *
 * Finding the task at all is the hard part, so the route is written down here.
 * The daily checklist item "Play the Decisive Picker" is a plain `Task` of name
 * UPSERT_TASK_APPEARANCES. It carries no pickable data - it is only a progress
 * counter that ticks when the real picker is played. The real picker is a
 * separate `DecisivePlayerPickerTask`, and it surfaces only in
 * `currentUser.featuredTasks` and `currentUser.setPlayTasks`. It is absent from
 * `tasks(periodicity:)` at every periodicity, which is why it stayed hidden.
 *
 * Every pickable field is marked "cannot be nested within a list" in the
 * schema, so it cannot be read from that list. It has to be re-fetched one task
 * at a time through `currentUser.task(id:)`, and that argument wants the BARE
 * uuid - passing the full "Tasks::Task:<uuid>" id fails with the misleading
 * "Tasks::TaskConfig(id=) not found".
 */
import { gql } from './client.js';
import { TIER_STARS } from './essence.js';

const SPORT = 'FOOTBALL';

/** `currentUser.task(id:)` wants the bare uuid, not the prefixed global id. */
const bare = (id) => String(id).replace(/^Tasks::Task:/, '');

const Q_FIND = `
  query FindPickers($sport: Sport!) {
    currentUser {
      featuredTasks(sport: $sport) { __typename id title aasmState }
      setPlayTasks(sport: $sport, first: 30) { __typename id title aasmState }
    }
  }
`;

const Q_TASK = `
  query Picker($id: ID!) {
    currentUser {
      task(id: $id) {
        ... on DecisivePlayerPickerTask {
          id title aasmState mode expired maxAppearancesCount
          taskAppearances { id status }
          pickableGames(first: 25) {
            nodes {
              game {
                ... on Game {
                  id date
                  competition { ... on Competition { name } }
                  homeTeam { ... on TeamInterface { name } }
                  awayTeam { ... on TeamInterface { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const Q_GAME = `
  query PickerGame($id: ID!, $gameId: ID!) {
    currentUser {
      task(id: $id) {
        ... on DecisivePlayerPickerTask {
          pickableCards(gameId: $gameId, first: 50) {
            totalCount
            nodes { ... on Card { slug anyPlayer { slug displayName gameplayTier } } }
          }
          pickableTeams(gameId: $gameId) {
            team { ... on TeamInterface { name } }
            pickablePlayers {
              slug
              averageStat
              projectedStat(gameId: $gameId)
              player { ... on Player { displayName position } }
            }
          }
        }
      }
    }
  }
`;

const M_UPSERT = `
  mutation Pick($input: upsertTaskAppearancesInput!) {
    upsertTaskAppearances(input: $input) {
      errors { message }
      task { id aasmState ... on DecisivePlayerPickerTask { taskAppearances { id status } } }
    }
  }
`;

const LIVE = new Set(['READY', 'IN_PROGRESS']);

/** Every live picker that actually has games to pick from. */
export async function findPickerTasks() {
  const d = await gql(Q_FIND, { sport: SPORT });
  const u = d.currentUser ?? {};
  const candidates = [...(u.featuredTasks ?? []), ...(u.setPlayTasks ?? [])]
    .filter((t) => t.__typename === 'DecisivePlayerPickerTask' && LIVE.has(t.aasmState));

  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.id)) continue;                // listed in both collections
    seen.add(c.id);
    const r = await gql(Q_TASK, { id: bare(c.id) });
    const t = r.currentUser?.task;
    if (!t || t.expired) continue;
    const games = (t.pickableGames?.nodes ?? []).map((n) => n.game).filter(Boolean);
    if (!games.length) continue;                 // a dead picker, nothing to play
    out.push({ ...t, games });
  }
  return out;
}

/**
 * Sorare's own projection first, its own recent average second. Tier is only a
 * tiebreak - a 5-star who is not expected to play is worth less than a 3-star
 * who is.
 */
function scoreOf(card, stats) {
  const s = stats.get(card.anyPlayer?.slug) ?? {};
  const stars = TIER_STARS[card.anyPlayer?.gameplayTier] ?? 0;
  const base = s.projectedStat ?? s.averageStat ?? null;
  return {
    score: base != null ? base * 10 + stars : stars,
    basis: s.projectedStat != null ? 'projected' : s.averageStat != null ? 'average' : 'tier only',
    value: base,
    stars,
  };
}

/** Ranks every eligible card across every pickable game of one task. */
export async function rankCandidates(task) {
  const now = Date.now();
  const rows = [];
  for (const g of task.games) {
    if (new Date(g.date).getTime() <= now) continue;      // already kicked off
    const gameId = String(g.id).replace(/^Game:/, '');
    const r = await gql(Q_GAME, { id: bare(task.id), gameId });
    const t = r.currentUser?.task ?? {};
    const stats = new Map();
    for (const tm of t.pickableTeams ?? []) {
      for (const p of tm.pickablePlayers ?? []) {
        stats.set(p.slug, { averageStat: p.averageStat, projectedStat: p.projectedStat });
      }
    }
    for (const c of t.pickableCards?.nodes ?? []) {
      const s = scoreOf(c, stats);
      rows.push({
        cardSlug: c.slug,
        gameId,
        player: c.anyPlayer?.displayName ?? c.slug,
        fixture: `${g.homeTeam?.name ?? '?'} v ${g.awayTeam?.name ?? '?'}`,
        competition: g.competition?.name ?? null,
        kickoff: g.date,
        ...s,
      });
    }
  }
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * Plays one picker.
 *
 * Owning an eligible card is the binding constraint: the slate is a handful of
 * games and the picks have to come from those squads, so on plenty of days the
 * honest answer is that there is nothing to pick. That is reported, not
 * treated as an error.
 */
export async function playPicker(task, { dryRun = false } = {}) {
  const already = (task.taskAppearances ?? []).length;
  const slots = Math.max(0, (task.maxAppearancesCount ?? 1) - already);
  const out = { task: task.title, id: task.id, slots, picks: [], errors: [] };
  if (!slots) { out.reason = 'already played'; return out; }

  const ranked = await rankCandidates(task);
  out.considered = ranked.length;
  if (!ranked.length) {
    out.reason = `no eligible card in ${task.games.length} pickable game(s)`;
    return out;
  }

  // One card per player, spread across games, best first.
  const picks = [];
  const seen = new Set();
  for (const r of ranked) {
    if (picks.length >= slots) break;
    if (seen.has(r.player)) continue;
    seen.add(r.player);
    picks.push(r);
  }
  out.picks = picks;

  if (dryRun) { out.dryRun = true; return out; }

  const appearances = picks.map((p, i) => ({ index: already + i, cardSlug: p.cardSlug, gameId: p.gameId }));
  try {
    const r = await gql(M_UPSERT, { input: { taskId: task.id, taskAppearances: appearances } },
                        { mutationName: 'upsertTaskAppearances' });
    const errs = r.upsertTaskAppearances?.errors ?? [];
    if (errs.length) out.errors.push(errs.map((e) => e.message).join('; '));
    else out.submitted = (r.upsertTaskAppearances?.task?.taskAppearances ?? []).length;
  } catch (err) { out.errors.push(err.message); }
  return out;
}

export async function runPickers({ dryRun = false } = {}) {
  const out = { played: [], errors: [] };
  let tasks;
  try { tasks = await findPickerTasks(); }
  catch (err) { out.errors.push(err.message); return out; }

  out.found = tasks.length;
  if (!tasks.length) { out.reason = 'no live picker with pickable games'; return out; }
  for (const t of tasks) {
    try { out.played.push(await playPicker(t, { dryRun })); }
    catch (err) { out.errors.push(`${t.title}: ${err.message}`); }
  }
  return out;
}
