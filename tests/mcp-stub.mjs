/**
 * A minimal MCP server, for testing the connector client against something real.
 *
 * It answers initialize and tools/list as plain JSON and tools/call as an SSE
 * stream, because a real server may use either and the client has to handle
 * both. It also demands the credential, so a test that gets a tool list has
 * proved the header actually went out.
 */
import { createServer } from 'node:http';

const TOOLS = [
  {
    name: 'lookup_client',
    title: 'Look up a client',
    description: 'Find a client record by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The client name' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'delete_client',
    title: 'Delete a client',
    description: 'Permanently remove a client record.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

const RECORDS = {
  'acme holdings': 'Acme Holdings Inc — client since 2019, S corporation, fiscal year end 31 December.',
};

export async function startStubServer({ token = 'test-token' } = {}) {
  const calls = [];

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      // The credential is required, so reaching tools/list at all proves the
      // header was sent.
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const reply = (result) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'stub-session-1',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };

      if (message.method === 'initialize') {
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub', version: '1.0.0' },
        });
        return;
      }

      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }

      if (message.method === 'tools/list') {
        reply({ tools: TOOLS });
        return;
      }

      if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params ?? {};
        calls.push({ name, args });

        const known = TOOLS.some((t) => t.name === name);
        const text = known
          ? name === 'lookup_client'
            ? (RECORDS[String(args?.name ?? '').toLowerCase()] ?? 'No client by that name.')
            : 'Deleted.'
          : `Unknown tool: ${name}`;

        // Answered as SSE, which is the other transport shape a server may use.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.write(': keepalive\n\n');
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text }], isError: !known },
          })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unknown method: ${message.method}` },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
