# Next session: make the bot actually PLAY

It reads, picks and claims. It does not perform daily tasks. Start here.

## 1. The free daily pack  (PARTLY FOUND)

`currentUser.packs(sport:)` returns Pack objects with `claimed` and
`cardPack { effectivePrice currency }`. **Two of the six packs there have
`effectivePrice: 0`** - free packs do come through the normal pack system, they
are just not listed in `market.setSections` (all 12 of those are 1000 essence or
10-50 gems).

Right now `packs` shows 0 unclaimed, yet the site still offers the daily pack. So
the pack object probably does not exist until something *grants* it. Look for the
grant: a mutation that awards the daily pack, or a zero-price slug passed to
`buyCardPack`. Once it exists, `claimCardsFromPack(packId, chosenCardSlugs)`
opens it.

Also wired and ready: `openFreePacks()` in `src/autopilot.js` handles
probabilistic bundles (`myWheelRewards` -> `probabilisticBundlesOpen`). All 50 of
those are already opened, so it finds nothing, but the path works and
`probabilisticBundlesOpen` is now allow-listed (the type carries no price field,
so opening is free).

## 2. The Decisive Player Picker  (NOT BUILT - biggest remaining gap)

`setPlayTasks` returns one task, `DECISIVE_PLAYER_PICKER`, state READY, progress 0.
It needs picks submitted, so the mutation is `upsertTaskLineup(taskId,
taskAppearances, targetScore)` or `upsertTaskAppearances(taskId, taskAppearances)`.
Read `ManagerTaskInterface` (it has `target` and `progress`) and the task's own
compose bench to see which players are selectable, then submit.

## 3. The bonus pack after every 10  (STILL NOT FOUND)

Never located. It only becomes visible once packs are being opened regularly.
Must be claimed BEFORE the next pack or the counter stops advancing.

## Settled today

- Essence floor lowered to **1000** at the owner's instruction (was 4000, which
  blocked all buying at a 4500 balance).
- Target rule fixed: a gap smaller than the spread of five players (~56 points)
  is now played. Refusing to enter guaranteed zero where entering had ~17%.
