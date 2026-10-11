/**
 * Lineup guard: the DNP check on its own.
 *
 * For an account whose owner sets the lineups by hand (the second account),
 * this is the only thing the bot does to them. It looks at a lineup that is
 * already entered and still editable, and replaces a player who will not
 * play - injured, suspended, no fixture left in the window, or Sorare's own
 * starter odds under 50% - with the best safe card for that slot. Everyone
 * else, and the captain, stay as the owner set them.
 *
 * A Set lineup locks whole at its FIRST kickoff, so a swap is only possible
 * before then. The guard therefore runs on the same clock as the main
 * account: rarely when nothing is near, every few minutes in the final hour
 * when confirmed teams and late odds land.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, writeState } from './client.js';
import { resolveBoards, fetchStep, fetchBench, fetchPlayersOnBench, liveLineupOf, submitLineup } from './autopilot.js';
import { describe, blockReason, bonusMultiplier, DEFAULTS } from './optimiser.js';
import { LADDER, LOCK_BUFFER_MIN, minutesUntil } from './schedule.js';

/** Below this published chance to start, a player counts as not playing. */
export const DNP_BP = 5000;
/** With nothing locking soon, look this often - enough to find a newly set lineup. */
const IDLE_MIN = 360;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Why an entered player will not play, or null. Only hard signals, never a hunch. */
export function dnpReason(node, now = Date.now()) {
  const injuries = (node.player?.activeInjuries ?? []).filter((i) => i.active);
  if (injuries.length) return `injured${injuries[0].kind ? ` (${injuries[0].kind})` : ''}`;
  if ((node.activeSuspensions ?? []).length) return 'suspended';
  const g = node.player?.anyFutureGameStats?.[0];
  if (!g?.anyGame) return 'no game left in this window';
  const o = g.footballPlayingStatusOdds;
  if (o && o.starterOddsBasisPoints < DNP_BP) return `only ${Math.round(o.starterOddsBasisPoints / 100)}% to start`;
  return null;
}

/** Five cards still make a legal lineup: one per position plus a non-keeper extra. */
function legal(five) {
  const n = (p) => five.filter((c) => c.position === p).length;
  return five.length === 5 && n('GK') === 1 && n('DF') >= 1 && n('MD') >= 1 && n('FW') >= 1;
}

function fits(five, c) {
  const perGame = five.filter((x) => x.gameId && x.gameId === c.gameId);
  if (perGame.length >= DEFAULTS.maxPerGame) return false;
  // Never two sides of one match.
  if (perGame.some((x) => x.teamSlug && c.teamSlug && x.teamSlug !== c.teamSlug)) return false;
  return true;
}

/**
 * Replace each risky card with the best safe card that keeps a legal five.
 * Pure, so it can be tested without Sorare. Safe means blockReason passes:
 * fit, starting, not on a side expected to lose if he defends.
 */
export function planSwaps(five, risky, bench) {
  const next = five.filter((c) => !risky.some((r) => r.c.slug === c.slug));
  const swaps = [];
  for (const { c: gone, why } of risky) {
    const last = next.length === 4;          // the final swap must leave a legal five
    const pick = bench
      .filter((x) => !x.blocked && x.expected > 0)
      .filter((x) => !five.some((y) => y.slug === x.slug) && !next.some((y) => y.slug === x.slug))
      .filter((x) => (gone.position === 'GK' ? x.position === 'GK' : x.position !== 'GK'))
      .filter((x) => fits(next, x) && (!last || legal([...next, x])))
      // Like for like first, then the strongest.
      .sort((a, z) => (a.position === gone.position ? 0 : 1) - (z.position === gone.position ? 0 : 1) || z.expected - a.expected)[0];
    swaps.push({ out: gone.player, why, in: pick?.player ?? null });
    if (pick) next.push(pick);
  }
  return { next, swaps };
}

async function journal(row) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'state', 'reports');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `guard-${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

async function alert(subject, lines) {
  try {
    const { deliver } = await import('./report.js');
    await deliver(subject, lines.join('\n'));
  } catch { /* the journal still has it */ }
}

/** Check every editable lineup on this account once. */
export async function guardLineups({ dryRun = false } = {}) {
  const out = { boards: [], nextLock: null };
  const { boards, nickname } = await resolveBoards();
  out.account = nickname;
  const now = Date.now();

  for (const b of boards) {
    const row = { surface: b.surface, action: 'none' };
    out.boards.push(row);
    const step = await fetchStep(b.stepId);
    const live = liveLineupOf(step);
    if (!live) { row.reason = 'no lineup set'; continue; }
    if (live.updatable === false) { row.reason = 'locked - nothing can change now'; continue; }

    const apps = live.taskAppearances ?? [];
    const locks = apps.map((a) => a.lockedAt).filter((t) => t && Date.parse(t) > now).sort();
    if (locks[0] && (!out.nextLock || locks[0] < out.nextLock)) out.nextLock = locks[0];

    const nodes = await fetchPlayersOnBench(b.stepId, apps);
    const capSlug = apps.find((a) => a.captain)?.anyPlayer?.slug ?? null;
    const five = nodes.map((n) => ({ ...describe(n, DEFAULTS), node: n }));
    const risky = five.map((c) => ({ c, why: dnpReason(c.node, now) })).filter((r) => r.why);
    row.players = five.map((c) => c.player);
    if (!risky.length) { row.reason = 'all five expected to play'; continue; }

    // Replace each risky card with the best safe card that keeps it legal.
    const bench = (await fetchBench(b.stepId)).map((n) => describe(n, DEFAULTS));
    const { next, swaps } = planSwaps(five, risky, bench);
    row.swaps = swaps;

    if (next.length < 5 || !legal(next)) {
      row.action = 'alert';
      row.reason = 'a player will not play and no safe replacement exists';
      if (!dryRun) {
        await journal({ account: nickname, ...row });
        await alert(`Sorare ${nickname}: ${risky.map((r) => r.c.player).join(', ')} may not play`, [
          `${nickname} - ${b.surface}`,
          ...risky.map((r) => `  ${r.c.player}: ${r.why}`),
          'No safe replacement on the bench. Change it yourself before the lineup locks.',
        ]);
      }
      continue;
    }

    // The owner's captain stays unless he is the one going out.
    const uplift = (c) => (c.expected / bonusMultiplier(c.bonus)) * DEFAULTS.captainBonus;
    const captain = next.find((c) => c.slug === capSlug)
      ?? next.filter((c) => c.position !== 'GK').reduce((a, z) => (uplift(z) > uplift(a) ? z : a));
    row.captain = captain.player;

    if (dryRun) { row.action = 'would-swap'; continue; }
    try {
      await submitLineup(b.stepId, { chosen: next, captain }, { lineupId: live.id });
      row.action = 'swapped';
      await journal({ account: nickname, ...row });
      await alert(`Sorare ${nickname}: swapped ${swaps.map((s) => s.out).join(', ')} out`, [
        `${nickname} - ${b.surface}`,
        ...swaps.map((s) => `  out ${s.out} (${s.why}), in ${s.in}`),
        `Captain: ${captain.player}. Everything else is as you set it.`,
      ]);
    } catch (err) {
      row.action = 'error';
      row.reason = err.message;
      await journal({ account: nickname, ...row });
    }
  }
  return out;
}

/**
 * Should this tick run the guard? Keyed off the earliest lock among this
 * account's editable lineups, remembered from the last check.
 */
export async function guardDue(now = Date.now()) {
  const s = await readState();
  const since = s.guardLastRun ? (now - s.guardLastRun) / 60000 : Infinity;
  const raw = minutesUntil(s.guardNextLock, now);
  const mins = raw == null || raw < 0 ? null : raw - LOCK_BUFFER_MIN;
  const every = mins == null ? IDLE_MIN : (LADDER.find((r) => mins <= r.withinMin)?.everyMin ?? IDLE_MIN);
  return { run: since >= Math.min(every, IDLE_MIN), every, mins };
}

export async function runGuard({ dryRun = false, force = false } = {}) {
  const due = await guardDue();
  if (!due.run && !force) return { skipped: true, ...due };
  const r = await guardLineups({ dryRun });
  if (!dryRun) await writeState({ guardLastRun: Date.now(), guardNextLock: r.nextLock });
  return r;
}
