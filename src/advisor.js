/**
 * Kobe NBA advisor: suggestions only, posted to Google Chat.
 *
 * The owner plays Kobe's NBA by hand (2 Nov 2026) and wants, in Chat:
 *   - a check of each lineup he has set: who is injured, who is a game-time
 *     decision, who has a game;
 *   - the best five Kobe could enter under the stars cap, and the swaps;
 *   - who is hot, and who is great value for his stars;
 *   - late news: a lineup player turning GTD or OUT, or a strong bench
 *     player becoming available, while there is still time to act.
 *
 * It never changes anything: it runs with SORARE_READONLY=1, which makes the
 * client refuse every mutation.
 *
 * Sorare's own projection (nextClassicFixtureProjectedScore) is the main
 * signal - it knows minutes and matchups. Recent form and the stars cap do
 * the rest.
 */
import { gql, readState, writeState } from './client.js';
import { resolveBoards, fetchStep, fetchBench, fetchPlayersOnBench, liveLineupOf } from './autopilot.js';
import { pickLineup, NBA_OPTIONS, starsOf } from './optimiser.js';
import { postChat, postCard, chatSpace } from './chat.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJLOG = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state', 'nba-projlog.jsonl');
/** Log each projection for its next game, once, to measure later against the real score. */
async function logProjections(views) {
  const seen = new Set();
  const lines = [];
  for (const v of views) for (const r of [...v.current, ...v.benchRows]) {
    if (!r.slug || !r.next || seen.has(r.slug)) continue;
    seen.add(r.slug);
    lines.push(JSON.stringify({ at: new Date().toISOString(), slug: r.slug, game: r.next, sorare: r.proj ?? null,
      l15: r.l15 ?? null, l5: r.l5 ?? null, injury: r.injury?.status ?? null }));
  }
  if (lines.length) await fs.appendFile(PROJLOG, lines.join('\n') + '\n');
}

const SYD = 'Australia/Sydney';
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: SYD }) : '?');
const sydHour = (t = Date.now()) => Number(new Date(t).toLocaleString('en-AU', { hour: 'numeric', hour12: false, timeZone: SYD }));
const sydDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: SYD });
const STAR = (t) => `${starsOf(t)}★`;

function guard() {
  if (process.env.SORARE_READONLY !== '1') throw new Error('The advisor must run read-only (SORARE_READONLY=1).');
}

/** Sorare's projection and injury status for each player, in batches. */
async function projections(slugs) {
  const out = new Map();
  const list = [...new Set(slugs)].filter(Boolean);
  for (let i = 0; i < list.length; i += 25) {
    const d = await gql(`query($s:[String!]){ players(slugs:$s) { slug ... on NBAPlayer { displayName gameplayTier nextClassicFixtureProjectedScore activeInjuries { status kind expectedEndDate } anyFutureGameStats(first: 1) { anyGame { date } } news(last: 1) { date headline notes } } } }`, { s: list.slice(i, i + 25) });
    for (const p of d.players ?? []) {
      out.set(p.slug, { proj: p.nextClassicFixtureProjectedScore ?? null, injury: (p.activeInjuries ?? [])[0] ?? null,
        name: p.displayName, tier: p.gameplayTier, next: p.anyFutureGameStats?.[0]?.anyGame?.date ?? null,
        news: (p.news ?? [])[0] ?? null });
    }
  }
  return out;
}

const statusOf = (inj) => (inj ? `${inj.status ?? 'injured'}${inj.kind ? ` (${inj.kind})` : ''}` : 'fit');

/**
 * The squad board: its target is the squad's TOP THREE lineups combined, not
 * Kobe's own. Every squad lineup is projected to the end - points already in
 * for players who have played (FINAL / REVIEWING), Sorare's projection for
 * players still to come, whichever is higher for a player mid-game - and the
 * best three are added up against the target.
 */
async function squadView(stepId, me) {
  const d = await gql(`query($id:String!){ currentUser { step(id:$id) { ... on SquadStep { target squadLeaderboardLineups(top: 15) { ranking lineup { id ... on TaskLineupInterface { score user { nickname } taskAppearances { score scoreStatus anyPlayer { slug } game { ... on GameOfBasketball { statusTyped } } } } } } } } } }`, { id: stepId });
  const rows = d.currentUser?.step?.squadLeaderboardLineups ?? [];
  const P = await projections(rows.flatMap((r) => (r.lineup?.taskAppearances ?? []).map((a) => a.anyPlayer?.slug)));
  const lineups = rows.map((r) => {
    let live = 0, proj = 0, toPlay = 0;
    for (const a of r.lineup?.taskAppearances ?? []) {
      const done = playState({ gameState: a.game?.statusTyped, scoreStatus: a.scoreStatus, score: a.score }) === 'done'
        || playState({ gameState: a.game?.statusTyped, scoreStatus: a.scoreStatus, score: a.score }) === 'dnp';
      const sp = P.get(a.anyPlayer?.slug)?.proj ?? 0;
      live += a.score ?? 0;
      if (done) proj += a.score ?? 0; else { toPlay += 1; proj += Math.max(a.score ?? 0, sp); }
    }
    return { who: r.lineup?.user?.nickname ?? '?', live, proj, toPlay, mine: r.lineup?.user?.nickname === me };
  });
  const byProj = [...lineups].sort((a, b) => b.proj - a.proj);
  const byLive = [...lineups].sort((a, b) => b.live - a.live);
  const top3 = byProj.slice(0, 3);
  return {
    target: d.currentUser?.step?.target ?? null, count: lineups.length,
    liveTop3: byLive.slice(0, 3).reduce((n, l) => n + l.live, 0),
    projTop3: top3.reduce((n, l) => n + l.proj, 0),
    toPlay: top3.reduce((n, l) => n + l.toPlay, 0),
    myRank: byProj.findIndex((l) => l.mine) + 1, mineInTop3: top3.some((l) => l.mine), lineups: byProj,
  };
}

/** Everything the advice needs for one board. */
let NICK = null;
async function boardView(b) {
  const step = await fetchStep(b.stepId);
  const live = liveLineupOf(step);
  const apps = live?.taskAppearances ?? [];
  const editable = !!live && live.updatable !== false;
  const lockAt = apps.map((a) => a.lockedAt).filter(Boolean).sort()[0] ?? null;
  const mine = apps.length ? await fetchPlayersOnBench(b.stepId, apps) : [];
  const bench = await fetchBench(b.stepId);
  const P = await projections([...apps.map((a) => a.anyPlayer?.slug), ...bench.map((n) => n.player?.slug)]);
  // The projection: Sorare's own number (it knows tonight's rotation, injuries
  // and matchup) blended 50/50 with recent form. Measured on 639 recent NBA
  // games: form alone misses by 8.7 a player on average and minutes, venue,
  // opponent, rest and missing teammates together only got it to 8.8, so the
  // extra factors are left to Sorare's number. A GTD player counts at 60%.
  // Every projection is logged against the actual score (projlog) so the
  // weights get measured, not guessed.
  const blendOf = (n) => {
    const p = P.get(n.player?.slug);
    const form = n.averageScore != null && n.formL5 != null ? (n.averageScore + n.formL5) / 2 : (n.averageScore ?? null);
    const base = p?.proj != null && form != null ? 0.5 * p.proj + 0.5 * form : (p?.proj ?? form ?? 0);
    const avail = p?.injury ? (/GTD|QUESTION|DOUBT|PROB/i.test(p.injury.status ?? '') ? 0.6 : 0) : 1;
    return base * avail;
  };
  const withProj = (n) => {
    const v = blendOf(n);
    return { ...n, averageScore: v, formL5: v, sorareProj: P.get(n.player?.slug)?.proj ?? null };
  };
  const starsRule = (step?.displayedTypedRules ?? []).find((r) => r.__typename === 'So5AverageScoresRule' && r.averageType === 'STARS');
  const opts = { ...NBA_OPTIONS, ...(starsRule?.max ? { starsCap: starsRule.max } : {}), calibration: 1 };
  const pool = [...mine, ...bench.filter((n) => !mine.some((m) => m.player?.slug === n.player?.slug))].map(withProj);
  const best = pickLineup(pool, opts);
  // From the lineup itself: a squad lineup's cards may not come back from
  // the bench lookup, but every appearance names its player.
  const current = apps.map((a) => {
    const slug = a.anyPlayer?.slug;
    const p = P.get(slug) ?? {};
    return { slug, name: p.name ?? a.anyPlayer?.displayName, tier: p.tier, proj: p.proj, injury: p.injury, next: p.next,
      news: p.news, pic: a.pictureUrl ?? null, score: a.score ?? null, scoreStatus: a.scoreStatus ?? null, gameAt: a.game?.date ?? null,
      gameState: a.game?.statusTyped ?? null };
  });
  const benchRows = bench.map((n) => {
    const p = P.get(n.player?.slug) ?? {};
    return { slug: n.player?.slug, name: n.player?.displayName, tier: n.player?.gameplayTier, proj: p.proj, injury: p.injury,
      l5: n.formL5, l15: n.averageScore, next: n.player?.anyFutureGameStats?.[0]?.anyGame?.date ?? null,
      news: p.news, pic: n.pictureUrl ?? null, team: n.player?.anyFutureGameStats?.[0]?.anyTeam?.name ?? null,
      ...(() => {
        const g = n.player?.anyFutureGameStats?.[0];
        const mine = g?.anyTeam?.slug;
        const home = g?.anyGame?.homeTeam, away = g?.anyGame?.awayTeam;
        if (!home || !away) return {};
        const isHome = home.slug === mine;
        return { opp: (isHome ? away : home).name ?? null, home: isHome };
      })() };
  });
  const picOf = new Map([...mine, ...bench].map((n) => [n.player?.slug, n.pictureUrl]));
  // AI pick: the five most likely to PASS this level. With ~9 points of
  // swing per player a five's total swings ~25, so the chance to clear the
  // target - not the average - is what is ranked. If a lineup is already in
  // and locked, the pick is a second team from the cards not in it ("Add
  // team now" in the app); otherwise it is the best five overall.
  const inUse = new Set(apps.map((a) => a.anyPlayer?.slug));
  // Only a team that can still be entered: every player's game must start
  // at least 20 minutes from now, because a lineup locks at its first tip-off.
  const startsLater = (n) => {
    const t = n.player?.anyFutureGameStats?.[0]?.anyGame?.date;
    return !!t && Date.parse(t) > Date.now() + 20 * 60e3 && !(n.lockedAt && Date.parse(n.lockedAt) <= Date.now());
  };
  const aiPool = (v_locked => v_locked ? bench.filter((n) => !inUse.has(n.player?.slug)) : pool)(!!live && live.updatable === false)
    .filter(startsLater).map(withProj);
  const aiPick = pickLineup(aiPool, opts);
  const SD = 25;
  const passChance = (proj) => { const z = (proj - step.target) / SD; return Math.round(100 * (0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3))))); };
  const squad = b.surface.startsWith('team') && live ? await squadView(b.stepId, NICK).catch(() => null) : null;
  let opensAt = null;
  if (b.surface.startsWith('team') && step.state === 'PRE_MATCHDAY_LOCKED') {
    try { opensAt = (await gql(`query { currentUser { setBoard(mode: SQUAD, sport: NBA) { ... on SquadBoard { nextMatchdayAt } } } }`, {})).currentUser?.setBoard?.nextMatchdayAt ?? null; } catch {}
  }
  return { b, step, live, editable, lockAt, current, benchRows, best, cap: opts.starsCap, picOf, newsOf: (slug) => P.get(slug)?.news ?? null, squad, opensAt,
    aiPick, aiSecond: !!live && live.updatable === false, passChance };
}

/* ----------------------------------------------------------- Chat cards */

const COLOUR = { fit: '#1e8e3e', GTD: '#e37400', OUT: '#d93025', locked: '#80868b', open: '#1a73e8', hot: '#e8710a' };
const font = (c, t) => `<font color="${c}">${t}</font>`;
function statusBadge(inj) {
  if (!inj) return font(COLOUR.fit, '<b>FIT</b>');
  const st = String(inj.status ?? 'OUT').toUpperCase();
  const c = /GTD|QUESTION|DOUBT|PROB/.test(st) ? COLOUR.GTD : COLOUR.OUT;
  const icon = c === COLOUR.GTD ? '🟠' : '🔴';
  const due = inj.expectedEndDate ? ` · update due ${when(inj.expectedEndDate)}` : '';
  return `${icon} ${font(c, `<b>${st}</b>`)}${inj.kind ? ` (${inj.kind.toLowerCase()})` : ''}${due}`;
}
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  return h < 1 ? 'just now' : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
function playerRow(c, { full = false } = {}) {
  const news = c.news && (c.injury || full || Date.now() - Date.parse(c.news.date) < 24 * 3600e3) ? c.news : null;
  return { decoratedText: {
    ...(c.pic ? { startIcon: { iconUrl: c.pic, altText: c.name } } : {}),
    topLabel: `${c.name} · ${STAR(c.tier)} · plays ${when(c.next)}`,
    text: `${statusBadge(c.injury)} · proj <b>${c.proj != null ? Math.round(c.proj) : '?'}</b>`,
    ...(news ? { bottomLabel: `📰 ${news.headline} (${ago(news.date)})${c.injury && news.notes ? ` - ${news.notes}` : ''}`.slice(0, 380) } : {}),
    wrapText: true,
  } };
}
const cardGrid = (rows) => ({ grid: {
  columnCount: Math.min(5, Math.max(1, rows.length)),
  items: rows.map((r) => ({ image: { imageUri: r.pic ?? 'https://sorare.com/favicon.ico', altText: r.name }, title: r.name, ...(r.caption ? { subtitle: r.caption } : {}), textAlignment: 'CENTER' })),
} });

function boardSection(v) {
  const name = v.b.surface.startsWith('team') ? 'Team set' : 'My set';
  const curProj = v.current.reduce((s, c) => s + (c.proj ?? 0), 0);
  const widgets = [];
  if (!v.live) widgets.push({ decoratedText: { text: `${font(COLOUR.open, '<b>NO LINEUP IN</b>')} - pick one below`, wrapText: true } });
  else if (v.editable) widgets.push({ decoratedText: { text: `🔓 ${font(COLOUR.open, '<b>OPEN</b>')} · locks <b>${when(v.lockAt)}</b> · Sorare projects <b>${Math.round(curProj)}</b> of ${v.step.target}`, wrapText: true } });
  else widgets.push({ decoratedText: { text: `🔒 ${font(COLOUR.locked, '<b>LOCKED</b>')} · Sorare projects <b>${Math.round(curProj)}</b> of ${v.step.target} · no changes possible`, wrapText: true } });
  if (v.current.length) {
    widgets.push(cardGrid(v.current));
    for (const c of v.current) widgets.push(playerRow(c));
  }
  if (v.best.ok && (v.editable || !v.live)) {
    const bestProj = v.best.chosen.reduce((s, c) => s + c.expected, 0);
    const inNow = new Set(v.current.map((c) => c.slug));
    const swapsIn = v.best.chosen.filter((c) => !inNow.has(c.slug));
    if (!v.live || swapsIn.length) {
      const out = v.current.filter((c) => !v.best.chosen.some((x) => x.slug === c.slug));
      widgets.push({ decoratedText: { topLabel: 'Suggested five', text: `<b>${Math.round(bestProj)}</b> projected${v.live ? ` (${font(COLOUR.fit, `+${Math.round(bestProj - curProj)}`)})` : ''} · ${v.best.chosen.reduce((s, c) => s + starsOf(c.tier), 0)}★ of ${v.cap}`
        + (swapsIn.length && v.live ? `<br>In: <b>${swapsIn.map((c) => c.player).join(', ')}</b><br>Out: ${out.map((c) => c.name).join(', ')}` : ''), wrapText: true } });
      widgets.push(cardGrid(v.best.chosen.map((c) => ({ name: c.player, pic: v.picOf.get(c.slug) }))));
    } else widgets.push({ decoratedText: { text: `${font(COLOUR.fit, '✓')} Your five is already the best Kobe can enter.`, wrapText: true } });
  }
  return { header: `${name} · level ${v.b.level} · needs ${v.step.target}`, collapsible: false, widgets };
}

function listSections(views) {
  const rows = new Map();
  for (const v of views) for (const r of v.benchRows) if (!r.injury && r.proj != null) rows.set(r.slug, r);
  const all = [...rows.values()];
  const hot = all.filter((r) => r.l5 && r.l15 && r.l5 >= r.l15 + 5).sort((a, b) => (b.l5 - b.l15) - (a.l5 - a.l15)).slice(0, 5);
  const value = [...all].sort((a, b) => b.proj / starsOf(b.tier) - a.proj / starsOf(a.tier)).slice(0, 5);
  const out = [];
  if (hot.length) out.push({ header: '🔥 Hot right now', widgets: hot.map((r) => ({ decoratedText: {
    ...(r.pic ? { startIcon: { iconUrl: r.pic, altText: r.name } } : {}),
    topLabel: `${r.name} · ${STAR(r.tier)} · plays ${when(r.next)}`,
    text: `${font(COLOUR.hot, `<b>${Math.round(r.l5)}</b>`)} lately vs ${Math.round(r.l15)} usual · proj <b>${Math.round(r.proj)}</b>`, wrapText: true } })) });
  if (value.length) out.push({ header: '💎 Best value for your stars', widgets: value.map((r) => ({ decoratedText: {
    ...(r.pic ? { startIcon: { iconUrl: r.pic, altText: r.name } } : {}),
    topLabel: `${r.name} · ${STAR(r.tier)} · plays ${when(r.next)}`,
    text: `proj <b>${Math.round(r.proj)}</b> · ${font(COLOUR.fit, `<b>${(r.proj / starsOf(r.tier)).toFixed(1)}</b> per star`)}`, wrapText: true } })) });
  return out;
}

/* ------------------------------------------------- fixed daily template */
// Owner, 2 Nov 2026: keep it the same every day so it becomes familiar.
// Always these sections, in this order, each with an explicit empty state:
//   1 At a glance   2 Needs your attention   3 My set   4 Team set   5 Worth a look

const boardName = (v) => (v.b.surface.startsWith('team') ? 'Team Set' : 'My Set');
const curProjOf = (v) => v.current.reduce((n, c) => n + (c.proj ?? 0), 0);
const flagged = (v) => v.current.filter((c) => c.injury);
const swapsOf = (v) => {
  if (!v.best.ok || !(v.editable || !v.live)) return null;
  const inNow = new Set(v.current.map((c) => c.slug));
  const ins = v.best.chosen.filter((c) => !inNow.has(c.slug));
  if (v.live && !ins.length) return null;
  const outs = v.current.filter((c) => !v.best.chosen.some((x) => x.slug === c.slug));
  const gain = v.best.chosen.reduce((n, c) => n + c.expected, 0) - curProjOf(v);
  if (v.live && gain < Math.max(5, curProjOf(v) * 0.03)) return null;   // not worth the bother
  return { ins, outs, gain, best: v.best.chosen };
};
/** Where a lineup player stands right now: done, live, did not play, or still to play. */
function playState(c) {
  // The game's own state decides. Sorare's scoreStatus reads REVIEWING while
  // a game is still on (2 Nov: Kessler showed "final" mid Lakers game).
  const g = String(c.gameState ?? '').toLowerCase();
  const st = String(c.scoreStatus ?? '').toUpperCase();
  if (g === 'playing' || g === 'live' || g === 'halftime') return 'live';
  if (g === 'scheduled' || g === 'postponed') return 'upcoming';
  if (g === 'played' || g === 'final' || g === 'ended') {
    if (/DID_NOT_PLAY|DNP|NOT_PLAYED/.test(st) || (c.score ?? 0) === 0 && st === 'FINAL') return (c.score ?? 0) === 0 ? 'dnp' : 'done';
    return 'done';
  }
  // No game state: fall back on the score status, treating REVIEWING as live.
  if (st === 'FINAL') return 'done';
  if (st === 'REVIEWING' || (c.score > 0 && st !== 'PENDING')) return 'live';
  return 'upcoming';
}
const STATE_LABEL = { done: '✅ Final', live: '🔵 Live', dnp: '❌ DNP', upcoming: '⏳ To play' };
/** "1pm", "12:30pm" - short enough not to wrap under a card. */
const shortTime = (iso) => {
  if (!iso) return '?';
  const t = new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: SYD }).replace(/\s/g, '').toLowerCase();
  return t.replace(':00', '').replace(/m$/, '');   // 12:30p / 1p - never wraps under a card
};
const STATE_ICON = { done: '✅', live: '🔵', dnp: '❌', upcoming: '⏳' };
/** Points banked plus what is still to come, for one lineup. */
const liveProj = (v) => v.current.reduce((n, c) => {
  const s2 = playState(c);
  return n + (s2 === 'done' || s2 === 'dnp' ? (c.score ?? 0) : s2 === 'live' ? Math.max(c.score ?? 0, c.proj ?? 0) : (c.proj ?? 0));
}, 0);
const banked = (v) => v.current.reduce((n, c) => n + (playState(c) === 'upcoming' ? 0 : (c.score ?? 0)), 0);
const captionOf = (c) => {
  const s2 = playState(c);
  if (s2 === 'done') return `${Math.round(c.score ?? 0)} Final`;
  if (s2 === 'dnp') return 'DNP';
  if (s2 === 'live') return `${Math.round(c.score ?? 0)} Live`;
  if (c.injury && !/GTD|QUESTION|DOUBT|PROB/i.test(c.injury.status ?? '')) return `Out · ${shortTime(c.next)}`;
  return `${c.proj != null ? Math.round(c.proj) : '?'} · ${shortTime(c.next)}`;
};

const dot = (inj) => (!inj ? '🟢' : /GTD|QUESTION|DOUBT|PROB/i.test(inj.status ?? '') ? '🟠' : '🔴');

function summaryLine(v) {
  const w = glanceSection([v]).widgets[0];
  const { topLabel, ...rest } = w.decoratedText;   // the section heading already names the board
  return { decoratedText: rest };
}

function glanceSection(views) {
  const widgets = views.map((v) => {
    const issues = v.editable || !v.live ? flagged(v).length : 0;   // locked: nothing to watch
    const sw = swapsOf(v);
    const state = !v.live ? `${font(COLOUR.open, '<b>No Lineup</b>')}`
      : v.editable ? `🔓 ${font(COLOUR.open, '<b>Open</b>')} · Locks ${when(v.lockAt)}`
      : `🔒 ${font(COLOUR.locked, '<b>Locked</b>')}`;
    const sq = v.squad;
    let proj, flag;
    if (sq) {
      const short = sq.target - sq.projTop3;
      proj = ` · Squad Top 3 <b>~${Math.round(sq.projTop3)}</b> / ${sq.target}`;
      flag = short <= 0 ? ` · ${font(COLOUR.fit, '<b>On Course</b>')}`
        : sq.toPlay === 0 ? ` · ${font(COLOUR.OUT, `<b>Short ${Math.round(short)}</b>`)}`
        : ` · ${font(COLOUR.GTD, `<b>~${Math.round(short)} Short</b>`)}`;
    } else {
      const lp = v.live ? liveProj(v) : null;
      const left = v.current.filter((c) => playState(c) === 'upcoming' || playState(c) === 'live').length;
      proj = v.live ? ` · <b>~${Math.round(lp)}</b> / ${v.step.target}` : ` · Needs ${v.step.target}`;
      const short = v.live ? v.step.target - lp : 0;
      flag = issues ? ` · ${font(COLOUR.GTD, `<b>${issues} to Watch</b>`)}`
        : sw ? ` · ${font(COLOUR.open, '<b>Swap Suggested</b>')}`
        : !v.live ? ''
        : short > 0 ? ` · ${font(left ? COLOUR.GTD : COLOUR.OUT, `<b>~${Math.round(short)} Short</b>`)}`
        : ` · ${font(COLOUR.fit, '<b>On Course</b>')}`;
    }
    return { decoratedText: { topLabel: `${boardName(v).toUpperCase()} · LEVEL ${v.b.level}`, text: state + proj + flag, wrapText: true } };
  });
  return { header: '1 · At a glance', widgets };
}

function attentionSection(views, extraLines = []) {
  const widgets = extraLines.map((t) => ({ textParagraph: { text: t } }));
  for (const v of views) {
    // Only what can still be acted on: a locked lineup's injuries are FYI,
    // shown under that lineup instead.
    if (v.editable || !v.live) for (const c of flagged(v)) widgets.push(playerRow(c, { full: true }));
    const sw = swapsOf(v);
    if (sw) {
      widgets.push({ decoratedText: {
        topLabel: `${boardName(v)} · suggested ${v.live ? 'swap' : 'five'}${v.live ? ` (${font(COLOUR.fit, `+${Math.round(sw.gain)}`)})` : ''}`,
        text: v.live ? `In: <b>${sw.ins.map((c) => c.player).join(', ')}</b><br>Out: ${sw.outs.map((c) => c.name).join(', ')}`
          : `<b>${sw.best.map((c) => c.player).join(', ')}</b> · proj ${Math.round(sw.best.reduce((n, c) => n + c.expected, 0))}`,
        wrapText: true } });
      widgets.push(cardGrid(sw.best.map((c) => ({ name: `${c.player.split(' ').pop()} ${STAR(c.tier)}`, pic: v.picOf.get(c.slug), caption: `${Math.round(c.expected)} · ${shortTime(c.kickoff)}` }))));
    }
  }
  if (!widgets.length) widgets.push({ decoratedText: { text: `✅ ${font(COLOUR.fit, '<b>Nothing Needs You</b>')}`, wrapText: true } });
  return { header: 'Needs Your Attention', widgets };
}

function lineupSection(n, v) {
  if (!v) return { header: `${n} · Lineup`, widgets: [{ textParagraph: { text: 'No board.' } }] };
  const name = boardName(v);
  // No team lineup in: recommend one (owner, 2 Nov 2026), only if it can be entered.
  if (v.b.surface.startsWith('team') && !v.live) {
    const head = { header: `${name} · Level ${v.b.level}` };
    if (v.step.state === 'PRE_MATCHDAY_LOCKED') {
      return { ...head, widgets: [{ textParagraph: { text: `Not open yet - opens ${v.opensAt ? when(v.opensAt) : 'at the next matchday'}. A recommended five will be here once it opens.` } }] };
    }
    if (!v.aiPick?.ok) return { ...head, widgets: [{ textParagraph: { text: 'No lineup in, and not enough cards with games still to come for a five.' } }] };
    const lockAt = v.aiPick.chosen.map((x) => x.kickoff).filter(Boolean).sort()[0];
    const proj = v.aiPick.chosen.reduce((t, x) => t + x.expected, 0);
    return { ...head, widgets: [
      { decoratedText: { topLabel: `No lineup in · recommended five · enter before ${when(lockAt)}`, text: `${font(COLOUR.open, '<b>Put a team in</b>')} · proj <b>${Math.round(proj)}</b> toward the squad's ${v.step.target} · ${v.aiPick.chosen.reduce((t, x) => t + starsOf(x.tier), 0)}★ of ${v.cap}`, wrapText: true } },
      cardGrid(v.aiPick.chosen.map((x) => ({ name: `${x.player.split(' ').pop()} ${STAR(x.tier)}`, pic: v.picOf.get(x.slug), caption: `${Math.round(x.expected)} · ${shortTime(x.kickoff)}` }))),
    ] };
  }
  if (!v.live) return { header: `${name} · Level ${v.b.level}`, widgets: [summaryLine(v), { textParagraph: { text: 'No lineup in yet - see the AI pick below.' } }] };
  // A locked lineup's pending GTD is noise - nothing can be changed. It is
  // only mentioned once decided (cleared or ruled out), as late news.
  const fyi = [];
  const squadRows = v.squad ? [{ decoratedText: { topLabel: `SQUAD TOP 3 vs ${v.squad.target} · ${v.squad.toPlay} player(s) still to play`,
    text: v.squad.lineups.slice(0, 5).map((l, i) => `${i < 3 ? '<b>' : ''}${i + 1}. ${l.who}${l.mine ? ' (you)' : ''}: ${Math.round(l.live)} now → ~${Math.round(l.proj)}${i < 3 ? '</b>' : ''}`).join('<br>'), wrapText: true } }] : [];
  // Team set: one line, the squad's top three against the target (owner: "super simple").
  if (v.squad && v.live) {
    // One line, no heading (owner): name and level lead the status.
    const line = summaryLine(v);
    line.decoratedText.text = `<b>${name} · Level ${v.b.level}</b> · ${line.decoratedText.text}`;
    return { widgets: [line] };
  }

  // Status on the left, the key on the right, one line (owner, 2 Nov 2026).
  const statusRow = { columns: { columnItems: [
    { horizontalSizeStyle: 'FILL_AVAILABLE_SPACE', horizontalAlignment: 'START', verticalAlignment: 'CENTER', widgets: [summaryLine(v)] },
    { horizontalSizeStyle: 'FILL_MINIMUM_SPACE', horizontalAlignment: 'END', verticalAlignment: 'CENTER',
      widgets: [{ textParagraph: { text: font(COLOUR.locked, '✅Final 🔵Live ⏳To Play 🟠GTD ❌Out') } }] },
  ] } };
  return { header: `${name} · Level ${v.b.level}`, widgets: [statusRow, ...squadRows, ...fyi, cardGrid(v.current.map((c) => {
    const st = playState(c);
    // Undecided players get their own icon, locked or not (owner): 🟠 GTD,
    // ❌ when ruled out. It is a status, not a call to action.
    const icon = st === 'upcoming' && c.injury ? (/GTD|QUESTION|DOUBT|PROB/i.test(c.injury.status ?? '') ? '🟠' : '❌') : STATE_ICON[st];
    // Two lines only: name, then icon + number + time (an icon beside a long
    // name like Wembanyama pushed it onto three).
    return { name: c.name.split(' ').pop(), pic: c.pic, caption: `${icon} ${captionOf(c)}` };
  }))] };
}

function worthSection(views) {
  const inLineups = new Set(views.flatMap((v) => v.current.map((c) => c.slug)));
  const rows = new Map();
  for (const v of views) for (const r of v.benchRows) if (!r.injury && r.proj != null && !inLineups.has(r.slug)) rows.set(r.slug, r);
  const all = [...rows.values()];
  const hot = all.filter((r) => r.l5 && r.l15 && r.l5 >= r.l15 + 5).sort((a, b) => (b.l5 - b.l15) - (a.l5 - a.l15)).slice(0, 6);
  const value = all.filter((r) => !hot.includes(r)).sort((a, b) => b.proj / starsOf(b.tier) - a.proj / starsOf(a.tier)).slice(0, 6);
  // Full name and team instead of a picture (owner): "Jaxson Hayes / Jazz · 1.5★".
  const nick = (team) => {
    if (!team) return '';
    const t = team.replace(/^Los Angeles /, 'LA ');
    const two = ['Trail Blazers'];
    for (const x of two) if (t.endsWith(x)) return x;
    return t.split(' ').pop();
  };
  // The owner's format: "Projected 21 - 12:30pm @ Grizzlies".
  const fullTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: SYD }).replace(/\s/g, '').toLowerCase().replace(':00', '') : '?');
  const game = (r) => `${fullTime(r.next)}${r.opp ? ` ${r.home ? 'vs' : '@'} ${nick(r.opp)}` : ''}`;
  const item = (r, text) => ({ decoratedText: {
    // One line, same font, kept short enough to fit.
    // Name big on top, projection and game smaller underneath (owner).
    text: `${r.name}${r.team ? ` / ${nick(r.team)}` : ''} · ${STAR(r.tier)}`, bottomLabel: `${text.replace(/<[^>]+>/g, '')} - ${game(r)}`, wrapText: true } });
  // Heading and its list in ONE column, both left-aligned: Chat always draws
  // these rows from the left, so a centred heading never lines up with them.
  const col = (title, list, fmt) => ({ horizontalSizeStyle: 'FILL_AVAILABLE_SPACE', horizontalAlignment: 'START', verticalAlignment: 'TOP',
    widgets: [{ textParagraph: { text: `<b>${title}</b>` } }, ...(list.length ? list.map(fmt) : [{ textParagraph: { text: 'None today' } }])] });
  return { widgets: [{ columns: { columnItems: [
    // Just what he might score (owner): the projection and the game.
    col('🔥 Hot', hot, (r) => item(r, `Projected ${font(COLOUR.hot, `<b>${Math.round(r.proj)}</b>`)}`)),
    col('💎 Value', value, (r) => item(r, `Projected ${font(COLOUR.fit, `<b>${Math.round(r.proj)}</b>`)}`)),
  ] } }] };
}

const footer = (nextAt) => ({ widgets: [{ textParagraph: { text: font(COLOUR.locked, `Next check ${nextAt ? when(nextAt) : 'before the next lock'} · updates post here only when something changes · suggestions only, nothing is changed`) } }] });

function aiPickSection(views) {
  const widgets = [];
  // Solo only (owner, 2 Nov 2026): no squad suggestions.
  for (const v of views.filter((x) => !x.b.surface.startsWith('team'))) {
    if (!v.aiPick?.ok) { widgets.push({ textParagraph: { text: 'Not enough cards with games still to come for a five right now - check back after tonight\'s games.' } }); continue; }
    const proj = v.aiPick.chosen.reduce((n, c) => n + c.expected, 0);
    const chance = v.passChance(proj);
    // Owner, 2 Nov 2026: only suggest a team with a 60%+ chance to pass.
    if (chance < 60) {
      widgets.push({ textParagraph: { text: `No team at 60%+ yet · Best ${font(COLOUR.GTD, `<b>${chance}%</b>`)}` } });
      continue;
    }
    const c = chance >= 50 ? COLOUR.fit : chance >= 25 ? COLOUR.GTD : COLOUR.OUT;
    const lockAt = v.aiPick.chosen.map((x) => x.kickoff).filter(Boolean).sort()[0];
    widgets.push({ decoratedText: {
      topLabel: `${v.aiSecond ? 'Second team ("Add Team Now")' : 'Best five'} · Enter before ${when(lockAt)}`,
      text: `${font(c, `<b>${chance}% to pass</b>`)} · Proj <b>${Math.round(proj)}</b> / ${v.step.target} · ${v.aiPick.chosen.reduce((n, x) => n + starsOf(x.tier), 0)}★ of ${v.cap}`,
      wrapText: true } });
    widgets.push(cardGrid(v.aiPick.chosen.map((x) => ({ name: `${x.player.split(' ').pop()} ${STAR(x.tier)}`, pic: v.picOf.get(x.slug), caption: `${Math.round(x.expected)} · ${shortTime(x.kickoff)}` }))));
  }
  // Nothing to suggest: one line, no heading (owner).
  if (widgets.length === 1 && widgets[0].textParagraph && /No team at/.test(widgets[0].textParagraph.text)) {
    return { widgets: [{ textParagraph: { text: `<b>AI Pick</b> · ${widgets[0].textParagraph.text}` } }] };
  }
  return { header: 'AI Pick', widgets };
}

function dailyCard(views, dateLine, nextAt, extraAttention = []) {
  const mine = views.find((v) => !v.b.surface.startsWith('team'));
  const team = views.find((v) => v.b.surface.startsWith('team'));
  return card('daily', '🏀 Kobe NBA · Daily Briefing', dateLine, [
    attentionSection(views, extraAttention.filter((l) => l.actionable).map((l) => l.line)),
    lineupSection(2, mine), lineupSection(3, team),
    ...fyiSection(extraAttention.filter((l) => !l.actionable).map((l) => l.line)),
    worthSection(views), aiPickSection(views),
  ]);
}
const fyiSection = (lines) => (lines.length ? [{ header: 'News on locked lineups (FYI)', widgets: lines.map((t) => ({ textParagraph: { text: t } })) }] : []);
function updateCard(views, dateLine, lines, nextAt, title = '🏀 Kobe NBA · Update') {
  const act = lines.filter((l) => l.actionable).map((l) => l.line);
  const info = lines.filter((l) => !l.actionable).map((l) => l.line);
  return card('update', title, dateLine, [...(act.length ? [attentionSection(views, act)] : []), ...fyiSection(info)]);
}

// One header line: title and date together (owner: "make it all 1 line").
const card = (id, title, subtitle, sections) => [{ cardId: id, card: { header: { title: subtitle ? `${title} · ${subtitle}` : title }, sections } }];

function describeBoard(v) {
  const L = [];
  const name = v.b.surface.startsWith('team') ? 'Team set' : 'My set';
  L.push(`*${name}* - level ${v.b.level}, needs ${v.step.target}`);
  const curProj = v.current.reduce((s, c) => s + (c.proj ?? 0), 0);
  if (!v.live) L.push('No lineup in.');
  else {
    L.push(v.editable ? `Lineup in, locks ${when(v.lockAt)}. Sorare projects ${Math.round(curProj)}.` : `Locked and playing. Sorare projected ${Math.round(curProj)}.`);
    for (const c of v.current) {
      const flag = c.injury ? ` ⚠️ ${statusOf(c.injury)}` : '';
      L.push(`- ${c.name} ${STAR(c.tier)}: proj ${c.proj != null ? Math.round(c.proj) : '?'}, plays ${when(c.next)}${flag}`);
    }
  }
  if (v.best.ok && (v.editable || !v.live)) {
    const bestProj = v.best.chosen.reduce((s, c) => s + c.expected, 0);
    const inNow = new Set(v.current.map((c) => c.slug));
    const swapsIn = v.best.chosen.filter((c) => !inNow.has(c.slug));
    if (!v.live || swapsIn.length) {
      L.push(`*Best five* (${v.best.chosen.reduce((s, c) => s + starsOf(c.tier), 0)}★ of ${v.cap}, projects ${Math.round(bestProj)}${v.live ? `, +${Math.round(bestProj - curProj)} on yours` : ''}):`);
      for (const c of v.best.chosen) L.push(`- ${c.player} ${STAR(c.tier)}: ${Math.round(c.expected)}${inNow.has(c.slug) ? '' : ' (in)'}`);
      const out = v.current.filter((c) => !v.best.chosen.some((x) => x.slug === c.slug));
      if (out.length) L.push(`Out: ${out.map((c) => c.name).join(', ')}`);
    } else L.push('Your five is already the best Kobe can enter.');
  }
  return L.join('\n');
}

function hotAndValue(views) {
  const rows = new Map();
  for (const v of views) for (const r of v.benchRows) if (!r.injury && r.proj != null) rows.set(r.slug, r);
  const all = [...rows.values()];
  const hot = all.filter((r) => r.l5 && r.l15 && r.l5 >= r.l15 + 5).sort((a, b) => (b.l5 - b.l15) - (a.l5 - a.l15)).slice(0, 5);
  const value = [...all].sort((a, b) => b.proj / starsOf(b.tier) - a.proj / starsOf(a.tier)).slice(0, 5);
  const L = [];
  if (hot.length) L.push('*Hot right now* (last 5 well above last 15):', ...hot.map((r) => `- ${r.name} ${STAR(r.tier)}: ${Math.round(r.l5)} lately vs ${Math.round(r.l15)} usual, proj ${Math.round(r.proj)}`));
  if (value.length) L.push('*Best value for your stars:*', ...value.map((r) => `- ${r.name} ${STAR(r.tier)}: proj ${Math.round(r.proj)} (${(r.proj / starsOf(r.tier)).toFixed(1)} per star), plays ${when(r.next)}`));
  return L.join('\n');
}

/** Statuses worth alerting on: lineup players, and the strongest bench options. */
function watchlist(views) {
  const m = {};
  for (const v of views) {
    for (const c of v.current) m[c.slug] = { name: c.name, status: statusOf(c.injury), inLineup: v.b.surface, editable: v.editable, lockAt: v.lockAt, newsDate: c.news?.date ?? null, row: c };
    for (const r of [...v.benchRows].filter((r) => r.proj != null).sort((a, b) => b.proj - a.proj).slice(0, 12)) {
      if (!m[r.slug]) m[r.slug] = { name: r.name, status: statusOf(r.injury), inLineup: null, proj: r.proj, newsDate: r.news?.date ?? null, row: r };
    }
  }
  return m;
}

export async function advise({ force = false, dryRun = false } = {}) {
  guard();
  if (!dryRun && !chatSpace()) return { skipped: true, reason: 'no Chat space yet' };
  const st = await readState();
  const now = Date.now();
  const today = sydDay(now);
  // Driven by the real NBA schedule, not a fixed window. The plan (built on
  // the previous check) holds: the briefing time - about 2.5 hours before the
  // day's first tip-off - and checks at 120 / 60 / 30 / 12 minutes before
  // each open lineup locks, which is when injury reports and game-time calls
  // land and a swap is still possible.
  const plan = st.advisorPlan ?? [];
  const last = st.advisorCheckedAt ?? 0;
  const planned = plan.find((t) => Date.parse(t) > last && Date.parse(t) <= now);
  const briefAt = st.advisorBriefAt ? Date.parse(st.advisorBriefAt) : null;
  const briefingDue = st.advisorBriefed !== today && (briefAt ? now >= briefAt : sydHour(now) >= 7);
  // A safety net: never more than 6 hours without a look, so a new lineup or
  // a schedule change is picked up even if the plan is stale.
  const stale = now - last > 6 * 3600e3;
  if (!force && !briefingDue && !planned && !stale) return { skipped: true };

  const { boards, nickname } = await resolveBoards();
  NICK = nickname;
  const views = [];
  for (const b of boards) { try { views.push(await boardView(b)); } catch (err) { views.push({ b, error: err.message }); } }
  const ok = views.filter((v) => !v.error);
  const locks = ok.filter((v) => v.editable && v.lockAt).map((v) => v.lockAt).sort();

  const messages = [];
  const dateLine = new Date(now).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: SYD });
  const nextAt = (st.advisorPlan ?? []).find((t) => Date.parse(t) > now) ?? null;
  if (briefingDue || force) {
    messages.push({
      text: [`🏀 Kobe NBA - ${dateLine}`, ...ok.map(describeBoard), hotAndValue(ok)].filter(Boolean).join('\n\n'),
      cards: null,   // built below, once late news is known
    });
  }

  // Late news since the last check: status changes, and fresh news on any
  // lineup player - locked or not, so a Kyrie-type call is never missed.
  const watch = watchlist(ok);
  const before = st.advisorWatch ?? {};
  const alertRows = [];
  for (const [slug, w] of Object.entries(watch)) {
    const prev = before[slug];
    if (!prev) continue;
    const where = w.inLineup ? (w.inLineup.startsWith('team') ? 'team set' : 'set') : null;
    const lock = w.editable ? `, which locks ${when(w.lockAt)} - consider a swap` : ' (locked - for your information)';
    let line = null;
    const lockedHere = where && !w.editable;
    if (prev.status !== w.status) {
      if (lockedHere) {
        // Locked: only the decision matters - cleared, or ruled out.
        if (w.status === 'fit') line = `✅ <b>${w.name}</b> is cleared to play - in your ${where}.`;
        else if (/^OUT/i.test(w.status)) line = `🔴 <b>${w.name}</b> is ruled out - your ${where} loses his points.`;
      } else if (where && w.status !== 'fit') line = `⚠️ <b>${w.name}</b> is now ${w.status} - in your ${where}${lock}.`;
      else if (where && w.status === 'fit') line = `✅ <b>${w.name}</b> is cleared to play (was ${prev.status}) - in your ${where}.`;
      else if (!where && w.status === 'fit') line = `🟢 <b>${w.name}</b> is available again (was ${prev.status}) - worth a look if a lineup is still open.`;
    } else if (where && w.editable && w.newsDate && w.newsDate !== prev.newsDate) {
      line = `📰 New update on <b>${w.name}</b> - in your ${where}, locks ${when(w.lockAt)}.`;
    }
    if (line) alertRows.push({ line, row: w.row, actionable: !w.inLineup || !!w.editable });
  }
  const lines = alertRows.map((a) => ({ line: a.line, actionable: a.actionable }));
  if (briefingDue || force) {
    messages[0].cards = dailyCard(ok, dateLine, nextAt, lines);
    if (lines.length) messages[0].text += `\n\nLate news\n${lines.map((l) => l.line.replace(/<[^>]+>/g, '')).join('\n')}`;
  } else if (lines.length) {
    messages.push({ text: ['🏀 Kobe NBA - update', ...lines.map((l) => l.line.replace(/<[^>]+>/g, ''))].join('\n'), cards: updateCard(ok, dateLine, lines, nextAt) });
  }

  // One reminder per open lineup, about an hour before it locks, only if a
  // better five exists (5%+ on Sorare's projections).
  const reminded = { ...(st.advisorReminded ?? {}) };
  if (!(briefingDue || force)) {
    for (const v of ok) {
      if (!v.editable || !v.lockAt || reminded[v.lockAt]) continue;
      const mins = (Date.parse(v.lockAt) - now) / 60000;
      if (mins > 75 || mins < 5) continue;
      const cur = v.current.reduce((n, c) => n + (c.proj ?? 0), 0);
      const best = v.best.ok ? v.best.chosen.reduce((n, c) => n + c.expected, 0) : 0;
      reminded[v.lockAt] = true;
      if (best > cur * 1.05) {
        messages.push({ text: `⏰ Kobe NBA - locks in ${Math.round(mins)} min\n\n${describeBoard(v)}`,
          cards: updateCard(ok, dateLine, [{ line: `⏰ <b>${boardName(v)}</b> locks in <b>${Math.round(mins)} min</b> and a better five is available.`, actionable: true }], nextAt, `🏀 Kobe NBA · Locks in ${Math.round(mins)} min`) });
      }
    }
  }

  if (dryRun) return { messages, nickname };
  if (briefingDue || force) await logProjections(ok).catch(() => {});
  const sent = [];
  for (const m of messages) {
    const r = await postCard(m.cards, '');   // the card carries its own title; text above it doubled it
    sent.push(r.sent ? r : await postChat(m.text));   // plain text if a card is refused
  }
  // Next plan: checks before each open lineup's lock, and tomorrow's
  // briefing from the earliest tip-off still ahead on Kobe's bench.
  const offsets = [120, 60, 30, 12];
  // Also before the tip-off of any undecided (GTD) player in a LOCKED lineup,
  // so "cleared to play" or "ruled out" arrives as soon as it is called.
  const gtdTips = ok.filter((v) => v.live && !v.editable)
    .flatMap((v) => v.current.filter((c) => c.injury && playState(c) === 'upcoming' && c.next).map((c) => c.next));
  const tipOffsets = [90, 45, 20, 5];
  const nextPlan = [...new Set([
    ...locks.flatMap((l) => offsets.map((m) => new Date(Date.parse(l) - m * 60e3).toISOString())),
    ...gtdTips.flatMap((t) => tipOffsets.map((m) => new Date(Date.parse(t) - m * 60e3).toISOString())),
  ])].filter((t) => Date.parse(t) > now).sort();
  const tips = ok.flatMap((v) => v.benchRows.map((r) => r.next)).filter((t) => t && Date.parse(t) > now).sort();
  const firstTomorrow = tips.find((t) => sydDay(Date.parse(t)) !== today) ?? null;
  const briefNext = firstTomorrow ? new Date(Date.parse(firstTomorrow) - 150 * 60e3).toISOString() : null;
  await writeState({
    advisorCheckedAt: now, advisorWatch: Object.fromEntries(Object.entries(watch).map(([k, w]) => { const { row, ...rest } = w; return [k, rest]; })), advisorNextLock: locks[0] ?? null,
    advisorPlan: nextPlan, advisorReminded: reminded, ...(briefNext ? { advisorBriefAt: briefNext } : {}),
    ...(briefingDue || force ? { advisorBriefed: today } : {}),
  });
  return { messages, sent, nickname };
}
