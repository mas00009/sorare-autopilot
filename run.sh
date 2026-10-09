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
  "$NODE" src/cli.js run 2>&1
  code=$?
  echo "---- exit $code ----"

  # Refresh the published dashboard. Only pushes when something actually changed,
  # so a quiet pass leaves no commit noise.
  "$NODE" src/cli.js dashboard >/dev/null 2>&1
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
