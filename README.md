# Sorare Autopilot

Picks, enters and babysits your Set-mode lineup while you're asleep.

It reads the live step, filters your bench down to players who are fit,
unsuspended and actually likely to start, picks the five with the highest
expected points, submits them, and then keeps re-checking until lock — swapping
anyone who picks up a knock or drops out of the XI.

## The one rule

**It cannot spend gems.** Not "won't" — can't. `src/guardrails.js` refuses any
gem-denominated cost and any mutation that could debit gems or money
(`buyCardPack`, the credit-card and mobile-purchase flows), by name, before the
request is built. New mutations fail closed: anything not explicitly
allow-listed is refused. Essence and other soft currencies are fine.

The `ALLOW_GEM_SPEND` env var exists only so that setting it by accident does
nothing — it is hard-blocked in code as well.

## Setup

There are two ways in. Sorare gates OAuth behind identity verification, so most
people start on route B and move to route A when that clears.

### Route B - sign in from your terminal (works today)

```bash
cp .env.example .env     # paste your API key into SORARE_API_KEY
npm run signin
```

It asks for your Sorare email and password. The password is bcrypt-hashed on
this machine against Sorare's salt and sent only to `api.sorare.com`. It is
never stored, never logged, never echoed, and never written to disk. Two-factor
is handled if your account has it.

What gets saved is a JWT in `state/tokens.json` (mode 0600), valid for about
30 days. When it lapses the autopilot says so - re-run `npm run signin`.

### Route A - OAuth (permanent, no monthly re-auth)

Needs a verified identity on your Sorare account. Once the verify step on
<https://sorare.com/settings/developer> clears, create an OAuth application
there with redirect URI `http://127.0.0.1:8737/callback`, put the client ID and
secret in `.env`, then:

```bash
npm run auth
```

Opens sorare.com so you log in there. Only the authorisation code comes back.
The refresh token renews itself, so this is a one-time step.

The client prefers route A whenever OAuth credentials exist, and falls back to
the route B token otherwise. You can have both configured.

## Use

```bash
npm run signin     # route B sign-in (or `npm run auth` for route A)
npm run doctor     # check auth, print balances, find the live step
npm run plan       # full dry run: decides and prints, submits nothing
npm run run        # one real pass: submits and claims
npm run watch      # repeat until the step locks
node src/cli.js simulate            # replay past rounds through the optimiser
node src/cli.js simulate --refresh  # ...after pulling fresh history first
```

Useful flags:

```bash
node src/cli.js plan --min-starter 7500     # only near-certain starters
node src/cli.js watch --every 900 --until 2026-09-26T13:55:00Z
node src/cli.js run --json                  # machine-readable, for the routine
```

## How a card gets rejected

In order — the first one that hits wins:

| Check | Source |
|---|---|
| Active injury | `player.activeInjuries[].active` |
| Suspension | `activeSuspensions` |
| No fixture in the scoring window | `BenchFilterInput.includeNoGame: false` |
| Already locked | `lockedAt` in the past |
| Below the starter threshold | `starterOddsBasisPoints < minStarterBp` (default 6000 = 60%) |

Sorare publishes starter probability itself, per player per game, so the
late-team-news signal comes from source rather than from scraping previews.

Expected points for a card:

```
L15 average  ×  (1 + card bonus)  ×  (P(start) + 0.35 × P(sub))
```

Ties are broken toward spreading across fixtures — `maxPerGame` (default 2)
stops the whole lineup riding on one match.

## Passes are idempotent

Every pass recomputes from scratch and compares against the live lineup. If
nothing has changed it submits nothing, so running it every ten minutes costs
one cheap query and no writes.

## Layout

```
src/guardrails.js   spend limits, enforced structurally
src/client.js       GraphQL + OAuth token handling, rate limited to ~190/min
src/queries.js      documents, grounded in reference/schema.graphql
src/optimiser.js    selection, rejection reasons, diffing
src/autopilot.js    orchestration: one pass
src/cli.js          commands
test/               optimiser tests, no network needed
reference/schema.graphql   the live schema, for checking field paths
```

## Worth knowing

Sorare's published API docs claim there are no lineup mutations. That's out of
date — `upsertStepLineup`, `upsertTaskLineup` and friends are all in the live
schema. Because they're undocumented they could change without a changelog
entry, so `npm run plan` failing with a GraphQL field error is the expected
symptom of a schema change. Re-download the schema and diff it:

```bash
curl -s https://api.sorare.com/graphql/schema -o reference/schema.graphql
```

Sorare's T&Cs don't explicitly address automated lineup submission. They offer
self-service API credentials, so API use is clearly intended, but the automation
question is unaddressed rather than permitted. Your call.

## What the research found

Every weight in the optimiser was measured against this account's own history -
6,920 appearances from 464 players, walk-forward, scored on real results - and
the simulator replays 44 past rounds through the real picker so any change can
be judged on realised points rather than on a hunch. The findings, so nobody
re-tests them by accident:

- **The pool is the limit, not the model.** Every variant lands within noise
  (mean 259-272 raw points a round; 6-10% of lineups clear 360). The pool holds
  on average 2.9 regular starters averaging 60+ when they play, and 360 needs
  five. Only 13 of 44 rounds had five available. An oracle that knew exactly who
  would play still cleared 360 just 11% of the time. Better cards beat better
  maths from here.
- **Start rate as availability, until odds land.** Sorare publishes starter
  odds only near kickoff. Before that, a player's last-ten start rate stands in.
  It lifted lineups clearing 300 from 20% to 33% and is what stops a 30%
  starter with a good average from making the team.
- **Opponent strength is a defensive effect, internationals only.** Defenders
  gain from a soft opponent (about 0.04 per 100 FIFA points, MAE 17.26 to
  17.02), midfield a little, forwards nothing at all. Applied per position.
  For club fixtures the league table predicts nothing (0.7% across the whole
  table, holdout unchanged) and is deliberately not used. FIFA points beat Elo
  as the measure. `data/fifa-rankings.json` needs refreshing after each FIFA
  update.
- **Stacking a mismatch.** Two cards a match is the rule (team-mates'
  residuals correlate 0.23-0.28). A third GK/DF/MD from a side 200+ FIFA points
  ahead is allowed, and taken only when the plain lineup falls short - under a
  threshold, correlation helps when short and only adds risk when clear. This
  one is reasoned from the clean-sheet finding, not measured on its own.
- **Bookmaker odds for club fixtures: real, but small.** 3,567 club
  appearances joined to closing 1X2 and over/under odds (football-data.co.uk).
  A favourite's defenders do score more (correlation 0.13, t=3.2; haul rate
  15% as a heavy underdog to 30% as a favourite) and so do its forwards
  (0.10, t=2.3), where the league table showed nothing. As a multiplier the
  gain is 0.3-0.5% of error - real, and far below what would move the replay.
  The stronger signal was availability: players on 65%+ favourites started
  22% of the time against 37% for heavy underdogs. Big clubs rotate. That is
  already carried by Sorare's starter odds and the start-rate prior. Wired
  through The Odds API on the free plan: one credit per league per day, only
  leagues on the bench, cached for the day, hard ceiling of 450 a month
  (`state/odds/usage.json`). Every fetch is also appended to
  `state/odds/log.jsonl` so the simulator can be re-run on real pre-match odds
  once enough have built up. Needs `ODDS_API_KEY` in `.env`; without it the
  bot runs exactly as before.
- **Tested and rejected:** home advantage (twice), Elo, friendlies as
  different from competitive, score-per-90 times expected minutes, captain by
  haul rate or by L5, one or three cards a match as the default, lock-day
  tolerance changes. None moved the replay.

## Tests

```bash
node --test test/*.test.mjs
```

Runs offline against a fixture modelled on a real gameweek, including an injured
top scorer who must not be selected.
