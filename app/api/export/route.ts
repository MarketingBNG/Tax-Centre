import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { all, one } from '@/lib/db';
import { loadThread, parseToolLog } from '@/lib/thread';
import { listMemories, listProjects, listStyles, getPrefs } from '@/lib/prefs';
import { modelLabel } from '@/lib/models';
import type { ConversationRow } from '@/lib/types';

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Strips the citation markers, which mean nothing outside the app. */
const plain = (text: string) => text.replace(/\[\[cite:[^\]]*\]\]/g, '').trim();

const slug = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'chat';

/**
 * Two exports behind one route.
 *
 *   ?conversationId=…  one thread as Markdown, for pasting into a file note
 *   ?all=1             everything this person has, as JSON
 *
 * The JSON one is the answer to "can I have my data" and to "we are leaving" —
 * both need the whole set, not a rendering of it.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const params = new URL(req.url).searchParams;
  const conversationId = params.get('conversationId');

  if (conversationId) {
    const conversation = await one<ConversationRow>(
      `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
      conversationId,
      user.id,
    );
    if (!conversation) return notFound();

    const thread = await loadThread(conversation.id, conversation.head_id);
    const lines = [
      `# ${conversation.title}`,
      '',
      `_Exported ${stamp(Date.now())} from the assistant._`,
      '',
    ];

    for (const m of thread) {
      const who = m.role === 'user' ? user.display_name || 'You' : 'Assistant';
      const label = m.model ? ` · ${modelLabel(m.model)}` : '';
      lines.push(`## ${who}${label}`, '', plain(m.content), '');

      const tools = parseToolLog(m.tool_log);
      for (const t of tools) {
        lines.push(`> **${t.summary}**`, '', '```', t.output.slice(0, 4000), '```', '');
      }
    }

    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug(conversation.title)}.md"`,
      },
    });
  }

  const [conversations, projects, memories, styles, prefs] = await Promise.all([
    all<ConversationRow>(
      `SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at`,
      user.id,
    ),
    listProjects(user.id),
    listMemories(user.id, 10_000),
    listStyles(user.id),
    getPrefs(user.id),
  ]);

  const messages = await all<Record<string, unknown>>(
    `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ? ORDER BY m.created_at`,
    user.id,
  );

  const payload = {
    exportedAt: stamp(Date.now()),
    user: { email: user.email, displayName: user.display_name },
    preferences: {
      instructions: prefs.instructions,
      model: prefs.model,
      style: prefs.style,
      thinking: prefs.thinking,
      memoryEnabled: prefs.memory_enabled === 1,
    },
    projects,
    styles,
    memories,
    conversations,
    messages,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="assistant-export.json"`,
    },
  });
}
