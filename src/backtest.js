/**
 * Walk-forward backtest.
 *
 * The optimiser's weights were my judgement, never measured. Waiting for live
 * gameweeks would take months, but Sorare already holds each player's past
 * scores, so the weights can be fitted against history instead.
 *
 * Walk-forward means each prediction uses ONLY games before the one being
 * predicted. Computing a player's average over their whole history and then
 * "predicting" a game inside it would leak the answer into the input and
 * produce a flattering, useless result.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql } from './client.js';
import { resolveBoards, fetchBench } from './autopilot.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'state', 'backtest.json');

// Note: the root field is `players(slugs:)`. There is no singular `player`.
// Batching also cuts the request count by an order of magnitude.
const Q = `
  query Hist($slugs: [String!]) {
    players(slugs: $slugs) {
      slug
      displayName
      anyGameStats(last: 25) {
        anyTeam { slug }
        anyGame { date homeTeam { slug } awayTeam { slug } }
        playedInGame
        playerGameScore { score }
      }
    }
  }
`;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Build a walk-forward sample set for one player. */
export function samplesFor(stats) {
  const games = (stats ?? [])
    .filter((g) => g?.anyGame?.date)
    .map((g) => ({
      date: g.anyGame.date,
      score: g.playerGameScore?.score ?? (g.playedInGame ? 0 : null),
      home: g.anyGame.homeTeam?.slug && g.anyGame.homeTeam.slug === g.anyTeam?.slug,
    }))
    .filter((g) => g.score != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const out = [];
  for (let i = 5; i < games.length; i += 1) {
    const prior = games.slice(0, i);
    out.push({
      actual: games[i].score,
      home: !!games[i].home,
      l5: mean(prior.slice(-5).map((g) => g.score)),
      l15: mean(prior.slice(-15).map((g) => g.score)),
    });
  }
  return out;
}

/** Error for one weight combination. */
export function evaluate(samples, { formWeight, homeAdvantage }) {
  let se = 0, ae = 0, bias = 0;
  for (const s of samples) {
    const base = s.l15 * (1 - formWeight) + s.l5 * formWeight;
    const pred = base * (s.home ? homeAdvantage : 1);
    const err = s.actual - pred;
    se += err * err; ae += Math.abs(err); bias += err;
  }
  const n = samples.length || 1;
  return { rmse: Math.sqrt(se / n), mae: ae / n, bias: bias / n, n: samples.length };
}

export async function run({ maxPlayers = 60, log = console.log } = {}) {
  const { boards } = await resolveBoards();
  const slugs = new Set();
  for (const b of boards) {
    try {
      for (const n of await fetchBench(b.stepId, { first: 50 })) {
        if (n.player?.slug) slugs.add(n.player.slug);
      }
    } catch { /* a locked board has no bench */ }
  }
  const list = [...slugs].slice(0, maxPlayers);
  log(`collecting history for ${list.length} players`);

  const samples = [];
  const BATCH = 10;
  for (let i = 0; i < list.length; i += BATCH) {
    const slugs = list.slice(i, i + BATCH);
    try {
      const d = await gql(Q, { slugs });
      for (const pl of d.players ?? []) samples.push(...samplesFor(pl?.anyGameStats));
    } catch (err) { log(`  batch failed: ${err.message.slice(0, 80)}`); }
    log(`  ${Math.min(i + BATCH, list.length)}/${list.length} players, ${samples.length} samples`);
  }
  log(`${samples.length} walk-forward samples`);
  if (samples.length < 50) return { ok: false, reason: 'not enough history', samples: samples.length };

  // Grid search. Small space, so exhaustive beats anything clever.
  let best = null;
  const grid = [];
  for (let fw = 0; fw <= 1.0001; fw += 0.1) {
    for (let ha = 1.0; ha <= 1.1001; ha += 0.01) {
      const r = evaluate(samples, { formWeight: fw, homeAdvantage: ha });
      grid.push({ formWeight: +fw.toFixed(2), homeAdvantage: +ha.toFixed(2), ...r });
      if (!best || r.rmse < best.rmse) best = grid[grid.length - 1];
    }
  }

  const current = evaluate(samples, { formWeight: 0.4, homeAdvantage: 1.03 });
  const result = {
    at: new Date().toISOString(),
    players: list.length,
    samples: samples.length,
    current: { formWeight: 0.4, homeAdvantage: 1.03, ...current },
    best,
    improvementRmse: Number((current.rmse - best.rmse).toFixed(3)),
    note: 'Walk-forward: each prediction uses only games before it. No lookahead.',
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
