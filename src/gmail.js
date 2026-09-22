/**
 * Gmail REST over HTTPS.
 *
 * Outbound SMTP is blocked on this network, so mail goes through the Gmail API
 * on port 443 instead. This reuses the OAuth credentials the RoboAaron agent
 * already has at ~/.config/roboaaron/credentials - the same problem was solved
 * there, and a second set of Google credentials would only be another thing to
 * rotate. Nothing is copied; the file is read in place.
 *
 * Works headless: no browser, no Claude app, no scheduled task.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CREDS = path.join(os.homedir(), '.config', 'roboaaron', 'credentials');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export async function loadCreds(file = CREDS) {
  const out = {};
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no creds file - caller decides */ }
  return out;
}

export async function available() {
  const c = await loadCreds();
  return !!(c.GMAIL_REFRESH_TOKEN && c.GMAIL_CLIENT_ID && c.GMAIL_CLIENT_SECRET);
}

async function accessToken(c) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: c.GMAIL_CLIENT_ID,
      client_secret: c.GMAIL_CLIENT_SECRET,
      refresh_token: c.GMAIL_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token returned');
  return j.access_token;
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Encode a header value that may contain non-ASCII. */
const mimeWord = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export async function send({ to, subject, body, html = null, from = null }) {
  const c = await loadCreds();
  if (!(c.GMAIL_REFRESH_TOKEN && c.GMAIL_CLIENT_ID && c.GMAIL_CLIENT_SECRET)) {
    return { sent: false, reason: `no Gmail OAuth credentials at ${CREDS}` };
  }
  const sender = from ?? c.GMAIL_USER ?? to;

  let token;
  try { token = await accessToken(c); }
  catch (err) { return { sent: false, reason: err.message }; }

  const head =
    `From: Sorare Autopilot <${sender}>\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${mimeWord(subject)}\r\n` +
    `MIME-Version: 1.0\r\n`;

  // multipart/alternative: the plain text is the fallback for clients that will
  // not render HTML, so both halves always carry the same facts.
  const bound = `sa_${Date.now().toString(36)}`;
  const raw = b64url(html
    ? head +
      `Content-Type: multipart/alternative; boundary="${bound}"\r\n\r\n` +
      `--${bound}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n\r\n` +
      `--${bound}\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n\r\n` +
      `--${bound}--\r\n`
    : head + `Content-Type: text/plain; charset=UTF-8\r\n\r\n` + body);

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) return { sent: false, reason: `gmail send ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const j = await res.json();
  return { sent: true, id: j.id, via: 'gmail-api' };
}
