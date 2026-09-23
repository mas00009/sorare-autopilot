/**
 * Opponent strength.
 *
 * Sorare gives `domesticLeagueRanking` for clubs and nothing whatsoever for
 * national teams, so international fixtures arrived with no notion of who was
 * being played. That matters: on an international break the whole bench is
 * national-team fixtures, and "who is playing the worst team" was invisible.
 *
 * The weights here were measured on 6,915 appearances from this account's own
 * players, not guessed:
 *
 *   International, when the player actually took the field (n=323)
 *     +1.56 points of score per 100 FIFA ranking points of advantage
 *     correlation 0.249, t=4.61, significant at 95%
 *     holdout (fit on the older half, tested on the newer): mean absolute
 *     error 14.45 -> 13.94
 *
 *   Club, same method (n=3,382)
 *     0.71% across the ENTIRE league table, correlation 0.039
 *     holdout: 13.17 -> 13.17, no improvement at all
 *
 * So the factor is applied to internationals and deliberately NOT to club
 * fixtures. A league position that moves a projection by a fraction of a point
 * is noise dressed as insight, and the last invented multiplier in this file's
 * neighbourhood (a 1.03 home advantage) was wrong too.
 *
 * It multiplies the score a player makes GIVEN that they play. Whether they
 * play at all is already carried by the availability term, which matters here:
 * a big nation facing a minnow rotates, and blanks run at 32% against 15% for
 * the minnow's own players.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'data', 'fifa-rankings.json');

/** Read once. The scheduled job must never reach the network for this. */
let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  try {
    TABLE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    TABLE = { teams: {}, aliases: {}, asOf: null };
  }
  return TABLE;
}

/** @returns {{rank:number, points:number}|null} - null means "not a national team we know". */
export function nation(name) {
  if (!name) return null;
  const t = table();
  const key = t.aliases?.[name] ?? name;
  return t.teams?.[key] ?? null;
}

export const rankingsAsOf = () => table().asOf ?? null;

export const OPPONENT_DEFAULTS = {
  /** Multiplier per 100 FIFA points of advantage. Fitted, see above. */
  weightPer100: 0.0327,
  /** Beyond this the relationship is extrapolation, not measurement. */
  clampPoints: 400,
};

/**
 * @returns {{factor:number, gap:number, mine:object, theirs:object}|null}
 *          null for club fixtures and for nations missing from the table.
 */
export function opponentEdge(teamName, opponentName, opts = OPPONENT_DEFAULTS) {
  const mine = nation(teamName);
  const theirs = nation(opponentName);
  if (!mine || !theirs) return null;              // a club game, or an unknown side
  const raw = mine.points - theirs.points;
  const gap = Math.max(-opts.clampPoints, Math.min(opts.clampPoints, raw));
  return {
    factor: 1 + (opts.weightPer100 * gap) / 100,
    gap: raw,
    mine,
    theirs,
  };
}

/** The factor alone, 1 when there is nothing measured to apply. */
export function opponentFactor(teamName, opponentName, opts = OPPONENT_DEFAULTS) {
  return opponentEdge(teamName, opponentName, opts)?.factor ?? 1;
}
