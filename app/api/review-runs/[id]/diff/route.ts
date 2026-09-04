import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import {
  getRun,
  getRunByNumber,
  listFindings,
  listQuestions,
} from '@/lib/review-engine/store';
import { diffRuns, type DiffFinding } from '@/lib/review-engine/versioning';

type Ctx = { params: Promise<{ id: string }> };

const toDiff = (rows: Awaited<ReturnType<typeof listFindings>>): DiffFinding[] =>
  rows.map((f) => ({
    id: f.id,
    code: f.finding_code,
    stageKey: f.stage_key,
    severity: f.severity,
    status: f.status,
    title: f.title,
    lineageKey: f.lineage_key,
    carriedFromFindingId: f.carried_from_finding_id,
  }));

/**
 * What changed between this run and the one before it.
 *
 * Answers the question the team actually asks after posting fixes: did it work.
 * Not "did the number change" — whether the specific check now passes.
 *
 * Defaults to the parent run, which is nearly always what is wanted; pass
 * ?against=<runNumber> to compare against a different one.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const against = new URL(req.url).searchParams.get('against');
  const previous = against
    ? await getRunByNumber(run.engagement_id, Number(against))
    : run.parent_run_id
      ? await getRun(run.parent_run_id)
      : null;

  if (!previous) {
    return badRequest('There is no earlier run to compare this one against.');
  }

  const [beforeFindings, afterFindings, beforeQuestions, afterQuestions] = await Promise.all([
    listFindings(previous.id),
    listFindings(id),
    listQuestions(previous.id),
    listQuestions(id),
  ]);

  const diff = diffRuns({
    before: toDiff(beforeFindings),
    after: toDiff(afterFindings),
    questions: {
      before: beforeQuestions.length,
      answeredInBefore: beforeQuestions.filter((q) => q.status === 'answered').length,
      // Carried into this run and still not answered: the check that stops a
      // return being re-run and re-cleared without the fact ever arriving.
      stillOpenInAfter: afterQuestions.filter(
        (q) => q.carried_from_question_id && q.status === 'open',
      ).length,
    },
  });

  return Response.json({
    from: { id: previous.id, runNumber: previous.run_number, verdict: previous.verdict },
    to: { id: run.id, runNumber: run.run_number, verdict: run.verdict },
    verdictMoved: previous.verdict !== run.verdict,
    ...diff,
  });
}
