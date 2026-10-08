/**
 * Run journal + email.
 *
 * Every pass appends a line to state/reports/<date>.jsonl. Two things go out by
 * mail: an immediate alert when a 4- or 5-star card drops, and one digest per day
 * covering lineup changes, claims and essence spent.
 *
 * Mail goes via curl's SMTP support so there is no dependency to install and no
 * long-lived process. It needs a Gmail app password in .env (SMTP_USER,
 * SMTP_APP_PASSWORD, REPORT_TO) - created by the account owner, never by Claude.
 * With those unset, everything still runs and the journal is still written; only
 * delivery is skipped.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'state', 'reports');
export const OUTBOX = path.join(ROOT, 'state', 'outbox');

/**
 * Queue a message for delivery.
 *
 * Outbound SMTP is blocked on this network (ports 25/465/587 all refused), so
 * mail cannot be sent from the scheduled job itself. Instead each message is
 * written here and a separate Claude scheduled task drains the folder over
 * HTTPS via the Gmail connector. Queuing never fails the run.
 */
export async function queueMail(subject, body) {
  await fs.mkdir(OUTBOX, { recursive: true });
  const name = `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.txt`;
  await fs.writeFile(path.join(OUTBOX, name), `Subject: ${subject}\n\n${body}\n`, 'utf8');
  return { queued: true, file: name };
}

const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function mailConfigured(env = process.env) {
  return !!(env.SMTP_USER && env.SMTP_APP_PASSWORD && env.REPORT_TO);
}

/** Send one plain-text mail. Returns {sent, reason}. */
export async function sendMail(subject, body, env = process.env) {
  if (!mailConfigured(env)) return { sent: false, reason: 'mail not configured (SMTP_USER / SMTP_APP_PASSWORD / REPORT_TO)' };

  const host = env.SMTP_HOST ?? 'smtp.gmail.com';
  const port = env.SMTP_PORT ?? '587';
  const msg =
    `From: Sorare Autopilot <${env.SMTP_USER}>\r\n` +
    `To: ${env.REPORT_TO}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `${body}\r\n`;

  const tmp = path.join(DIR, `.mail-${Date.now()}.txt`);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(tmp, msg, 'utf8');
  try {
    await run('curl', [
      '--silent', '--show-error', '--ssl-reqd',
      `smtp://${host}:${port}`,
      '--mail-from', env.SMTP_USER,
      '--mail-rcpt', env.REPORT_TO,
      '--upload-file', tmp,
      '--user', `${env.SMTP_USER}:${env.SMTP_APP_PASSWORD}`,
    ], { timeout: 30_000 });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err.stderr || err.message || '').toString().slice(0, 200) };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Failure alerting.
 *
 * Everything else assumes someone reads the log. Nobody reads the log. A run
 * that dies - expired token, changed schema, launchd stopped - would otherwise
 * be invisible until a gameweek was already lost. Alert once per streak rather
 * than on every pass, so a broken morning is one email and not ninety.
 */
const FAIL_STREAK_ALERT = 3;

export async function trackHealth(entry, state, write) {
  const failed = (entry.errors ?? []).length > 0;
  const streak = failed ? (state.failStreak ?? 0) + 1 : 0;
  await write({ failStreak: streak, lastFailAt: failed ? Date.now() : state.lastFailAt ?? null });

  // Recovered after having alerted - say so, then reset.
  if (!failed && state.failAlerted) {
    await write({ failAlerted: false });
    return { recovered: true };
  }
  if (streak >= FAIL_STREAK_ALERT && !state.failAlerted) {
    await write({ failAlerted: true });
    return { alert: true, streak };
  }
  return {};
}

/**
 * Sorare's task identifiers are internal names, not English. Anything a person
 * reads - the dashboard, the daily email - gets the readable form.
 */
const TASK_NAMES = {
  DAILY_ACTION: 'Daily training',
  DECISIVE_PLAYER_PICKER: 'Decisive player picker',
  CARDS_COUNT_TARGET: 'Collect cards',
  COMPLETE_COLLECTIONS_COUNT_TARGET: 'Complete a collection',
  TASK_APPEARANCE_SCORE: 'Player hits 100 points',
  TASKS_TRACK: 'Collection track',
};
/** A player slug reads badly in a report; this is the readable fallback. */
export const humanSlug = (s) => String(s ?? '')
  .split('-').filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

export const humanTask = (n) => TASK_NAMES[n]
  ?? String(n ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Append this pass to today's journal. */
export async function journal(report) {
  await fs.mkdir(DIR, { recursive: true });
  const entry = {
    at: report.startedAt,
    lineups: (report.lineups ?? []).map((l) => {
      // The delta carries slugs. Resolve them to the names on the cards while
      // the lineup is still in hand, so the report never has to guess.
      const names = new Map((l.lineup ?? []).map((c) => [c.slug, c.player]));
      const named = (slugs) => (slugs ?? []).map((s) => names.get(s) ?? humanSlug(s));
      return {
        surface: l.surface, action: l.action ?? (l.skipped ? 'skipped' : null),
        reason: l.reason ?? null,
        in: named(l.delta?.in), out: named(l.delta?.out),
        projected: l.projected ?? null,
        target: l.target ?? null,
        // The team as it stood on this pass, slim enough to keep on every line.
        // Without it the daily mail would have to re-fetch a lineup that has
        // since moved on, or show nothing.
        // What is actually entered wins. Only when nothing is entered does the
        // pick stand in, because then it is what the next pass will submit.
        five: (l.inPlay?.length ? l.inPlay : (l.lineup ?? []).slice(0, 5).map((c) => ({
          name: c.player, slug: c.slug, pos: c.position, pic: c.picture,
          exp: c.expected, opp: c.opponent ?? null, home: c.home ?? null,
          captain: c.slug === l.captain?.slug,
        }))),
        entered: !!l.inPlay?.length,
        enteredProjection: l.enteredProjection ?? null,
      };
    }),
    claimed: (report.missions?.claimed ?? []).map((t) => ({ name: t.name, description: t.description ?? null })),
    rewards: report.missions?.balanceDelta ?? [],
    stepClaims: (report.lineups ?? [])
      .filter((l) => l.action === 'claimed' || l.action === 'restarted')
      .map((l) => ({ surface: l.surface, action: l.action, reason: l.reason })),
    essenceSpent: report.packs?.spent ?? 0,
    // Lineups that reached a final state on this pass, with Sorare's scores,
    // so the daily mail can show what each card made.
    finished: (report.finishedLineups ?? []),
    // The balances as they stood at the end of this pass, so the daily mail can
    // say where things actually are rather than only what moved.
    essence: report.packs?.essenceAfter ?? report.packs?.essenceBefore ?? null,
    gems: (report.gems ?? []).reduce((n, b) => n + (b.amount ?? 0), 0) || null,
    pulls: (report.packs?.opened ?? []).flatMap((o) => o.cards ?? []),
    errors: [report.lineupError, report.missionsError, ...(report.missions?.errors ?? [])].filter(Boolean),
  };
  await fs.appendFile(path.join(DIR, `${today()}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** Alert threshold: 3 stars and up. */
export const ALERT_STARS = 3;

export function bigPulls(entry) {
  return (entry.pulls ?? []).filter((c) => (c.stars ?? 0) >= ALERT_STARS);
}

/**
 * Send, trying each route in turn.
 *
 *   1. Gmail REST over HTTPS - works headless on this network
 *   2. SMTP - blocked here, but kept in case the block is ever lifted
 *   3. Outbox - queued for the scheduled task to pick up
 */
export async function deliver(subject, body, { html = null, env = process.env } = {}) {
  const to = env.REPORT_TO;
  if (to) {
    try {
      const gmail = await import('./gmail.js');
      const res = await gmail.send({ to, subject, body, html });
      if (res.sent) return res;
      var gmailReason = res.reason;
    } catch (err) { var gmailReason = err.message; }
  }

  const smtp = await sendMail(subject, body, env);
  if (smtp.sent) return { ...smtp, via: 'smtp' };

  const q = await queueMail(subject, body);
  return {
    sent: false, queued: true, via: 'outbox', file: q.file,
    reason: `gmail: ${gmailReason ?? 'no recipient'} | smtp: ${smtp.reason}`,
  };
}

export async function alertBigPull(cards) {
  const sorted = [...cards].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  const list = sorted.map((c) => `  ${c.name} - ${c.stars}-star (${c.tier})`).join('\n');
  const top = sorted[0];
  return deliver(
    `Sorare: ${top.name} - ${top.stars} star${sorted.length > 1 ? ` (+${sorted.length - 1} more)` : ''}`,
    `Pulled from an essence pack just now:\n\n${list}\n`,
  );
}

async function readDay(date) {
  try {
    const raw = await fs.readFile(path.join(DIR, `${date}.jsonl`), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/**
 * Everything a day's digest reports, read once. The text and HTML mails both
 * render this, so the two can never drift apart.
 */
export function digestData(entries) {
  const claimRows = entries.flatMap((e) => e.claimed ?? [])
    .map((c) => (typeof c === 'string' ? { name: c, description: null } : c));
  return {
    passes: entries.length,
    finished: [...new Map(entries.flatMap((e) => e.finished ?? []).map((l) => [l.lineupId, l])).values()],
    changes: entries.flatMap((e) => e.lineups.filter((l) => l.in?.length || l.out?.length)),
    claims: [...new Map(claimRows.map((c) => [c.name, c])).values()],
    rewards: entries.flatMap((e) => e.rewards ?? []),
    stepClaims: entries.flatMap((e) => e.stepClaims ?? []),
    spent: entries.reduce((s, e) => s + (e.essenceSpent ?? 0), 0),
    essence: [...entries].reverse().map((e) => e.essence).find((v) => v != null) ?? null,
    gems: [...entries].reverse().map((e) => e.gems).find((v) => v != null) ?? null,
    pulls: entries.flatMap((e) => e.pulls ?? []),
    errors: entries.flatMap((e) => e.errors ?? []),
    restarts: entries.flatMap((e) => e.lineups.filter((l) => l.action === 'restarted')),
    // The last pass of the day that actually held a team is the one worth
    // showing: it is what is sitting in the step now.
    team: [...entries].reverse()
      .flatMap((e) => e.lineups ?? [])
      .find((l) => (l.five ?? []).length) ?? null,
  };
}

/** Human-readable digest for a day. */
export function digest(date, entries) {
  const L = [];
  const { changes, claims, rewards, stepClaims, spent, pulls, errors, restarts } = digestData(entries);

  L.push(`Sorare Autopilot - ${date}`, '', `${entries.length} pass${entries.length === 1 ? '' : 'es'}.`, '');

  L.push('LINEUP CHANGES');
  if (!changes.length) L.push('  none');
  for (const c of changes) {
    L.push(`  [${c.surface}] ${c.action}${c.projected ? ` - projected ${c.projected} pts` : ''}`);
    if (c.out?.length) L.push(`    out: ${c.out.join(', ')}`);
    if (c.in?.length) L.push(`    in:  ${c.in.join(', ')}`);
  }
  if (restarts.length) { L.push('', 'LADDER RESTARTS'); for (const r of restarts) L.push(`  [${r.surface}] ${r.reason}`); }

  L.push('', 'CLAIMED');
  if (!claims.length && !stepClaims.length) L.push('  nothing');
  for (const c of claims) L.push(`  ${c.name}${c.description ? ` - ${c.description.slice(0, 70)}` : ''}`);
  for (const s of stepClaims) L.push(`  [${s.surface}] ${s.reason ?? s.action}`);

  if (rewards.length) {
    L.push('', 'RECEIVED');
    const totals = new Map();
    for (const r of rewards) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.change);
    for (const [cur, chg] of totals) L.push(`  ${cur}  ${chg > 0 ? '+' : ''}${chg}`);
  }

  L.push('', 'ESSENCE', `  spent ${spent}`);
  if (pulls.length) {
    const best = [...pulls].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, 8);
    L.push('  pulled: ' + best.map((c) => `${c.name} ${c.stars}*`).join(', '));
  }

  if (errors.length) {
    L.push('', 'ERRORS');
    for (const e of [...new Set(errors.map(String))].slice(0, 10)) L.push(`  ${e}`);
  }
  return L.join('\n');
}

/**
 * Send yesterday's digest once. Uses a marker file so repeated passes on the
 * same day cannot send it twice.
 */
export async function maybeSendDigest(now = new Date()) {
  const y = new Date(now.getTime() - 86_400_000);
  const date = today(y);
  const marker = path.join(DIR, `.sent-${date}`);
  try { await fs.access(marker); return { sent: false, reason: 'already sent' }; } catch {}

  const entries = await readDay(date);
  if (!entries.length) return { sent: false, reason: 'no activity to report' };

  const res = await deliver(
    `Sorare Autopilot - daily report ${date}`,
    digest(date, entries),
    { html: digestHtml(date, entries) },
  );
  if (res.sent || res.queued) await fs.writeFile(marker, '', 'utf8');
  return { ...res, date };
}

/* ------------------------------------------------------------------ *
 * HTML mail.
 *
 * Email clients strip <style> blocks and ignore flexbox and grid, so this is
 * tables and inline styles on purpose - the plain-text digest above stays the
 * fallback and carries the same facts.
 * ------------------------------------------------------------------ */

const SITE = 'https://mas00009.github.io/sorare-autopilot/';
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const C = {
  ink: '#10131c', dim: '#5d6577', faint: '#8d95a6', line: '#e4e7ee',
  panel: '#f6f7fa', go: '#0f9d63', warn: '#b45309', stop: '#be3455', v: '#6d4fe0',
};

const num = (v) => (v == null ? '-' : Number(v).toLocaleString('en-AU'));

/**
 * The daily mail.
 *
 * It reads the same snapshot the dashboard is built from (docs/data.json), so
 * the two never describe a board differently, plus the day's journal for what
 * was spent, pulled and claimed. One block per board, each opening with the
 * status sentence a person can read; then the day's money; then anything
 * that went wrong. Nothing that needs the reader to know what the bot calls
 * things.
 */
export function digestHtml(date, entries, snapshot = null) {
  const d = digestData(entries);
  const snap = snapshot ?? readSnapshotSync();
  const pretty = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-AU',
    { weekday: 'long', day: 'numeric', month: 'long' });
  const F = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  const P = (txt, extra = '') => `<p style="margin:0;font:400 14px/1.55 ${F};color:${C.ink};${extra}">${txt}</p>`;
  const H = (txt) => `<div style="font:700 11px/1 ${F};letter-spacing:.13em;text-transform:uppercase;color:${C.faint};padding-bottom:9px">${esc(txt)}</div>`;
  const tone = { good: C.go, warn: C.warn, bad: C.stop, neutral: C.dim };

  /* ---- one block per board ------------------------------------------- */
  const boards = (snap?.surfaces ?? []).map((s) => {
    const name = s.surface.replace(/\s*\(.*\)/, '').replace(/\b\w/g, (c) => c.toUpperCase());
    const level = s.level != null && s.totalLevels ? `Level ${s.level} of ${s.totalLevels}` : '';
    const lives = s.lives ? `${s.lives.left} of ${s.lives.of} lives` : '';
    const pays = (s.rewards ?? []).map((r) => r.kind === 'gems' ? `${r.amount} gems` : r.kind === 'cash' ? `$${r.usd}` : r.kind === 'essence' ? `${r.amount} essence` : r.kind === 'pack' ? `a ${r.cards}-card pack` : null).filter(Boolean).join(' + ');
    const meta = [level, s.target ? (s.isSquad ? `squad needs ${s.target}` : `needs ${s.target}`) : '', pays ? `pays ${pays}` : '', lives].filter(Boolean).join(' · ');
    const five = s.entered?.five ?? [];
    // Every card is the same size whatever the client does. Mail clients
    // ignore percentage widths and size columns to their content, so a long
    // opponent ("@ 1. FC Union Berlin") on a no-wrap line widened one column
    // and its picture with it. Fixed pixel columns, a fixed image box (the
    // card art is always 771x1248), and every text line cut to fit one line.
    const COL = 106, IMG_W = 100, IMG_H = Math.round(IMG_W * 1248 / 771);
    const clip = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
    const cells = five.map((c) => {
      const plain = c.name.replace(/\s+(Jr\.?|Sr\.?|Junior)$/i, '');
      const surname = plain.split(' ').length > 1 && plain.length > 12 ? plain.split(' ').slice(1).join(' ') : plain;
      const opp = c.opp ? `${c.home ? 'vs' : '@'} ${shortTeam(c.opp).replace(/^1\.\s*FC\s+/i, '')}` : '';
      const cap = c.captain ? `<span style="display:inline-block;width:14px;height:14px;line-height:14px;border-radius:7px;background:#e07b12;color:#ffffff;font:800 9px/14px ${F};text-align:center;margin-right:3px">C</span>` : '';
      const num = c.actual != null
        ? `<span style="color:${C.go}">${Math.round(c.actual)}</span> <span style="font:600 9px/1 ${F};color:${C.faint};letter-spacing:.06em">SCORED</span>`
        : `<span style="color:${c.captain ? '#e07b12' : C.v}">${c.exp != null ? Math.round(c.exp) : '&nbsp;'}</span> <span style="font:600 9px/1 ${F};color:${C.faint};letter-spacing:.06em">${c.exp != null ? 'EXP' : ''}</span>`;
      return `<td width="${COL}" valign="top" style="width:${COL}px;padding:0 2px">
      <table role="presentation" width="${COL - 4}" cellpadding="0" cellspacing="0" border="0" style="width:${COL - 4}px;table-layout:fixed;border:1px solid ${c.captain ? '#e8a33d' : C.line};border-radius:10px;overflow:hidden">
        <tr><td align="center" height="${IMG_H}" style="padding:0;line-height:0;height:${IMG_H}px">${c.pic ? `<img src="${esc(c.pic)}" width="${IMG_W}" height="${IMG_H}" alt="${esc(c.name)}" style="display:block;width:${IMG_W}px;height:${IMG_H}px;border:0;margin:0 auto">` : ''}</td></tr>
        <tr><td style="padding:6px 6px 8px;background:#ffffff">
          <div style="font:700 11px/16px ${F};color:${C.ink};white-space:nowrap;overflow:hidden">${cap}${esc(clip(surname, c.captain ? 10 : 12))}</div>
          <div style="font:500 10px/14px ${F};color:${C.faint};white-space:nowrap;overflow:hidden">${opp ? esc(clip(opp, 16)) : '&nbsp;'}</div>
          <div style="font:800 14px/18px ${F};padding-top:3px;white-space:nowrap">${num}</div>
        </td></tr></table></td>`;
    }).join('');
    const finished = d.finished.filter((l) => l.surface === s.surface);
    const results = finished.map((l) => {
      const verdict = l.collaborative
        ? (l.cleared ? `The squad reached ${Math.round(l.squadScore)}, over the ${l.target} it needed.` : `The squad made ${Math.round(l.squadScore)}, short of the ${l.target} it needed.`)
        : (l.cleared ? `Passed with ${Math.round(l.score)} against ${l.target}.` : `Missed: ${Math.round(l.score)} against ${l.target}.`);
      const line = l.players.map((p) => `${p.captain ? '(C) ' : ''}${esc(p.name.split(' ').pop())} ${Math.round(p.score ?? 0)}`).join(' &middot; ');
      return `<div style="margin-top:12px;padding:10px 12px;background:${C.panel};border-radius:10px">
        ${P(`<b>Result, level ${l.level}:</b> ${verdict}`)}
        <div style="font:500 12px/1.5 ${F};color:${C.dim};padding-top:3px">${line}</div></div>`;
    }).join('');
    return `<tr><td style="padding:22px 26px 0">
      ${H(name)}
      ${meta ? `<div style="font:500 12px/1.4 ${F};color:${C.dim};margin:-4px 0 10px">${esc(meta)}</div>` : ''}
      <div style="padding:10px 12px;border-left:3px solid ${tone[s.tone] ?? C.dim};background:${C.panel};border-radius:0 10px 10px 0">${P(esc(s.status ?? ''))}</div>
      ${five.length ? `<table role="presentation" align="center" width="${five.length * 106}" cellpadding="0" cellspacing="0" border="0" style="width:${five.length * 106}px;table-layout:fixed;border-collapse:separate;margin:12px auto 0"><tr>${cells}</tr></table>` : ''}
      ${results}
    </td></tr>`;
  }).join('');

  /* ---- the day's money ------------------------------------------------ */
  // Name the pulls worth naming; count the rest. Twenty two-star names in a
  // row is noise, and the 3-star is the only one the day was about.
  const best = [...d.pulls].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  const good = best.filter((c) => (c.stars ?? 0) >= 3);
  const rest = best.length - good.length;
  const pulls = best.length
    ? (good.map((c) => `${esc(c.name)} <span style="color:${(c.stars ?? 0) >= 4 ? C.v : C.go};font-weight:700">${c.stars}&#9733;</span>`).join(', ')
       + (rest ? `${good.length ? ' and ' : ''}${rest} card${rest === 1 ? '' : 's'} of 2 stars or under` : ''))
    : '';
  const claims = [...d.claims.map((c) => c.name), ...d.stepClaims.map((s) => `${s.surface}: ${s.reason ?? s.action}`)];
  const moneyLines = [
    `You have <b>${num(snap?.balances?.essence ?? d.essence)}</b> essence and <b>${num(snap?.balances?.gems ?? d.gems)}</b> gems.`,
    d.spent ? `Spent <b>${num(d.spent)}</b> essence on packs today${pulls ? `, which pulled: ${pulls}.` : '.'}` : 'No essence spent today.',
    claims.length ? `Claimed: ${claims.map(esc).join('; ')}.` : 'Nothing was ready to claim.',
  ];
  const gemsNote = snap?.gems ? `${snap.gems.ladderGemsAhead + snap.gems.collectionGemsOpen} more gems are in reach: ${snap.gems.ladderGemsAhead} on the ladder and ${snap.gems.collectionGemsOpen} from the LaLiga collections${snap.gems.collections?.length ? ` (${snap.gems.collections.map((c) => `${c.progress}/${c.target}`).join(', ')})` : ''}.` : '';
  const errors = [...new Set(d.errors.map(String))].slice(0, 6);

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef0f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f5;padding:26px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${C.line}">
  <tr><td style="background:#11141f;padding:20px 26px">
    <img src="${SITE}img/wordmark.png" alt="Sorare Autopilot" width="190" style="display:block;width:190px;height:auto;border:0">
    <div style="font:500 13px/1.4 ${F};color:#8b95ad;padding-top:8px">${esc(pretty)}</div></td></tr>
  ${boards}
  <tr><td style="padding:22px 26px 0">
    ${H('Essence and gems')}
    ${moneyLines.map((l) => P(l, 'padding:3px 0')).join('')}
    ${gemsNote ? P(gemsNote, `padding:3px 0;color:${C.dim}`) : ''}
  </td></tr>
  ${errors.length ? `<tr><td style="padding:22px 26px 0">${H('Problems')}${errors.map((e) => P(`<span style="color:${C.stop}">${esc(e)}</span>`, 'padding:2px 0')).join('')}</td></tr>` : ''}
  <tr><td style="padding:24px 26px 26px">
    <a href="${SITE}" style="display:inline-block;background:${C.v};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:9px;font:700 14px/1 ${F}">Open the dashboard</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** "Real Club Deportivo de La Coruña" does not fit a 106px card; "La Coruña" does. */
function shortTeam(name) {
  return String(name ?? '')
    .replace(/^(Real Club Deportivo de|Real Club Deportivo|Real Sociedad de Fútbol|RCD|CA|CD|UD|SD|FC|RC|AS|SS|US|AC|SSC|Club Atlético de|Atlético de|Deportivo)\s+/i, '')
    .replace(/\s+(FC|CF|AFC|SC|BC|CFC|Calcio|Spor Kulübü)$/i, '')
    .trim();
}

/** The dashboard's snapshot, if it exists. The mail is built from it. */
function readSnapshotSync() {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'docs', 'data.json'), 'utf8')); } catch { return null; }
}
