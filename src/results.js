/**
 * Did the picks actually score?
 *
 * The optimiser's weights - 40% recency, 3% home advantage, 0.35 for a
 * substitute appearance - are judgement, not measurement. Nothing so far has
 * checked a projection against a real score. This records both so the weights
 * can eventually be corrected by evidence.
 *
 * It needs several gameweeks before it says anything trustworthy. Until then it
 * is collecting, not concluding.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql } from './client.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'state', 'results.jsonl');

const Q = `
  query Results($id: String!) {
    currentUser {
      step(id: $id) {
        id state target
        myLineups {
          id
          ... on TaskLineupInterface {
            score
            aasmState
            taskAppearances {
              captain
              score(withBonus: true)
              scoreStatus
              anyPlayer { slug displayName }
            }
          }
        }
      }
    }
  }
`;

/** Record a finished step: what we projected against what it scored. */
export async function recordIfFinished(stepId, surface, projections = []) {
  const d = await gql(Q, { id: stepId });
  const step = d.currentUser?.step;
  const lineup = step?.myLineups?.[0];
  if (!lineup || !['SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(lineup.aasmState)) return null;

  const seen = await read();
  if (seen.some((r) => r.lineupId === lineup.id)) return null;  // already recorded

  const byPlayer = new Map(projections.map((p) => [p.slug, p]));
  const row = {
    at: new Date().toISOString(),
    stepId, surface, lineupId: lineup.id,
    outcome: lineup.aasmState,
    target: step.target,
    actual: lineup.score,
    projected: projections.reduce((s, p) => s + (p.expected ?? 0), 0) || null,
    players: (lineup.taskAppearances ?? []).map((a) => {
      const slug = a.anyPlayer?.slug;
      const p = byPlayer.get(slug);
      return {
        name: a.anyPlayer?.displayName ?? slug,
        captain: a.captain,
        actual: a.score ?? null,
        projected: p?.expected ?? null,
        status: a.scoreStatus ?? null,
      };
    }),
  };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.appendFile(FILE, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export async function read() {
  try {
    return (await fs.readFile(FILE, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** How well have the projections tracked reality so far? */
export function accuracy(rows) {
  const pairs = rows.flatMap((r) => r.players)
    .filter((p) => p.projected != null && p.actual != null);
  if (!pairs.length) return { n: 0 };

  const err = pairs.map((p) => p.actual - p.projected);
  const bias = err.reduce((a, b) => a + b, 0) / err.length;
  const mae = err.reduce((a, b) => a + Math.abs(b), 0) / err.length;
  const blanks = pairs.filter((p) => (p.actual ?? 0) === 0).length;

  return {
    n: pairs.length,
    bias: Number(bias.toFixed(1)),          // negative = we over-projected
    mae: Number(mae.toFixed(1)),
    blankRate: Number((blanks / pairs.length).toFixed(2)),
    steps: rows.length,
    hit: rows.filter((r) => r.outcome === 'SUCCESSFUL').length,
  };
}
