/**
 * Sorare GraphQL client.
 *
 * Auth model: OAuth authorization-code, run once by the account owner in their
 * own browser (see `npm run auth`). We store only the refresh token. Claude
 * never sees, types or stores the account password - Sorare's own login page
 * handles it. There is deliberately no email/password sign-in path in here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMutationAllowed } from './guardrails.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, 'state', 'tokens.json');

const GQL_URL = 'https://api.sorare.com/graphql';
const TOKEN_URL = 'https://api.sorare.com/oauth/token';

const RATE_LIMIT_MS = 320;      // ~190/min, just under the 200/min API-key tier
const MAX_RETRIES = 4;

let lastCall = 0;

async function pace() {
  const wait = RATE_LIMIT_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export async function getAccessToken({ force = false } = {}) {
  const state = await readState();
  const fresh = state.accessToken && state.expiresAt && Date.now() < state.expiresAt - 60_000;
  if (fresh && !force) return state.accessToken;

  const refreshToken = state.refreshToken || process.env.SORARE_REFRESH_TOKEN;
  if (!refreshToken) throw new NoOAuthError('no refresh token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: requireEnv('SORARE_CLIENT_ID'),
    client_secret: requireEnv('SORARE_CLIENT_SECRET'),
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  await writeState({
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

class NoOAuthError extends Error {}

/**
 * Resolve credentials for a request.
 *
 * Route A (OAuth) is preferred because it renews itself. Route B (terminal
 * sign-in) is used when no OAuth app exists yet - Sorare gates OAuth behind
 * identity verification, so this is the path until that clears.
 */
export async function getAuth({ force = false } = {}) {
  try {
    const token = await getAccessToken({ force });
    return { token, aud: null };
  } catch (err) {
    if (!(err instanceof NoOAuthError)) throw err;
  }

  const state = await readState();
  if (!state.jwt) {
    throw new Error(
      'Not signed in. Run `npm run signin` (route B), or `npm run auth` once ' +
      'your Sorare identity verification clears (route A).',
    );
  }
  if (state.jwtExpiresAt && Date.now() > state.jwtExpiresAt - 60_000) {
    throw new Error(
      `Your Sorare token expired on ${new Date(state.jwtExpiresAt).toISOString().slice(0, 10)}. ` +
      'Run `npm run signin` again.',
    );
  }
  return { token: state.jwt, aud: state.jwtAud ?? 'sorare-autopilot' };
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

/**
 * Run a GraphQL document.
 * Mutations must declare their name so the guardrail can vet them.
 */
export async function gql(query, variables = {}, { mutationName = null, retries = MAX_RETRIES } = {}) {
  if (mutationName) assertMutationAllowed(mutationName);

  const { token, aud } = await getAuth();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (aud) headers['JWT-AUD'] = aud;
  if (process.env.SORARE_API_KEY) headers.APIKEY = process.env.SORARE_API_KEY;

  await pace();
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 && retries > 0) {
    const after = Number(res.headers.get('Retry-After') ?? 5);
    await new Promise((r) => setTimeout(r, after * 1000));
    return gql(query, variables, { mutationName, retries: retries - 1 });
  }
  if (res.status === 401 && retries > 0) {
    await getAuth({ force: true });
    return gql(query, variables, { mutationName, retries: retries - 1 });
  }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

export { readState, writeState, STATE };
