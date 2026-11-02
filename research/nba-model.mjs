import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(new URL('./nba-games.json', import.meta.url))).filter((r) => r.date < new Date().toISOString())
  .sort((a, b) => a.date.localeCompare(b.date));
// team schedule and points allowed
const games = new Map();
for (const r of rows) games.set(r.game, { date: r.date, home: r.home, away: r.away, hs: r.hs, as: r.as });
const teamGames = new Map();
for (const g of games.values()) for (const [t, allowed, scored] of [[g.home, g.as, g.hs], [g.away, g.hs, g.as]]) {
  if (!teamGames.has(t)) teamGames.set(t, []); teamGames.get(t).push({ date: g.date, allowed, scored });
}
for (const v of teamGames.values()) v.sort((a, b) => a.date.localeCompare(b.date));
const leagueAllowed = [...games.values()].reduce((s, g) => s + g.hs + g.as, 0) / (2 * games.size);
const prior = (list, date, n) => list.filter((x) => x.date < date).slice(-n);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
// per player history
const byPlayer = new Map();
for (const r of rows) { if (!byPlayer.has(r.slug)) byPlayer.set(r.slug, []); byPlayer.get(r.slug).push(r); }
const l10Of = new Map(); // slug|game -> prior L10 avg (played only)
for (const [slug, list] of byPlayer) {
  const played = [];
  for (const r of list) { l10Of.set(slug + '|' + r.game, mean(played.slice(-10))); if (r.played && r.score != null) played.push(r.score); }
}
// teammates missing in a game: sum of prior L10 of teammates who did not play
const byGameTeam = new Map();
for (const r of rows) { const k = r.game + '|' + r.team; if (!byGameTeam.has(k)) byGameTeam.set(k, []); byGameTeam.get(k).push(r); }
const data = [];
for (const [slug, list] of byPlayer) {
  const hist = [];
  for (const r of list) {
    if (r.played && r.score != null && hist.length >= 5) {
      const L10 = mean(hist.slice(-10).map((h) => h.score)), L5 = mean(hist.slice(-5).map((h) => h.score)), L3 = mean(hist.slice(-3).map((h) => h.score));
      const mins5 = mean(hist.slice(-5).map((h) => h.mins)), minsLast = hist.at(-1).mins;
      const opp = r.team === r.home ? r.away : r.home;
      const oppAllowed = mean(prior(teamGames.get(opp) ?? [], r.date, 10).map((x) => x.allowed));
      const tg = prior(teamGames.get(r.team) ?? [], r.date, 1)[0];
      const rest = tg ? (Date.parse(r.date) - Date.parse(tg.date)) / 86400e3 : 3;
      const mates = (byGameTeam.get(r.game + '|' + r.team) ?? []).filter((m) => m.slug !== slug && !m.played);
      const missing = mates.reduce((s, m) => s + (l10Of.get(m.slug + '|' + r.game) ?? 0), 0);
      const homeHist = mean(hist.filter((h) => (h.team === h.home) === (r.team === r.home)).slice(-10).map((h) => h.score));
      data.push({ y: r.score, L10, L5, L3, mins5, minsLast, home: r.team === r.home ? 1 : 0, opp: oppAllowed != null ? oppAllowed - leagueAllowed : 0,
        b2b: rest < 1.5 ? 1 : 0, missing: missing / 10, venueDiff: homeHist != null ? homeHist - L10 : 0, date: r.date });
    }
    if (r.played && r.score != null) hist.push(r);
  }
}
data.sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(data.length * 0.75);
const train = data.slice(0, cut), test = data.slice(cut);
console.log('samples', data.length, 'train', train.length, 'test', test.length, 'league pts allowed', leagueAllowed.toFixed(1));
// OLS via normal equations
function fit(feats) {
  const X = train.map((d) => [1, ...feats.map((f) => d[f])]); const y = train.map((d) => d.y);
  const k = X[0].length; const A = Array.from({ length: k }, () => new Array(k).fill(0)); const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c]; }
  for (let a = 0; a < k; a++) A[a][a] += 1e-6;
  // gaussian elimination
  for (let i = 0; i < k; i++) { let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r; [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < k; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; } }
  const w = b.map((v, i) => v / A[i][i]);
  const pred = (d) => w[0] + feats.reduce((s, f, i) => s + w[i + 1] * d[f], 0);
  const mae = mean(test.map((d) => Math.abs(d.y - pred(d))));
  return { w, mae };
}
const mae = (fn) => mean(test.map((d) => Math.abs(d.y - fn(d))));
console.log('baseline L10 MAE', mae((d) => d.L10).toFixed(2), '| L5', mae((d) => d.L5).toFixed(2), '| 50/50', mae((d) => (d.L10 + d.L5) / 2).toFixed(2));
const sets = [['L10'], ['L10', 'L5'], ['L10', 'L5', 'mins5'], ['L10', 'L5', 'mins5', 'minsLast'], ['L10', 'L5', 'mins5', 'minsLast', 'home'],
  ['L10', 'L5', 'mins5', 'minsLast', 'home', 'opp'], ['L10', 'L5', 'mins5', 'minsLast', 'home', 'opp', 'b2b'],
  ['L10', 'L5', 'mins5', 'minsLast', 'home', 'opp', 'b2b', 'missing'], ['L10', 'L5', 'L3', 'mins5', 'minsLast', 'home', 'opp', 'b2b', 'missing', 'venueDiff']];
for (const f of sets) { const r = fit(f); console.log(f.join('+').padEnd(70), 'MAE', r.mae.toFixed(2), '| w', r.w.map((x) => x.toFixed(3)).join(' ')); }
fs.writeFileSync(new URL('./nba-model.json', import.meta.url), JSON.stringify({ feats: sets.at(-1), ...fit(sets.at(-1)), leagueAllowed }, null, 1));
