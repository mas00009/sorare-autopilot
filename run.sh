#!/bin/bash
# Sorare Autopilot - scheduled run.
# Invoked by launchd. Self-contained: no inherited shell environment.
set -uo pipefail

DIR="$HOME/sorare-autopilot"
LOG="$DIR/state/autopilot.log"
cd "$DIR" || exit 1
mkdir -p state

# Keep the log to the last ~2000 lines.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

NODE="$(command -v node || echo /usr/local/bin/node)"
[ -x "$NODE" ] || NODE=/opt/homebrew/bin/node

{
  echo ""
  echo "======== $(date '+%Y-%m-%d %H:%M:%S %Z') ========"
  out=$("$NODE" src/cli.js run 2>&1)
  code=$?
  printf '%s\n' "$out"
  echo "---- exit $code ----"

  # Main account: the same DNP guard, for any lineup the owner set by hand.
  "$NODE" src/cli.js guard 2>&1

  # Second account (Kobe-8-24): since 26 Oct 2026 the owner wants it fully automated on
  # soccer, same as main (lineups, missions, packs), to earn gems for the NBA launch.
  # It keeps its own state file and schedule clock, plus the DNP guard. No NBA: the
  # owner plays that side himself (30 Oct 2026).
  if [ -f "$DIR/state/tokens-second.json" ]; then
    out2=$(SORARE_ACCOUNT=second "$NODE" src/cli.js run 2>&1)
    echo "---- second account ----"; printf '%s\n' "$out2"
    SORARE_ACCOUNT=second "$NODE" src/cli.js guard 2>&1
  fi

  # Once a day, both accounts: drop exact duplicate Set cards for essence (Mas, 18 Oct 2026).
  # dupes.js keeps one copy of each exact card (same player, rarity, season, edition),
  # never touches a 4- or 5-star player, a card in a lineup or a sealed card.
  TODAY=$(date +%F)
  for ACCT in main second; do
    STAMP="$DIR/state/dupes-$ACCT.date"
    [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && continue
    if [ "$ACCT" = main ]; then
      "$NODE" src/cli.js dupes 2>&1 && echo "$TODAY" > "$STAMP"
    elif [ -f "$DIR/state/tokens-second.json" ]; then
      SORARE_ACCOUNT=second "$NODE" src/cli.js dupes 2>&1 && echo "$TODAY" > "$STAMP"
    fi
  done

  # Refresh the published dashboard. Only pushes when something actually changed,
  # so a quiet pass leaves no commit noise.
  # The dashboard build reads both boards and their benches from Sorare - dozens
  # of calls. Only after a real pass, or every 30 minutes for live scores.
  dash_age=$(( $(date +%s) - $(stat -f %m "$DIR/docs/data.json" 2>/dev/null || echo 0) ))
  if ! printf '%s' "$out" | grep -q '^skip:' || [ "$dash_age" -gt 1800 ]; then
    "$NODE" src/cli.js dashboard >/dev/null 2>&1
  fi
  # Only timestamps change on most passes. Pushing those every 5 minutes ran
  # ~250 Pages deploys a day, at GitHub's ~10-an-hour limit, and every network
  # blip became a "Run failed" email. Push when something real changed, or
  # every 30 minutes so the page's "updated" time stays honest.
  substantive=$("$NODE" -e '
    const fs = require("fs"); const { execSync } = require("child_process");
    // generatedAt anywhere; lastRunAt and its "next due in" reason only on
    // the scheduler object, so a board status change still counts.
    const strip = (t) => JSON.stringify(JSON.parse(t), function (k, v) {
      if (k === "generatedAt") return undefined;
      if (v && typeof v === "object" && !Array.isArray(v) && "lastRunAt" in v) {
        const { lastRunAt, reason, ...rest } = v; return rest;
      }
      return v;
    });
    let old = "{}"; try { old = execSync("git show HEAD:docs/data.json", { encoding: "utf8" }); } catch {}
    console.log(strip(old) === strip(fs.readFileSync("docs/data.json", "utf8")) ? "no" : "yes");
  ' 2>/dev/null || echo yes)
  last=$(git -C "$DIR" log -1 --format=%ct -- docs/data.json 2>/dev/null || echo 0)
  stale=$(( $(date +%s) - last > 1800 ))
  if [ -n "$(git -C "$DIR" status --porcelain docs/data.json)" ] && { [ "$substantive" = yes ] || [ "$stale" = 1 ]; }; then
    git -C "$DIR" add docs/data.json
    git -C "$DIR" -c user.email=mmohammad@freelancer.com -c user.name="Sorare Autopilot" \
      commit -q -m "dashboard: $(date -u +%Y-%m-%dT%H:%MZ)" && git -C "$DIR" push -q origin main 2>&1
  fi
} >> "$LOG" 2>&1
