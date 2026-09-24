/**
 * Replay past rounds through the real optimiser.
 *
 * For each round the pool is rebuilt as it stood at the lock - every player of
 * this account with a fixture in the window, scored on games BEFORE it - then
 * pickAcrossWindow() picks the five exactly as the live bot would, and the
 * five are scored on what actually happened. Run after any change to the
 * optimiser; a change that does not move these numbers is not an improvement.
 *
 * What it cannot see: Sorare's starter odds (not kept historically), card
 * bonuses (about +4% on the day), injuries flagged before kickoff. So the
 * absolute figures run low; the comparison between variants is the point.
 *
 * Headline from the first run, 44 rounds Mar-Sep 2026: every model variant
 * lands within noise (mean 259-272, 6-10% of lineups clear 360) because the
 * pool holds on average 2.9 regular starters averaging 60+ when they play,
 * and 360 needs five of them. Only 13 of 44 rounds had five available. An
 * oracle that knew exactly who would play still cleared 360 just 11% of the
 * time. The lever is the card pool, not the maths.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql } from './client.js';
import { pickAcrossWindow, pickLineup } from './optimiser.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HISTORY = path.join(ROOT, 'state', 'history.json');
const OUT = path.join(ROOT, 'state', 'simulation.json');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const DAY = 86_400_000;

const Q_HIST = `
  query Hist($slugs: [String!]) {
    players(slugs: $slugs) {
      slug displayName anyPositions
      anyGameStats(last: 40) {
        anyTeam { slug name __typename }
        playedInGame
        ... on PlayerGameStats { gameStarted minsPlayed }
        anyGame { date ... on Game { competition { name }
          homeTeam { ... on TeamInterface { name slug } } awayTeam { ... on TeamInterface { name slug } } } }
        playerGameScore { score }
      }
    }
  }
`;

/** Every common football player this account holds a card for. */
async function ownedPlayers() {
  let after = null; const out = new Map();
  for (let page = 0; page < 20; page += 1) {
    const q = `query { currentUser { cards(rarities: [common], sport: FOOTBALL, first: 50${after ? `, after: "${after}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { ... on Card { anyPlayer { slug displayName anyPositions } } } } } }`;
    const c = (await gql(q, {})).currentUser.cards;
    for (const n of c.nodes) if (n.anyPlayer?.slug) out.set(n.anyPlayer.slug, n.anyPlayer);
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  return [...out.keys()];
}

export async function refreshHistory() {
  const slugs = await ownedPlayers();
  const out = {};
  for (let i = 0; i < slugs.length; i += 10) {
    const d = await gql(Q_HIST, { slugs: slugs.slice(i, i + 10) });
    for (const p of d.players ?? []) out[p.slug] = { pos: (p.anyPositions ?? [])[0], name: p.displayName, games: p.anyGameStats ?? [] };
  }
  await fs.writeFile(HISTORY, JSON.stringify(out));
  return { players: Object.keys(out).length };
}

function flatten(H) {
  const apps = [];
  for (const [slug, p] of Object.entries(H)) for (const g of p.games ?? []) {
    if (!g?.anyGame?.date) continue;
    const score = g.playerGameScore?.score ?? (g.playedInGame ? 0 : null);
    if (score == null) continue;
    apps.push({
      slug, name: p.name, pos: p.pos, date: new Date(g.anyGame.date), score,
      played: !!g.playedInGame, started: !!g.gameStarted,
      team: g.anyTeam, homeTeam: g.anyGame.homeTeam, awayTeam: g.anyGame.awayTeam,
      comp: g.anyGame.competition?.name ?? '',
      gid: `${g.anyGame.date}|${g.anyGame.homeTeam?.slug}|${g.anyGame.awayTeam?.slug}`,
    });
  }
  return apps.sort((a, b) => a.date - b.date);
}

/** Non-overlapping three-day windows, each opening on a day with a real slate. */
function rounds(apps, { windowDays = 3, minPlayers = 25 } = {}) {
  const days = [...new Set(apps.map((a) => a.date.toISOString().slice(0, 10)))].sort();
  const out = []; let cursor = null;
  for (const d of days) {
    const start = new Date(`${d}T00:00:00Z`);
    if (cursor && start < cursor) continue;
    const end = new Date(+start + windowDays * DAY);
    const players = new Set(apps.filter((a) => a.date >= start && a.date < end).map((a) => a.slug));
    if (players.size >= minPlayers) { out.push({ start, end }); cursor = end; }
  }
  return out;
}

/** The bench as the bot would have seen it, from games before the lock only. */
function benchFor(bySlug, round) {
  const nodes = [];
  for (const [slug, list] of bySlug) {
    const prior = list.filter((a) => a.date < round.start);
    const next = list.find((a) => a.date >= round.start && a.date < round.end);
    if (!next || prior.length < 3) continue;
    const sc = prior.map((a) => a.score);
    const last10 = prior.slice(-10);
    const whenPlaying = prior.filter((a) => a.played).slice(-15).map((a) => a.score);
    nodes.push({
      id: slug, position: next.pos, positions: [next.pos], rarity: 'common', bonus: 1.0,
      averageScore: mean(sc.slice(-15)), formL5: mean(sc.slice(-5)), lockedAt: null, activeSuspensions: [],
      startRate: mean(last10.map((a) => (a.started ? 1 : 0))),
      playRate: mean(last10.map((a) => (a.played ? 1 : 0))),
      player: {
        slug, displayName: next.name, activeInjuries: [],
        anyFutureGameStats: [{
          onGameSheet: true, anyTeam: { slug: next.team?.slug, name: next.team?.name },
          anyGame: {
            id: next.gid, date: next.date.toISOString(), competition: { name: next.comp },
            homeTeam: { slug: next.homeTeam?.slug, name: next.homeTeam?.name },
            awayTeam: { slug: next.awayTeam?.slug, name: next.awayTeam?.name },
          },
        }],
      },
      _actual: next.score, _played: next.played,
      _strong: whenPlaying.length >= 3 && mean(whenPlaying) >= 60,
    });
  }
  return nodes;
}

/** The variants compared on every run. `bench` reshapes the pool; `opts` go to the optimiser. */
export const VARIANTS = {
  'live model': {},
  'no availability prior': { bench: (b) => b.map((n) => ({ ...n, startRate: null, playRate: null })) },
  'no opponent factor': { opts: { opponent: false } },
  'form weight 0.25': { opts: { formWeight: 0.25 } },
  'form weight 0.75': { opts: { formWeight: 0.75 } },
  'sides mixed in a match (old rule)': { opts: { oneSidePerMatch: false } },
  'one card per match': { opts: { maxPerGame: 1 } },
  'three cards per match': { opts: { maxPerGame: 3 } },
  'plain pick, no lock-day logic': { plain: true },
  'oracle: only players who did play': { bench: (b) => b.filter((n) => n._played) },
};

export async function simulate({ target = 360, thresholds = [300, 360, 400], variants = VARIANTS } = {}) {
  const H = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
  const apps = flatten(H);
  const bySlug = new Map();
  for (const a of apps) (bySlug.get(a.slug) ?? bySlug.set(a.slug, []).get(a.slug)).push(a);
  const R = rounds(apps);

  const res = Object.fromEntries(Object.keys(variants).map((k) => [k, { totals: [], nonPlayers: 0 }]));
  const ceiling = []; const pool = [];
  for (const r of R) {
    const bench = benchFor(bySlug, r);
    if (bench.length < 20) continue;
    const actual = new Map(bench.map((n) => [n.id, n]));
    const realise = (p) => {
      let t = 0;
      for (const c of p.chosen) t += actual.get(c.id)._actual;
      if (p.captain) t += actual.get(p.captain.id)._actual * 0.5;
      return t;
    };
    pool.push({ n: bench.length, strong: bench.filter((n) => n._strong && n.startRate >= 0.7).length });
    for (const [k, v] of Object.entries(variants)) {
      const b = v.bench ? v.bench(bench) : bench;
      const p = v.plain ? pickLineup(b, v.opts ?? {}) : pickAcrossWindow(b, { target, ...(v.opts ?? {}) });
      if (!p.ok) continue;
      res[k].totals.push(realise(p));
      res[k].nonPlayers += p.chosen.filter((c) => !actual.get(c.id)._played).length;
    }
    const hind = pickLineup(bench.map((n) => ({ ...n, averageScore: n._actual, formL5: n._actual, startRate: null })), { opponent: false, formWeight: 0 });
    if (hind.ok) ceiling.push(realise(hind));
  }

  const summarise = (t, extra = {}) => ({
    rounds: t.length, mean: Number(mean(t).toFixed(1)),
    clear: Object.fromEntries(thresholds.map((T) => [T, Number((100 * mean(t.map((x) => (x >= T ? 1 : 0)))).toFixed(0))])),
    ...extra,
  });
  const report = {
    ranAt: new Date().toISOString(), target, roundsAvailable: R.length, roundsUsed: pool.length,
    poolStrength: { players: Number(mean(pool.map((q) => q.n)).toFixed(0)), regularsAveraging60: Number(mean(pool.map((q) => q.strong)).toFixed(1)),
      roundsWithFive: pool.filter((q) => q.strong >= 5).length },
    variants: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, summarise(v.totals, { nonPlayersPerRound: Number((v.nonPlayers / Math.max(1, v.totals.length)).toFixed(2)) })])),
    ceiling: summarise(ceiling),
  };
  await fs.writeFile(OUT, JSON.stringify(report, null, 1));
  return report;
}

export function print(report) {
  const T = Object.keys(report.ceiling.clear);
  console.log(`\nSimulation - ${report.roundsUsed} rounds replayed, target ${report.target}`);
  console.log(`Pool: ${report.poolStrength.players} players a round, ${report.poolStrength.regularsAveraging60} regular starters averaging 60+, five or more in ${report.poolStrength.roundsWithFive} rounds\n`);
  const row = (k, s, extra = '') => console.log(`  ${k.padEnd(34)} mean ${String(s.mean).padStart(6)}  ${T.map((t) => `>=${t} ${String(s.clear[t]).padStart(3)}%`).join('  ')}${extra}`);
  for (const [k, s] of Object.entries(report.variants)) row(k, s, `  non-players/round ${s.nonPlayersPerRound}`);
  row('ceiling, perfect hindsight', report.ceiling);
}
