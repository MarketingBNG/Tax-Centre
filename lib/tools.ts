import 'server-only';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { ANALYSIS_TIMEOUT_MS, TOOLS_ENABLED } from './config';
import { audit, run } from './db';
import { runConnectorTool, type ResolvedConnectorTool } from './connectors';
import { runAccountTool, type ResolvedAccountTool } from './accounts';
import type { FileRow, UserRow } from './types';
import type { ToolInvocation, ToolSpec } from './providers/types';

/* ------------------------------------------------------------ the sandbox */

/**
 * Runs one model-written script and returns what it printed.
 *
 * `node:vm` is an isolation boundary, not a security boundary — the standard
 * caveat applies. Two things narrow it enough to be worth having:
 *
 *   - Code generation is disabled in the context, which removes `eval` and the
 *     `Function` constructor. That is the vector every published vm escape goes
 *     through (`this.constructor.constructor("return process")()`), so closing
 *     it turns a plausible escape into a hard one.
 *   - A fresh context starts with no `require`, `process`, `fetch` or timers,
 *     so there is nothing to reach the network or the filesystem with even
 *     before the timeout expires.
 *
 * The code is written by the model, and documents in context are untrusted, so
 * treat this as defence in depth behind the prompt rule that says instructions
 * inside a document are never instructions to the model.
 */
function runAnalysis(code: string, files: Record<string, string>): string {
  const logs: string[] = [];
  const print = (...args: unknown[]) => {
    if (logs.length > 400) return;
    logs.push(
      args
        .map((a) =>
          typeof a === 'string'
            ? a
            : (() => {
                try {
                  return JSON.stringify(a, null, 2);
                } catch {
                  return String(a);
                }
              })(),
        )
        .join(' '),
    );
  };

  const sandbox = {
    files,
    console: { log: print, info: print, warn: print, error: print },
    /**
     * Splits delimited text into rows, handling the quoting Excel emits.
     * Provided because every second script needs it and hand-rolling it in
     * model-written code is where the off-by-one bugs live.
     */
    parseDelimited(text: string, delimiter = ','): string[][] {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') {
            quoted = false;
          } else {
            cell += ch;
          }
        } else if (ch === '"') {
          quoted = true;
        } else if (ch === delimiter) {
          row.push(cell);
          cell = '';
        } else if (ch === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        } else if (ch !== '\r') {
          cell += ch;
        }
      }
      if (cell || row.length) {
        row.push(cell);
        rows.push(row);
      }
      return rows;
    },
    /** Parses "1,234.50", "(1,234.50)" and "$1,234.50" the way a ledger means them. */
    money(value: unknown): number {
      const s = String(value ?? '').trim();
      if (!s) return NaN;
      const negative = /^\(.*\)$/.test(s);
      const n = Number(s.replace(/[()$,\s]/g, '').replace(/[^0-9.eE+-]/g, ''));
      return negative ? -n : n;
    },
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  let completion: unknown;
  try {
    completion = vm.runInContext(code, context, {
      timeout: ANALYSIS_TIMEOUT_MS,
      displayErrors: true,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const printed = logs.length ? `\nPrinted before it failed:\n${logs.join('\n')}` : '';
    throw new Error(`${message}${printed}`);
  }

  const tail =
    completion === undefined || completion === null
      ? ''
      : `\nFinal value: ${typeof completion === 'string' ? completion : JSON.stringify(completion)}`;

  const printed = logs.join('\n');
  if (!printed && !tail) {
    return 'The script ran but printed nothing. Use console.log to report results.';
  }
  return `${printed}${tail}`.slice(0, 20_000);
}

/* -------------------------------------------------------------- the specs */

const ANALYSIS_TOOL: ToolSpec = {
  name: 'run_analysis',
  description:
    'Run a short synchronous JavaScript program to compute something exactly. Use ' +
    'this whenever an answer depends on arithmetic over more than a couple of ' +
    'numbers — totals, reconciliations, variances, date maths, checking that a ' +
    'column foots. Reading figures off a page and adding them up in your head is ' +
    'what this tool exists to replace.\n\n' +
    'Available in scope: `files`, an object mapping each attached filename to its ' +
    'full text; `parseDelimited(text, delimiter)`, which returns rows of cells; ' +
    '`money(value)`, which parses accounting-formatted numbers including ' +
    'parenthesised negatives; and `console.log`. There is no require, no network, ' +
    'no filesystem and no async — await and timers will not work. Print every ' +
    'result you intend to use with console.log; nothing else comes back.',
  parameters: {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: 'One short line, shown to the reader, saying what this computes.',
      },
      code: { type: 'string', description: 'The program. Synchronous JavaScript.' },
    },
    required: ['explanation', 'code'],
    additionalProperties: false,
  },
};

const REMEMBER_TOOL: ToolSpec = {
  name: 'remember',
  description:
    'Save one durable fact about this person or how they work, so it is available ' +
    'in every future conversation. Use it when they ask you to remember something, ' +
    'and when a lasting preference or a stable fact about their work becomes clear ' +
    '("I handle the Rodriguez file", "always give me the figure before the ' +
    'explanation"). Do not save anything that is only true of the conversation you ' +
    'are in, anything about a specific client matter that will be closed, or ' +
    'anything they told you in confidence about a third party. One fact per call, ' +
    'written as a standalone sentence that will still make sense in a year.',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact, as one standalone sentence.' },
    },
    required: ['fact'],
    additionalProperties: false,
  },
};

const FORGET_TOOL: ToolSpec = {
  name: 'forget',
  description:
    'Delete a remembered fact by its id, when the person asks you to forget it or ' +
    'tells you something that makes it wrong. The ids are listed with the ' +
    'remembered facts in your instructions.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id shown beside the fact.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------- the runner */

export interface ToolContext {
  user: UserRow;
  conversationId: string;
  files: FileRow[];
  memoryEnabled: boolean;
  /** Approved connector tools this conversation switched on, by function name. */
  connectorTools?: Map<string, ResolvedConnectorTool>;
  /** Tools reaching this person own connected accounts, by function name. */
  accountTools?: Map<string, ResolvedAccountTool>;
  signal?: AbortSignal;
  /** Called when the model saves or deletes a fact, so the UI can refresh. */
  onMemoryChanged?: () => void;
}

/** Which tools this turn gets. Nothing to analyse means no analysis tool. */
export function toolsFor(ctx: ToolContext): ToolSpec[] {
  if (!TOOLS_ENABLED) return [];
  const specs: ToolSpec[] = [];
  if (ctx.files.some((f) => (f.extracted_text ?? '').trim().length > 0)) {
    specs.push(ANALYSIS_TOOL);
  }
  if (ctx.memoryEnabled) specs.push(REMEMBER_TOOL, FORGET_TOOL);
  for (const entry of ctx.connectorTools?.values() ?? []) specs.push(entry.spec);
  for (const entry of ctx.accountTools?.values() ?? []) specs.push(entry.spec);
  return specs;
}

/**
 * Text of every attached document, keyed by filename, for the sandbox.
 *
 * Native PDFs and images have no extracted text — the model reads those with
 * its eyes — so they are absent here rather than present and empty, which is
 * the difference between the model working around a gap and inventing figures
 * for a file it thinks it has.
 */
function datasets(files: FileRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const text = (f.extracted_text ?? '').trim();
    if (text) out[f.filename] = text;
  }
  return out;
}

export async function runTool(ctx: ToolContext, call: ToolInvocation): Promise<string> {
  const { name, args } = call;

  // A connector reaches a system outside this app, so every call is logged with
  // who caused it before it is made, whether or not it then succeeds.
  const connectorTool = ctx.connectorTools?.get(name);
  if (connectorTool) {
    await audit(ctx.user.id, 'connector.call', 'connector', connectorTool.connector.id, {
      tool: connectorTool.toolName,
      conversation: ctx.conversationId,
      args: JSON.stringify(args).slice(0, 500),
    });
    return runConnectorTool(connectorTool, args, ctx.signal);
  }

  // Reaching somebody own mailbox or drive, with their own token. Logged the
  // same way, and for the same reason, as a shared connector.
  const accountTool = ctx.accountTools?.get(name);
  if (accountTool) {
    await audit(ctx.user.id, 'account.call', 'account', accountTool.provider.id, {
      tool: accountTool.tool.name,
      conversation: ctx.conversationId,
      args: JSON.stringify(args).slice(0, 500),
    });
    return runAccountTool(ctx.user.id, accountTool, args);
  }

  if (name === 'run_analysis') {
    const code = String(args.code ?? '').trim();
    if (!code) throw new Error('No code was supplied.');
    const available = datasets(ctx.files);
    if (!Object.keys(available).length) {
      return (
        'No document in this conversation has extractable text. PDFs and images ' +
        'are read visually and are not available to this tool.'
      );
    }
    return runAnalysis(code, available);
  }

  if (name === 'remember') {
    if (!ctx.memoryEnabled) return 'Memory is switched off for this person.';
    const fact = String(args.fact ?? '').trim().slice(0, 600);
    if (!fact) throw new Error('No fact was supplied.');
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO memories (id, user_id, text, source_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      ctx.user.id,
      fact,
      ctx.conversationId,
      Date.now(),
    );
    ctx.onMemoryChanged?.();
    return `Saved as ${id.slice(0, 8)}.`;
  }

  if (name === 'forget') {
    if (!ctx.memoryEnabled) return 'Memory is switched off for this person.';
    const prefix = String(args.id ?? '').trim().slice(0, 36);
    if (!prefix) throw new Error('No id was supplied.');
    // Ownership is in the predicate: an id from another person's list matches
    // nothing rather than deleting anything.
    await run(
      `DELETE FROM memories WHERE user_id = ? AND id LIKE ?`,
      ctx.user.id,
      `${prefix.replace(/[%_]/g, '')}%`,
    );
    ctx.onMemoryChanged?.();
    return 'Forgotten.';
  }

  throw new Error(`Unknown tool: ${name}`);
}
