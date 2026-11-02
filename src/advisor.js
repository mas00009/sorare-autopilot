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
import { postChat, chatSpace } from './chat.js';

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
    const d = await gql(`query($s:[String!]){ players(slugs:$s) { slug ... on NBAPlayer { displayName gameplayTier nextClassicFixtureProjectedScore activeInjuries { status kind expectedEndDate } anyFutureGameStats(first: 1) { anyGame { date } } } } }`, { s: list.slice(i, i + 25) });
    for (const p of d.players ?? []) {
      out.set(p.slug, { proj: p.nextClassicFixtureProjectedScore ?? null, injury: (p.activeInjuries ?? [])[0] ?? null,
        name: p.displayName, tier: p.gameplayTier, next: p.anyFutureGameStats?.[0]?.anyGame?.date ?? null });
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
    return { slug, name: p.name ?? a.anyPlayer?.displayName, tier: p.tier, proj: p.proj, injury: p.injury, next: p.next };
  });
  const benchRows = bench.map((n) => {
    const p = P.get(n.player?.slug) ?? {};
    return { slug: n.player?.slug, name: n.player?.displayName, tier: n.player?.gameplayTier, proj: p.proj, injury: p.injury,
      l5: n.formL5, l15: n.averageScore, next: n.player?.anyFutureGameStats?.[0]?.anyGame?.date ?? null };
  });
  return { b, step, live, editable, lockAt, current, benchRows, best, cap: opts.starsCap };
}

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
    for (const c of v.current) m[c.slug] = { name: c.name, status: statusOf(c.injury), inLineup: v.b.surface, editable: v.editable, lockAt: v.lockAt };
    for (const r of [...v.benchRows].filter((r) => r.proj != null).sort((a, b) => b.proj - a.proj).slice(0, 12)) {
      if (!m[r.slug]) m[r.slug] = { name: r.name, status: statusOf(r.injury), inLineup: null, proj: r.proj };
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
  if (briefingDue || force) {
    messages.push([`🏀 *Kobe NBA - ${new Date(now).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: SYD })}*`,
      ...ok.map(describeBoard), hotAndValue(ok)].filter(Boolean).join('\n\n'));
  }

  // Late news since the last check.
  const watch = watchlist(ok);
  const before = st.advisorWatch ?? {};
  const alerts = [];
  for (const [slug, w] of Object.entries(watch)) {
    const was = before[slug]?.status;
    if (was === undefined || was === w.status) continue;
    if (w.inLineup && w.status !== 'fit') {
      alerts.push(`⚠️ *${w.name}* is now ${w.status} - in your ${w.inLineup.startsWith('team') ? 'team set' : 'set'}${w.editable ? `, which locks ${when(w.lockAt)}. Consider a swap.` : ' (locked, nothing to change).'}`);
    } else if (w.inLineup && w.status === 'fit') {
      alerts.push(`✅ *${w.name}* is cleared to play (was ${was}) - in your ${w.inLineup.startsWith('team') ? 'team set' : 'set'}.`);
    } else if (!w.inLineup && w.status === 'fit' && was !== 'fit') {
      alerts.push(`🟢 *${w.name}* is available again (was ${was}), proj ${Math.round(w.proj ?? 0)} - worth a look if a lineup is still open.`);
    }
  }
  if (alerts.length && !(briefingDue || force)) messages.push(['🏀 *Kobe NBA - late news*', ...alerts].join('\n'));
  else if (alerts.length) messages[0] += `\n\n*Late news*\n${alerts.join('\n')}`;

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
      if (best > cur * 1.05) messages.push(`⏰ *Kobe NBA - locks in ${Math.round(mins)} min*\n\n${describeBoard(v)}`);
    }
  }

  if (dryRun) return { messages, nickname };
  const sent = [];
  for (const m of messages) sent.push(await postChat(m));
  // Next plan: checks before each open lineup's lock, and tomorrow's
  // briefing from the earliest tip-off still ahead on Kobe's bench.
  const offsets = [120, 60, 30, 12];
  const nextPlan = [...new Set(locks.flatMap((l) => offsets.map((m) => new Date(Date.parse(l) - m * 60e3).toISOString())))]
    .filter((t) => Date.parse(t) > now).sort();
  const tips = ok.flatMap((v) => v.benchRows.map((r) => r.next)).filter((t) => t && Date.parse(t) > now).sort();
  const firstTomorrow = tips.find((t) => sydDay(Date.parse(t)) !== today) ?? null;
  const briefNext = firstTomorrow ? new Date(Date.parse(firstTomorrow) - 150 * 60e3).toISOString() : null;
  await writeState({
    advisorCheckedAt: now, advisorWatch: watch, advisorNextLock: locks[0] ?? null,
    advisorPlan: nextPlan, advisorReminded: reminded, ...(briefNext ? { advisorBriefAt: briefNext } : {}),
    ...(briefingDue || force ? { advisorBriefed: today } : {}),
  });
  return { messages, sent, nickname };
}
