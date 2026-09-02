import { currentUser, unauthorized } from '@/lib/auth';
import { all } from '@/lib/db';

/** Search a reviewer's own conversations by title and by message text. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();

  const user = await currentUser();
  if (!user) return unauthorized();
  if (q.length < 2) return Response.json([]);

  // `~` is the LIKE escape character rather than a backslash: a backslash has
  // to be escaped in the SQL string literal too, and getting that wrong yields
  // "ESCAPE expression must be a single character". `~` needs no escaping
  // anywhere, so the intent stays readable.
  const needle = `%${q.replace(/[~%_]/g, (c) => `~${c}`)}%`;

  return Response.json(
    all<{ id: string; title: string; updated_at: number; snippet: string | null }>(
      `SELECT c.id, c.title, c.updated_at,
              (SELECT substr(m.content, 1, 160) FROM messages m
                WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '~'
                ORDER BY m.created_at LIMIT 1) AS snippet
       FROM conversations c
       WHERE c.user_id = ?
         AND (c.title LIKE ? ESCAPE '~'
              OR EXISTS (SELECT 1 FROM messages m2
                          WHERE m2.conversation_id = c.id AND m2.content LIKE ? ESCAPE '~'))
       ORDER BY c.updated_at DESC LIMIT 40`,
      needle,
      user.id,
      needle,
      needle,
    ),
  );
}
