# Status

Daily reset is **07:00 UTC = 5pm Sydney**. Everything claimable is held until then.

## Order after the reset (implemented)

1. Claim board steps (`acknowledgeStep`) and collect-mission steps (`claimTask`)
2. Inspect what the claims granted for a 3-star card
3. Only if none appeared, buy essence packs until one drops

A 5-min launchd tick forces a full pass the moment the daily cycle id changes,
so claiming happens within 5 minutes of 5pm rather than waiting out the cadence.

## Not yet done

**The bonus pack after every 10 packs.** Must be claimed BEFORE opening another
pack or the counter stops advancing and the free pack is lost. Not found in
`inboxTasks`, `setEndOfSeasonTasks`, `featuredTasks` or `setPlayTasks` - it may
only appear once packs have been bought this cycle. Check again after the reset
once a pack has been opened, then wire it ahead of step 3 above.

`node src/cli.js plan --claim-now` previews what would be claimed, without claiming.

## Other

- Sorare token expires 2026-10-21; CLI warns from 10 days out.
- `AUTOPILOT_WEBHOOK_URL` unwired.
