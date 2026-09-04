import { currentUser, unauthorized, notFound, badRequest } from '@/lib/auth';
import {
  currentApproval,
  currentFacts,
  getEngagement,
  getRun,
  listFindings,
  listTieOuts,
  recordApproval,
} from '@/lib/review-engine/store';
import { computeVerdict, canApprove, verdictFindingsFrom } from '@/lib/review-engine/verdict';
import { requiredForms } from '@/lib/review-engine/obligations';
import type { Verdict } from '@/lib/review-types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Signs a run off.
 *
 * The AI's verdict is a first pass; this is the sign-off, and what makes it
 * worth anything is what gets recorded alongside it: a named person, a time,
 * and the exact register version they were looking at.
 *
 * The version is checked rather than merely stored. If somebody answered a
 * question while the approver had the page open, the register they read is not
 * the register they would be approving — so this refuses with a 409 and the
 * UI reloads. Approving a document that changed underneath you is precisely
 * what an approval is supposed to rule out.
 *
 * Nothing here overrides the register. A Hold cannot be approved away; the
 * platform's job is to make the senior review faster, not to provide a way
 * around it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return notFound();

  const body = await req.json().catch(() => ({}));
  const result = String(body.result ?? '') as Verdict;
  if (!['clear', 'release_with_conditions'].includes(result)) {
    return badRequest('Approve as either clear or release_with_conditions.');
  }

  const seen = Number(body.registerVersionSeen);
  if (!Number.isInteger(seen)) {
    return badRequest('registerVersionSeen is required — it is what the approval attests to.');
  }

  if (seen !== run.register_version) {
    return Response.json(
      {
        error:
          'The register changed since you read it. Reload and check what moved before ' +
          'signing off.',
        registerVersionSeen: seen,
        registerVersionNow: run.register_version,
      },
      { status: 409 },
    );
  }

  // Recomputed here rather than trusting the stored verdict: it is the register
  // as it stands that is being approved.
  const [findings, tieOuts, engagement] = await Promise.all([
    listFindings(id),
    listTieOuts(id),
    getEngagement(run.engagement_id),
  ]);
  const facts = await currentFacts(run.engagement_id);
  const formsPresent = Array.isArray(facts.forms_present) ? facts.forms_present.map(String) : [];

  const verdict = computeVerdict({
    findings: verdictFindingsFrom(findings),
    requiredForms: requiredForms(engagement?.return_type ?? null, facts),
    presentForms: formsPresent,
    facts,
    failedTieOuts: tieOuts
      .filter((t) => !t.agrees)
      .map((t) => ({ name: t.name, findingId: t.finding_id })),
  });

  const permitted = canApprove(verdict, result);
  if (!permitted.ok) {
    return Response.json(
      { error: permitted.reason, verdict, blockers: verdict.blockers },
      { status: 422 },
    );
  }

  await recordApproval(user.id, id, {
    registerVersionSeen: seen,
    verdictSeen: result,
    note: body.note ? String(body.note).slice(0, 2000) : null,
  });

  const standing = await currentApproval(id);
  return Response.json({
    ok: true,
    approval: standing && {
      approvedBy: standing.approver_name,
      approvedAt: standing.approved_at,
      registerVersionSeen: standing.register_version_seen,
      verdictSeen: standing.verdict_seen,
    },
  });
}
