import { currentUser, unauthorized, notFound } from '@/lib/auth';
import { one, run } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Rate one answer. The vote is stored on the message rather than in its own
 * table because there is exactly one voter: the person whose conversation it
 * is. Ownership is checked through the conversation, so a message id from
 * somebody else's thread matches nothing.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const owned = await one<{ id: string }>(
    `SELECT m.id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.user_id = ?`,
    id,
    user.id,
  );
  if (!owned) return notFound();

  const body = await req.json().catch(() => ({}));
  const raw = Number(body.vote);
  const vote = raw === 1 || raw === -1 ? raw : null;

  await run(`UPDATE messages SET vote = ? WHERE id = ?`, vote, id);
  return Response.json({ ok: true, vote });
}
