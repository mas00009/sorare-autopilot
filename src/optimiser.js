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

export const DEFAULTS = {
  /** Reject anyone below this starter probability, in basis points. */
  minStarterBp: 6000,
  /** A substitute appearance is worth roughly this fraction of a start. */
  substituteWeight: 0.35,
  /** How much recent form (L5) outweighs the longer L15 record. */
  formWeight: 0.4,
  /** Playing at home is worth a few percent. */
  homeAdvantage: 1.03,
  /** Most cards allowed from any single real-world match, to limit correlation. */
  maxPerGame: 2,
  /** Slot requirements. Total must equal `size`. */
  size: 5,
  require: { GK: 1, DF: 1, MD: 1, FW: 1 },
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
  return {
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
  // No odds published yet: assume available rather than scoring them to zero.
  const availability = o
    ? o.starterOddsBasisPoints / 10000 + opts.substituteWeight * (o.substituteOddsBasisPoints / 10000)
    : 1;
  return avg * bonus * availability * venue;
}

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
    home: fx?.home ?? null,
    competition: fx?.competition ?? null,
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

  const canTake = (c) => {
    if (chosen.some((x) => x.id === c.id)) return false;
    if (chosen.some((x) => x.slug === c.slug)) return false; // no duplicate players
    const n = perGame.get(c.gameId) ?? 0;
    return n < opts.maxPerGame;
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
    if (!canTake(c)) continue;
    take(c);
  }

  if (chosen.length < opts.size) {
    return { ok: false, reason: `Only ${chosen.length}/${opts.size} slots fillable.`, chosen, pool: all };
  }

  chosen.sort((a, b) => b.expected - a.expected);
  // Keepers score steadily but rarely produce the big hauls a captain multiplier
  // is worth spending on, so captain an outfielder unless there is nobody else.
  const captain = chosen.find((c) => c.position !== 'GK') ?? chosen[0];
  const projected = chosen.reduce((s, c) => s + c.expected, 0);

  return {
    ok: true,
    chosen,
    captain,
    projected: Number(projected.toFixed(2)),
    excluded: all.filter((c) => c.blocked),
    pool: all,
  };
}

/** Build the AppearanceInput[] that upsertStepLineup expects. */
export function toAppearances(picked) {
  return picked.chosen.map((c, i) => ({
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
    const picked = pickLineup(pool, options);
    if (!picked.ok) continue;
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
