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
  if [ -n "$(git -C "$DIR" status --porcelain docs/data.json)" ]; then
    git -C "$DIR" add docs/data.json
    git -C "$DIR" -c user.email=mmohammad@freelancer.com -c user.name="Sorare Autopilot" \
      commit -q -m "dashboard: $(date -u +%Y-%m-%dT%H:%MZ)" && git -C "$DIR" push -q origin main 2>&1
  fi
} >> "$LOG" 2>&1
