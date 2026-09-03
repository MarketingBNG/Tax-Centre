import 'server-only';
import crypto from 'node:crypto';
import { all, one, run } from '../db';
import { decryptSecret, encryptSecret } from '../secrets';
import {
  ACCOUNT_PROVIDERS,
  accountProvider,
  isConfigured,
  toolName,
  toolSpec,
  type AccountProvider,
  type AccountTool,
} from './providers';
import type { ToolSpec } from '../providers/types';

export { ACCOUNT_PROVIDERS, accountProvider, isConfigured } from './providers';
export type { AccountProvider } from './providers';

interface AccountRow {
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string;
  account_label: string | null;
  created_at: number;
  updated_at: number;
}

/** An authorisation left half-finished should not sit around being reusable. */
const STATE_TTL_MS = 15 * 60 * 1000;

/* --------------------------------------------------------- starting a flow */

export async function beginAuth(input: {
  userId: string;
  providerId: string;
  redirectUri: string;
}): Promise<string> {
  const provider = accountProvider(input.providerId);
  if (!provider) throw new Error('No such account type.');
  if (!isConfigured(provider)) {
    throw new Error(`${provider.label} is not set up on this deployment. ${provider.setupHint}`);
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  await run(`DELETE FROM oauth_states WHERE created_at < ?`, Date.now() - STATE_TTL_MS);
  await run(
    `INSERT INTO oauth_states (state, user_id, provider, code_verifier, redirect_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    state,
    input.userId,
    provider.id,
    verifier,
    input.redirectUri,
    Date.now(),
  );

  const params = new URLSearchParams({
    client_id: provider.clientId(),
    redirect_uri: input.redirectUri,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(provider.extraAuthParams ?? {}),
  });
  if (provider.scopes.length) params.set('scope', provider.scopes.join(' '));

  return `${provider.authorizeUrl}?${params}`;
}

/* ------------------------------------------------------------- finishing */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function exchange(
  provider: AccountProvider,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: provider.clientId(),
      client_secret: provider.clientSecret(),
      ...body,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? `The token request failed (${res.status}).`,
    );
  }
  return data;
}

export async function completeAuth(input: {
  code: string;
  state: string;
}): Promise<{ providerId: string; label: string | null }> {
  const pending = await one<{
    user_id: string;
    provider: string;
    code_verifier: string;
    redirect_to: string | null;
    created_at: number;
  }>(`SELECT * FROM oauth_states WHERE state = ?`, input.state);

  // Single use, whatever happens next: a state that has been seen must not be
  // replayable.
  await run(`DELETE FROM oauth_states WHERE state = ?`, input.state);

  if (!pending) throw new Error('That sign-in link has expired. Start again from Settings.');
  if (Date.now() - Number(pending.created_at) > STATE_TTL_MS) {
    throw new Error('That sign-in took too long. Start again from Settings.');
  }

  const provider = accountProvider(pending.provider);
  if (!provider) throw new Error('No such account type.');

  const token = await exchange(provider, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: pending.redirect_to ?? '',
    code_verifier: pending.code_verifier,
  });

  let label: string | null = null;
  try {
    label = await provider.identify(token.access_token!);
  } catch {
    // A working token whose owner cannot be named is still a working token.
  }

  const now = Date.now();
  await run(
    `INSERT INTO oauth_accounts
       (user_id, provider, access_token, refresh_token, expires_at, scope,
        account_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope,
       account_label = EXCLUDED.account_label,
       updated_at    = EXCLUDED.updated_at`,
    pending.user_id,
    provider.id,
    encryptSecret(token.access_token!),
    token.refresh_token ? encryptSecret(token.refresh_token) : null,
    token.expires_in ? now + token.expires_in * 1000 : null,
    token.scope ?? provider.scopes.join(' '),
    label,
    now,
    now,
  );

  return { providerId: provider.id, label };
}

/* ------------------------------------------------------------ the tokens */

/**
 * A usable access token, refreshed if it has expired.
 *
 * Returns null rather than throwing when the account simply is not connected,
 * or when its tokens were written under a previous AUTH_SECRET and can no
 * longer be decrypted — both mean the same thing to the caller: ask the person
 * to connect it again.
 */
export async function validToken(userId: string, providerId: string): Promise<string | null> {
  const provider = accountProvider(providerId);
  if (!provider) return null;

  const row = await one<AccountRow>(
    `SELECT * FROM oauth_accounts WHERE user_id = ? AND provider = ?`,
    userId,
    providerId,
  );
  if (!row) return null;

  const expiresAt = row.expires_at ? Number(row.expires_at) : null;
  // A minute of slack, so a token does not expire in flight.
  const stillGood = !expiresAt || expiresAt - 60_000 > Date.now();
  if (stillGood) {
    const token = decryptSecret(row.access_token);
    if (token) return token;
  }

  const refresh = decryptSecret(row.refresh_token);
  if (!refresh) return null;

  const token = await exchange(provider, { grant_type: 'refresh_token', refresh_token: refresh });
  const now = Date.now();

  await run(
    `UPDATE oauth_accounts
        SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
            expires_at = ?, updated_at = ?
      WHERE user_id = ? AND provider = ?`,
    encryptSecret(token.access_token!),
    // Box rotates refresh tokens on every use; Google does not send a new one.
    token.refresh_token ? encryptSecret(token.refresh_token) : null,
    token.expires_in ? now + token.expires_in * 1000 : null,
    now,
    userId,
    providerId,
  );

  return token.access_token!;
}

/* ------------------------------------------------------------- the store */

export interface ConnectedAccount {
  provider: string;
  label: string;
  accountLabel: string | null;
  connectedAt: number;
  toolCount: number;
}

export async function connectedAccounts(userId: string): Promise<ConnectedAccount[]> {
  const rows = await all<AccountRow>(
    `SELECT * FROM oauth_accounts WHERE user_id = ? ORDER BY provider`,
    userId,
  );

  return rows.flatMap((r) => {
    const provider = accountProvider(r.provider);
    if (!provider) return [];
    return [
      {
        provider: provider.id,
        label: provider.label,
        accountLabel: r.account_label,
        connectedAt: Number(r.created_at),
        toolCount: provider.tools.length,
      },
    ];
  });
}

export const disconnectAccount = (userId: string, providerId: string): Promise<void> =>
  run(`DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?`, userId, providerId);

/* ------------------------------------------------------- exposing to the model */

export interface ResolvedAccountTool {
  provider: AccountProvider;
  tool: AccountTool;
  spec: ToolSpec;
}

/**
 * The tools of the accounts this conversation switched on, for this person.
 *
 * Scoped to the one asking, always. Two people in the same firm running the
 * same connector see their own Drive and nobody else's, because the token that
 * makes the call is the one attached to their user id.
 */
export async function accountTools(
  userId: string,
  providerIds: string[],
): Promise<Map<string, ResolvedAccountTool>> {
  const map = new Map<string, ResolvedAccountTool>();
  if (!providerIds.length) return map;

  const connected = await connectedAccounts(userId);

  for (const id of providerIds) {
    const provider = accountProvider(id);
    if (!provider || !isConfigured(provider)) continue;
    if (!connected.some((c) => c.provider === id)) continue;

    for (const tool of provider.tools) {
      map.set(toolName(provider, tool), { provider, tool, spec: toolSpec(provider, tool) });
    }
  }

  return map;
}

export async function runAccountTool(
  userId: string,
  resolved: ResolvedAccountTool,
  args: Record<string, unknown>,
): Promise<string> {
  const token = await validToken(userId, resolved.provider.id);
  if (!token) {
    throw new Error(
      `${resolved.provider.label} is not connected, or the connection has expired. ` +
        `Ask the person to reconnect it under Settings.`,
    );
  }
  return resolved.tool.run(token, args);
}
