/**
 * One-shot OAuth authorisation, run by the account owner.
 *
 * Opens Sorare's own consent page in your browser. You log in there.
 * This process only ever receives the authorization code that comes back,
 * exchanges it for a refresh token, and stores that token locally (0600).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { writeState, requireEnv } from './client.js';

const PORT = Number(process.env.AUTOPILOT_AUTH_PORT ?? 8737);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const AUTHORIZE_URL = 'https://sorare.com/oauth/authorize';
const TOKEN_URL = 'https://api.sorare.com/oauth/token';

export async function authorize() {
  const clientId = requireEnv('SORARE_CLIENT_ID');
  const clientSecret = requireEnv('SORARE_CLIENT_SECRET');
  const scope = process.env.SORARE_OAUTH_SCOPE ?? '';
  const state = crypto.randomBytes(16).toString('hex');

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (scope) url.searchParams.set('scope', scope);

  console.log('\nOpening Sorare to authorise this app.');
  console.log('You log in on sorare.com. Your password never touches this machine.\n');
  console.log(url.toString(), '\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const got = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (got.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = got.searchParams.get('error');
      const returnedState = got.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err) {
        res.end('<p>Authorisation refused. You can close this tab.</p>');
        server.close();
        return reject(new Error(`Authorisation refused: ${err}`));
      }
      if (returnedState !== state) {
        res.end('<p>State mismatch. Nothing was stored. You can close this tab.</p>');
        server.close();
        return reject(new Error('OAuth state mismatch - possible CSRF. Aborted.'));
      }
      res.end('<p>Authorised. You can close this tab and go back to the terminal.</p>');
      server.close();
      resolve(got.searchParams.get('code'));
    });
    server.listen(PORT, '127.0.0.1', () => {
      exec(`open ${JSON.stringify(url.toString())}`);
    });
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for authorisation (5 min).'));
    }, 5 * 60_000);
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  if (!json.refresh_token) {
    throw new Error(
      'Sorare returned no refresh token. The app may need the offline/refresh scope ' +
      'set via SORARE_OAUTH_SCOPE.',
    );
  }
  await writeState({
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  console.log('Stored refresh token in state/tokens.json (0600). You will not need to do this again.');
}
