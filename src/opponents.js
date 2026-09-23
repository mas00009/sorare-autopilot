/**
 * Opponent strength.
 *
 * Sorare gives `domesticLeagueRanking` for clubs and nothing whatsoever for
 * national teams, so international fixtures arrived with no notion of who was
 * being played. That matters: on an international break the whole bench is
 * national-team fixtures, and "who is playing the worst team" was invisible.
 *
 * Every number here was measured on this account's own history - 6,920
 * appearances, walk-forward, scored against actual results - not guessed. The
 * last invented multiplier in this codebase (a 1.03 home advantage) was worth
 * nothing, and re-testing it here on played appearances only found the same.
 *
 * What the data says, international fixtures, player took the field:
 *
 *   The effect is DEFENSIVE. It is a clean-sheet effect, not a goals effect.
 *     DF  n=75  best weight ~0.06/100pts   MAE 17.26 -> 17.02
 *     MD  n=43  best weight  0.02/100pts   MAE 12.67 -> 12.64
 *     FW  n=48  best weight  0            any factor makes it worse
 *     GK  n=12  too few to fit; given the DF weight because it is the same
 *               mechanism (goals conceded), and flagged as such
 *   DF+MD holdout (fit on the older half, tested on the newer): 14.38 -> 14.29
 *
 *   One weight for every position - the first version of this file - scored
 *   WORSE than no factor at all, because forwards cancel the defenders' gain.
 *
 *   Club fixtures, same method (n=3,382): 0.71% across the ENTIRE league
 *   table, correlation 0.039, holdout 13.17 -> 13.17. Not applied.
 *
 *   FIFA points against Elo as the measure of strength: FIFA correlates
 *   0.114 with the residual, Elo 0.091. FIFA stays; no second table needed.
 *
 *   Friendlies against competitive internationals: no difference in play
 *   rate (64% v 66%), start rate (49% v 48%) or score (46.7 v 46.4).
 *
 * It multiplies the score a player makes GIVEN that they play. Whether they
 * play at all is the availability term in expectedPoints(), which is the half
 * that matters here: a big nation facing a minnow rotates, and blanks run at
 * 32% against 15% for the minnow's own players. A start-rate prior for the
 * no-odds case was tested too: it does not pick better teams (46.1 -> 46.2
 * realised) and worsens projections, so the existing rule stands.
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
  /**
   * Multiplier per 100 FIFA points of advantage, by position. Fitted, see
   * above. DF sits at 0.04 rather than its own best of 0.06: nearly all the
   * gain, less extrapolation on 75 samples.
   */
  weightPer100: { GK: 0.04, DF: 0.04, MD: 0.02, FW: 0 },
  /** Beyond this the relationship is extrapolation, not measurement. */
  clampPoints: 400,
  /**
   * A mismatch: this far ahead on FIFA points, the fixture is treated as a
   * likely blowout for stacking purposes (see optimiser pickLineup).
   */
  mismatchPoints: 200,
};

const weightFor = (position, opts) => {
  const w = opts.weightPer100;
  if (typeof w === 'number') return w;
  return w?.[position] ?? 0;
};

/**
 * @returns {{factor:number, gap:number, mine:object, theirs:object}|null}
 *          null for club fixtures and for nations missing from the table.
 */
export function opponentEdge(teamName, opponentName, position = null, opts = OPPONENT_DEFAULTS) {
  const mine = nation(teamName);
  const theirs = nation(opponentName);
  if (!mine || !theirs) return null;              // a club game, or an unknown side
  const raw = mine.points - theirs.points;
  const gap = Math.max(-opts.clampPoints, Math.min(opts.clampPoints, raw));
  return {
    factor: 1 + (weightFor(position, opts) * gap) / 100,
    gap: raw,
    mismatch: raw >= opts.mismatchPoints,
    mine,
    theirs,
  };
}

/** The factor alone, 1 when there is nothing measured to apply. */
export function opponentFactor(teamName, opponentName, position = null, opts = OPPONENT_DEFAULTS) {
  return opponentEdge(teamName, opponentName, position, opts)?.factor ?? 1;
}
