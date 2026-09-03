import { currentUser, unauthorized, notFound, badRequest, audit } from '@/lib/auth';
import { one, run } from '@/lib/db';
import { visibleFiles } from '@/lib/chat';
import { getMessage, leafUnder, loadThread, parseToolLog, setHead } from '@/lib/thread';
import { getPrefs, getProject, resolveModel, resolveStyle, resolveThinking } from '@/lib/prefs';
import { isKnownModel, isThinkingLevel } from '@/lib/models';
import { ACCOUNT_PREFIX, connectorsFor, parseSelection, validSelection } from '@/lib/connectors';
import { activeSkills, parseSelectedSkills } from '@/lib/skills';
import type { ConversationRow } from '@/lib/types';

type Ctx = { params: Promise<{ id: string }> };

// Ownership lives in the SQL predicate, and a miss returns 404 rather than 403
// so ids cannot be probed for existence.
function owned(id: string, userId: string) {
  return one<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ? AND user_id = ?`,
    id,
    userId,
  );
}

export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const conversation = await owned(id, user.id);
  if (!conversation) return notFound();

  const [thread, files, prefs] = await Promise.all([
    loadThread(id, conversation.head_id),
    visibleFiles(conversation),
    getPrefs(user.id),
  ]);
  const style = await resolveStyle(user.id, conversation.style, prefs);

  return Response.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      starred: conversation.starred,
      archivedAt: conversation.archived_at,
      projectId: conversation.project_id,
    },
    // What this thread will actually run with, resolved rather than raw, so the
    // composer shows the effective setting instead of a blank "inherited".
    settings: {
      model: resolveModel(conversation.model, prefs),
      thinking: resolveThinking(conversation.thinking, prefs),
      style: style.id,
      styleLabel: style.label,
      // Resolved against what is still live, so a connector an admin switched
      // off or an account since disconnected stops showing as active here.
      connectors: [
        ...(await connectorsFor(conversation.connectors)).map((c) => c.id),
        ...(await validSelection(
          user.id,
          parseSelection(conversation.connectors).accountIds.map((a) => `${ACCOUNT_PREFIX}${a}`),
        )),
      ],
      // Resolved against what is still enabled, so a skill an admin removed
      // stops showing as pinned on an old thread.
      skills: (await activeSkills(user.id))
        .filter((s) => parseSelectedSkills(conversation.skills).includes(s.id))
        .map((s) => s.id),
    },
    messages: thread.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      thinking: m.thinking,
      model: m.model,
      finish: m.finish,
      vote: m.vote,
      toolRuns: parseToolLog(m.tool_log),
      version: m.version,
      versionCount: m.versionCount,
      versionIds: m.versionIds,
    })),
    files: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: f.kind,
      sizeBytes: f.size_bytes,
      pageCount: f.page_count,
      fromProject: Boolean(f.project_id),
    })),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const conversation = await owned(id, user.id);
  if (!conversation) return notFound();

  const body = await req.json().catch(() => ({}));
  const touch = () => run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, Date.now(), id);
  let title: string | undefined;

  if (body.title !== undefined) {
    title = String(body.title ?? '').trim().slice(0, 120);
    if (!title) return badRequest('Title cannot be empty');
    await run(`UPDATE conversations SET title = ? WHERE id = ?`, title, id);
  }

  if (body.starred !== undefined) {
    await run(`UPDATE conversations SET starred = ? WHERE id = ?`, body.starred ? 1 : 0, id);
  }

  if (body.archived !== undefined) {
    await run(
      `UPDATE conversations SET archived_at = ? WHERE id = ?`,
      body.archived ? Date.now() : null,
      id,
    );
  }

  if (body.projectId !== undefined) {
    const wanted = body.projectId ? String(body.projectId) : null;
    if (wanted && !(await getProject(user.id, wanted))) return notFound();
    await run(`UPDATE conversations SET project_id = ? WHERE id = ?`, wanted, id);
  }

  for (const key of ['model', 'thinking', 'style'] as const) {
    if (body[key] === undefined) continue;
    const raw = body[key] === null ? null : String(body[key]);
    const value =
      key === 'model'
        ? raw && isKnownModel(raw)
          ? raw
          : null
        : key === 'thinking'
          ? raw && isThinkingLevel(raw)
            ? raw
            : null
          : raw || null;
    await run(`UPDATE conversations SET ${key} = ? WHERE id = ?`, value, id);
  }

  if (body.connectors !== undefined) {
    const live = await validSelection(user.id, body.connectors);
    await run(
      `UPDATE conversations SET connectors = ? WHERE id = ?`,
      live.length ? JSON.stringify(live) : null,
      id,
    );
  }

  if (body.skills !== undefined) {
    const wanted = Array.isArray(body.skills) ? body.skills.map(String) : [];
    const live = (await activeSkills(user.id))
      .filter((s) => wanted.includes(s.id))
      .map((s) => s.id);
    await run(
      `UPDATE conversations SET skills = ? WHERE id = ?`,
      live.length ? JSON.stringify(live) : null,
      id,
    );
  }

  // Switching to another version of a message: the head becomes that branch's
  // newest tip, so the reader lands on the end of the alternative rather than
  // in the middle of it.
  if (body.headMessageId !== undefined) {
    const target = await getMessage(id, String(body.headMessageId));
    if (!target) return notFound();
    await setHead(id, await leafUnder(id, target.id));
  }

  if (body.title !== undefined || body.starred !== undefined || body.archived !== undefined) {
    await touch();
  }

  return Response.json({ ok: true, title });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!(await owned(id, user.id))) return notFound();

  await run(`DELETE FROM conversations WHERE id = ?`, id);
  await audit(user.id, 'conversation.delete', 'conversation', id, null);
  return Response.json({ ok: true });
}
