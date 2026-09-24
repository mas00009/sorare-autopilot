/**
 * Every lineup this account has entered on both boards, with what it scored.
 *
 * The results people want to see are Sorare's own numbers - each lineup's
 * score against its step's target, and each card's score inside it - so this
 * reads them straight from the boards rather than from anything the bot
 * wrote down. Both the dashboard's Results tab and the daily mail draw on it.
 */
import { gql } from './client.js';

const SPORT = 'FOOTBALL';

const LINEUP = `
  myLineups {
    id
    ... on TaskLineupInterface {
      score aasmState
      taskAppearances {
        captain locked lockedAt
        score(withBonus: true)
        scoreStatus
        anyPlayer { slug displayName }
        position
        anyPlayer { anyFutureGameStats(first: 1) { anyGame { date } } }
      }
    }
  }
`;

const Q = `
  query AllLineups($sport: Sport!) {
    currentUser {
      squad(sport: $sport) { name }
      career: setBoard(mode: CAREER, sport: $sport) {
        title
        steps { level state target ... on CareerStep { ${LINEUP} } }
      }
      team: setBoard(mode: SQUAD, sport: $sport) {
        title
        steps { level state target ... on SquadStep { totalLineups totalScore ${LINEUP} } }
      }
    }
  }
`;

/** Lineup states that are finished, one way or the other. */
export const FINISHED = new Set(['SUCCESSFUL', 'CANCELLED', 'FAILED', 'EXPIRED']);

export async function allLineups() {
  const d = await gql(Q, { sport: SPORT });
  const u = d.currentUser ?? {};
  const out = [];
  const add = (surface, board, collaborative) => {
    for (const s of board?.steps ?? []) {
      for (const l of s.myLineups ?? []) {
        const players = (l.taskAppearances ?? []).map((a) => ({
          name: a.anyPlayer?.displayName ?? a.anyPlayer?.slug, slug: a.anyPlayer?.slug,
          position: a.position ?? null, captain: !!a.captain,
          score: a.score ?? null, status: a.scoreStatus ?? null,
          kickoff: a.anyPlayer?.anyFutureGameStats?.[0]?.anyGame?.date ?? null,
        }));
        out.push({
          surface, level: s.level, target: s.target, stepState: s.state, collaborative,
          squadLineups: s.totalLineups ?? null, squadScore: s.totalScore ?? null,
          lineupId: l.id, state: l.aasmState, score: l.score ?? 0,
          finished: FINISHED.has(l.aasmState),
          // On the personal board the step's target is this lineup's target. On
          // the squad board the lineup contributes to a combined score, so its
          // own "cleared" is the squad's.
          cleared: collaborative
            ? (s.totalScore != null && s.totalScore >= s.target)
            : (l.aasmState === 'SUCCESSFUL'),
          players,
          scored: players.filter((p) => p.status === 'FINAL' || (p.score ?? 0) > 0).length,
        });
      }
    }
  };
  add('my set', u.career, false);
  add(`team set (${u.squad?.name ?? 'squad'})`, u.team, true);
  // Newest first: higher level first, then live before finished.
  out.sort((a, b) => b.level - a.level || (a.finished === b.finished ? 0 : a.finished ? 1 : -1));
  return out;
}
