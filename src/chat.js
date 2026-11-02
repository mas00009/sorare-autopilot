/**
 * Google Chat, via the Claude app in ~/gchat-agent.
 *
 * The owner misses email (2 Nov 2026), so Sorare updates go to a Chat space
 * instead. The space id lives in state/chat.json ({ "space": "spaces/..." })
 * or SORARE_CHAT_SPACE. With no space set, callers fall back to email.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTIFY = path.join(os.homedir(), 'gchat-agent', 'notify.js');

const CHAT_FILE = path.join(ROOT, 'state', 'chat.json');
const RELAY_LOG = path.join(os.homedir(), 'gchat-agent', 'logs', 'relay.log');
/** The owner's DM with the Claude app - not the Sorare space. */
const DM = 'spaces/h2Ro6qAAAAE';

export function chatSpace() {
  if (process.env.SORARE_CHAT_SPACE) return process.env.SORARE_CHAT_SPACE;
  try { const s = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')).space; if (s) return s; } catch {}
  // Not set yet: the first space the Claude app is added to after the owner
  // asked for a Sorare space (2 Nov 2026) is that space. The relay logs it.
  try {
    const lines = fs.readFileSync(RELAY_LOG, 'utf8').split('\n').filter((l) => / added to spaces\//.test(l));
    for (const l of lines) {
      const [ts] = l.split(' ');
      const space = l.match(/added to (spaces\/\S+)/)?.[1];
      if (space && space !== DM && ts >= '2026-11-02') {
        fs.writeFileSync(CHAT_FILE, JSON.stringify({ space, foundAt: new Date().toISOString(), from: 'relay log' }, null, 2));
        return space;
      }
    }
  } catch {}
  return null;
}

/** Post text to the Sorare space. Returns { sent, reason }. */
export async function postChat(text) {
  const space = chatSpace();
  if (!space) return { sent: false, reason: 'no Chat space configured' };
  if (!fs.existsSync(NOTIFY)) return { sent: false, reason: 'gchat-agent notify.js not found' };
  try {
    await run(process.execPath, [NOTIFY, '--space', space, text], { timeout: 60_000 });
    return { sent: true, via: 'chat' };
  } catch (err) {
    return { sent: false, reason: `chat: ${err.stderr?.trim() || err.message}` };
  }
}

/**
 * Post a Chat card (cardsV2): player pictures, colour, sections. Uses the
 * Claude app's own service account, the same identity notify.js posts as.
 * `text` is the plain fallback shown in notifications.
 */
export async function postCard(cardsV2, text = '') {
  const space = chatSpace();
  if (!space) return { sent: false, reason: 'no Chat space configured' };
  try {
    const gdir = path.join(os.homedir(), 'gchat-agent');
    const require = createRequire(path.join(gdir, 'package.json'));
    const { GoogleAuth } = require('google-auth-library');
    const cfg = JSON.parse(fs.readFileSync(path.join(gdir, 'config.json'), 'utf8'));
    const keyFile = path.resolve(gdir, cfg.serviceAccountKey || 'secrets/service-account.json');
    const auth = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/chat.bot'] });
    const client = await auth.getClient();
    await client.request({ url: `https://chat.googleapis.com/v1/${space}/messages`, method: 'POST', data: { text, cardsV2 } });
    return { sent: true, via: 'chat-card' };
  } catch (err) {
    return { sent: false, reason: `chat card: ${err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message}` };
  }
}
