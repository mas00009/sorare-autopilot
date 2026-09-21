#!/usr/bin/env node
/**
 * autopilot <command>
 *
 *   doctor   check credentials, print balances, resolve the live step
 *   plan     full dry run - decides and prints, submits nothing
 *   run      one real pass - submits the lineup and claims missions
 *   watch    repeat `run` on an interval until the step locks
 *   signin   route B: sign in from this terminal (JWT, ~30 days)
 *   auth     route A: one-off OAuth authorisation (needs verified identity)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal .env loader - no dependency needed.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const cmd = process.argv[2] ?? 'plan';
const flag = (n) => process.argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

function line(c) {
  const star = c.captain ? ' (C)' : '';
  const fx = c.opponent ? `${c.home ? 'H' : 'A'} v ${c.opponent}` : '';
  return `  ${String(c.position).padEnd(3)} ${String(c.player).padEnd(20)} ` +
    `L15 ${String(c.average ?? '?').padStart(3)}  L5 ${String(c.formL5 ?? '-').padStart(3)}  ` +
    `${String(fx).padEnd(22)} ` +
    `start ${c.starterPct != null ? `${String(c.starterPct.toFixed(0)).padStart(3)}%` : '  ? '}  ` +
    `exp ${String(c.expected).padStart(6)}${star}`;
}

function printLineup(l) {
  if (!l) return;
  const who = l.surface ? l.surface.toUpperCase() : 'LINEUP';
  if (l.skipped) { console.log(`\n${who}: skipped - ${l.reason}`); return; }
  console.log(`\n${who}${l.target ? `  -  target ${l.target} pts` : ''}`);
  console.log(`Action: ${l.action}`);
  if (l.reason) console.log(`  ${l.reason}`);
  if (l.current) console.log(`  holding: ${l.current.join(', ')}`);
  if (l.dead?.length) {
    console.log('  replacing (no fixture in this window, or injured):');
    for (const d of l.dead) {
      console.log(`    ${d.name} - ${d.injured ? 'injured' : `next game ${d.date ? d.date.slice(0, 10) : 'unknown'}`}`);
    }
  }
  if (l.delta) {
    if (l.delta.in.length) console.log(`  IN : ${l.delta.in.join(', ')}`);
    if (l.delta.out.length) console.log(`  OUT: ${l.delta.out.join(', ')}`);
  }
  console.log('');
  for (const c of l.lineup ?? []) {
    console.log(line({ ...c, captain: c.id === l.captain?.id }));
  }
  console.log(`\n  projected ${l.projected} pts`);
  const ex = (l.excluded ?? []).filter((c) => /injur|suspend|to start|locked/.test(c.blocked ?? ''));
  if (ex.length) {
    console.log('\n  held out:');
    for (const c of ex.slice(0, 12)) console.log(`    ${c.player} - ${c.blocked}`);
  }
}

async function report(r) {
  if (flag('json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`\n${r.dryRun ? 'DRY RUN' : 'LIVE'}  ${r.startedAt}`);
  if (r.paused) { console.log(`PAUSED by remote control (${r.control?.source}). Nothing was done.`); return; }
  if (r.control && r.control.source !== 'default') {
    const off = ['packs','lineups','claims'].filter((k) => r.control[`${k}Enabled`] === false);
    if (off.length) console.log(`control: ${off.join(', ')} disabled`);
  }
  // The sign-in token lapses after ~30 days. Warn well before it does, so it
  // never dies silently mid-matchday on a scheduled run.
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'tokens.json'), 'utf8'));
    if (st.jwtExpiresAt && !st.refreshToken) {
      const days = Math.round((st.jwtExpiresAt - Date.now()) / 86400000);
      if (days <= 10) {
        console.log(`\n*** TOKEN EXPIRES IN ${days} DAY${days === 1 ? '' : 'S'} - run \`npm run signin\` or the autopilot stops. ***`);
      }
    }
  } catch {}
  if (r.nickname) console.log(`Account: ${r.nickname}`);
  if (r.gems?.length) {
    console.log(`Gems: ${r.gems.map((g) => `${g.amount} ${g.currency}`).join(', ')}  (untouched)`);
  }
  if (r.balanceError) console.log(`Balances: ${r.balanceError}`);
  for (const l of r.lineups ?? (r.lineup ? [r.lineup] : [])) printLineup(l);
  if (r.lineupError) console.log(`\nLineup error: ${JSON.stringify(r.lineupError)}`);
  if (r.missions) {
    const m = r.missions;
    console.log('\nMissions');
    if (m.heldUntilReset) { console.log('  held until the daily reset (a claim may contain a free 3-star)'); }
    else if (m.claimed.length) {
      console.log(`  claimed ${m.claimed.length}${m.claimed[0]?.dryRun ? ' (dry run)' : ''}:`);
      for (const t of m.claimed) {
        console.log(`    ${t.name}${t.description ? ` - ${t.description.slice(0, 60)}` : ''}`);
      }
    } else if (!m.heldUntilReset) {
      console.log('  nothing ready to claim');
    }
    if (m.balanceDelta?.length) {
      console.log('  rewards:');
      for (const d of m.balanceDelta) {
        console.log(`    ${d.currency}  ${d.before} -> ${d.after}  (${d.change > 0 ? '+' : ''}${d.change})`);
      }
    } else if (m.claimed.length && !m.claimed[0]?.dryRun) {
      console.log('  rewards: no currency change (cards, pack progress or ladder points)');
    }
    if (m.notReady.length) console.log(`  still in progress: ${m.notReady.length}`);
    for (const e of m.errors.slice(0, 5)) console.log(`  ! ${e}`);
  }
  if (r.results?.length) {
    console.log('\nResults recorded');
    for (const row of r.results) {
      console.log(`  [${row.surface}] ${row.outcome} - scored ${row.actual}${row.projected ? ` vs ${row.projected.toFixed(0)} projected` : ''} (target ${row.target})`);
    }
  }

  if (r.freeThreeStar) {
    console.log(`\nFree 3-star from a claim: ${r.freeThreeStar.name} (${r.freeThreeStar.stars}-star) - skipping essence packs.`);
  }

  if (r.packs) {
    const p = r.packs;
    console.log('\nPacks');
    console.log(`  essence ${p.essenceBefore} -> ${p.essenceAfter}${p.spent ? `  (spent ${p.spent})` : ''}`);
    for (const o of p.opened) {
      if (o.dryRun) { console.log(`  would buy ${o.slug} for ${o.price} ${o.currency}`); continue; }
      const cards = (o.cards ?? []).map((c) => `${c.name} ${c.stars}*`).join(', ');
      console.log(`  ${o.slug} (${o.price}): ${cards || 'no cards returned'}`);
      if (o.claimError) console.log(`    ! claim failed: ${o.claimError}`);
    }
    if (p.found) console.log(`  FOUND: ${p.found.name} - ${p.found.stars}-star (${p.found.tier})`);
    console.log(`  stopped: ${p.stopped}`);
  }

  // Journal every pass, alert on a big pull, and send yesterday's digest once.
  if (!r.dryRun) {
    try {
      const rep = await import('./report.js');
      const entry = await rep.journal(r);

      const big = rep.bigPulls(entry);
      if (big.length) {
        const res = await rep.alertBigPull(big);
        console.log(`  alert: ${big.map((c) => `${c.name} ${c.stars}*`).join(', ')} - ${res.sent ? 'emailed' : res.queued ? 'queued for delivery' : `not sent (${res.reason})`}`);
      }

      // Health: alert on a run of failures, and again when it recovers.
      try {
        const { readState, writeState } = await import('./client.js');
        const st2 = await readState();
        const h = await rep.trackHealth(entry, st2, writeState);
        if (h.alert) {
          await rep.deliver(
            `Sorare Autopilot FAILING - ${h.streak} passes in a row`,
            `The autopilot has failed ${h.streak} passes in a row.\n\nLatest errors:\n` +
            (entry.errors ?? []).map((e) => `  ${e}`).join('\n') +
            `\n\nIt will keep retrying. Check:\n  tail -40 ~/sorare-autopilot/state/autopilot.log\n`,
          );
          console.log(`  FAILING ${h.streak} passes - alert sent`);
        }
        if (h.recovered) {
          await rep.deliver('Sorare Autopilot recovered', 'The autopilot is completing passes again.\n');
          console.log('  recovered - alert sent');
        }
      } catch (e) { console.log(`  health check failed: ${e.message}`); }

      const dig = await rep.maybeSendDigest();
      if (dig.sent) console.log(`  daily report for ${dig.date} emailed`);
      else if (dig.queued) console.log(`  daily report for ${dig.date} queued for delivery`);
      else if (dig.reason && !/already sent|no activity/.test(dig.reason)) console.log(`  daily report not sent: ${dig.reason}`);
    } catch (err) {
      console.log(`  reporting failed: ${err.message}`);
    }
  }

  if (process.env.AUTOPILOT_WEBHOOK_URL) {
    try {
      await fetch(process.env.AUTOPILOT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
      });
    } catch (err) { console.log(`webhook failed: ${err.message}`); }
  }
}

const main = async () => {
  if (cmd === 'create-app') {
    const { createApp } = await import('./createapp.js');
    return createApp();
  }

  if (cmd === 'signin') {
    const { signIn } = await import('./signin.js');
    return signIn();
  }

  if (cmd === 'auth') {
    const { authorize } = await import('./auth.js');
    return authorize();
  }

  const { pass, readBalances, resolveLiveStep } = await import('./autopilot.js');

  if (cmd === 'doctor') {
    const bal = await readBalances();
    console.log(`Authenticated as ${bal.nickname}`);
    console.log('Balances:', bal.all.map((b) => `${b.amount} ${b.currency}`).join(', ') || '(none)');
    const s = await resolveLiveStep();
    console.log(`Squad: ${s.squad?.name ?? '(none)'}`);
    console.log(`Live step: ${s.stepId ?? '(none open)'}`);
    return;
  }

  if (cmd === 'report') {
    const rep = await import('./report.js');
    const when = opt('date', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    const fsx = await import('node:fs/promises');
    const p = new URL(`../state/reports/${when}.jsonl`, import.meta.url);
    let entries = [];
    try { entries = (await fsx.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
    if (!entries.length) { console.log(`no activity recorded for ${when}`); return; }
    console.log(rep.digest(when, entries));
    if (flag('send')) {
      const res = await rep.deliver(`Sorare Autopilot - daily report ${when}`, rep.digest(when, entries));
      console.log(res.sent ? `\nsent via ${res.via}` : res.queued ? `\nqueued (${res.reason})` : `\nnot sent: ${res.reason}`);
    }
    return;
  }

  if (cmd === 'pause' || cmd === 'resume') {
    const C = await import('./control.js');
    const next = await C.set({ paused: cmd === 'pause' });
    console.log(`${cmd === 'pause' ? 'PAUSED' : 'RUNNING'} locally. Push to make it take effect remotely:`);
    console.log('  git -C ~/sorare-autopilot add docs/control.json && git -C ~/sorare-autopilot commit -m "control" && git -C ~/sorare-autopilot push');
    console.log(JSON.stringify(next));
    return;
  }

  if (cmd === 'backtest') {
    const B = await import('./backtest.js');
    const r = await B.run({ maxPlayers: Number(opt('players', 60)) });
    if (!r.ok && r.reason) { console.log(`not enough data: ${r.reason} (${r.samples} samples)`); return; }
    console.log(`\n${r.samples} walk-forward samples from ${r.players} players\n`);
    console.log(`  current  formWeight 0.40  home 1.03   RMSE ${r.current.rmse.toFixed(2)}  bias ${r.current.bias.toFixed(2)}`);
    console.log(`  best     formWeight ${r.best.formWeight.toFixed(2)}  home ${r.best.homeAdvantage.toFixed(2)}   RMSE ${r.best.rmse.toFixed(2)}  bias ${r.best.bias.toFixed(2)}`);
    console.log(`\n  improvement in RMSE: ${r.improvementRmse}`);
    console.log(`  ${r.note}`);
    return;
  }

  if (cmd === 'dashboard') {
    const { build } = await import('./dashboard.js');
    const d = await build();
    console.log(`docs/data.json written - ${d.surfaces.length} surfaces, ${d.fixtures.length} fixtures, ${d.accuracy.n ?? 0} projections checked`);
    return;
  }

  if (cmd === 'accuracy') {
    const R = await import('./results.js');
    const rows = await R.read();
    const a = R.accuracy(rows);
    if (!a.n) { console.log('No finished lineups recorded yet. Needs a few gameweeks.'); return; }
    console.log(`\n${a.steps} steps recorded, ${a.hit} hit target.`);
    console.log(`  ${a.n} player projections checked`);
    console.log(`  bias ${a.bias > 0 ? '+' : ''}${a.bias} pts  (negative = over-projecting)`);
    console.log(`  mean error ${a.mae} pts`);
    console.log(`  blanked ${(a.blankRate * 100).toFixed(0)}% of the time`);
    if (a.steps < 4) console.log('\n  Too few samples to tune weights on. Keep collecting.');
    return;
  }

  if (cmd === 'when') {
    const { resolveBoards, fetchBench } = await import('./autopilot.js');
    const { describe } = await import('./optimiser.js');
    const { decide } = await import('./schedule.js');
    const { readState } = await import('./client.js');

    const { boards } = await resolveBoards();
    const games = new Map();
    for (const b of boards) {
      let bench = [];
      try { bench = await fetchBench(b.stepId, { first: 50 }); } catch { continue; }
      for (const c of bench.map((n) => describe(n))) {
        if (!c.kickoff || new Date(c.kickoff) <= new Date()) continue;
        const key = `${c.kickoff}|${c.team}|${c.opponent}`;
        if (!games.has(key)) games.set(key, { ...c, players: [] });
        games.get(key).players.push(c.player);
      }
    }
    const rows = [...games.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    console.log(`\nUpcoming fixtures with your players (${rows.length})\n`);
    for (const g of rows) {
      const when = new Date(g.kickoff);
      const hrs = Math.round((when - Date.now()) / 3600000);
      console.log(
        `${when.toISOString().slice(5, 16).replace('T', ' ')}  (${String(hrs).padStart(3)}h)  ` +
        `${String(g.team).padEnd(14)} ${g.home ? 'v' : '@'} ${String(g.opponent).padEnd(16)} ` +
        `${g.players.slice(0, 4).join(', ')}${g.players.length > 4 ? ` +${g.players.length - 4}` : ''}`,
      );
    }
    const st = await readState();
    const d = decide({ nextKickoff: st.nextKickoff ?? null, nextLock: st.nextLock ?? null, lastRunAt: st.lastRunAt ?? null });
    console.log(`\ncadence now: every ${d.cadence}m  -  ${d.reason}`);
    return;
  }

  const options = {
    minStarterBp: Number(opt('min-starter', 6000)),
    maxPerGame: Number(opt('max-per-game', 2)),
    essenceFloor: Number(opt('essence-floor', 4000)),
    maxPacks: Number(opt('max-packs', 3)),
    packs: !flag('no-packs'),
    claimNow: flag('claim-now'),
    targetMargin: Number(opt('target-margin', 1)),
  };

  if (cmd === 'plan') return report(await pass({ dryRun: true, options }));

  if (cmd === 'run') {
    if (!flag('force')) {
      const { decide } = await import('./schedule.js');
      const { readState } = await import('./client.js');
      const st = await readState();
      const d = decide({ nextKickoff: st.nextKickoff ?? null, nextLock: st.nextLock ?? null, lastRunAt: st.lastRunAt ?? null });
      if (!d.run) {
        // A new daily cycle means claims and the pack allowance have reset, and
        // a held reward may contain a free 3-star. That is worth acting on
        // immediately rather than waiting out the cadence, so check for a
        // rollover before skipping. One tiny query.
        let rolled = false;
        try {
          const { dailyCycleId } = await import('./autopilot.js');
          const cycle = await dailyCycleId();
          rolled = !!cycle && !!st.claimCycle && cycle !== st.claimCycle;
          if (rolled) console.log(`go: daily cycle rolled over (${cycle})`);
        } catch { /* fall through to the normal skip */ }
        if (!rolled) {
          console.log(`skip: ${d.reason}`);
          return;
        }
      } else {
        console.log(`go: ${d.reason}`);
      }
    }
    return report(await pass({ dryRun: flag('dry'), options }));
  }

  if (cmd === 'watch') {
    const every = Number(opt('every', 600)) * 1000;
    const until = opt('until', null);
    const deadline = until ? new Date(until).getTime() : Infinity;
    for (;;) {
      await report(await pass({ dryRun: flag('dry'), options }));
      if (Date.now() + every > deadline) { console.log('\nDeadline reached, stopping.'); return; }
      await new Promise((r) => setTimeout(r, every));
    }
  }

  console.log('Usage: autopilot <doctor|plan|run|when|report|accuracy|dashboard|backtest|pause|resume|watch|signin|create-app|auth> [--json] [--dry] [--force] [--min-starter 6000]');
  process.exitCode = 1;
};

main().catch((err) => {
  console.error(`\n${err.name === 'GuardrailError' ? 'BLOCKED' : 'ERROR'}: ${err.message}`);
  process.exitCode = 1;
});
