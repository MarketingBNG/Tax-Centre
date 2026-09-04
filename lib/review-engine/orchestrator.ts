import 'server-only';
import { REVIEW_COST_CEILING_USD } from '@/lib/config';
import * as store from './store';
import { runStage, type StageEvent } from './stage-runner';
import { computeVerdict, verdictFindingsFrom } from './verdict';
import { requiredForms } from './obligations';
import { stageDef } from './stage-defs';
import type { StageKey } from '@/lib/review-types';

/**
 * Advancing a run by one stage.
 *
 * The run does not execute in a single request, and deliberately so. A whole
 * review is several model calls over several minutes, which no serverless
 * invocation will survive; one stage is one-to-few calls, which fits
 * comfortably. So the caller claims a stage, runs it, commits, and returns —
 * and the client asks again for the next one.
 *
 * That turns the platform's hard timeout from a thing that kills runs into a
 * boundary the design already respects. Everything needed to resume lives in
 * the database: close the browser mid-review and the run pauses at a stage
 * boundary, honestly reporting where it stopped, and the Resume button picks
 * it up.
 */

/**
 * Writes the register lines for everything decided before a stage ever runs:
 * modules the engagement does not need, and documents the gate let the run
 * proceed without.
 *
 * A stage planned as not_applicable is never claimed, so the runner's own
 * not-applicable branch never sees it — without this, "not needed" would exist
 * only as a stage status and the register would simply be silent about it.
 * Rule 3 is that a reader must be able to tell that apart from "not looked at",
 * and a status on a progress rail is not the workpaper.
 */
export async function recordPlannedGaps(
  runId: string,
  input: {
    notApplicable: { stageKey: StageKey; reason?: string }[];
    missingInputs?: { label: string; neededFor: string; consequence: string }[];
  },
): Promise<void> {
  for (const stage of input.notApplicable) {
    const def = stageDef(stage.stageKey);
    await store.insertFindings(runId, stage.stageKey, [
      {
        kind: 'coverage',
        defectKind: null,
        severity: null,
        category: def.category,
        title: `${def.label} — not applicable`,
        whatIsWrong: stage.reason ?? 'This module does not apply to this engagement.',
        status: 'closed',
        owner: null,
        confidence: 1,
      },
    ]);
  }

  for (const input_ of input.missingInputs ?? []) {
    await store.insertFindings(runId, 'S0', [
      {
        kind: 'coverage',
        defectKind: null,
        severity: null,
        category: 'bookkeeping',
        title: `${input_.label} was not provided`,
        whatIsWrong:
          `Needed for: ${input_.neededFor}. ${input_.consequence} ` +
          'Recorded here so the review does not read as though it was checked.',
        status: 'open',
        owner: 'preparer',
        confidence: 1,
      },
    ]);
  }
}

export interface AdvanceResult {
  /** What happened to the stage that ran, if one did. */
  outcome: 'ran' | 'nothing_to_do' | 'aborted' | 'blocked';
  stageKey?: StageKey;
  status?: 'complete' | 'halted' | 'failed';
  findings?: number;
  /** True when the whole run reached a terminal state on this call. */
  runFinished: boolean;
  runStatus: string;
  message?: string;
}

/** Emits to the live stream and to the replay log, so a reconnecting tab catches up. */
function emitter(runId: string, live: (event: StageEvent) => void) {
  return async (event: StageEvent) => {
    live(event);
    await store.appendEvent(runId, event);
  };
}

export async function advanceRun(input: {
  runId: string;
  actorId: string;
  onEvent: (event: StageEvent) => void;
  signal?: AbortSignal;
}): Promise<AdvanceResult> {
  const { runId, actorId } = input;
  const emit = emitter(runId, input.onEvent);

  const run = await store.getRun(runId);
  if (!run) return { outcome: 'nothing_to_do', runFinished: true, runStatus: 'missing' };

  if (run.status === 'blocked_inputs') {
    return {
      outcome: 'blocked',
      runFinished: true,
      runStatus: run.status,
      message: 'This run is missing documents it cannot proceed without.',
    };
  }
  if (['complete', 'failed', 'cancelled', 'halted'].includes(run.status)) {
    return { outcome: 'nothing_to_do', runFinished: true, runStatus: run.status };
  }

  if (await store.isAbortRequested(runId)) {
    await store.setRunStatus(runId, 'cancelled');
    await emit({ type: 'error', message: 'Stopped.' });
    return { outcome: 'aborted', runFinished: true, runStatus: 'cancelled' };
  }

  // A runaway run should be a visible failure, not a quiet bill. Checked before
  // claiming the next stage rather than mid-stage, so nothing is left half done.
  const spentMicros = (await store.listStages(runId)).reduce(
    (total, stage) => total + Number(stage.cost_micros ?? 0),
    0,
  );
  const spentUsd = spentMicros / 1_000_000;
  if (spentUsd >= REVIEW_COST_CEILING_USD) {
    const message =
      `This run has spent $${spentUsd.toFixed(2)}, at the $${REVIEW_COST_CEILING_USD} ceiling. ` +
      'Stopped before the next stage. Raise REVIEW_COST_CEILING_USD if this return is genuinely ' +
      'that large.';
    await store.setRunStatus(runId, 'failed', { errorText: message });
    await emit({ type: 'error', message });
    return { outcome: 'nothing_to_do', runFinished: true, runStatus: 'failed', message };
  }

  const engagement = await store.getEngagement(run.engagement_id);
  if (!engagement) return { outcome: 'nothing_to_do', runFinished: true, runStatus: 'missing' };

  const stage = await store.claimNextStage(runId);
  if (!stage) {
    // Nothing left to claim: the run is done, so settle the verdict.
    await finalise(runId, actorId);
    const settled = await store.getRun(runId);
    return {
      outcome: 'nothing_to_do',
      runFinished: true,
      runStatus: settled?.status ?? 'complete',
    };
  }

  if (run.status !== 'running') await store.setRunStatus(runId, 'running');
  await store.touchRun(runId);

  // An inapplicable module is still a line on the register: Rule 3 says a
  // reviewer must be able to tell "not needed" from "not looked at".
  const def = stageDef(stage.stage_key);
  const facts = JSON.parse(run.facts_snapshot || '{}') as Record<string, unknown>;
  const applies = def.applies({ returnType: engagement.return_type, facts });

  if (!applies.applies) {
    await store.insertFindings(runId, stage.stage_key, [
      {
        kind: 'coverage',
        defectKind: null,
        severity: null,
        category: def.category,
        title: `${def.label} — not applicable`,
        whatIsWrong: applies.reason ?? 'This module does not apply to this engagement.',
        status: 'closed',
        owner: null,
        confidence: 1,
      },
    ]);
    await store.completeStage(stage.id, { status: 'not_applicable' });
    await emit({ type: 'stage_complete', stageKey: stage.stage_key, note: 'not applicable' });

    const more = await store.listStages(runId);
    const remaining = more.some((s) => s.status === 'pending');
    if (!remaining) await finalise(runId, actorId);
    return {
      outcome: 'ran',
      stageKey: stage.stage_key,
      status: 'complete',
      findings: 0,
      runFinished: !remaining,
      runStatus: remaining ? 'running' : 'complete',
    };
  }

  const result = await runStage({
    runId,
    stageId: stage.id,
    stageKey: stage.stage_key,
    engagement,
    facts,
    actorId,
    model: run.model,
    onEvent: emit,
    signal: input.signal,
  });

  if (result.status === 'halted') {
    await store.setRunStatus(runId, 'halted', { haltReason: result.halted });
    await finalise(runId, actorId);
    return {
      outcome: 'ran',
      stageKey: stage.stage_key,
      status: 'halted',
      findings: result.findings,
      runFinished: true,
      runStatus: 'halted',
      message: result.halted,
    };
  }

  if (result.status === 'failed') {
    // Not terminal by itself: the stage is retried on the next advance until it
    // runs out of attempts, at which point the run fails with the reason.
    const stages = await store.listStages(runId);
    const exhausted = stages.find(
      (s) => s.id === stage.id && s.attempt >= store.MAX_STAGE_ATTEMPTS,
    );
    if (exhausted) {
      await store.setRunStatus(runId, 'failed', { errorText: result.error });
      return {
        outcome: 'ran',
        stageKey: stage.stage_key,
        status: 'failed',
        runFinished: true,
        runStatus: 'failed',
        message: result.error,
      };
    }
    return {
      outcome: 'ran',
      stageKey: stage.stage_key,
      status: 'failed',
      runFinished: false,
      runStatus: 'running',
      message: result.error,
    };
  }

  const stages = await store.listStages(runId);
  const remaining = stages.some(
    (s) => s.status === 'pending' || (s.status === 'failed' && s.attempt < store.MAX_STAGE_ATTEMPTS),
  );
  if (!remaining) await finalise(runId, actorId);

  return {
    outcome: 'ran',
    stageKey: stage.stage_key,
    status: 'complete',
    findings: result.findings,
    runFinished: !remaining,
    runStatus: remaining ? 'running' : 'complete',
  };
}

/**
 * Settles the verdict once no stage is left to run.
 *
 * Computed from the register, never written by the model — so the banner a
 * partner reads is arithmetic over the findings rather than an opinion about
 * them.
 */
export async function finalise(runId: string, actorId: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) return;

  const [findings, tieOuts, engagement] = await Promise.all([
    store.listFindings(runId),
    store.listTieOuts(runId),
    store.getEngagement(run.engagement_id),
  ]);

  const facts = await store.currentFacts(run.engagement_id);
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

  await store.setVerdict(runId, verdict.result, verdict);

  // A halted run keeps that status: it stopped early, and calling it complete
  // would imply the whole sequence ran.
  if (run.status !== 'halted') await store.setRunStatus(runId, 'complete');
  await store.appendEvent(runId, { type: 'done', verdict: verdict.result });
  await store.touchRun(runId);
  void actorId;
}
