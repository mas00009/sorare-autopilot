/**
 * Remote controls.
 *
 * A static GitHub Pages site cannot run anything on this machine, and shipping
 * a token so that it could would put write access to the repo on the open
 * internet. Instead the bot reads docs/control.json from the repo on every
 * pass. Editing it needs a GitHub login, so the authority stays with the
 * account owner and nothing secret is published.
 *
 * Falls back to the local copy when offline, and to "running" if neither can be
 * read - a network blip must not silently stop the autopilot.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL = path.join(ROOT, 'docs', 'control.json');
const REMOTE = 'https://raw.githubusercontent.com/mas00009/sorare-autopilot/main/docs/control.json';

export const DEFAULTS = { paused: false, packsEnabled: true, lineupsEnabled: true, claimsEnabled: true };

export async function read({ timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(`${REMOTE}?t=${Date.now()}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ...DEFAULTS, ...(await res.json()), source: 'github' };
  } catch { /* fall through to local */ }
  try {
    return { ...DEFAULTS, ...JSON.parse(await fs.readFile(LOCAL, 'utf8')), source: 'local' };
  } catch {
    return { ...DEFAULTS, source: 'default' };
  }
}

/** Flip a switch locally and push it, so the CLI and the web agree. */
export async function set(patch) {
  let cur = DEFAULTS;
  try { cur = { ...cur, ...JSON.parse(await fs.readFile(LOCAL, 'utf8')) }; } catch {}
  const next = { ...cur, ...patch };
  await fs.writeFile(LOCAL, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
