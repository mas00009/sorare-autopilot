/**
 * Lineup selection.
 *
 * Expected points for a card =
 *   L15 average score  x  (1 + card bonus)  x  availability factor
 *
 * The availability factor is the whole point of this file. A 72-average winger
 * who is 20% to start is worth less than a 55-average defender who is nailed on,
 * and that is exactly the judgement that gets missed when lineups are set the
 * night before and left alone.
 */

import { opponentEdge, OPPONENT_DEFAULTS } from './opponents.js';
import { oddsFactor, ODDS_DEFAULTS } from './odds.js';

export const DEFAULTS = {
  /** Reject anyone below this starter probability, in basis points. */
  minStarterBp: 6000,
  /** A substitute appearance is worth roughly this fraction of a start. */
  substituteWeight: 0.35,
  /**
   * Fitted on 480 walk-forward samples (see `npm run backtest`), not guessed.
   * Recent form and the longer record turned out to deserve equal weight.
   */
  formWeight: 0.5,
  /**
   * 1.0 - no home advantage.
   *
   * The 1.03 here before was invented. Fitting against real history put the
   * optimum at exactly 1.00, so for these players in these competitions a home
   * fixture predicts nothing extra. Raising it again needs evidence, not a hunch.
   */
  homeAdvantage: 1.0,
  /** Most cards allowed from any single real-world match, to limit correlation. */
  maxPerGame: 2,
  /** Allow a third defensive card from a side facing a minnow. See pickLineup. */
  stackMismatch: false,
  /** Slot requirements. Total must equal `size`. */
  size: 5,
  require: { GK: 1, DF: 1, MD: 1, FW: 1 },
  /**
   * The fifth slot. Sorare's own So5AppearancesRule names it "extra" and lists
   * Defender, Midfielder, Forward - a second keeper is not a legal lineup, and
   * the flex fill used to be free to pick one.
   */
  flexPositions: ['DF', 'MD', 'FW'],
  /**
   * What the armband adds to the captain's own bonus multiplier, so it pays on
   * the raw score rather than the already-bonused one. 0.5 is Sorare's own
   * engineConfiguration.captain on both boards, and four finished lineups agree:
   * a 1.03 card captained scored on 1.53, a 1.02 on 1.52.
   */
  captainBonus: 0.5,
  /**
   * Opponent strength, for international fixtures only. See opponents.js: the
   * effect is real and holdout-validated for internationals, and measured at
   * nothing for club games, so club league position is deliberately ignored.
   */
  opponent: OPPONENT_DEFAULTS,
  /**
   * Bookmaker odds for club fixtures. See odds.js: measured on 3,567 club
   * appearances against real closing odds; a small, real effect on defenders
   * and forwards. Never applied to the same card as the FIFA factor.
   */
  odds: ODDS_DEFAULTS,
};

const POS = { Goalkeeper: 'GK', Defender: 'DF', Midfielder: 'MD', Forward: 'FW' };

export function normalisePosition(p) {
  if (!p) return null;
  const up = String(p).toUpperCase();
  if (['GK', 'DF', 'MD', 'FW'].includes(up)) return up;
  return POS[p] ?? up.slice(0, 2);
}

/**
 * Sorare returns `bonus` as a multiplier (1.01 = +1%), not an additive fraction.
 * Older payloads used the additive form, so accept both rather than silently
 * doubling every score.
 */
export function bonusMultiplier(bonus) {
  if (bonus == null) return 1;
  return bonus >= 1 ? bonus : 1 + bonus;
}

function odds(node) {
  const stats = node.player?.anyFutureGameStats?.[0];
  return stats?.footballPlayingStatusOdds ?? null;
}

/** Home/away and the opponent, from the player's next fixture. */
function fixture(node) {
  const stats = node.player?.anyFutureGameStats?.[0];
  const game = stats?.anyGame;
  if (!game) return null;
  const home = game.homeTeam?.slug && game.homeTeam.slug === stats?.anyTeam?.slug;
  const us = home ? game.homeTeam : game.awayTeam;
  const them = home ? game.awayTeam : game.homeTeam;
  return {
    code: us?.code ?? null,
    opponentCode: them?.code ?? null,
    rank: us?.domesticLeagueRanking ?? null,
    opponentRank: them?.domesticLeagueRanking ?? null,
    gameId: game.id,
    date: game.date,
    competition: game.competition?.name ?? null,
    team: stats?.anyTeam?.name ?? null,
    opponent: (home ? game.awayTeam?.name : game.homeTeam?.name) ?? null,
    home: !!home,
  };
}

/** Why a card cannot be used. Returns null when it is usable. */
export function blockReason(node, opts = DEFAULTS) {
  const injuries = (node.player?.activeInjuries ?? []).filter((i) => i.active);
  if (injuries.length) {
    const i = injuries[0];
    return `injured (${i.kind ?? 'unspecified'}${i.expectedEndDate ? `, back ~${i.expectedEndDate.slice(0, 10)}` : ''})`;
  }
  if ((node.activeSuspensions ?? []).length) return 'suspended';

  const stats = node.player?.anyFutureGameStats?.[0];
  if (!stats?.anyGame) return 'no fixture in window';

  if (node.lockedAt && new Date(node.lockedAt) <= new Date()) return 'locked';

  // Starter odds appear only as kickoff approaches. Treating "not published yet"
  // as a rejection would empty the bench days out, so it is not a block - the
  // later passes re-check and swap once real odds land.
  // A last-five average of zero means no minutes in their last five games.
  // With no starter odds published this is the strongest available signal that
  // someone is a reserve, and it is exactly how a backup keeper with a flattering
  // career average sneaks into a lineup.
  if (!odds(node) && (node.formL5 ?? null) === 0 && (node.averageScore ?? 0) > 0) {
    return 'no minutes in last 5 games';
  }

  const o = odds(node);
  if (o && o.starterOddsBasisPoints < opts.minStarterBp) {
    return `only ${(o.starterOddsBasisPoints / 100).toFixed(0)}% to start`;
  }
  return null;
}

/** True when we are picking without published starter odds. */
export function oddsUnknown(node) {
  return !odds(node);
}

/**
 * Availability from the player's own last ten games, for fixtures whose odds
 * are not out yet. A bench appearance is worth the substitute weight, the
 * same as it is in the odds-based term. Floored so a regular who missed a
 * few games is dimmed, not deleted.
 */
export function priorAvailability(node, opts = DEFAULTS) {
  if (node.startRate == null) return 1;
  const start = node.startRate;
  const bench = Math.max(0, (node.playRate ?? start) - start);
  return Math.max(0.05, start + opts.substituteWeight * bench);
}

export function expectedPoints(node, opts = DEFAULTS) {
  const l15 = node.averageScore ?? 0;
  const l5 = node.formL5;
  // Blend the long record with recent form, so a player in form is preferred to
  // one coasting on an old average - and vice versa.
  const avg = l5 == null || l5 === 0 ? l15 : l15 * (1 - opts.formWeight) + l5 * opts.formWeight;
  const bonus = bonusMultiplier(node.bonus);
  const fx = fixture(node);
  const venue = fx?.home ? opts.homeAdvantage : 1;
  const o = odds(node);
  // Sorare's odds when published. Before that, the player's own recent start
  // rate stands in - measured to lift lineups clearing 300 from 20% to 33%
  // over 44 replayed rounds. With neither, assume available rather than score
  // everyone to zero.
  const availability = o
    ? o.starterOddsBasisPoints / 10000 + opts.substituteWeight * (o.substituteOddsBasisPoints / 10000)
    : priorAvailability(node, opts);
  // How well they do GIVEN they play. Whether they play is the availability
  // term above, which is the half that matters when a big nation rotates
  // against a minnow.
  const edge = opts.opponent === false
    ? null
    : opponentEdge(fx?.team, fx?.opponent, normalisePosition(node.position), opts.opponent ?? OPPONENT_DEFAULTS);
  const market = opts.odds === false ? 1 : oddsFactor(normalisePosition(node.position), node.matchOdds ?? null, opts.odds ?? ODDS_DEFAULTS);
  return avg * bonus * availability * venue * (edge?.factor ?? 1) * market;
}

/** The ranking edge for a bench node, or null when it is a club fixture. */
const oppEdge = (node) => {
  const fx = fixture(node);
  return opponentEdge(fx?.team, fx?.opponent, normalisePosition(node.position));
};

export function describe(node, opts = DEFAULTS) {
  const o = odds(node);
  const stats = node.player?.anyFutureGameStats?.[0];
  const fx = fixture(node);
  return {
    id: node.id,
    player: node.player?.displayName ?? node.player?.slug,
    slug: node.player?.slug,
    position: normalisePosition(node.position),
    average: node.averageScore,
    bonus: node.bonus,
    starterPct: o ? o.starterOddsBasisPoints / 100 : null,
    startRate: node.startRate ?? null,
    oddsKnown: !!o,
    onGameSheet: stats?.onGameSheet ?? null,
    reliability: o?.reliability ?? null,
    formL5: node.formL5 ?? null,
    picture: node.pictureUrl ?? null,
    rarity: node.rarity ?? null,
    gameId: stats?.anyGame?.id ?? null,
    kickoff: stats?.anyGame?.date ?? null,
    team: fx?.team ?? null,
    opponent: fx?.opponent ?? null,
    opponentCode: fx?.opponentCode ?? null,
    code: fx?.code ?? null,
    rank: fx?.rank ?? null,
    opponentRank: fx?.opponentRank ?? null,
    home: fx?.home ?? null,
    competition: fx?.competition ?? null,
    intl: !!oppEdge(node),
    oppRank: oppEdge(node)?.theirs?.rank ?? null,
    ownRank: oppEdge(node)?.mine?.rank ?? null,
    oppFactor: oppEdge(node) ? Number(oppEdge(node).factor.toFixed(3)) : null,
    mismatch: !!oppEdge(node)?.mismatch,
    // Bookmaker view of the fixture, club games only. The dashboard shows it.
    pWin: node.matchOdds?.pWin != null ? Number(node.matchOdds.pWin.toFixed(3)) : null,
    pLose: node.matchOdds?.pLose != null ? Number(node.matchOdds.pLose.toFixed(3)) : null,
    oddsBooks: node.matchOdds?.books ?? null,
    marketFactor: node.matchOdds ? Number(oddsFactor(normalisePosition(node.position), node.matchOdds, opts.odds ?? ODDS_DEFAULTS).toFixed(3)) : null,
    lockedAt: node.lockedAt ?? null,
    expected: Number(expectedPoints(node, opts).toFixed(2)),
    blocked: blockReason(node, opts),
  };
}

/**
 * Greedy fill of required slots by expected points, then best remaining for the
 * flex slots, respecting the per-game cap. With a bench of a few hundred and a
 * lineup of five this is optimal in practice and finishes instantly; if the
 * formation ever grows, swap in a proper assignment solver.
 */
export function pickLineup(benchNodes, options = {}) {
  const opts = { ...DEFAULTS, ...options, require: { ...DEFAULTS.require, ...(options.require ?? {}) } };

  const all = benchNodes.map((n) => describe(n, opts));
  const usable = all
    .filter((c) => !c.blocked && c.expected > 0)
    .sort((a, b) => b.expected - a.expected);

  const chosen = [];
  const perGame = new Map();

  // Two from any one match, to cap how much one game can sink the lineup -
  // team-mates' scores move together (residual correlation 0.23-0.28).
  //
  // The exception is a mismatch. When a side is far ahead on FIFA points the
  // game is a likely clean sheet, and it is the defenders and midfielders who
  // cash that in, so a third from THAT team is allowed for those positions.
  // Correlation is the point: under a threshold target, when the projection is
  // short, team-mates rising together is how the target gets cleared. The
  // caller (pickAcrossWindow) only takes the stacked lineup when the unstacked
  // one would not clear, so a lineup that already clears keeps the lower risk.
  // The data behind the mismatch rule is thin - one match in the history had
  // three of this account's players facing a minnow - so it is reasoned from
  // the clean-sheet finding rather than measured on its own.
  const STACK_POS = new Set(['GK', 'DF', 'MD']);
  const capFor = (c) => (opts.stackMismatch && c.mismatch && STACK_POS.has(c.position)
    ? opts.maxPerGame + 1 : opts.maxPerGame);
  const canTake = (c) => {
    if (chosen.some((x) => x.id === c.id)) return false;
    if (chosen.some((x) => x.slug === c.slug)) return false; // no duplicate players
    const n = perGame.get(c.gameId) ?? 0;
    return n < capFor(c);
  };
  const take = (c) => {
    chosen.push(c);
    perGame.set(c.gameId, (perGame.get(c.gameId) ?? 0) + 1);
  };

  for (const [pos, count] of Object.entries(opts.require)) {
    let filled = 0;
    for (const c of usable) {
      if (filled >= count) break;
      if (c.position !== pos) continue;
      if (!canTake(c)) continue;
      take(c);
      filled += 1;
    }
    if (filled < count) {
      return {
        ok: false,
        reason: `Could not fill ${count}x ${pos} - only ${filled} usable.`,
        chosen,
        pool: all,
      };
    }
  }

  for (const c of usable) {
    if (chosen.length >= opts.size) break;
    if (opts.flexPositions && !opts.flexPositions.includes(c.position)) continue;
    if (!canTake(c)) continue;
    take(c);
  }

  if (chosen.length < opts.size) {
    return { ok: false, reason: `Only ${chosen.length}/${opts.size} slots fillable.`, chosen, pool: all };
  }

  chosen.sort((a, b) => b.expected - a.expected);
  // The armband pays a share of the RAW score, so what it is worth is
  // expected/bonus, not expected. A high-bonus card can out-rank a bigger
  // scorer on expected points and still be the weaker captain.
  const uplift = (c) => (c.expected / bonusMultiplier(c.bonus)) * opts.captainBonus;
  // Keepers score steadily but rarely produce the big hauls the armband is
  // worth spending on, so captain an outfielder unless there is nobody else.
  const eligible = chosen.filter((c) => c.position !== 'GK');
  const captain = (eligible.length ? eligible : chosen)
    .reduce((a, b) => (uplift(b) > uplift(a) ? b : a));
  const captainPoints = Number(uplift(captain).toFixed(2));
  const projected = chosen.reduce((s, c) => s + c.expected, 0) + captainPoints;

  return {
    ok: true,
    chosen,
    captain,
    captainPoints,
    projected: Number(projected.toFixed(2)),
    excluded: all.filter((c) => c.blocked),
    pool: all,
  };
}

/**
 * Build the AppearanceInput[] that upsertStepLineup expects.
 *
 * The index is the SLOT, not a ranking. Sorare's So5AppearancesRule orders them
 * goalkeeper, defender, midfielder, forward, extra, and validates each one
 * against that slot's positions - submitting the five sorted by projection gets
 * "Appearance goalkeeper should be one of Goalkeeper". So the lineup is laid
 * out into its slots first, best card into each, and whoever is left takes the
 * extra.
 */
export const SLOT_ORDER = ['GK', 'DF', 'MD', 'FW'];

export function orderForSlots(chosen, slots = SLOT_ORDER) {
  const pool = [...chosen];
  const out = [];
  for (const pos of slots) {
    const i = pool.findIndex((c) => c.position === pos);
    if (i === -1) continue;                       // formation without this slot
    out.push(pool.splice(i, 1)[0]);
  }
  return [...out, ...pool];                       // the extra slot takes the rest
}

export function toAppearances(picked) {
  return orderForSlots(picked.chosen).map((c, i) => ({
    index: i,
    composeTeamBenchObjectId: c.id,
    captain: c.id === picked.captain.id,
  }));
}

/** What changed between the live lineup and a fresh pick. */
export function diffLineup(currentAppearances = [], picked) {
  const now = new Set((currentAppearances ?? []).map((a) => a.anyPlayer?.slug).filter(Boolean));
  const next = new Set(picked.chosen.map((c) => c.slug));
  return {
    in: [...next].filter((s) => !now.has(s)),
    out: [...now].filter((s) => !next.has(s)),
    unchanged: [...next].filter((s) => now.has(s)),
  };
}


/**
 * Choose across the whole scoring window, not just the earliest matchday.
 *
 * The lineup locks at the kickoff of the EARLIEST player in it. So including
 * one player who plays on day one locks the other four on day one too, and
 * their team news - injuries, rotation, confirmed XIs - arrives after it is
 * too late to act on. A later lock is worth real points even when the raw
 * projection is slightly lower.
 *
 * So: build a lineup for each possible lock day, then prefer the latest lock
 * among those that clear the target. If none clear it, return the best one and
 * say so, because entering a lineup that cannot reach the target only burns a
 * heart.
 */
export function pickAcrossWindow(benchNodes, { target = null, tolerance = 0.03, ...options } = {}) {
  const days = [...new Set(
    benchNodes
      .map((n) => n.player?.anyFutureGameStats?.[0]?.anyGame?.date)
      .filter(Boolean)
      .map((d) => d.slice(0, 10)),
  )].sort();

  const attempts = [];
  for (const day of days) {
    const pool = benchNodes.filter((n) => {
      const d = n.player?.anyFutureGameStats?.[0]?.anyGame?.date;
      return d && d.slice(0, 10) >= day;
    });
    // Plain first. Only when it falls short is a stacked lineup - a third
    // defender or midfielder from a side facing a minnow - considered, and
    // only kept when it projects higher: short of the target, team-mates
    // moving together is help; clear of it, it is only risk.
    let picked = pickLineup(pool, { ...options, stackMismatch: false });
    if (!picked.ok) continue;
    if (target && picked.projected < target) {
      const stacked = pickLineup(pool, { ...options, stackMismatch: true });
      if (stacked.ok && stacked.projected > picked.projected) picked = { ...stacked, stacked: true };
    }
    const lock = picked.chosen.map((c) => c.kickoff).filter(Boolean).sort()[0] ?? null;
    attempts.push({ lockDay: day, lock, projected: picked.projected, picked });
  }

  if (!attempts.length) {
    return { ok: false, reason: 'No complete lineup possible from the eligible pool.', attempts };
  }

  const clearing = target ? attempts.filter((a) => a.projected >= target) : attempts;

  if (!clearing.length) {
    const best = attempts.reduce((a, b) => (b.projected > a.projected ? b : a));
    return {
      ...best.picked, ok: true, clearsTarget: false,
      lock: best.lock, lockDay: best.lockDay, attempts,
      shortfall: target ? Number((target - best.projected).toFixed(1)) : null,
    };
  }

  // Latest lock wins, unless an earlier one is meaningfully stronger.
  const strongest = clearing.reduce((a, b) => (b.projected > a.projected ? b : a));
  const latest = clearing.reduce((a, b) => (b.lockDay > a.lockDay ? b : a));
  const chosen = latest.projected >= strongest.projected * (1 - tolerance) ? latest : strongest;

  return {
    ...chosen.picked, ok: true, clearsTarget: true,
    lock: chosen.lock, lockDay: chosen.lockDay, attempts,
    tradedPointsForTime: chosen !== strongest
      ? Number((strongest.projected - chosen.projected).toFixed(1)) : 0,
  };
}
