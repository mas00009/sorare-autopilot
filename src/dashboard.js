/**
 * Writes docs/data.json - everything the dashboard page renders.
 *
 * Deliberately excludes anything secret: no tokens, no credentials, no email
 * config. The page is published to GitHub Pages and is public, so this file is
 * the boundary. Add nothing here that should not be on the open internet.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from './client.js';
import { resolveBoards, fetchStep, fetchBench, readBalances } from './autopilot.js';
import { describe } from './optimiser.js';
import { readEssence } from './essence.js';
import { decide } from './schedule.js';
import * as results from './results.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'data.json');

export async function build() {
  const st = await readState();
  const [bal, ess, { boards, squad, nickname }] = await Promise.all([
    readBalances().catch(() => null),
    readEssence().catch(() => ({ amount: null })),
    resolveBoards(),
  ]);

  const surfaces = [];
  for (const b of boards) {
    const step = await fetchStep(b.stepId).catch(() => null);
    let pool = [];
    try { pool = (await fetchBench(b.stepId, { first: 50 })).map((n) => describe(n)); } catch {}

    const current = (step?.myLineups?.[0]?.taskAppearances ?? []).map((ap) => ({
      name: ap.anyPlayer?.displayName ?? ap.anyPlayer?.slug,
      captain: ap.captain,
      locked: ap.locked,
      nextGame: ap.anyPlayer?.anyFutureGameStats?.[0]?.anyGame?.date ?? null,
    }));

    const usable = pool.filter((c) => !c.blocked).sort((a, b) => b.expected - a.expected);
    let plan = null;
    try {
      const { pickAcrossWindow } = await import('./optimiser.js');
      const raw = await fetchBench(b.stepId, { first: 50 });
      const p = pickAcrossWindow(raw, { target: step?.target ?? null });
      if (p.ok) plan = {
        clearsTarget: p.clearsTarget, projected: p.projected, lock: p.lock ?? null,
        shortfall: p.shortfall ?? null, tradedPointsForTime: p.tradedPointsForTime ?? 0,
        five: p.chosen.slice(0, 5),
      };
    } catch {}
    const rewards = (step?.rewardConfigs ?? []).map((r) => {
      if (r.__typename === 'CardPacksRewardConfig' && r.cardPack) {
        return { kind: 'pack', cards: r.cardPack.cardsCount, worth: r.cardPack.effectivePrice, currency: r.cardPack.currency };
      }
      if (r.__typename === 'CardShardRewardConfig') return { kind: 'essence', amount: r.quantity, rarity: r.rarity };
      return { kind: r.__typename.replace(/RewardConfig$/, '') };
    });

    surfaces.push({
      surface: b.surface,
      level: b.level ?? null,
      totalLevels: b.total ?? null,
      levelsDone: b.done ?? 0,
      ladder: b.ladder ?? [],
      rewards,
      state: step?.state ?? null,
      target: step?.target ?? null,
      current,
      plan,
      candidates: (plan?.five?.length ? plan.five : usable).slice(0, 12),
      projected: Number(usable.slice(0, 5).reduce((s, c) => s + c.expected, 0).toFixed(1)),
    });
  }

  // Upcoming fixtures across both boards.
  const games = new Map();
  for (const s of surfaces) {
    for (const c of [...s.candidates, ...s.current.map(() => null).filter(Boolean)]) {
      if (!c?.kickoff || new Date(c.kickoff) <= new Date()) continue;
      const key = `${c.kickoff}|${c.team}|${c.opponent}`;
      if (!games.has(key)) {
        games.set(key, {
          kickoff: c.kickoff, competition: c.competition ?? null,
          team: c.team, code: c.code, rank: c.rank,
          opponent: c.opponent, opponentCode: c.opponentCode, opponentRank: c.opponentRank,
          home: c.home, players: [], points: 0, bestStarter: null, surfaces: new Set(),
        });
      }
      const g = games.get(key);
      g.players.push(c.player);
      g.points += c.expected ?? 0;
      if (c.starterPct != null) g.bestStarter = Math.max(g.bestStarter ?? 0, c.starterPct);
      g.surfaces.add(s.surface);
    }
  }

  const cadence = decide({ nextKickoff: st.nextKickoff ?? null, nextLock: st.nextLock ?? null, lastRunAt: st.lastRunAt ?? null });
  const rows = await results.read();

  const data = {
    generatedAt: new Date().toISOString(),
    account: nickname ?? null,
    squad: squad?.name ?? null,
    balances: {
      essence: ess.amount,
      gems: bal?.gems?.[0]?.amount ?? null,
    },
    schedule: {
      nextLock: st.nextLock ?? null,
      cadenceMin: cadence.cadence,
      lastRunAt: st.lastRunAt ?? null,
      reason: cadence.reason,
    },
    packs: {
      lastThreeStar: st.lastThreeStarName ?? null,
      cycleDone: !!st.lastPackCycle,
    },
    health: { failStreak: st.failStreak ?? 0 },
    control: await (await import('./control.js')).read().catch(() => null),
    surfaces,
    fixtures: [...games.values()]
      .map((g) => ({ ...g, points: Number(g.points.toFixed(1)), surfaces: [...g.surfaces] }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
      .slice(0, 24),
    accuracy: results.accuracy(rows),
    backtest: await (async () => {
      try { return JSON.parse(await fs.readFile(path.join(ROOT, 'state', 'backtest.json'), 'utf8')); }
      catch { return null; }
    })(),
    recentResults: rows.slice(-8).reverse(),
  };

  // generatedAt changes on every pass, so writing unconditionally guaranteed a
  // diff every 30 minutes, a commit, and a Pages rebuild - which queued behind
  // real changes and made them look like they had not deployed. Only write when
  // something other than the timestamp actually moved.
  const meaningful = (o) => JSON.stringify({ ...o, generatedAt: null, schedule: { ...o.schedule, lastRunAt: null } });
  let unchanged = false;
  try {
    const prev = JSON.parse(await fs.readFile(OUT, 'utf8'));
    unchanged = meaningful(prev) === meaningful(data);
  } catch { /* no previous file */ }

  if (unchanged) return { ...data, unchanged: true };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
