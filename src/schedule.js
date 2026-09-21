/**
 * Adaptive cadence.
 *
 * launchd fires on a fixed short interval; this decides whether that tick should
 * do real work. The cadence is driven by the next actual kickoff, so the bot is
 * quiet on an empty Tuesday and checks every few minutes as a lineup locks -
 * which is when late team news lands and a swap is still possible.
 */

/** Minutes between full passes, by how close the next kickoff is. */
export const LADDER = [
  { withinMin: 60, everyMin: 5 },     // final hour: confirmed XIs are out
  { withinMin: 180, everyMin: 15 },   // last 3 hours: odds firming up
  { withinMin: 720, everyMin: 60 },   // same day
  { withinMin: Infinity, everyMin: 180 },
];

/** A full pass at least this often regardless, so missions still get claimed. */
export const FLOOR_MIN = 180;

/**
 * Act this many minutes before the lineup actually locks.
 *
 * The lock is exact - Sorare sets it to the earliest kickoff among the selected
 * players - but a pass takes a few seconds and the tick that triggers it can
 * land anywhere in the 5-minute window. Aiming at the lock itself would mean
 * the last useful pass sometimes arrives just after it. Ten minutes is comfortably
 * inside the window where confirmed XIs are already out.
 */
export const LOCK_BUFFER_MIN = Number(process.env.AUTOPILOT_LOCK_BUFFER_MIN ?? 10);

export function minutesUntil(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (t - now) / 60000;
}

/** How often we should be running, given the next kickoff. */
export function cadenceFor(minsToKickoff) {
  if (minsToKickoff == null) return FLOOR_MIN;
  if (minsToKickoff < 0) return FLOOR_MIN;  // everything has kicked off
  return LADDER.find((r) => minsToKickoff <= r.withinMin).everyMin;
}

/**
 * @returns {{run: boolean, cadence: number, minsToKickoff: number|null, reason: string}}
 */
export function decide({ nextKickoff = null, nextLock = null, lastRunAt = null, now = Date.now(), buffer = LOCK_BUFFER_MIN } = {}) {
  // Work to the real lock when Sorare gives us one, falling back to kickoff.
  const deadline = nextLock ?? nextKickoff;
  const raw = minutesUntil(deadline, now);
  // Effective time left is time-to-lock minus the buffer, so the ladder tightens
  // early enough that the final pass lands before the lock rather than on it.
  const minsToKickoff = raw == null ? null : raw - buffer;
  const cadence = cadenceFor(minsToKickoff);
  const sinceLast = lastRunAt ? (now - lastRunAt) / 60000 : Infinity;

  if (sinceLast >= cadence) {
    return {
      run: true, cadence, minsToKickoff,
      reason: minsToKickoff != null && minsToKickoff >= 0
        ? `lock in ${Math.round(raw)}m (${Math.round(minsToKickoff)}m usable after ${buffer}m buffer), cadence ${cadence}m`
        : `nothing locking soon, cadence ${cadence}m`,
    };
  }
  return {
    run: false, cadence, minsToKickoff,
    reason: `last run ${Math.round(sinceLast)}m ago, next due in ${Math.round(cadence - sinceLast)}m` +
            (raw != null && raw >= 0 ? ` (lock in ${Math.round(raw)}m)` : ''),
  };
}
