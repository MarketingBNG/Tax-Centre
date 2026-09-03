import { currentUser, unauthorized, badRequest, notFound } from '@/lib/auth';
import { one, run } from '@/lib/db';
import { attachFiles, generateTitle, runTurn } from '@/lib/chat';
import { getMessage, insertMessage } from '@/lib/thread';
import { isKnownModel, isThinkingLevel } from '@/lib/models';
import { validSelection } from '@/lib/connectors';
import { activeSkills } from '@/lib/skills';
import type { ConversationRow, StreamEvent } from '@/lib/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

type Action = 'send' | 'edit' | 'retry' | 'continue';

const ACTIONS: Action[] = ['send', 'edit', 'retry', 'continue'];

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const {
    conversationId,
    question,
    fileIds,
    messageId,
    model,
    style,
    thinking,
  } = body as Record<string, unknown>;

  const action: Action = ACTIONS.includes(body.action as Action) ? (body.action as Action) : 'send';
  const attached: string[] = Array.isArray(fileIds) ? (fileIds as string[]) : [];
  const asked = typeof question === 'string' ? question.trim() : '';

  if (action === 'send' && !asked && !attached.length) return badRequest('Empty message');
  if (action === 'edit' && !asked) return badRequest('An edited message cannot be empty');
  if (action !== 'send' && typeof messageId !== 'string') return badRequest('No message given');

  let conversation = await one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    String(conversationId ?? ''),
    user.id,
  );
  if (!conversation) return notFound();

  // The composer's pickers are conversation-scoped: choosing Deep for this
  // thread must not change the default for every other one.
  const settings: Partial<Record<'model' | 'style' | 'thinking', string | null>> = {};
  if (typeof model === 'string') settings.model = isKnownModel(model) ? model : null;
  if (typeof style === 'string') settings.style = style || null;
  if (typeof thinking === 'string') settings.thinking = isThinkingLevel(thinking) ? thinking : null;

  for (const [column, value] of Object.entries(settings)) {
    await run(`UPDATE conversations SET ${column} = ? WHERE id = ?`, value, conversation.id);
    conversation = { ...conversation, [column]: value } as ConversationRow;
  }

  // Which connectors this thread may reach. Sent with the message rather than
  // only patched, because a conversation created by the first send has no row
  // to patch until this point.
  if (Array.isArray(body.connectors)) {
    const live = await validSelection(user.id, body.connectors);
    const stored = live.length ? JSON.stringify(live) : null;
    await run(`UPDATE conversations SET connectors = ? WHERE id = ?`, stored, conversation.id);
    conversation = { ...conversation, connectors: stored };
  }

  // Pinned skills, sent with the message for the same reason connectors are:
  // a conversation created by this very request has no row to patch first.
  if (Array.isArray(body.skills)) {
    const wanted = (body.skills as unknown[]).map(String);
    const live = (await activeSkills(user.id))
      .filter((s) => wanted.includes(s.id))
      .map((s) => s.id);
    const stored = live.length ? JSON.stringify(live) : null;
    await run(`UPDATE conversations SET skills = ? WHERE id = ?`, stored, conversation.id);
    conversation = { ...conversation, skills: stored };
  }

  if (attached.length) await attachFiles(user.id, conversation.id, attached);

  /* ------------------------------------------------------ where to attach */

  let parentId: string | null = null;
  let continueMessageId: string | null = null;
  let questionForTitle = asked;

  if (action === 'send') {
    const text = asked || 'Take a look at the attached file(s).';
    questionForTitle = text;
    parentId = await insertMessage({
      conversationId: conversation.id,
      role: 'user',
      content: text,
      parentId: conversation.head_id,
    });
  } else {
    const target = await getMessage(conversation.id, String(messageId));
    if (!target) return notFound();

    if (action === 'edit') {
      if (target.role !== 'user') return badRequest('Only your own message can be edited');
      // A sibling, not an overwrite: the original question and its answer stay
      // reachable through the version arrows.
      parentId = await insertMessage({
        conversationId: conversation.id,
        role: 'user',
        content: asked,
        parentId: target.parent_id,
      });
    } else {
      if (target.role !== 'assistant') return badRequest('Only an answer can be retried');
      parentId = target.parent_id;
      if (action === 'continue') continueMessageId = target.id;
    }
  }

  /* ------------------------------------------------------------ streaming */

  const encoder = new TextEncoder();
  const needsTitle = conversation.title === 'New chat';
  let assembled = '';

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          // Client disconnected; the answer still persists in runTurn.
        }
      };

      try {
        await runTurn({
          user,
          conversation: conversation!,
          parentId,
          continueMessageId,
          // Closing the browser's fetch aborts this request, which stops the
          // model call rather than letting it run on and bill.
          signal: req.signal,
          onEvent: (event) => {
            if (event.type === 'text') assembled += event.delta;
            emit(event);
          },
        });

        if (needsTitle && assembled.trim()) {
          const title = await generateTitle({
            user,
            conversationId: conversation!.id,
            question: questionForTitle || 'the attached documents',
            answer: assembled,
          });
          if (title) emit({ type: 'title', title });
        }
      } catch (err) {
        const message = (err as Error).message ?? 'Something went wrong.';
        // An abort is the Stop button working, not a failure to report.
        if ((err as Error).name !== 'AbortError') emit({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
