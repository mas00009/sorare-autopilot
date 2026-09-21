/**
 * Route B: sign in from your own terminal.
 *
 * You type your Sorare email and password here, on your own machine. The
 * password is bcrypt-hashed locally against Sorare's salt and sent only to
 * api.sorare.com. It is never written to disk, never logged, never echoed to
 * the terminal, and never leaves this process in plaintext.
 *
 * What gets stored is the JWT, in state/tokens.json (0600). It expires after
 * about 30 days, so re-run `npm run signin` when the autopilot says the token
 * has lapsed. Route A (OAuth, once identity verification clears) removes that
 * chore permanently.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { writeState } from './client.js';

const SALT_URL = (email) => `https://api.sorare.com/api/v1/users/${encodeURIComponent(email)}`;
const GQL_URL = 'https://api.sorare.com/graphql';

/** The audience claim. Must match on every later request via the JWT-AUD header. */
export const AUD = process.env.SORARE_JWT_AUD || 'sorare-autopilot';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false;
    const mutable = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: mutable, terminal: true });
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    if (hidden) muted = true;
  });
}

async function fetchSalt(email) {
  const res = await fetch(SALT_URL(email), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not fetch salt (HTTP ${res.status}).`);
  const { salt } = await res.json();
  if (!salt) throw new Error('Sorare returned no salt for that address.');
  return salt;
}

async function callSignIn(variables, apiKey) {
  const query = `
    mutation SignIn($input: signInInput!, $aud: String!) {
      signIn(input: $input) {
        currentUser { slug nickname }
        jwtToken(aud: $aud) { token expiredAt }
        otpSessionChallenge
        tcuToken
        errors { message }
      }
    }
  `;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.APIKEY = apiKey;

  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data?.signIn;
}

export async function signIn() {
  const apiKey = process.env.SORARE_API_KEY || null;
  console.log('\nSorare sign-in. Your password is hashed on this machine and sent only to Sorare.');
  console.log('It is never stored or logged.\n');

  const email = process.env.SORARE_EMAIL || (await ask('Sorare email: '));
  const password = await ask('Password (hidden): ', { hidden: true });
  if (!email || !password) throw new Error('Email and password are both required.');

  const salt = await fetchSalt(email);
  let hashed = bcrypt.hashSync(password, salt);

  let result = await callSignIn({ input: { email, password: hashed }, aud: AUD }, apiKey);

  // Two-factor, if the account has it enabled.
  if (result?.otpSessionChallenge) {
    console.log('\nTwo-factor is on for this account.');
    const otp = await ask('Authenticator code: ');
    result = await callSignIn(
      { input: { otpSessionChallenge: result.otpSessionChallenge, otpAttempt: otp }, aud: AUD },
      apiKey,
    );
  }

  // Wipe the plaintext and the hash from memory as soon as they are spent.
  hashed = null;

  if (result?.tcuToken) {
    throw new Error(
      'Sorare needs you to accept updated terms before signing in. ' +
      'Log in at sorare.com once, accept them, then re-run this.',
    );
  }
  if (result?.errors?.length) {
    throw new Error(`Sign-in refused: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  if (!result?.jwtToken?.token) {
    throw new Error('Sign-in returned no token. Check the email and password.');
  }

  await writeState({
    jwt: result.jwtToken.token,
    jwtAud: AUD,
    jwtExpiresAt: new Date(result.jwtToken.expiredAt).getTime(),
    nickname: result.currentUser?.nickname ?? null,
  });

  const days = Math.round((new Date(result.jwtToken.expiredAt) - Date.now()) / 86_400_000);
  console.log(`\nSigned in as ${result.currentUser?.nickname ?? email}.`);
  console.log(`Token stored in state/tokens.json (0600), good for about ${days} days.`);
  console.log('Run `npm run doctor` next.');
}
