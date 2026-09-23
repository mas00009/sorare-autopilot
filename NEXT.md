# Where things stand

The bot reads, picks, submits, holds, claims, opens packs, plays the picker and
mails a report. The daily checklist and the bonus-pack counters are all found
and wired (see `src/autopilot.js` and `src/picker.js` for the traps). What is
left is judgement, not plumbing.

## The number that matters

`node src/cli.js simulate` replays 44 past rounds through the real picker.
Every model variant clears the 360 target 6-10% of the time, and an oracle that
knows exactly who will play manages 11%. The pool holds about three regular
starters averaging 60+ a round; the target needs five. See the README.

So the next real gain is the card pool:

- The essence pack loop stops at the first 3-star. Consider valuing a pull by
  whether the player is a regular starter (start rate) with a 60+ average, not
  by star tier alone - that is what the simulator says a target-clearing team
  is made of.
- Track pool strength over time. The dashboard shows it per window; a trend
  would show whether packs are actually moving it.

## Odds log

`state/odds/log.jsonl` accumulates every pre-match odds snapshot the bot
fetches. After two or three months there will be enough to replay the
simulator against real odds rather than the football-data.co.uk join, and to
check whether the measured DF/FW factors hold. Do that before touching the
weights in `src/odds.js`.

## Small things

- `data/fifa-rankings.json` is the 20 July 2026 table. FIFA's next update is
  7 October 2026; refresh it then (`WebFetch` of fotmob's ranking page, same
  format).
- The Decisive Picker plays itself the first day the slate includes a club this
  account holds a card for. Nothing to build; watch the daily report.
- The team set needs three squad lineups before it counts. Nothing the bot can
  do about the other two.
