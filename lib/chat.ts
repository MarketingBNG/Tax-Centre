import 'server-only';
import crypto from 'node:crypto';
import { all, run } from './db';
import { getProvider } from './providers';
import { assembleSystemBlocks, getCustomPrompt, TITLE_PROMPT } from './prompt';
import { buildDocumentParts } from './ingest';
import { getPrefs, getProject, listMemories, resolveModel, resolveStyle, resolveThinking } from './prefs';
import { runTool, toolsFor, type ToolContext } from './tools';
import { connectorsFor, connectorTools, parseSelection } from './connectors';
import { accountTools } from './accounts';
import { appendToMessage, insertMessage, loadThread } from './thread';
import type { Turn } from './providers/types';
import type {
  ConversationRow,
  FileRow,
  MessageRow,
  NormalisedUsage,
  StreamEvent,
  ToolRun,
  UserRow,
} from './types';

export async function recordUsage(input: {
  userId: string;
  purpose: string;
  model: string;
  usage: NormalisedUsage;
  costMicros: number;
}): Promise<void> {
  await run(
    `INSERT INTO usage_records
       (id, user_id, purpose, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_micros, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.userId,
    input.purpose,
    input.model,
    input.usage.inputTokens,
    input.usage.outputTokens,
    input.usage.cacheReadTokens,
    input.usage.cacheWriteTokens,
    input.costMicros,
    Date.now(),
  );
}

/**
 * Claim files the composer uploaded before this conversation existed.
 *
 * An upload can happen before the first message, so its row starts with no
 * conversation. Binding it here — scoped to the owner — is what makes
 * `files.conversation_id` a trustworthy list of what this thread can see.
 */
export async function attachFiles(
  userId: string,
  conversationId: string,
  fileIds: string[],
): Promise<void> {
  for (const id of fileIds) {
    await run(
      `UPDATE files SET conversation_id = ?
       WHERE id = ? AND user_id = ? AND conversation_id IS NULL AND project_id IS NULL`,
      conversationId,
      id,
      userId,
    );
  }
}

export const conversationFiles = (conversationId: string): Promise<FileRow[]> =>
  all<FileRow>(
    `SELECT * FROM files WHERE conversation_id = ? AND deleted_at IS NULL
     ORDER BY created_at`,
    conversationId,
  );

export const projectFiles = (projectId: string): Promise<FileRow[]> =>
  all<FileRow>(
    `SELECT * FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at`,
    projectId,
  );

/**
 * Everything this conversation can see: its own attachments, and the shelf of
 * documents belonging to the project it sits in. The project's come first
 * because they are the stable part of the prefix and change least often.
 */
export async function visibleFiles(conversation: ConversationRow): Promise<FileRow[]> {
  const own = await conversationFiles(conversation.id);
  if (!conversation.project_id) return own;
  const shelf = await projectFiles(conversation.project_id);
  return [...shelf, ...own];
}

/* ------------------------------------------------------------------ turns */

function threadToTurns(messages: MessageRow[], docParts: Awaited<ReturnType<typeof buildDocumentParts>>['parts']): Turn[] {
  const turns: Turn[] = [];

  // Keep the documents in context rather than stripping them. Where the
  // provider caches the document prefix they read back at a fraction of the
  // input price, which beats re-fetching pages by tool and losing fidelity.
  if (docParts.length) {
    turns.push({
      role: 'user',
      parts: [...docParts, { kind: 'text', text: 'These are the attached documents.' }],
    });
    turns.push({
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Understood — I have the documents.' }],
    });
  }

  for (const m of messages) {
    if (m.content?.trim()) turns.push({ role: m.role, parts: [{ kind: 'text', text: m.content }] });
  }
  return turns;
}

export interface RunTurnInput {
  user: UserRow;
  conversation: ConversationRow;
  /** The message being answered. Null only for a conversation with no history. */
  parentId: string | null;
  /** Set to extend an existing answer rather than write a new one. */
  continueMessageId?: string | null;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void | Promise<void>;
}

/**
 * One answer: assembles the prompt, streams the model, runs whatever tools it
 * asks for, and persists the result.
 *
 * The answer is written to the database in `finally` rather than on success,
 * so a stop or a disconnect keeps whatever had already streamed. That is the
 * behaviour the Stop button promises.
 */
export async function runTurn(input: RunTurnInput): Promise<void> {
  const { user, conversation, parentId, continueMessageId, signal, onEvent } = input;

  const [files, prefs, admin] = await Promise.all([
    visibleFiles(conversation),
    getPrefs(user.id),
    getCustomPrompt(),
  ]);

  const [style, memories, project] = await Promise.all([
    resolveStyle(user.id, conversation.style, prefs),
    prefs.memory_enabled ? listMemories(user.id) : Promise.resolve([]),
    conversation.project_id ? getProject(user.id, conversation.project_id) : Promise.resolve(null),
  ]);

  const model = resolveModel(conversation.model, prefs);
  const thinking = resolveThinking(conversation.thinking, prefs);

  // Only the connectors this thread switched on, and only the tools an admin
  // approved on each of them.
  const connectorRows = await connectorsFor(conversation.connectors);
  const connectorMap = connectorTools(connectorRows);
  const accountMap = await accountTools(
    user.id,
    parseSelection(conversation.connectors).accountIds,
  );

  const toolContext: ToolContext = {
    user,
    conversationId: conversation.id,
    files,
    memoryEnabled: prefs.memory_enabled === 1,
    connectorTools: connectorMap,
    accountTools: accountMap,
    signal,
  };
  const tools = toolsFor(toolContext);

  const system = assembleSystemBlocks({
    admin,
    projectName: project?.name,
    projectInstructions: project?.instructions,
    styleInstructions: style.instructions,
    personalInstructions: prefs.instructions,
    memories,
    files,
    toolsAvailable: tools.length > 0,
    connectorsAvailable: connectorMap.size + accountMap.size > 0,
  });

  const history = await loadThread(conversation.id, parentId);
  const { parts: docParts } = await buildDocumentParts(files);

  // Continuing: the partial answer is handed to the provider as a prefill, so
  // it must not also appear as the last turn of the history.
  const prefill = continueMessageId
    ? (history.find((m) => m.id === continueMessageId)?.content ?? '')
    : '';
  const forModel = continueMessageId
    ? history.filter((m) => m.id !== continueMessageId)
    : history;

  const provider = getProvider();

  let assembled = '';
  let thoughts = '';
  const toolRuns: ToolRun[] = [];
  let finished = false;

  try {
    const result = await provider.streamChat({
      system,
      turns: threadToTurns(forModel, docParts),
      model,
      thinking,
      tools: tools.length ? tools : undefined,
      runTool: tools.length ? (call) => runTool(toolContext, call) : undefined,
      prefill: prefill || undefined,
      signal,
      onText: (delta) => {
        assembled += delta;
        void onEvent({ type: 'text', delta });
      },
      onThinking: (delta) => {
        thoughts += delta;
        void onEvent({ type: 'thinking', delta });
      },
      onToolRun: (run) => {
        toolRuns.push(run);
        void onEvent({ type: 'tool', run });
      },
    });

    finished = true;
    assembled = result.text || assembled;
    thoughts = result.thinking || thoughts;

    const messageId = await persist({
      conversation,
      parentId,
      continueMessageId,
      content: assembled,
      thinking: thoughts,
      model: result.model,
      finish: result.finish,
      toolRuns,
    });

    await recordUsage({
      userId: user.id,
      purpose: 'chat',
      model: result.model,
      usage: result.usage,
      costMicros: result.costMicros,
    });

    await onEvent({ type: 'saved', userMessageId: null, assistantMessageId: messageId });
    await onEvent({ type: 'usage', usage: result.usage, costMicros: result.costMicros });
    await onEvent({ type: 'done', costMicros: result.costMicros, finish: result.finish });
  } finally {
    // Stopped or failed mid-stream: keep what was written, marked as aborted so
    // the reader is offered Continue rather than being told nothing happened.
    if (!finished && assembled.trim()) {
      await persist({
        conversation,
        parentId,
        continueMessageId,
        content: assembled,
        thinking: thoughts,
        model,
        finish: 'aborted',
        toolRuns,
      });
    }
  }
}

async function persist(input: {
  conversation: ConversationRow;
  parentId: string | null;
  continueMessageId?: string | null;
  content: string;
  thinking: string;
  model: string;
  finish: 'stop' | 'length' | 'aborted';
  toolRuns: ToolRun[];
}): Promise<string> {
  if (input.continueMessageId) {
    await appendToMessage(
      input.continueMessageId,
      input.content,
      input.finish,
      input.toolRuns,
    );
    await run(
      `UPDATE conversations SET updated_at = ? WHERE id = ?`,
      Date.now(),
      input.conversation.id,
    );
    return input.continueMessageId;
  }

  return insertMessage({
    conversationId: input.conversation.id,
    role: 'assistant',
    content: input.content,
    parentId: input.parentId,
    thinking: input.thinking,
    model: input.model,
    finish: input.finish,
    toolRuns: input.toolRuns,
  });
}

/* ----------------------------------------------------------------- titles */

/**
 * Names a thread from its opening exchange.
 *
 * Worth a second model call: the alternative — the first sixty characters of
 * the question — produces a sidebar of near-identical rows, which is exactly
 * the thing that makes an old conversation impossible to find again. Failure
 * is silent and leaves the fallback title in place; a chat that works but is
 * badly named beats an error.
 */
export async function generateTitle(input: {
  user: UserRow;
  conversationId: string;
  question: string;
  answer: string;
}): Promise<string | null> {
  const provider = getProvider();
  if (!provider.isConfigured()) return null;

  try {
    const result = await provider.streamChat({
      system: [TITLE_PROMPT],
      thinking: 'off',
      turns: [
        {
          role: 'user',
          parts: [
            {
              kind: 'text',
              text: `Question:\n${input.question.slice(0, 2000)}\n\nAnswer:\n${input.answer.slice(0, 1200)}`,
            },
          ],
        },
      ],
    });

    const title = result.text
      .replace(/^["'\s]+|["'\s.]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 70)
      .trim();
    if (!title) return null;

    await recordUsage({
      userId: input.user.id,
      purpose: 'title',
      model: result.model,
      usage: result.usage,
      costMicros: result.costMicros,
    });

    await run(
      `UPDATE conversations SET title = ? WHERE id = ? AND title = 'New chat'`,
      title,
      input.conversationId,
    );
    return title;
  } catch {
    return null;
  }
}
