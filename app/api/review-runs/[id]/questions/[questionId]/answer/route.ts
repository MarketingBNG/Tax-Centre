import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import {
  getFinding,
  getQuestion,
  getRun,
  recordAnswer,
  registerVersion,
  updateFindingStatus,
} from '@/lib/review-engine/store';
import { outcomeOfAnswer } from '@/lib/review-engine/questions';
import { resettleVerdict } from '@/lib/review-engine/orchestrator';

type Ctx = { params: Promise<{ id: string; questionId: string }> };

/**
 * Records an answer to one of the preparer's questions.
 *
 * The rule this exists to enforce: whether the finding closes depends on
 * whether a document was attached, not on how convincing the sentence is. A
 * written explanation leaves a High finding counted as open, with a note saying
 * why. It is meant to be structurally awkward to clear something serious with
 * words under deadline pressure.
 *
 * Who answered comes from the session and never from the body. An audit trail
 * whose author can be typed in is not an audit trail.
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id, questionId } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const question = await getQuestion(questionId);
  if (!question || question.run_id !== id) return notFound();

  const body = await req.json().catch(() => ({}));
  const answerText = String(body.answer ?? '').trim();
  if (!answerText) return badRequest('An answer needs some text.');

  const evidenceFileIds: string[] = Array.isArray(body.evidenceFileIds)
    ? body.evidenceFileIds.map(String)
    : [];

  await recordAnswer(user.id, questionId, {
    answerText,
    evidenceFileIds,
    answerKind: evidenceFileIds.length ? 'document' : (question.answer_kind ?? 'text'),
  });

  // Move the finding this question was asked about.
  let updated = null;
  if (question.finding_id) {
    const finding = await getFinding(question.finding_id);
    if (finding) {
      const outcome = outcomeOfAnswer({
        severity: finding.severity,
        hasEvidence: evidenceFileIds.length > 0,
        needsReviewer: Boolean(body.needsReviewer),
        awaitingClient: question.owner === 'client' && !evidenceFileIds.length && Boolean(body.awaitingClient),
      });
      updated = await updateFindingStatus(user.id, question.finding_id, {
        status: outcome.status,
        statusNote: outcome.note,
      });
    }
  }

  // Recomputed from the register on every status change, so the banner cannot
  // lag behind the finding that moved.
  const verdict = await resettleVerdict(id);

  return Response.json({
    ok: true,
    finding: updated && {
      id: updated.id,
      code: updated.finding_code,
      status: updated.status,
      statusNote: updated.status_note,
    },
    verdict,
    // Any change bumps the version, which is what silently lapses a standing
    // approval — see the approve route.
    registerVersion: await registerVersion(id),
  });
}
