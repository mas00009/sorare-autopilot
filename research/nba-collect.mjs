// Collect NBA game history for every active player on every team, for the projection study.
import fs from 'node:fs';
const { gql } = await import('../src/client.js');
const teams = ['atlanta-hawks','boston-celtics','brooklyn-nets','charlotte-hornets','chicago-bulls','cleveland-cavaliers','dallas-mavericks','denver-nuggets','detroit-pistons','golden-state-warriors','houston-rockets','indiana-pacers','la-clippers','los-angeles-clippers','los-angeles-lakers','memphis-grizzlies','miami-heat','milwaukee-bucks','minnesota-timberwolves','new-orleans-pelicans','new-york-knicks','oklahoma-city-thunder','orlando-magic','philadelphia-76ers','phoenix-suns','portland-trail-blazers','sacramento-kings','san-antonio-spurs','toronto-raptors','utah-jazz','washington-wizards'];
const players = new Map();
for (const t of teams) {
  try {
    const d = await gql(`query($s:String!){ team(slug:$s) { slug ... on Club { activePlayers(first: 25) { nodes { slug displayName } } } } }`, { s: t });
    for (const p of d.team.activePlayers?.nodes ?? []) players.set(p.slug, { team: d.team.slug, name: p.displayName });
  } catch { /* slug miss */ }
}
console.error('players', players.size);
const rows = [];
const slugs = [...players.keys()];
for (let i = 0; i < slugs.length; i += 10) {
  const d = await gql(`query($s:[String!]){ players(slugs:$s) { slug ... on NBAPlayer { anyGameStats(last: 45) { ... on PlayerGameStatsBasketball { playedInGame minsPlayed points playerGameScore { score } anyTeam { slug } anyGame { id date ... on GameOfBasketball { homeTeam { slug } awayTeam { slug } homeScore awayScore } } } } } } }`, { s: slugs.slice(i, i + 10) });
  for (const p of d.players ?? []) for (const g of p.anyGameStats ?? []) {
    if (!g.anyGame?.homeTeam) continue;
    rows.push({ slug: p.slug, team: g.anyTeam?.slug, game: g.anyGame.id, date: g.anyGame.date, home: g.anyGame.homeTeam.slug, away: g.anyGame.awayTeam.slug,
      hs: g.anyGame.homeScore, as: g.anyGame.awayScore, played: g.playedInGame, mins: g.minsPlayed ?? 0, score: g.playerGameScore?.score ?? null });
  }
}
fs.writeFileSync(new URL('./nba-games.json', import.meta.url), JSON.stringify(rows));
console.log('rows', rows.length, 'players', new Set(rows.map((r) => r.slug)).size, 'games', new Set(rows.map((r) => r.game)).size,
  'dates', rows.map((r) => r.date).sort()[0], '->', rows.map((r) => r.date).sort().at(-1));
