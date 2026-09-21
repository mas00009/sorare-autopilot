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
    surfaces.push({
      surface: b.surface,
      state: step?.state ?? null,
      target: step?.target ?? null,
      current,
      candidates: usable.slice(0, 12),
      rejected: pool.filter((c) => c.blocked).slice(0, 15),
      projected: Number(usable.slice(0, 5).reduce((s, c) => s + c.expected, 0).toFixed(1)),
    });
  }

  // Upcoming fixtures across both boards.
  const games = new Map();
  for (const s of surfaces) {
    for (const c of [...s.candidates, ...s.current.map(() => null).filter(Boolean)]) {
      if (!c?.kickoff || new Date(c.kickoff) <= new Date()) continue;
      const key = `${c.kickoff}|${c.team}|${c.opponent}`;
      if (!games.has(key)) games.set(key, { kickoff: c.kickoff, team: c.team, opponent: c.opponent, home: c.home, players: [] });
      games.get(key).players.push(c.player);
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
    surfaces,
    fixtures: [...games.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff)).slice(0, 20),
    accuracy: results.accuracy(rows),
    recentResults: rows.slice(-8).reverse(),
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
