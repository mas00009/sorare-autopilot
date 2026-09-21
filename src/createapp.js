/**
 * Create the OAuth application over the API instead of the website form.
 *
 * The site's form is unusable when a browser extension intercepts Sorare's
 * requests ("You appear offline"). This does the same thing from the terminal.
 * Requires a signed-in session first: `npm run signin`.
 *
 * Note logoData is non-nullable in the schema - the logo really is required,
 * which is why the website's Create button greys out with no error shown.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gql, readState, writeState } from './client.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const M_CREATE = `
  mutation CreateOAuthApp($input: createOAuthApplicationInput!) {
    createOAuthApplication(input: $input) {
      errors { message path }
      oauthApplication { uid name redirectUris status }
      clientSecret
    }
  }
`;

export async function createApp({
  name = 'Sorare Autopilot',
  redirectUris = ['http://127.0.0.1:8737/callback'],
  logoPath = path.join(ROOT, 'logo.png'),
} = {}) {
  const logo = await fs.readFile(logoPath);
  const input = {
    name,
    redirectUris,
    logoData: logo.toString('base64'),
    logoContentType: 'image/png',
  };

  console.log(`Creating OAuth application "${name}"`);
  console.log(`  redirect: ${redirectUris.join(', ')}`);
  console.log(`  logo:     ${path.basename(logoPath)} (${logo.length} bytes)\n`);

  const d = await gql(M_CREATE, { input }, { mutationName: 'createOAuthApplication' });
  const p = d.createOAuthApplication;
  if (p?.errors?.length) {
    throw new Error(p.errors.map((e) => `${(e.path ?? []).join('.')} ${e.message}`.trim()).join('; '));
  }

  const uid = p?.oauthApplication?.uid;
  const secret = p?.clientSecret;
  if (!uid || !secret) throw new Error('Sorare returned no client credentials.');

  // Written straight to .env - the secret is never printed in full.
  const envPath = path.join(ROOT, '.env');
  let env = '';
  try { env = await fs.readFile(envPath, 'utf8'); } catch { env = ''; }
  const put = (k, v) =>
    new RegExp(`^${k}=.*$`, 'm').test(env)
      ? (env = env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`))
      : (env += `\n${k}=${v}`);
  put('SORARE_CLIENT_ID', uid);
  put('SORARE_CLIENT_SECRET', secret);
  await fs.writeFile(envPath, env, { mode: 0o600 });
  await writeState({ oauthAppUid: uid });

  console.log(`Created. Status: ${p.oauthApplication.status}`);
  console.log(`  client id:     ${uid}`);
  console.log(`  client secret: ${secret.slice(0, 6)}${'*'.repeat(10)} (written to .env, not shown)`);
  console.log('\nNext: npm run auth');
  return { uid };
}
