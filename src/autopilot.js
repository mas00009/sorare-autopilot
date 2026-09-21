/**
 * Orchestrator: one pass = read state, decide, act, report.
 * Designed to be run repeatedly on a schedule. Every pass is idempotent -
 * if nothing has changed since the last one, it submits nothing.
 */
import { gql } from './client.js';
import { assertCostAllowed, GuardrailError, describeSkip } from './guardrails.js';
import {
  Q_BALANCES, Q_TRACK, Q_STEP, Q_BENCH, M_UPSERT_STEP_LINEUP,
  Q_MISSIONS, M_CLAIM_TASK, M_CLAIM_STEP, Q_BOARDS, M_RESTART_TRACK, M_ACK_STEP, Q_BUNDLES, M_OPEN_BUNDLE,
} from './queries.js';
import { openPacksUntilThreeStar } from './essence.js';
import { humanTask } from './report.js';
import { readState, writeState } from './client.js';
import { pickLineup, pickAcrossWindow, toAppearances, diffLineup } from './optimiser.js';

const SPORT = 'FOOTBALL';
const GEM_CURRENCIES = ['COMMON_GEM'];

export async function readBalances() {
  const d = await gql(Q_BALANCES, { sport: SPORT });
  const list = d.currentUser?.inGameCurrencyBalances ?? [];
  return {
    nickname: d.currentUser?.nickname,
    all: list,
    gems: list.filter((b) => GEM_CURRENCIES.includes(b.currency)),
  };
}

/**
 * Both Set surfaces: your own ladder (CAREER) and the squad's (SQUAD).
 * Each exposes myCurrentStep, and both use the same upsertStepLineup mutation.
 */
/** Sorare's daily cycle id - the DAILY task keeps one id per cycle. */
export async function dailyCycleId() {
  const d = await gql(`query { currentUser { dailyRunTask(sport: FOOTBALL) { id } } }`, {});
  return d.currentUser?.dailyRunTask?.id ?? null;
}

export async function resolveBoards() {
  const d = await gql(Q_BOARDS, { sport: SPORT });
  const u = d.currentUser ?? {};
  const out = [];
  const ladder = (b) => {
    const steps = (b?.steps ?? []).slice().sort((x, y) => (x.level ?? 0) - (y.level ?? 0));
    const lvl = b?.myCurrentStep?.level ?? null;
    return {
      level: lvl,
      total: steps.length || null,
      done: steps.filter((s) => s.state === 'CLAIMED').length,
      ladder: steps.map((s) => ({ level: s.level, state: s.state, target: s.target })),
    };
  };
  if (u.career?.myCurrentStep?.id) {
    out.push({ surface: 'my set', board: u.career.title ?? 'Career', stepId: u.career.myCurrentStep.id, ...ladder(u.career) });
  }
  if (u.team?.myCurrentStep?.id) {
    out.push({ surface: `team set (${u.squad?.name ?? 'squad'})`, board: u.team.title ?? 'Squad', stepId: u.team.myCurrentStep.id, ...ladder(u.team) });
  }
  return { boards: out, squad: u.squad ?? null, nickname: u.nickname };
}

export async function resolveLiveStep() {
  const d = await gql(Q_TRACK, { sport: SPORT });
  const u = d.currentUser ?? {};
  const stepId =
    u.setLiveTasksTrackStep?.id ??
    u.setTasksTrack?.currentStep?.id ??
    null;
  return { stepId, squad: u.squad ?? null, nickname: u.nickname };
}

export async function fetchStep(stepId) {
  const d = await gql(Q_STEP, { id: stepId });
  return d.currentUser?.step ?? null;
}

export async function fetchBench(stepId, { first = 50, positions = null } = {}) {
  const filters = {
    // Sorare's own defaults do the hard filtering for us:
    //   includeUnavailablePlayers:false -> no injured or suspended
    //   includeNoGame:false             -> everyone has a real fixture
    //   includePostExpiration:false     -> fixture is inside the scoring window
    includeUnavailablePlayers: false,
    includeNoGame: false,
    includePostExpiration: false,
    includeUsed: false,
    sortType: { type: 'LAST_FIFTEEN_SO5_AVERAGE_SCORE', direction: 'DESC' },
    ...(positions ? { positions } : {}),
  };
  const d = await gql(Q_BENCH, { id: stepId, filters, first });
  return d.currentUser?.step?.myFilteredBench?.nodes ?? [];
}

export async function submitLineup(stepId, picked, { lineupId = null, dryRun = false } = {}) {
  const input = {
    stepId,
    appearances: toAppearances(picked),
    ...(lineupId ? { lineupId } : {}),
  };
  if (dryRun) return { dryRun: true, input };
  const d = await gql(M_UPSERT_STEP_LINEUP, { input }, { mutationName: 'upsertStepLineup' });
  const payload = d.upsertStepLineup;
  if (payload?.errors?.length) {
    throw new Error(`upsertStepLineup rejected: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  return payload;
}

/** The lineup half of a pass. */
/** Appearances of the lineup currently set on a step, if any. */
function existingForLock(step) {
  return step?.myLineups?.[0]?.taskAppearances ?? null;
}

export async function runLineup({ dryRun = false, options = {}, stepId = null, surface = null } = {}) {
  if (!stepId) {
    const r = await resolveLiveStep();
    stepId = r.stepId;
    if (!stepId) return { skipped: true, reason: 'No live step open right now.', surface };
  }

  const step = await fetchStep(stepId);

  // PLAYABLE  = nothing entered yet.
  // LINEUP_SET = a lineup exists but the games have not started, so it is still
  //              swappable - this is the state the autopilot spends most of its
  //              life in, watching for injuries and late team news.
  // Everything else (LIVE, LOCKED, PRE_MATCHDAY_LOCKED, CLAIMABLE, CLAIMED,
  // FAILED) is past the point where changes are possible.
  const EDITABLE = ['PLAYABLE', 'LINEUP_SET'];

  // A finished step with a reward sitting on it.
  //
  // Held until the daily cycle rolls over on purpose. A claimed reward can
  // itself contain a 3-star card, which satisfies the daily collect challenge
  // for free - so claiming after the reset, and checking what came out before
  // touching the essence packs, can save the whole 1000-essence spend.
  if (step?.state === 'CLAIMABLE' && !options.claimNow) {
    const cycle = (await readState()).claimCycle;
    const current = await dailyCycleId().catch(() => null);
    if (current && cycle === current) {
      return { skipped: true, surface, stepId, action: 'holding-claim',
               reason: 'Reward ready, held until the daily reset so a free 3-star can count.' };
    }
  }

  if (step?.state === 'CLAIMABLE') {
    try {
      if (dryRun) {
        return { skipped: true, surface, stepId, action: 'would-claim',
                 reason: 'Step is CLAIMABLE - would claim its reward.' };
      }
      const got = await claimStep(stepId);
      const desc = got.rewards.length
        ? got.rewards.map((r) => r.kind === 'card' ? `${r.name} (${r.stars}-star)`
            : r.kind === 'essence' ? `${r.amount} essence`
            : r.kind === 'currency' ? `${r.amount} coins`
            : r.kind === 'pack' ? 'a card pack' : r.kind).join(', ')
        : 'no rewards listed';
      return { skipped: true, surface, stepId, action: 'claimed',
               rewards: got.rewards,
               reason: `Step was CLAIMABLE - claimed: ${desc}` };
    } catch (err) {
      return { skipped: true, surface, stepId, reason: `CLAIMABLE but claim failed: ${err.message}` };
    }
  }

  // A failed ladder step ends the run. Restart it so the climb begins again
  // rather than sitting dead until someone notices.
  if (step?.state === 'FAILED') {
    try {
      if (dryRun) {
        return { skipped: true, surface, stepId, action: 'would-restart',
                 reason: 'Step FAILED - would restart the ladder.' };
      }
      const r = await gql(M_RESTART_TRACK, { input: { taskId: stepId } },
                          { mutationName: 'restartTasksTrack' });
      const errs = r.restartTasksTrack?.errors ?? [];
      if (errs.length) {
        return { skipped: true, surface, stepId,
                 reason: `FAILED but restart refused: ${errs.map((e) => e.message).join('; ')}` };
      }
      return { skipped: true, surface, stepId, action: 'restarted',
               reason: `Step FAILED - ladder restarted (new task ${r.restartTasksTrack?.newTask?.id ?? '?'}). ` +
                       'Next pass will build a fresh lineup.' };
    } catch (err) {
      return { skipped: true, surface, stepId, reason: `FAILED but restart errored: ${err.message}` };
    }
  }

  if (step?.state && !EDITABLE.includes(step.state)) {
    // PRE_MATCHDAY_LOCKED is "not open yet", not "too late" - the step opens for
    // entry closer to its matchday. Every pass re-checks, so it will be filled
    // as soon as Sorare allows it. Saying "past the point of changes" for that
    // state reads as terminal and is wrong.
    const waiting = step.state === 'PRE_MATCHDAY_LOCKED';
    return {
      skipped: true, stepId, surface,
      action: waiting ? 'waiting' : 'closed',
      reason: waiting
        ? 'Not open for entry yet. It will be filled as soon as it opens.'
        : `Step is ${step.state} - past the point of changes.`,
    };
  }

  const bench = await fetchBench(stepId);
  if (!bench.length) return { skipped: true, reason: 'Bench came back empty.', stepId, surface };

  const picked = pickAcrossWindow(bench, { ...options, target: step?.target ?? null });
  if (!picked.ok) return { skipped: true, reason: picked.reason, stepId, surface, pool: picked.pool };

  const existing = step?.myLineups?.[0] ?? null;

  // Before kickoff nears, Sorare publishes no starter odds. Picking on raw
  // averages alone is guesswork - it will happily bench a settled XI for a
  // reserve keeper with a high average who is not in the squad. So when a
  // lineup already exists and no odds have landed yet, hold and wait.
  // Holding is only safe if the lineup that is already in is actually alive.
  // The eligible bench is filtered to this step's scoring window, so the latest
  // bench fixture marks the end of it. Anyone in the current lineup whose next
  // game falls outside that window scores nothing - during an international
  // break most club players are in exactly that position, and holding would
  // quietly protect a lineup that cannot score.
  // Earliest upcoming kickoff in this window - what the cadence keys off.
  const now = Date.now();
  const kickoffs = bench
    .map((n) => n.player?.anyFutureGameStats?.[0]?.anyGame?.date)
    .filter((d) => d && new Date(d).getTime() > now)
    .sort();
  // Sorare's own lock for this step, from any appearance not yet locked.
  const locks = (existingForLock(step) ?? [])
    .filter((ap) => !ap.locked && ap.lockedAt && new Date(ap.lockedAt).getTime() > now)
    .map((ap) => ap.lockedAt)
    .sort();
  await writeState({ nextLock: locks[0] ?? kickoffs[0] ?? null });

  if (kickoffs.length) {
    const prev = (await readState()).nextKickoff;
    if (!prev || new Date(prev).getTime() <= now || kickoffs[0] < prev) {
      await writeState({ nextKickoff: kickoffs[0] });
    }
  }

  const windowEnd = bench
    .map((n) => n.player?.anyFutureGameStats?.[0]?.anyGame?.date)
    .filter(Boolean)
    .sort()
    .at(-1);

  const held = (existing?.taskAppearances ?? []).map((ap) => {
    const p = ap.anyPlayer ?? {};
    const date = p.anyFutureGameStats?.[0]?.anyGame?.date ?? null;
    const injured = (p.activeInjuries ?? []).some((i) => i.active);
    const inWindow = !!date && !!windowEnd && date <= windowEnd;
    return { name: p.displayName ?? p.slug, date, injured, inWindow, locked: ap.locked };
  });
  const dead = held.filter((h) => !h.inWindow || h.injured);

  const anyOdds = picked.chosen.some((c) => c.oddsKnown);
  if (existing && dead.length === 0 && !anyOdds && !options.forceWithoutOdds) {
    return {
      stepId, surface, target: step?.target,
      action: 'hold',
      reason: 'Every held player has a fixture in this window and no odds are out yet - leaving it alone.',
      lineup: picked.chosen, projected: picked.projected, wouldBe: picked.chosen,
      current: (existing.taskAppearances ?? []).map((a) => a.anyPlayer?.displayName).filter(Boolean),
    };
  }
  const delta = diffLineup(existing?.taskAppearances ?? [], picked);
  const changed = delta.in.length > 0 || delta.out.length > 0 || !existing;

  if (!changed) {
    return {
      stepId, surface, target: step?.target,
      action: 'none', reason: 'Live lineup already optimal.',
      lineup: picked.chosen, projected: picked.projected,
    };
  }

  // Entering a lineup that cannot reach the target just burns the step. When the
  // best available five fall short, wait: later fixtures bring different players
  // into the eligible pool, and the step is only worth spending on a team that
  // can actually clear it.
  // Waiting only helps if later fixtures can actually close the gap. When the
  // best possible five fall short by less than the natural spread of five
  // players' scores, entering still has a real chance and not entering has
  // none - a step that expires unplayed scores zero just as surely as a failed
  // one, and costs the same nothing.
  const target = step?.target ?? null;
  const SPREAD = 56;          // measured: 25 points per player across five
  const withinReach = target && (target - picked.projected) <= SPREAD;

  if (target && picked.clearsTarget === false && !withinReach) {
    return {
      stepId, surface, target, dead,
      action: 'waiting-for-target',
      reason: `Best across the whole window projects ${picked.projected} against a target of ` +
              `${target}, short by ${picked.shortfall} - beyond what a good week could close. ` +
              'Holding until later fixtures bring enough scoring into the pool.',
      lineup: picked.chosen, projected: picked.projected,
      shortfall: Number((target - picked.projected).toFixed(1)),
      current: (existing?.taskAppearances ?? []).map((x) => x.anyPlayer?.displayName).filter(Boolean),
    };
  }

  let result;
  try {
    result = await submitLineup(stepId, picked, { lineupId: existing?.id ?? null, dryRun });
  } catch (err) {
    // Sorare marks a lineup final once the step is past the point of edits, even
    // while the state still reads LINEUP_SET. Nothing to be done - say so plainly
    // rather than surfacing a raw mutation error every pass.
    if (/final/i.test(err.message)) {
      return {
        stepId, surface, target: step?.target, dead,
        action: 'locked',
        reason: 'Sorare has marked this lineup final - it can no longer be changed.',
        lineup: picked.chosen, projected: picked.projected,
        current: (existing?.taskAppearances ?? []).map((a) => a.anyPlayer?.displayName).filter(Boolean),
      };
    }
    throw err;
  }
  return {
    stepId, surface, target: step?.target,
    dead,
    action: dryRun ? 'would-submit' : 'submitted',
    longShot: target ? picked.projected < target : false,
    shortfall: target ? Number((target - picked.projected).toFixed(1)) : null,
    lock: picked.lock ?? null,
    tradedPointsForTime: picked.tradedPointsForTime ?? 0,
    delta, lineup: picked.chosen, captain: picked.captain,
    projected: picked.projected, excluded: picked.excluded, raw: result,
  };
}

/**
 * Claim anything already earned.
 *
 * Only COMPLETED tasks are claimable - READY means the task is still in
 * progress. Attempting those produced a misleading "skipped" count before.
 *
 * Every claim is recorded by name and description, and currency balances are
 * snapshotted either side, so the morning report says what actually happened
 * rather than just how many calls were made.
 */
const CLAIMABLE_STATE = 'COMPLETED';

function tidy(task) {
  return {
    id: task.id,
    name: humanTask(task.name) ?? '(unnamed)',
    description: (task.description ?? '').trim() || null,
    state: task.aasmState,
  };
}

export async function runMissions({ dryRun = false, claimNow = false } = {}) {
  const out = {
    claimed: [], notReady: [], errors: [], held: 0,
    balancesBefore: null, balancesAfter: null, balanceDelta: [],
  };

  // Collect-mission rewards can contain a 3-star, same as step rewards, so they
  // are held until the daily cycle rolls over. Claiming one before the reset
  // would waste a free shot at the daily collect challenge.
  if (!claimNow) {
    const cycle = await dailyCycleId().catch(() => null);
    const state = await readState();
    if (cycle && state.claimCycle === cycle) {
      out.heldUntilReset = true;
      return out;
    }
  }

  let data;
  try {
    data = await gql(Q_MISSIONS, { sport: SPORT });
  } catch (err) {
    out.errors.push(`missions query failed: ${err.message}`);
    return out;
  }

  const u = data.currentUser ?? {};
  out.unclaimedCount = u.myUnclaimedTasksCount ?? null;

  const seen = new Map();
  // A collect track is never claimable itself - its currentStep is. Missing that
  // is why completed collect missions were reported as "nothing to claim".
  const collectSteps = (u.setCollectionsTaskTracks ?? [])
    .map((t) => t?.currentStep)
    .filter(Boolean);

  for (const t of [
    ...(u.setPlayTasks ?? []),
    ...(u.featuredTasks ?? []),
    ...collectSteps,
    ...(u.dailyRunTask ? [u.dailyRunTask] : []),
  ]) {
    if (t?.id && !seen.has(t.id)) seen.set(t.id, tidy(t));
  }

  const claimable = [...seen.values()].filter((t) => t.state === CLAIMABLE_STATE);
  out.notReady = [...seen.values()].filter((t) => t.state === 'READY');

  if (!claimable.length) return out;

  const snapshot = async () => {
    try { return (await readBalances()).all; } catch { return null; }
  };
  out.balancesBefore = await snapshot();

  for (const task of claimable) {
    try {
      assertCostAllowed(null); // claims are free; anything priced is refused upstream
      if (dryRun) { out.claimed.push({ ...task, dryRun: true }); continue; }
      const r = await gql(M_CLAIM_TASK, { input: { taskId: task.id } }, { mutationName: 'claimTask' });
      const errs = r.claimTask?.errors ?? [];
      if (errs.length) out.errors.push(`${task.name}: ${errs.map((e) => e.message).join('; ')}`);
      else out.claimed.push(task);
    } catch (err) {
      const skip = describeSkip(err);
      if (skip) out.errors.push(`${task.name}: ${skip.message}`);
      else out.errors.push(`${task.name}: ${err.message}`);
    }
  }

  if (!dryRun && out.claimed.length) {
    out.balancesAfter = await snapshot();
    if (out.balancesBefore && out.balancesAfter) {
      const before = Object.fromEntries(out.balancesBefore.map((b) => [b.currency, b.amount]));
      out.balanceDelta = out.balancesAfter
        .map((b) => ({ currency: b.currency, before: before[b.currency] ?? 0, after: b.amount }))
        .filter((d) => d.before !== d.after)
        .map((d) => ({ ...d, change: d.after - d.before }));
    }
  }
  return out;
}

const STAR = { DNP: 0, ROSTER: 2, IMPACT: 3, STAR: 4, GOAT: 5 };

/** Step states are API enums; never print them raw. */
const STATE_NAMES = {
  PLAYABLE: 'open for entry', LINEUP_SET: 'lineup in', CLAIMABLE: 'reward ready',
  CLAIMED: 'claimed', LIVE: 'playing now', LOCKED: 'locked',
  PRE_MATCHDAY_LOCKED: 'not open yet', FAILED: 'missed the target',
};
export const humanState = (s) => STATE_NAMES[s]
  ?? String(s ?? '').toLowerCase().replace(/_/g, ' ');

/** Flatten acknowledgeStep rewards into something readable and checkable. */
export function describeRewards(rewards = []) {
  return rewards.map((r) => {
    if (r.__typename === 'AnyCardReward') {
      const p = r.card?.anyPlayer;
      return { kind: 'card', name: p?.displayName ?? r.card?.slug, tier: p?.gameplayTier ?? null,
               stars: STAR[p?.gameplayTier] ?? 0 };
    }
    if (r.__typename === 'CardShardsReward') return { kind: 'essence', amount: r.quantity, rarity: r.rarity };
    if (r.__typename === 'InGameCurrencyReward') return { kind: 'currency', amount: r.coinAmount };
    if (r.__typename === 'CardPackReward') return { kind: 'pack', packId: r.pack?.id ?? null };
    return { kind: r.__typename };
  });
}

/** Claim a finished step. Uses acknowledgeStep; claimStep is deprecated. */
/**
 * Open any free daily pack that is sitting there.
 *
 * These are probabilistic bundles, listed as wheel rewards. They cost nothing to
 * open - whatever they cost was paid when they were granted - so this runs on
 * every pass and simply does nothing when none are waiting.
 */
export async function openFreePacks({ dryRun = false } = {}) {
  const out = { opened: [], cards: [], errors: [] };
  let d;
  try { d = await gql(Q_BUNDLES, { sport: SPORT }); }
  catch (err) { out.errors.push(err.message); return out; }

  const bundles = (d.currentUser?.myWheelRewards?.nodes ?? [])
    .map((n) => n.probabilisticBundle)
    .filter((b) => b && !b.opened && b.isOpenable !== false)
    .filter((b) => !b.openableAt || new Date(b.openableAt) <= new Date());

  out.waiting = bundles.length;
  for (const b of bundles.slice(0, 5)) {
    if (dryRun) { out.opened.push({ id: b.id, dryRun: true }); continue; }
    try {
      const r = await gql(M_OPEN_BUNDLE, { input: { probabilisticBundleId: b.id } },
                          { mutationName: 'probabilisticBundlesOpen' });
      const errs = r.probabilisticBundlesOpen?.errors ?? [];
      if (errs.length) { out.errors.push(errs.map((e) => e.message).join('; ')); continue; }
      const items = r.probabilisticBundlesOpen?.probabilisticBundle?.items ?? [];
      const cards = items.map((i) => i.card?.anyPlayer).filter(Boolean)
        .map((p) => ({ name: p.displayName, tier: p.gameplayTier, stars: STAR[p.gameplayTier] ?? 0 }));
      out.opened.push({ id: b.id, cards });
      out.cards.push(...cards);
    } catch (err) { out.errors.push(err.message); }
  }
  return out;
}

export async function claimStep(stepId, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, stepId };
  const r = await gql(M_ACK_STEP, { input: { stepId } }, { mutationName: 'acknowledgeStep' });
  const errs = r.acknowledgeStep?.errors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return { state: r.acknowledgeStep?.step?.state ?? null, rewards: describeRewards(r.acknowledgeStep?.rewards ?? []) };
}

async function _legacyClaimStep(stepId, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, stepId };
  const r = await gql(M_CLAIM_STEP, { input: { stepId } }, { mutationName: 'claimStep' });
  // The payload carries errors without throwing. Not checking them meant a
  // deprecated mutation was being reported as a successful claim.
  const errs = r.claimStep?.errors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return r.claimStep;
}

/** A full pass. */
export async function pass({ dryRun = false, options = {} } = {}) {
  const startedAt = new Date().toISOString();
  const report = { startedAt, dryRun };

  // Remote kill switch, read before anything is touched.
  const control = await (await import('./control.js')).read();
  report.control = control;
  if (control.paused) {
    report.paused = true;
    report.finishedAt = new Date().toISOString();
    return report;
  }
  if (control.packsEnabled === false) options = { ...options, packs: false };
  if (control.lineupsEnabled === false) options = { ...options, lineups: false };
  if (control.claimsEnabled === false) options = { ...options, claims: false };

  try {
    const bal = await readBalances();
    report.nickname = bal.nickname;
    report.gems = bal.gems;
    report.gemNote = 'Gems are read-only to this app. No code path can debit them.';
  } catch (err) {
    report.balanceError = err.message;
  }

  try {
    const { boards, squad, nickname } = await resolveBoards();
    report.squad = squad?.name ?? null;
    report.nickname = report.nickname ?? nickname;
    report.lineups = [];
    if (options.lineups === false) report.lineups.push({ skipped: true, reason: 'Lineups disabled by remote control.' });
    else for (const b of boards) {
      try {
        report.lineups.push(await runLineup({ dryRun, options, stepId: b.stepId, surface: b.surface }));
      } catch (err) {
        report.lineups.push({ surface: b.surface, stepId: b.stepId, skipped: true, reason: err.message });
      }
    }
    if (!boards.length) report.lineups.push({ skipped: true, reason: 'Neither board has a live step.' });
  } catch (err) {
    report.lineupError = err instanceof GuardrailError ? describeSkip(err) : err.message;
  }

  try {
    report.missions = options.claims === false
      ? { claimed: [], notReady: [], errors: [], disabled: true }
      : await runMissions({ dryRun, claimNow: options.claimNow });
  } catch (err) {
    report.missionsError = err.message;
  }

  try {
    report.freePacks = await openFreePacks({ dryRun });
  } catch (err) { report.freePacks = { opened: [], cards: [], errors: [err.message] }; }

  // Did anything claimed this pass already give us a 3-star? If so the daily
  // collect challenge is done and there is no reason to buy packs.
  const freeThreeStar = [
    ...(report.lineups ?? []).flatMap((l) => l.rewards ?? [])
      .filter((r) => r.kind === 'card').map((r) => ({ name: r.name, stars: r.stars })),
    ...(report.freePacks?.cards ?? []),
  ].find((c) => (c.stars ?? 0) >= 3);

  if (freeThreeStar) {
    const cycle = await dailyCycleId().catch(() => null);
    if (cycle) await writeState({ lastPackCycle: cycle, lastThreeStarName: freeThreeStar.name });
    report.freeThreeStar = freeThreeStar;
  }

  if (options.packs !== false) {
    try {
      report.packs = await openPacksUntilThreeStar({
        dryRun,
        essenceFloor: options.essenceFloor,
        maxPacks: options.maxPacks,
      });
    } catch (err) {
      report.packs = { stopped: err.message, opened: [] };
    }
  }

  // Record finished steps so projections can be checked against real scores.
  try {
    const R = await import('./results.js');
    report.results = [];
    for (const l of report.lineups ?? []) {
      if (!l.stepId) continue;
      const row = await R.recordIfFinished(l.stepId, l.surface, l.lineup ?? []);
      if (row) report.results.push(row);
    }
  } catch (err) { report.resultsError = err.message; }

  const claimed = (report.lineups ?? []).some((l) => l.action === 'claimed');
  if (claimed) {
    const cycle = await dailyCycleId().catch(() => null);
    if (cycle) await writeState({ claimCycle: cycle });
  }
  await writeState({ lastRunAt: Date.now() });
  report.finishedAt = new Date().toISOString();
  return report;
}
