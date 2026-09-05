import { currentUser, unauthorized, forbidden } from '@/lib/auth';
import { all } from '@/lib/db';
import { originFor } from '@/lib/accounts/origin';
import { CONNECTORS_ENABLED } from '@/lib/config';
import {
  ACCOUNT_PROVIDERS,
  isConfigured as accountConfigured,
} from '@/lib/accounts/providers';
import { BOOKS_PROVIDERS, isConfigured } from '@/lib/review-engine/books-oauth';

export const dynamic = 'force-dynamic';

/**
 * Everything this server can be connected to, in one answer.
 *
 * There are four different places a connection can be made — a client's
 * accounting system, a person's own mailbox, an MCP server, and the return data
 * itself — and until now the only way to find out what was available was to
 * visit all four and infer the rest. That is a bad way to answer "what can we
 * connect", which is a question an admin asks once and should not have to
 * assemble.
 *
 * Everything reports one of four states, and the distinction matters because
 * each needs a different person to act:
 *
 *   ready        — usable now
 *   needs_setup  — the code is built; someone must register an app or set keys
 *   needs_route  — the code is built; it cannot be reached from where this runs
 *   not_built    — no code yet
 *   unavailable  — settled as impossible, with the reason
 *
 * No credential ever leaves this route. Only whether one is present.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const origin = originFor(req);

  const connected = await all<{ provider: string; n: string }>(
    `SELECT provider, COUNT(*) AS n FROM books_connections
      WHERE revoked_at IS NULL GROUP BY provider`,
  );
  const revoked = await all<{ provider: string; n: string }>(
    `SELECT provider, COUNT(*) AS n FROM books_connections
      WHERE revoked_at IS NOT NULL GROUP BY provider`,
  );
  const mcp = await all<{ n: string }>(`SELECT COUNT(*) AS n FROM connectors WHERE enabled = 1`);
  const accounts = await all<{ provider: string; n: string }>(
    `SELECT provider, COUNT(*) AS n FROM oauth_accounts GROUP BY provider`,
  );

  const countFor = (rows: { provider: string; n: string }[], id: string) =>
    Number(rows.find((r) => r.provider === id)?.n ?? 0);

  const envName = (id: string) => (id === 'quickbooks' ? 'QUICKBOOKS' : id.toUpperCase());

  return Response.json({
    groups: [
      {
        id: 'books',
        title: "Client books",
        blurb:
          "Read a client's trial balance from their own system instead of asking them to " +
          'export one. Figures that arrive by code can be checked; figures read off a page ' +
          'cannot, so this is the part of a review that is verified rather than believed.',
        where: "Connect a client on that client's books screen, inside their review.",
        items: [
          ...BOOKS_PROVIDERS.map((provider) => ({
            id: provider.id,
            label: provider.label,
            how: 'The client authorises the firm’s app (OAuth)',
            state: isConfigured(provider) ? 'ready' : 'needs_setup',
            detail: provider.setupHint,
            redirectUri: `${origin}/api/books/${provider.id}/callback`,
            envKeys: [`${envName(provider.id)}_CLIENT_ID`, `${envName(provider.id)}_CLIENT_SECRET`],
            scopes: provider.scopes,
            inUse: countFor(connected, provider.id),
            needsReconnect: countFor(revoked, provider.id),
            note:
              provider.id === 'quickbooks'
                ? 'Intuit publishes no read-only accounting scope. This app never calls an ' +
                  'endpoint that writes, but the grant itself is not narrowed — unlike ' +
                  'Xero and Zoho, where it is.'
                : provider.id === 'zoho'
                  ? "Register in the client's own data centre. Tokens issued on zoho.in are " +
                    'not valid on zoho.com, and fail looking like a credentials problem.'
                  : null,
          })),
          {
            id: 'tally',
            label: 'Tally',
            how: "An adapter over the firm's read-only MCP server",
            /*
             * Built, and unreachable rather than unregistered. Tally is desktop
             * software reading a company file on a machine in the office, so no
             * amount of hosting brings it closer: moving this app elsewhere
             * changes nothing, and moving the MCP server to a host moves it
             * away from the data it reads.
             */
            state: 'needs_route',
            detail:
              'The adapter and the account mapping are built and tested. What is missing is a ' +
              'route: Tally runs on a machine in the office and a cloud deployment cannot ' +
              'reach it. Either an agent on that machine dials outward, or this app runs ' +
              'inside the office. Exposing Tally’s own HTTP interface to the internet is ' +
              'the one option to avoid — it has no authentication at all.',
            redirectUri: null,
            envKeys: [],
            scopes: [],
            inUse: countFor(connected, 'tally'),
            needsReconnect: 0,
            note: null,
          },
        ],
      },
      {
        id: 'returns',
        title: 'Return data',
        blurb:
          'The prepared return itself. Nothing here is connected today, which is why every ' +
          'return-side figure is read off a page and why a serious finding resting on one ' +
          'goes to a person to confirm by name.',
        where: 'Returns are uploaded to an engagement as PDFs.',
        items: [
          {
            id: 'drake',
            label: 'Drake',
            how: 'Structured export',
            state: 'unavailable',
            detail:
              'Settled rather than pending: Drake cannot reach this server, so there is no ' +
              'export to parse. Page images are permanent, and the per-figure confirmation ' +
              'queue is the mechanism rather than a stopgap.',
            redirectUri: null,
            envKeys: [],
            scopes: [],
            inUse: 0,
            needsReconnect: 0,
            note: null,
          },
          {
            id: 'proconnect',
            label: 'ProConnect',
            how: 'Export parser',
            state: 'not_built',
            detail:
              'Needs one real export file to read. A parser written against a guessed format ' +
              'is code that looks finished and fails on the first real return.',
            redirectUri: null,
            envKeys: [],
            scopes: [],
            inUse: 0,
            needsReconnect: 0,
            note: null,
          },
        ],
      },
      {
        id: 'assistant',
        title: 'Assistant connectors',
        blurb:
          'MCP servers the chat assistant may call — a document store, a practice system, an ' +
          'internal API. Adding one grants nothing on its own; individual tools are ticked, ' +
          'and every call is written to the audit log.',
        where: 'Admin → Connectors.',
        items: [
          {
            id: 'mcp',
            label: 'MCP servers',
            how: 'Streamable HTTP with a static credential',
            state: CONNECTORS_ENABLED ? 'ready' : 'needs_setup',
            detail: CONNECTORS_ENABLED
              ? 'Enabled. Servers requiring an OAuth sign-in are not supported yet.'
              : 'Turned off on this server (CONNECTORS_ENABLED=false).',
            redirectUri: null,
            envKeys: ['CONNECTORS_ENABLED'],
            scopes: [],
            inUse: Number(mcp[0]?.n ?? 0),
            needsReconnect: 0,
            note: null,
          },
        ],
      },
      {
        id: 'accounts',
        title: 'Personal accounts',
        blurb:
          'Somebody’s own Drive, mail or Box, connected by them and readable only in ' +
          'their own conversations. Read-only, always. These are not client books and are ' +
          'never shared across people.',
        where: 'Each person connects their own under Settings → Accounts.',
        items: ACCOUNT_PROVIDERS.map((provider) => ({
          id: provider.id,
          label: provider.label,
          how: 'Each person signs in themselves',
          state: accountConfigured(provider) ? 'ready' : 'needs_setup',
          detail: provider.setupHint,
          redirectUri: `${origin}/api/accounts/${provider.id}/callback`,
          envKeys: [],
          scopes: provider.scopes,
          inUse: countFor(accounts, provider.id),
          needsReconnect: 0,
          note: null,
        })),
      },
    ],
  });
}
