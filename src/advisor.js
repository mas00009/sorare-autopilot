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

/** Everything the advice needs for one board. */
async function boardView(b) {
  const step = await fetchStep(b.stepId);
  const live = liveLineupOf(step);
  const apps = live?.taskAppearances ?? [];
  const editable = !!live && live.updatable !== false;
  const lockAt = apps.map((a) => a.lockedAt).filter(Boolean).sort()[0] ?? null;
  const mine = apps.length ? await fetchPlayersOnBench(b.stepId, apps) : [];
  const bench = await fetchBench(b.stepId);
  const P = await projections([...apps.map((a) => a.anyPlayer?.slug), ...bench.map((n) => n.player?.slug)]);
  const withProj = (n) => {
    const p = P.get(n.player?.slug);
    // Feed Sorare's projection to the picker in place of the averages.
    return p?.proj != null ? { ...n, averageScore: p.proj, formL5: p.proj, sorareProj: p.proj } : n;
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
      news: p.news, pic: a.pictureUrl ?? null };
  });
  const benchRows = bench.map((n) => {
    const p = P.get(n.player?.slug) ?? {};
    return { slug: n.player?.slug, name: n.player?.displayName, tier: n.player?.gameplayTier, proj: p.proj, injury: p.injury,
      l5: n.formL5, l15: n.averageScore, next: n.player?.anyFutureGameStats?.[0]?.anyGame?.date ?? null,
      news: p.news, pic: n.pictureUrl ?? null };
  });
  const picOf = new Map([...mine, ...bench].map((n) => [n.player?.slug, n.pictureUrl]));
  return { b, step, live, editable, lockAt, current, benchRows, best, cap: opts.starsCap, picOf, newsOf: (slug) => P.get(slug)?.news ?? null };
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
  items: rows.map((r) => ({ image: { imageUri: r.pic ?? 'https://sorare.com/favicon.ico', altText: r.name }, title: r.name, textAlignment: 'CENTER' })),
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

const card = (id, title, subtitle, sections) => [{ cardId: id, card: { header: { title, subtitle }, sections } }];

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
  const views = [];
  for (const b of boards) { try { views.push(await boardView(b)); } catch (err) { views.push({ b, error: err.message }); } }
  const ok = views.filter((v) => !v.error);
  const locks = ok.filter((v) => v.editable && v.lockAt).map((v) => v.lockAt).sort();

  const messages = [];
  const dateLine = new Date(now).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: SYD });
  if (briefingDue || force) {
    messages.push({
      text: [`🏀 Kobe NBA - ${dateLine}`, ...ok.map(describeBoard), hotAndValue(ok)].filter(Boolean).join('\n\n'),
      cards: card('brief', '🏀 Kobe NBA', `${dateLine} · suggestions only, nothing is changed`, [...ok.map(boardSection), ...listSections(ok)]),
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
    if (prev.status !== w.status) {
      if (where && w.status !== 'fit') line = `⚠️ <b>${w.name}</b> is now ${w.status} - in your ${where}${lock}.`;
      else if (where && w.status === 'fit') line = `✅ <b>${w.name}</b> is cleared to play (was ${prev.status}) - in your ${where}.`;
      else if (!where && w.status === 'fit') line = `🟢 <b>${w.name}</b> is available again (was ${prev.status}) - worth a look if a lineup is still open.`;
    } else if (where && w.newsDate && w.newsDate !== prev.newsDate) {
      line = `📰 New update on <b>${w.name}</b> - in your ${where}${w.editable ? `, locks ${when(w.lockAt)}` : ' (locked)'}.`;
    }
    if (line) alertRows.push({ line, row: w.row });
  }
  if (alertRows.length) {
    const sections = [{ header: 'Late news', widgets: alertRows.flatMap((a) => [{ textParagraph: { text: a.line } }, ...(a.row ? [playerRow(a.row, { full: true })] : [])]) }];
    const text = ['🏀 Kobe NBA - late news', ...alertRows.map((a) => a.line.replace(/<[^>]+>/g, ''))].join('\n');
    if (briefingDue || force) { messages[0].cards[0].card.sections.splice(0, 0, ...sections); messages[0].text += `\n\n${text}`; }
    else messages.push({ text, cards: card('news', '🏀 Kobe NBA · late news', dateLine, sections) });
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
          cards: card('lock', `⏰ Kobe NBA · locks in ${Math.round(mins)} min`, 'a better five is available', [boardSection(v)]) });
      }
    }
  }

  if (dryRun) return { messages, nickname };
  const sent = [];
  for (const m of messages) {
    const r = await postCard(m.cards, m.text.split('\n')[0]);
    sent.push(r.sent ? r : await postChat(m.text));   // plain text if a card is refused
  }
  // Next plan: checks before each open lineup's lock, and tomorrow's
  // briefing from the earliest tip-off still ahead on Kobe's bench.
  const offsets = [120, 60, 30, 12];
  const nextPlan = [...new Set(locks.flatMap((l) => offsets.map((m) => new Date(Date.parse(l) - m * 60e3).toISOString())))]
    .filter((t) => Date.parse(t) > now).sort();
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
