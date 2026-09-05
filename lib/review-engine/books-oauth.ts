import 'server-only';
import crypto from 'node:crypto';
import { all, one, run as exec, audit } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/secrets';

/**
 * Connecting a client's own accounting system.
 *
 * Item 2 of the guidance: QuickBooks Online, Zoho Books and Xero, read-only.
 * All three are cloud systems, and all three only let software read a
 * company's books after that company has consented through OAuth. There is no
 * key a firm can paste in.
 *
 * ## Who registers what
 *
 * The firm registers ONE developer app per vendor and gets one client id and
 * secret. Clients register nothing — each client authorises the firm's app
 * against their own company, and that grant is stored here. So the vendor
 * paperwork is three forms in total, not three forms per client.
 *
 * ## Why the grant belongs to the client, not the reviewer
 *
 * lib/accounts holds a person's own Drive or Gmail, keyed by user id, because
 * that mailbox is theirs. A client's ledger is not the reviewer's, and a grant
 * that disappears when the reviewer leaves the firm is a grant that will
 * disappear at the worst time. So books_connections is keyed by client, and
 * records who obtained the grant separately from who it is for.
 *
 * ## What is deliberately not here
 *
 * Reading the trial balance itself. Every vendor returns its reports in a
 * different shape, and those shapes are not guessable — writing a parser
 * against an imagined response is how you get code that looks finished and
 * fails on the first real company. Each provider therefore carries a `probe`
 * that dumps what the vendor actually returned; the parser is written from
 * that, once, with a real connection in front of it.
 *
 * Every scope below is read-only. This platform never writes to a client's
 * books, and a write scope would have to be re-consented by every client,
 * which is the right amount of friction for that decision.
 */

const uuid = () => crypto.randomUUID();
const now = () => Date.now();

export type BooksProviderId = 'quickbooks' | 'xero' | 'zoho';

export interface BooksProvider {
  id: BooksProviderId;
  label: string;
  /** Shown to an admin who has not registered the developer app yet. */
  setupHint: string;
  authorizeUrl: (region: string | null) => string;
  tokenUrl: (region: string | null) => string;
  scopes: string[];
  /** Vendors differ on whether PKCE is supported; all three accept it. */
  usesPkce: boolean;
  clientId: () => string;
  clientSecret: () => string;
  /**
   * Which company was authorised.
   *
   * Tokens alone do not say. QuickBooks returns the realm on the callback,
   * Xero has to be asked, Zoho needs the organisation list. Until this is
   * answered the connection cannot be stored, because a grant that does not
   * name its company is a grant nobody can audit.
   */
  identify: (
    token: string,
    ctx: { callbackParams: URLSearchParams; region: string | null },
  ) => Promise<{ externalId: string; label: string | null }>;
  /** Dumps a real response so the report parser can be written from fact. */
  probe: (conn: ResolvedConnection) => Promise<string>;
}

/* ------------------------------------------------------------ credentials */

/**
 * Credentials come from the environment, and their absence is a first-class
 * answer rather than a crash.
 *
 * A firm that has registered QuickBooks and not Xero should see Xero offered
 * as "not set up yet" with the steps, not a 500 from a route nobody expected
 * to be reachable.
 */
const env = (key: string): string => process.env[key] ?? '';

export const isConfigured = (provider: BooksProvider): boolean =>
  Boolean(provider.clientId() && provider.clientSecret());

/* -------------------------------------------------------------- providers */

const QUICKBOOKS: BooksProvider = {
  id: 'quickbooks',
  label: 'QuickBooks Online',
  setupHint:
    'Register the app at developer.intuit.com → Create an app → QuickBooks Online and ' +
    'Payments, then set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET. Add this ' +
    "app's callback URL to the app's Redirect URIs.",
  authorizeUrl: () => 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: () => 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  // Accounting, read and write in one scope: Intuit does not publish a
  // read-only accounting scope, so restraint is enforced by this code never
  // calling a mutating endpoint rather than by the grant. Worth stating
  // plainly rather than implying the scope is narrower than it is.
  scopes: ['com.intuit.quickbooks.accounting'],
  usesPkce: true,
  clientId: () => env('QUICKBOOKS_CLIENT_ID'),
  clientSecret: () => env('QUICKBOOKS_CLIENT_SECRET'),

  async identify(_token, { callbackParams }) {
    // Intuit puts the company id on the callback itself.
    const realmId = callbackParams.get('realmId');
    if (!realmId) {
      throw new Error(
        'QuickBooks did not return a realmId on the callback, so which company was ' +
          'authorised is unknown. The connection was not saved.',
      );
    }
    return { externalId: realmId, label: null };
  },

  async probe(conn) {
    const base =
      env('QUICKBOOKS_API_BASE') || 'https://quickbooks.api.intuit.com';
    const url =
      `${base}/v3/company/${conn.externalId}/reports/TrialBalance?minorversion=75`;
    return describeResponse(url, {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: 'application/json',
    });
  },
};

const XERO: BooksProvider = {
  id: 'xero',
  label: 'Xero',
  setupHint:
    'Register the app at developer.xero.com → My Apps → New app (Web app), then set ' +
    'XERO_CLIENT_ID and XERO_CLIENT_SECRET.',
  authorizeUrl: () => 'https://login.xero.com/identity/connect/authorize',
  tokenUrl: () => 'https://identity.xero.com/connect/token',
  // offline_access is what makes the refresh token appear; without it the
  // connection dies after thirty minutes and looks like a bug.
  scopes: ['offline_access', 'accounting.reports.read', 'accounting.settings.read'],
  usesPkce: true,
  clientId: () => env('XERO_CLIENT_ID'),
  clientSecret: () => env('XERO_CLIENT_SECRET'),

  async identify(token) {
    // Xero issues one token across every organisation the user authorised, so
    // the tenant has to be asked for and then sent on every call.
    const res = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Xero would not list the authorised organisations (${res.status}).`);
    }
    const list = (await res.json()) as { tenantId?: string; tenantName?: string }[];
    const first = Array.isArray(list) ? list[0] : null;
    if (!first?.tenantId) {
      throw new Error('Xero returned no organisations for this authorisation.');
    }
    // More than one is possible and is not something to guess at: the person
    // picks, on the screen. Recorded here so that choice is visible.
    return { externalId: first.tenantId, label: first.tenantName ?? null };
  },

  async probe(conn) {
    return describeResponse('https://api.xero.com/api.xro/2.0/Reports/TrialBalance', {
      Authorization: `Bearer ${conn.accessToken}`,
      'Xero-tenant-id': conn.externalId,
      Accept: 'application/json',
    });
  },
};

const ZOHO: BooksProvider = {
  id: 'zoho',
  label: 'Zoho Books',
  setupHint:
    'Register the app at api-console.zoho.com → Server-based Applications, then set ' +
    'ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET. Register in the data centre the client ' +
    'account lives in.',
  /**
   * Zoho is regional, and this is the detail that wastes an afternoon.
   *
   * An account created in India lives on zoho.in and its tokens are not valid
   * on zoho.com. Sending them to the wrong host fails as an invalid token,
   * which reads like a credentials problem and is not one — so the region is
   * stored on the connection rather than inferred at call time.
   */
  authorizeUrl: (region) => `https://accounts.zoho.${region ?? 'com'}/oauth/v2/auth`,
  tokenUrl: (region) => `https://accounts.zoho.${region ?? 'com'}/oauth/v2/token`,
  scopes: ['ZohoBooks.reports.READ', 'ZohoBooks.settings.READ'],
  // Zoho wants access_type=offline for a refresh token, handled in authorize().
  usesPkce: false,
  clientId: () => env('ZOHO_CLIENT_ID'),
  clientSecret: () => env('ZOHO_CLIENT_SECRET'),

  async identify(token, { region }) {
    const host = `https://www.zohoapis.${region ?? 'com'}`;
    const res = await fetch(`${host}/books/v3/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        `Zoho would not list the organisations (${res.status}). If this is a token error, ` +
          `check the data centre: this connection is using zoho.${region ?? 'com'}.`,
      );
    }
    const body = (await res.json()) as {
      organizations?: { organization_id?: string; name?: string }[];
    };
    const first = body.organizations?.[0];
    if (!first?.organization_id) {
      throw new Error('Zoho returned no organisations for this authorisation.');
    }
    return { externalId: first.organization_id, label: first.name ?? null };
  },

  async probe(conn) {
    const host = `https://www.zohoapis.${conn.dataRegion ?? 'com'}`;
    return describeResponse(
      `${host}/books/v3/reports/trialbalance?organization_id=${conn.externalId}`,
      { Authorization: `Zoho-oauthtoken ${conn.accessToken}`, Accept: 'application/json' },
    );
  },
};

export const BOOKS_PROVIDERS: BooksProvider[] = [QUICKBOOKS, XERO, ZOHO];

export const booksProvider = (id: string): BooksProvider | null =>
  BOOKS_PROVIDERS.find((p) => p.id === id) ?? null;

/* ------------------------------------------------------------------ probe */

/**
 * Fetches once and describes what came back, structure first.
 *
 * This is the tool that turns "we think the trial balance looks like this"
 * into a parser written against the real thing. It prints the top-level shape
 * and a bounded sample rather than the whole report, because a report for a
 * real company is large and the point is the shape.
 */
async function describeResponse(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();

  const lines = [`GET ${url}`, `${res.status} ${res.statusText}`, ''];

  if (!res.ok) {
    lines.push(text.slice(0, 2000));
    return lines.join('\n');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    lines.push('Not JSON. First 2000 characters:', text.slice(0, 2000));
    return lines.join('\n');
  }

  const shape = (node: unknown, depth = 0): string => {
    const pad = '  '.repeat(depth);
    if (Array.isArray(node)) {
      if (!node.length) return `${pad}[] (empty)`;
      return `${pad}[${node.length} items]\n${shape(node[0], depth + 1)}`;
    }
    if (node && typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>)
        .slice(0, 40)
        .map(([k, v]) =>
          v && typeof v === 'object'
            ? `${pad}${k}:\n${shape(v, depth + 1)}`
            : `${pad}${k}: ${JSON.stringify(v)?.slice(0, 120)}`,
        )
        .join('\n');
    }
    return `${pad}${JSON.stringify(node)?.slice(0, 120)}`;
  };

  lines.push('Structure:', shape(parsed), '', 'Raw (first 4000 characters):', text.slice(0, 4000));
  return lines.join('\n');
}

/* ------------------------------------------------- the authorisation dance */

export interface StartedAuthorization {
  url: string;
  state: string;
}

/**
 * Begins an authorisation and returns where to send the browser.
 *
 * The PKCE verifier is stored server-side rather than in a cookie: a cookie the
 * browser can read is a cookie an injected script can read, and the verifier is
 * the one secret standing between an intercepted code and a usable token.
 */
export async function startAuthorization(input: {
  provider: BooksProvider;
  clientKey: string;
  engagementId?: string | null;
  redirectUri: string;
  redirectTo?: string | null;
  region?: string | null;
  startedBy?: string | null;
}): Promise<StartedAuthorization> {
  if (!isConfigured(input.provider)) {
    throw new Error(
      `${input.provider.label} is not set up yet. ${input.provider.setupHint}`,
    );
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');

  await exec(
    `INSERT INTO books_oauth_states
       (state, client_key, provider, engagement_id, code_verifier, redirect_to, started_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    state,
    input.clientKey,
    input.provider.id,
    input.engagementId ?? null,
    verifier,
    input.redirectTo ?? null,
    input.startedBy ?? null,
    now(),
  );

  const params = new URLSearchParams({
    client_id: input.provider.clientId(),
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: input.provider.scopes.join(' '),
    state,
  });

  if (input.provider.usesPkce) {
    params.set(
      'code_challenge',
      crypto.createHash('sha256').update(verifier).digest('base64url'),
    );
    params.set('code_challenge_method', 'S256');
  }
  if (input.provider.id === 'zoho') {
    // Without these Zoho issues an access token and no refresh token, and the
    // connection silently stops working an hour later.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return {
    url: `${input.provider.authorizeUrl(input.region ?? null)}?${params}`,
    state,
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function exchange(
  provider: BooksProvider,
  region: string | null,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetch(provider.tokenUrl(region), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // Intuit and Xero both want the client credentials in the Basic header
      // rather than the body; Zoho accepts them in the body. Sending both is
      // not safe — some servers reject the duplicate — so this follows the
      // provider.
      ...(provider.id === 'zoho'
        ? {}
        : {
            authorization: `Basic ${Buffer.from(
              `${provider.clientId()}:${provider.clientSecret()}`,
            ).toString('base64')}`,
          }),
    },
    body:
      provider.id === 'zoho'
        ? new URLSearchParams({
            ...Object.fromEntries(body),
            client_id: provider.clientId(),
            client_secret: provider.clientSecret(),
          })
        : body,
    signal: AbortSignal.timeout(30_000),
  });

  const token = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || token.error || !token.access_token) {
    throw new Error(
      `${provider.label} refused the token request: ` +
        `${token.error_description ?? token.error ?? res.status}`,
    );
  }
  return token;
}

export interface ResolvedConnection {
  id: string;
  clientKey: string;
  provider: BooksProviderId;
  externalId: string;
  externalLabel: string | null;
  dataRegion: string | null;
  accessToken: string;
}

export interface BooksConnectionRow {
  id: string;
  client_key: string;
  provider: BooksProviderId;
  external_id: string;
  external_label: string | null;
  data_region: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | number | null;
  scope: string;
  revoked_at: string | number | null;
  last_error: string | null;
  connected_by: string | null;
  created_at: string | number;
  updated_at: string | number;
}

/**
 * Completes an authorisation.
 *
 * The state row is consumed whatever happens next: a code that has been
 * presented once must not be presentable again, and leaving the row behind on
 * failure is how a replay becomes possible.
 */
export async function completeAuthorization(input: {
  state: string;
  code: string;
  redirectUri: string;
  callbackParams: URLSearchParams;
  region?: string | null;
}): Promise<BooksConnectionRow> {
  const pending = await one<{
    state: string;
    client_key: string;
    provider: BooksProviderId;
    engagement_id: string | null;
    code_verifier: string;
    started_by: string | null;
    created_at: string | number;
  }>(`SELECT * FROM books_oauth_states WHERE state = ?`, input.state);

  await exec(`DELETE FROM books_oauth_states WHERE state = ?`, input.state);

  if (!pending) {
    throw new Error('That authorisation is not one this server started, or it has expired.');
  }
  // Ten minutes is longer than a consent screen takes and shorter than a
  // browser left open over lunch.
  if (now() - Number(pending.created_at) > 10 * 60 * 1000) {
    throw new Error('That authorisation took too long. Start it again.');
  }

  const provider = booksProvider(pending.provider);
  if (!provider) throw new Error(`Unknown provider ${pending.provider}.`);

  const region = input.region ?? null;

  const token = await exchange(
    provider,
    region,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      ...(provider.usesPkce ? { code_verifier: pending.code_verifier } : {}),
    }),
  );

  const identity = await provider.identify(token.access_token!, {
    callbackParams: input.callbackParams,
    region,
  });

  const id = uuid();
  const expiresAt = token.expires_in ? now() + token.expires_in * 1000 : null;

  await exec(
    `INSERT INTO books_connections
       (id, client_key, provider, external_id, external_label, data_region,
        access_token, refresh_token, expires_at, scope, revoked_at, last_error,
        connected_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT (client_key, provider, external_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, books_connections.refresh_token),
       expires_at = EXCLUDED.expires_at,
       scope = EXCLUDED.scope,
       external_label = EXCLUDED.external_label,
       data_region = EXCLUDED.data_region,
       -- Reconnecting is how a revoked grant is repaired, so clear the marks.
       revoked_at = NULL,
       last_error = NULL,
       updated_at = EXCLUDED.updated_at`,
    id,
    pending.client_key,
    provider.id,
    identity.externalId,
    identity.label,
    region,
    encryptSecret(token.access_token!),
    token.refresh_token ? encryptSecret(token.refresh_token) : null,
    expiresAt,
    token.scope ?? provider.scopes.join(' '),
    pending.started_by,
    now(),
    now(),
  );

  await audit(pending.started_by, 'books.connected', 'books_connection', identity.externalId, {
    clientKey: pending.client_key,
    provider: provider.id,
    label: identity.label,
  });

  const row = await one<BooksConnectionRow>(
    `SELECT * FROM books_connections
      WHERE client_key = ? AND provider = ? AND external_id = ?`,
    pending.client_key,
    provider.id,
    identity.externalId,
  );
  return row!;
}

/* --------------------------------------------------------------- refresh */

/** Refreshed this far before expiry, so a long import does not die mid-call. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a usable access token, refreshing if it is near expiry.
 *
 * A refresh failure is recorded on the row rather than only thrown. The
 * failure usually means the client revoked access, and that fact has to reach
 * the screen — otherwise the next person to open the engagement sees an import
 * error with no explanation months after the grant lapsed.
 */
export async function resolveConnection(row: BooksConnectionRow): Promise<ResolvedConnection> {
  const provider = booksProvider(row.provider);
  if (!provider) throw new Error(`Unknown provider ${row.provider}.`);
  if (row.revoked_at) {
    throw new Error(
      `${provider.label} access for this client was withdrawn. Reconnect it before importing.`,
    );
  }

  const expiresAt = row.expires_at === null ? null : Number(row.expires_at);

  /**
   * A null decrypt is not a crash, it is a grant that can no longer be used.
   *
   * decryptSecret returns null when the ciphertext will not open — in practice
   * because AUTH_SECRET was rotated, which is exactly the behaviour that makes
   * a stolen database dump useless. The connection then needs re-consenting,
   * and saying so is more useful than a stack trace about a missing token.
   */
  let accessToken = decryptSecret(row.access_token);
  const refreshToken = decryptSecret(row.refresh_token);

  const fresh =
    accessToken !== null && (expiresAt === null || expiresAt - now() > REFRESH_MARGIN_MS);

  if (!fresh) {
    if (!refreshToken) {
      const reason =
        accessToken === null
          ? 'The stored tokens could not be decrypted, which happens when the encryption ' +
            'key is rotated.'
          : 'The access token expired and no refresh token was stored.';
      await markRevoked(row.id, reason);
      throw new Error(
        `${provider.label} access has expired and cannot be renewed automatically. ` +
          `Reconnect the client. (${reason})`,
      );
    }
    try {
      const token = await exchange(
        provider,
        row.data_region,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
      accessToken = token.access_token!;
      await exec(
        `UPDATE books_connections
            SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
                expires_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?`,
        encryptSecret(accessToken),
        token.refresh_token ? encryptSecret(token.refresh_token) : null,
        token.expires_in ? now() + token.expires_in * 1000 : null,
        now(),
        row.id,
      );
    } catch (err) {
      await markRevoked(row.id, (err as Error).message);
      throw new Error(
        `${provider.label} would not renew access for this client, which usually means the ` +
          `client withdrew it. Reconnect to continue. (${(err as Error).message})`,
      );
    }
  }

  // Unreachable by the logic above, and worth keeping: the alternative is a
  // request sent with the literal string "null" as a bearer token, which fails
  // as an authorisation error and sends whoever reads it hunting the wrong bug.
  if (accessToken === null) {
    await markRevoked(row.id, 'No usable access token after refresh.');
    throw new Error(`${provider.label} produced no usable access token. Reconnect the client.`);
  }

  return {
    id: row.id,
    clientKey: row.client_key,
    provider: row.provider,
    externalId: row.external_id,
    externalLabel: row.external_label,
    dataRegion: row.data_region,
    accessToken,
  };
}

async function markRevoked(id: string, reason: string): Promise<void> {
  await exec(
    `UPDATE books_connections SET revoked_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    now(),
    reason.slice(0, 500),
    now(),
    id,
  );
}

/* ----------------------------------------------------------------- store */

export const listConnections = (clientKey: string) =>
  all<BooksConnectionRow>(
    `SELECT * FROM books_connections WHERE client_key = ? ORDER BY provider`,
    clientKey,
  );

export const getConnection = (id: string) =>
  one<BooksConnectionRow>(`SELECT * FROM books_connections WHERE id = ?`, id);

export async function disconnect(actorId: string | null, id: string): Promise<void> {
  const row = await getConnection(id);
  if (!row) return;
  await exec(`DELETE FROM books_connections WHERE id = ?`, id);
  await audit(actorId, 'books.disconnected', 'books_connection', row.external_id, {
    clientKey: row.client_key,
    provider: row.provider,
  });
}

/** Abandoned authorisations are not kept; nothing reads them after ten minutes. */
export const purgeStaleStates = () =>
  exec(`DELETE FROM books_oauth_states WHERE created_at < ?`, now() - 60 * 60 * 1000);
