/**
 * Bookmaker odds for club fixtures, from The Odds API.
 *
 * Why it exists: for club games Sorare's `domesticLeagueRanking` predicted
 * nothing (0.7% across the whole table), but real closing odds did - joined
 * to 3,567 of this account's club appearances, a favourite's defenders score
 * more (correlation 0.13, t=3.2; haul rate 15% as a heavy underdog to 30% as
 * a favourite) and so do its forwards (0.10, t=2.3). The gain as a multiplier
 * is small - 0.3-0.5% of error - and the code says so; the larger value is
 * that the dashboard can now show who is playing the weakest side.
 *
 * International fixtures keep the FIFA-points factor in opponents.js. The two
 * never apply to the same card: a NationalTeam fixture is never looked up here.
 *
 * Quota. The free plan is 500 credits a month and one call costs
 * markets x regions, so every call here is h2h in one region: one credit per
 * league per day. Only leagues actually on the bench are fetched, the result
 * is cached for the day, and a monthly ceiling stops calls at 450 so the key
 * is never exhausted by a bug. A whole month of daily club fixtures across
 * five leagues is about 150 credits.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'state', 'odds');
const BASE = 'https://api.the-odds-api.com/v4';

export const ODDS_DEFAULTS = {
  /** Never spend past this many credits in a calendar month. Free plan is 500. */
  monthlyCeiling: 450,
  /**
   * Fitted on football-data.co.uk closing odds joined to this account's own
   * appearances (see README). Defenders and keepers on the clean-sheet proxy,
   * midfield and forwards on win probability. Both are multipliers around the
   * mean, so an average fixture changes nothing.
   */
  defensive: { k: 0.9, mean: 0.23 },     // proxy = (pWin + pDraw/2) * pUnder2.5, but see below
  attacking: { k: 0.2, mean: 0.36 },     // pWin
  /** Without a totals market, pUnder is stood in by this constant (league average). */
  underFallback: 0.5,
};

/** Sorare competition name -> Odds API sport key. Only these are ever fetched. */
export const SPORT_KEYS = {
  'Primera División': 'soccer_spain_la_liga',
  'LaLiga': 'soccer_spain_la_liga',
  'Segunda División': 'soccer_spain_segunda_division',
  'Premier League': 'soccer_epl',
  'Championship': 'soccer_efl_champ',
  'Bundesliga': 'soccer_germany_bundesliga',
  '2. Bundesliga': 'soccer_germany_bundesliga2',
  'Ligue 1': 'soccer_france_ligue_one',
  'Ligue 2': 'soccer_france_ligue_two',
  'Serie A': 'soccer_italy_serie_a',
  'Serie B': 'soccer_italy_serie_b',
  'Eredivisie': 'soccer_netherlands_eredivisie',
  'Primeira Liga': 'soccer_portugal_primeira_liga',
  'Süper Lig': 'soccer_turkey_super_league',
  'Scottish Premiership': 'soccer_spl',
  'UEFA Champions League': 'soccer_uefa_champs_league',
  'UEFA Europa League': 'soccer_uefa_europa_league',
  'UEFA Conference League': 'soccer_uefa_europa_conference_league',
  'MLS': 'soccer_usa_mls',
};

/* ---------------------------------------------------------------- names */

/** Strip the furniture so "Manchester United FC" and "Manchester United" meet. */
export const normaliseTeam = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(fc|cf|rc|rcd|cd|ca|ud|sd|afc|ac|as|us|ss|sc|ssc|bc|cfc|club|de|la|le|the|1\.|fsv|tsg|vfl|vfb|sv|bsc|ogc|losc|aj|sco|olympique|deportivo|real|athletic|atletico|sporting|hellas|associazione|calcio|stade|racing|football)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Where the two sides spell a club differently enough that normalising fails. */
const ALIASES = {
  // "Athletic Club" normalises to "club" -> strip -> "", so name it outright.
  'athletic club': 'athletic bilbao', 'bilbao': 'athletic bilbao',
  'celta': 'celta vigo', 'espanyol barcelona': 'espanyol',
  'madrid': 'real madrid', 'coruna': 'la coruna', 'santander': 'racing santander',
  'inter': 'inter milan', 'internazionale milano': 'inter milan', 'milan': 'ac milan',
  'wolverhampton wanderers': 'wolves', 'brighton hove albion': 'brighton', 'nottingham forest': 'nottm forest',
  'bayern munchen': 'bayern munich', 'monchengladbach': 'borussia monchengladbach',
  'paris saint germain': 'paris saint germain', 'marseille': 'marseille',
  'st pauli': 'st pauli', 'koln': 'cologne', 'ein frankfurt': 'eintracht frankfurt',
};
const canon = (s) => {
  const raw = String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (ALIASES[raw]) return ALIASES[raw];             // before stripping, for names made of furniture
  const n = normaliseTeam(s);
  return ALIASES[n] ?? n;
};

/** True when the two names are the same club, allowing for spelling. */
export function sameTeam(a, b) {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // one side carries an extra word: "elche" v "elche cf" after normalising, or "celta" v "celta vigo"
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

/* ------------------------------------------------------------ quota + cache */

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const usageFile = path.join(DIR, 'usage.json');

export async function usage() {
  const u = await readJson(usageFile, {});
  return { month: monthKey(), used: u[monthKey()]?.used ?? 0, remaining: u[monthKey()]?.remaining ?? null };
}

async function recordUsage(headers) {
  const u = await readJson(usageFile, {});
  const m = monthKey();
  const used = Number(headers.get('x-requests-used'));
  const remaining = Number(headers.get('x-requests-remaining'));
  u[m] = { used: Number.isFinite(used) ? used : (u[m]?.used ?? 0) + 1, remaining: Number.isFinite(remaining) ? remaining : null, at: new Date().toISOString() };
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(usageFile, JSON.stringify(u, null, 1));
}

/**
 * Today's events for one league, from cache when we already have them.
 * A call costs one credit and is made at most once per league per day.
 */
async function eventsFor(sportKey, { apiKey, opts = ODDS_DEFAULTS, now = new Date() } = {}) {
  const file = path.join(DIR, `${dayKey(now)}-${sportKey}.json`);
  const cached = await readJson(file, null);
  if (cached) return cached;
  if (!apiKey) return null;

  const u = await usage();
  if (u.used >= opts.monthlyCeiling) return null;         // hold the last 50 for a manual look

  const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  await recordUsage(res.headers);
  if (!res.ok) return null;
  const events = await res.json();
  const slim = (events ?? []).map((e) => ({
    id: e.id, commence: e.commence_time, home: e.home_team, away: e.away_team,
    ...implied(e),
  }));
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(slim));
  // Kept forever, so the simulator can be re-run against real pre-match odds
  // once enough have accumulated. This is the log the measurement asked for.
  await fs.appendFile(path.join(DIR, 'log.jsonl'), slim.map((s) => JSON.stringify({ fetched: now.toISOString(), sport: sportKey, ...s })).join('\n') + '\n');
  return slim;
}

/** Average the bookmakers, then remove the overround so the three sum to one. */
export function implied(event) {
  const acc = { home: [], draw: [], away: [] };
  for (const b of event.bookmakers ?? []) {
    const m = (b.markets ?? []).find((x) => x.key === 'h2h');
    if (!m) continue;
    for (const o of m.outcomes ?? []) {
      if (!(o.price > 1)) continue;
      if (o.name === event.home_team) acc.home.push(1 / o.price);
      else if (o.name === event.away_team) acc.away.push(1 / o.price);
      else if (/^draw$/i.test(o.name)) acc.draw.push(1 / o.price);
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const h = mean(acc.home), d = mean(acc.draw), a = mean(acc.away);
  if (h == null || a == null) return { pHome: null, pDraw: null, pAway: null, books: 0 };
  const s = h + (d ?? 0) + a;
  return { pHome: h / s, pDraw: d == null ? null : d / s, pAway: a / s, books: acc.home.length };
}

/* -------------------------------------------------------------- lookups */

/**
 * Odds for a bench card's fixture, or null. Only club competitions with a
 * sport key are looked up; national teams never reach here.
 *
 * @returns {{pWin:number, pLose:number, pDraw:number|null, favourite:boolean, books:number}|null}
 */
export async function fixtureOdds({ competition, homeTeam, awayTeam, team, date }, ctx) {
  const sport = SPORT_KEYS[competition];
  if (!sport) return null;
  const events = await eventsFor(sport, ctx);
  if (!events) return null;
  const kickoff = date ? new Date(date).getTime() : null;
  const ev = events.find((e) =>
    sameTeam(e.home, homeTeam) && sameTeam(e.away, awayTeam)
    && (kickoff == null || Math.abs(new Date(e.commence).getTime() - kickoff) < 36 * 3600e3));
  if (!ev || ev.pHome == null) return null;
  const isHome = sameTeam(team, homeTeam);
  const pWin = isHome ? ev.pHome : ev.pAway;
  const pLose = isHome ? ev.pAway : ev.pHome;
  return { pWin, pLose, pDraw: ev.pDraw, favourite: pWin >= 0.5, books: ev.books, source: sport };
}

/**
 * The multiplier for one card. Defenders and keepers on the clean-sheet
 * proxy, midfield and forwards on win probability. Both are centred on the
 * mean measured across this account's history, so a typical fixture is x1.
 */
export function oddsFactor(position, odds, opts = ODDS_DEFAULTS) {
  if (!odds || odds.pWin == null) return 1;
  if (position === 'GK' || position === 'DF') {
    const proxy = (odds.pWin + 0.5 * (odds.pDraw ?? 0)) * opts.underFallback;
    return 1 + opts.defensive.k * (proxy - opts.defensive.mean * (opts.underFallback / 0.5));
  }
  return 1 + opts.attacking.k * (odds.pWin - opts.attacking.mean);
}
