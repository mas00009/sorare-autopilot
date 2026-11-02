/**
 * Which Sorare sport this process plays. Football unless SORARE_SPORT=NBA.
 *
 * The owner's split (2 Nov 2026): Mas is fully automated on football AND
 * NBA; Kobe (SORARE_ACCOUNT=second) is football only - its NBA is played by
 * hand and the bot must never touch it.
 */
export const SPORT = String(process.env.SORARE_SPORT ?? 'FOOTBALL').toUpperCase() === 'NBA' ? 'NBA' : 'FOOTBALL';
export const IS_NBA = SPORT === 'NBA';

if (IS_NBA && (process.env.SORARE_ACCOUNT ?? '') !== '') {
  // Hard stop: Kobe's NBA is the owner's own.
  throw new Error('NBA automation is for the main account only - refusing to run NBA on a second account.');
}
