import 'server-only';
import { MCP_TIMEOUT_MS } from './config';

/**
 * A small MCP client, Streamable HTTP transport only.
 *
 * Only three calls are needed to expose a server's tools to the model —
 * initialize, tools/list and tools/call — so this is deliberately a few hundred
 * lines rather than a dependency. Doing it in-process rather than handing the
 * server URL to the model provider is what lets the app keep the credential,
 * enforce the approved-tool list, and write every call to the audit log.
 */

const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Servers that annotate their tools say here whether one only reads. */
  readOnly?: boolean;
}

export interface McpTarget {
  url: string;
  authHeader?: string | null;
  authValue?: string | null;
}

interface Session extends McpTarget {
  sessionId: string | null;
}

/**
 * An admin can point a connector anywhere this server can reach, which
 * includes the cloud metadata endpoint. Only admins can add one, but a
 * credential-stealing URL is cheap enough to refuse outright.
 */
function assertUsableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A connector URL must be http or https.');
  }
  if (/^(169\.254\.169\.254|metadata\.google\.internal)$/i.test(url.hostname)) {
    throw new Error('That host is the cloud metadata endpoint and cannot be a connector.');
  }
  return url;
}

let nextId = 1;

/** Parses either a plain JSON body or the SSE stream a server may answer with. */
async function readMessage(res: Response): Promise<Record<string, unknown> | null> {
  const type = res.headers.get('content-type') ?? '';

  if (type.includes('application/json')) {
    return (await res.json()) as Record<string, unknown>;
  }

  if (type.includes('text/event-stream')) {
    const text = await res.text();
    // The reply to a single request arrives as one or more SSE events; the one
    // that matters is the last data payload carrying a JSON-RPC result.
    let last: Record<string, unknown> | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if ('result' in parsed || 'error' in parsed) last = parsed;
      } catch {
        /* keepalive or a partial frame; skip it */
      }
    }
    return last;
  }

  // 202 Accepted with no body is the correct answer to a notification.
  return null;
}

async function rpc(
  session: Session,
  method: string,
  params: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  notification = false,
): Promise<unknown> {
  const url = assertUsableUrl(session.url);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (session.authHeader && session.authValue) {
    headers[session.authHeader] = session.authValue;
  }
  if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;

  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params) body.params = params;
  if (!notification) body.id = nextId++;

  const timeout = AbortSignal.timeout(MCP_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
      redirect: 'error',
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new Error(`The connector did not answer within ${MCP_TIMEOUT_MS / 1000}s.`);
    }
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`Could not reach the connector: ${(err as Error).message}`);
  }

  const returned = res.headers.get('mcp-session-id');
  if (returned) session.sessionId = returned;

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`The connector answered ${res.status}. ${detail}`.trim());
  }

  if (notification) return null;

  const message = await readMessage(res);
  if (!message) throw new Error('The connector sent an empty reply.');

  if (message.error) {
    const error = message.error as { message?: string; code?: number };
    throw new Error(error.message ?? `The connector reported error ${error.code ?? ''}`.trim());
  }
  return message.result;
}

/** Opens a session. Every call re-handshakes: these are short-lived requests. */
export async function connect(target: McpTarget, signal?: AbortSignal): Promise<Session> {
  const session: Session = { ...target, sessionId: null };

  await rpc(
    session,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'usaindiacfo-assistant', version: '3.0.0' },
    },
    signal,
  );

  // Required by the protocol before any other request; a server is entitled to
  // refuse everything until it arrives.
  await rpc(session, 'notifications/initialized', undefined, signal, true).catch(() => null);

  return session;
}

export async function listTools(target: McpTarget, signal?: AbortSignal): Promise<McpTool[]> {
  const session = await connect(target, signal);
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const result = (await rpc(
      session,
      'tools/list',
      cursor ? { cursor } : undefined,
      signal,
    )) as { tools?: Record<string, unknown>[]; nextCursor?: string };

    for (const raw of result?.tools ?? []) {
      const annotations = (raw.annotations ?? {}) as Record<string, unknown>;
      tools.push({
        name: String(raw.name ?? ''),
        title: raw.title ? String(raw.title) : undefined,
        description: raw.description ? String(raw.description) : undefined,
        inputSchema: (raw.inputSchema as Record<string, unknown>) ?? undefined,
        readOnly: annotations.readOnlyHint === true,
      });
    }
    cursor = result?.nextCursor;
    // A server paginating forever must not hang the admin screen.
  } while (cursor && tools.length < 500);

  return tools.filter((t) => t.name);
}

/** Runs one tool and flattens the reply to the text the model will see. */
export async function callTool(
  target: McpTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const session = await connect(target, signal);
  const result = (await rpc(session, 'tools/call', { name, arguments: args }, signal)) as {
    content?: Record<string, unknown>[];
    structuredContent?: unknown;
    isError?: boolean;
  };

  const parts: string[] = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text') parts.push(String(item.text ?? ''));
    else if (item.type === 'resource') {
      const resource = (item.resource ?? {}) as Record<string, unknown>;
      parts.push(String(resource.text ?? `[${resource.uri ?? 'resource'}]`));
    } else parts.push(`[${String(item.type ?? 'content')} omitted]`);
  }

  if (!parts.length && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  return {
    text: parts.join('\n').trim() || 'The connector returned nothing.',
    isError: result?.isError === true,
  };
}

export { assertUsableUrl };
