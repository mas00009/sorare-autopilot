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

/** Append this pass to today's journal. */
export async function journal(report) {
  await fs.mkdir(DIR, { recursive: true });
  const entry = {
    at: report.startedAt,
    lineups: (report.lineups ?? []).map((l) => ({
      surface: l.surface, action: l.action ?? (l.skipped ? 'skipped' : null),
      reason: l.reason ?? null,
      in: l.delta?.in ?? [], out: l.delta?.out ?? [],
      projected: l.projected ?? null,
    })),
    claimed: (report.missions?.claimed ?? []).map((t) => ({ name: t.name, description: t.description ?? null })),
    rewards: report.missions?.balanceDelta ?? [],
    stepClaims: (report.lineups ?? [])
      .filter((l) => l.action === 'claimed' || l.action === 'restarted')
      .map((l) => ({ surface: l.surface, action: l.action, reason: l.reason })),
    essenceSpent: report.packs?.spent ?? 0,
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
export async function deliver(subject, body, env = process.env) {
  const to = env.REPORT_TO;
  if (to) {
    try {
      const gmail = await import('./gmail.js');
      const res = await gmail.send({ to, subject, body });
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

/** Human-readable digest for a day. */
export function digest(date, entries) {
  const L = [];
  const changes = entries.flatMap((e) => e.lineups.filter((l) => l.in?.length || l.out?.length));
  const claimRows = entries.flatMap((e) => e.claimed ?? [])
    .map((c) => (typeof c === 'string' ? { name: c, description: null } : c));
  const claims = [...new Map(claimRows.map((c) => [c.name, c])).values()];
  const rewards = entries.flatMap((e) => e.rewards ?? []);
  const stepClaims = entries.flatMap((e) => e.stepClaims ?? []);
  const spent = entries.reduce((s, e) => s + (e.essenceSpent ?? 0), 0);
  const pulls = entries.flatMap((e) => e.pulls ?? []);
  const errors = entries.flatMap((e) => e.errors ?? []);
  const restarts = entries.flatMap((e) => e.lineups.filter((l) => l.action === 'restarted'));

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

  const res = await deliver(`Sorare Autopilot - daily report ${date}`, digest(date, entries));
  if (res.sent || res.queued) await fs.writeFile(marker, '', 'utf8');
  return { ...res, date };
}
