import 'server-only';
import { REVIEW_CONFIDENCE_THRESHOLD, REVIEW_MAX_TOOL_ROUNDS } from '@/lib/config';
import { getProvider } from '@/lib/providers';
import { runAnalysis, ANALYSIS_TOOL } from '@/lib/tools';
import { recordUsage } from '@/lib/chat';
import type { AiProvider, ToolInvocation, ToolSpec } from '@/lib/providers/types';
import type {
  Category,
  DefectKind,
  EngagementRow,
  FindingLocation,
  FindingStatus,
  Owner,
  StageKey,
} from '@/lib/review-types';
import * as store from './store';
import { buildNumberIndex, checkAmounts, type NumberIndex } from './amounts';
import { gateAuthority } from './authority';
import { classify, categoryFor, haltsRun } from './severity';
import { buildStagePrompt } from './prompts';
import { ModelVisualParser } from './return-data';
import {
  RECORD_FINDINGS_TOOL,
  RECORD_QUESTIONS_TOOL,
  RECORD_SCOPE_TOOL,
  RECORD_TIE_OUTS_TOOL,
  describeIssues,
  validateFinding,
} from './schema';
import { selectQuestions, type CandidateQuestion } from './questions';
import { lineageKey } from './versioning';
import type { FileRow } from '@/lib/types';
import { all } from '@/lib/db';

/**
 * Runs one stage.
 *
 * The shape worth noticing: the model's tool calls do not write to the
 * register. They go through the gates first — amounts checked against what the
 * run actually saw, citations demoted, severity computed from the defect kind —
 * and a call that fails those gates comes back to the model as a message it can
 * act on, not as a silent drop. Findings are only persisted once they survive.
 *
 * That is the whole difference between a review platform and a chat window with
 * a good prompt. The prompt asks; this enforces.
 */

export interface StageEvent {
  type: 'stage_started' | 'progress' | 'finding' | 'tool' | 'stage_complete' | 'halted' | 'error';
  stageKey?: StageKey;
  label?: string;
  note?: string;
  code?: string;
  severity?: string | null;
  title?: string;
  message?: string;
}

export interface RunStageResult {
  status: 'complete' | 'halted' | 'failed';
  findings: number;
  halted?: string;
  error?: string;
}

/** Findings already recorded, condensed so a later stage does not repeat them. */
function summariseRegister(
  findings: { finding_code: string; severity: string | null; title: string }[],
): string {
  if (!findings.length) return '';
  return findings
    .map((f) => `- ${f.finding_code} [${f.severity ?? 'agreed'}] ${f.title}`)
    .join('\n');
}

export async function runStage(input: {
  runId: string;
  stageId: string;
  stageKey: StageKey;
  engagement: EngagementRow;
  facts: Record<string, unknown>;
  actorId: string;
  model: string;
  onEvent: (event: StageEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /**
   * Overrides the model. Exists so the tests can drive scripted tool calls
   * through the real gates — proving they are wired in, not merely correct in
   * isolation — without spending money or depending on what a model happens to
   * say today.
   */
  provider?: Pick<AiProvider, 'streamChat'>;
}): Promise<RunStageResult> {
  const { runId, stageId, stageKey, engagement, facts, actorId, model, onEvent } = input;

  // A retry must not leave the previous attempt's findings behind.
  await store.clearStageOutput(runId, stageKey);

  const docRows = await store.listRunDocuments(runId);
  const ids = docRows.map((d) => d.file_id);
  const files = ids.length
    ? await all<FileRow>(
        `SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
    : [];

  const pairs = docRows
    .map((row) => ({ file: files.find((f) => f.id === row.file_id), docRole: row.doc_role }))
    .filter((p): p is { file: FileRow; docRole: (typeof docRows)[number]['doc_role'] } =>
      Boolean(p.file),
    );

  const returnData = await ModelVisualParser.parse(pairs);

  // The set of figures anything recorded this stage is allowed to cite. Calcs
  // are appended to it as the model runs them.
  const calcs = await store.listCalcs(runId);
  let numberIndex: NumberIndex = buildNumberIndex({
    documents: returnData.documents.map((d) => ({
      fileId: d.fileId,
      filename: d.filename,
      text: d.text,
    })),
    calcs: calcs.map((c) => ({
      id: c.id,
      values: c.values_json ? (JSON.parse(c.values_json) as number[]) : [],
    })),
  });

  const priorFindings = await store.listFindings(runId);
  const prompt = await buildStagePrompt({
    stageKey,
    engagement,
    facts,
    documents: returnData.documents.map((d) => ({
      fileId: d.fileId,
      filename: d.filename,
      docRole: d.docRole,
    })),
    parts: returnData.parts,
    priorSummary: summariseRegister(priorFindings),
  });

  const textFiles: Record<string, string> = {};
  for (const doc of returnData.documents) {
    if (doc.text) textFiles[doc.filename] = doc.text;
  }

  let recorded = 0;
  let haltReason: string | null = null;

  const tools: ToolSpec[] = [ANALYSIS_TOOL, RECORD_FINDINGS_TOOL, RECORD_TIE_OUTS_TOOL];
  if (stageKey === 'S0') tools.push(RECORD_SCOPE_TOOL);
  if (stageKey === 'S4') tools.push(RECORD_QUESTIONS_TOOL);

  async function handleTool(call: ToolInvocation): Promise<string> {
    const { name, args } = call;

    if (name === 'run_analysis') {
      const code = String(args.code ?? '').trim();
      if (!code) throw new Error('No code was supplied.');
      if (!Object.keys(textFiles).length) {
        return (
          'No document in this review has machine-readable text — the return is a PDF, ' +
          'read visually. You can still compare figures you can see, but record them with ' +
          'source_kind "visual" rather than claiming a calculation.'
        );
      }

      const output = runAnalysis(code, textFiles);

      // Persist the figures it printed. This is what makes "sourced to the
      // calculation layer" checkable afterwards rather than merely asserted.
      const values = [...output.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
        .map((m) => Number(m[0].replace(/,/g, '')))
        .filter((n) => Number.isFinite(n));

      const calc = await store.recordCalc(runId, stageKey, {
        explanation: String(args.explanation ?? '') || null,
        code,
        output,
        values,
      });

      // Widen the allowed set immediately, so a finding recorded in the very
      // next call can cite what was just computed.
      const merged = new Set(numberIndex.calc);
      const own = new Set<number>();
      for (const value of values) {
        merged.add(Math.round(value * 100));
        own.add(Math.round(value * 100));
      }
      numberIndex = {
        ...numberIndex,
        calc: merged,
        calcById: new Map(numberIndex.calcById).set(calc.id, own),
      };

      await onEvent({ type: 'tool', note: String(args.explanation ?? 'Ran a calculation') });
      return `calculation id: ${calc.id}\nCite figures from this as source_kind "calc", source_ref "${calc.id}".\n\n${output}`;
    }

    if (name === 'record_scope') {
      const forms = Array.isArray(args.forms_present) ? args.forms_present.map(String) : [];
      await store.assertFact(actorId, engagement.id, 'forms_present', forms, 'stage0');
      if (args.matches_engagement === false) {
        await store.assertFact(actorId, engagement.id, 'stage0_mismatch', true, 'stage0');
      }
      await onEvent({ type: 'progress', note: `Identified ${forms.length} forms in the return` });
      return `Recorded. ${forms.length} forms noted.`;
    }

    if (name === 'record_questions') {
      const raw = Array.isArray(args.questions) ? args.questions : [];
      if (!raw.length) return 'No questions were supplied.';

      // Questions point at findings by code, which is what the model can see;
      // the register keys on ids.
      const register = await store.listFindings(runId);
      const byCode = new Map(register.map((f) => [f.finding_code, f]));

      const candidates: CandidateQuestion[] = raw.map((q) => {
        const question = q as Record<string, unknown>;
        const code = question.finding_code == null ? null : String(question.finding_code);
        return {
          findingId: code ? (byCode.get(code)?.id ?? null) : null,
          owner: question.owner === 'client' ? 'client' : 'preparer',
          question: String(question.question ?? ''),
          figure: question.figure == null ? null : String(question.figure),
          branches: Array.isArray(question.branches)
            ? (question.branches as { if: string; then: string }[])
            : [],
          evidenceNeeded:
            question.evidence_needed == null ? null : String(question.evidence_needed),
          answerKind: (question.answer_kind ?? null) as CandidateQuestion['answerKind'],
        };
      });

      // The cap and the ranking are ours, not the model's: a capped list is
      // only useful if it is genuinely the top of the list.
      const { selected, dropped, shortfall } = selectQuestions(
        candidates.filter((c) => c.question.trim()),
        register.map((f) => ({ id: f.id, severity: f.severity, status: f.status })),
      );

      const saved = await store.insertQuestions(runId, selected);

      // Link each question back to its finding, so the register shows which
      // ones are waiting on an answer.
      for (const question of saved) {
        if (question.finding_id) {
          await store.updateFindingStatus(actorId, question.finding_id, {
            questionId: question.id,
          });
        }
      }

      await onEvent({ type: 'progress', note: `${saved.length} questions for the preparer` });

      const notes = [`Recorded ${saved.length} question${saved.length === 1 ? '' : 's'}.`];
      if (dropped) notes.push(`${dropped} dropped: past the cap of 10, or attached to a Low finding.`);
      if (shortfall) {
        notes.push(
          `${shortfall} more are expected — serious findings are open and fewer than five ` +
            'questions were asked. Add questions for the open Critical and High items.',
        );
      }
      return notes.join(' ');
    }

    if (name === 'record_tie_outs') {
      const list = Array.isArray(args.tie_outs) ? args.tie_outs : [];
      await store.insertTieOuts(
        runId,
        stageKey,
        list.map((t) => {
          const tie = t as Record<string, unknown>;
          return {
            name: String(tie.name ?? 'unnamed tie-out'),
            leftValue: tie.left_value == null ? null : Number(tie.left_value),
            rightValue: tie.right_value == null ? null : Number(tie.right_value),
            leftSource: tie.left_source == null ? null : String(tie.left_source),
            rightSource: tie.right_source == null ? null : String(tie.right_source),
            agrees: tie.agrees === true,
          };
        }),
      );
      return `Recorded ${list.length} tie-out${list.length === 1 ? '' : 's'}.`;
    }

    if (name === 'record_findings') {
      const list = Array.isArray(args.findings) ? args.findings : [];
      if (!list.length) return 'No findings were supplied.';

      const problems: string[] = [];
      const toStore: store.NewFinding[] = [];

      for (let i = 0; i < list.length; i++) {
        const issues = validateFinding(list[i], i);
        if (issues.length) {
          problems.push(describeIssues(issues));
          continue;
        }

        const f = list[i] as Record<string, unknown>;
        const kind = f.kind as 'exception' | 'agreed' | 'coverage';
        const defectKind = (f.defect_kind ?? null) as DefectKind | null;

        // Rule 1 — every figure has to point at something outside the model.
        const amountCheck = checkAmounts(
          (Array.isArray(f.amounts) ? f.amounts : []) as never[],
          numberIndex,
        );
        if (amountCheck.problems.length) {
          problems.push(
            `- findings[${i}] "${String(f.title ?? '')}": ` +
              amountCheck.problems.map((p) => `${p.label} (${p.value}) — ${p.reason}`).join(' '),
          );
          continue;
        }

        // Rule 2 — a citation nobody grounded is recorded as claimed, never as
        // authority. Not a rejection: the finding itself may be perfectly good.
        const authority = gateAuthority({
          status: f.authority_citation ? 'grounded' : 'none_required',
          citation: (f.authority_citation ?? null) as string | null,
        });

        const severity = classify({ kind, defectKind });

        // Rule 8 — below the threshold it goes to a human, and the severity is
        // left exactly as computed rather than quietly softened.
        const stated = Number(f.confidence);
        const confidence = Math.min(
          Number.isFinite(stated) ? stated : 0.5,
          amountCheck.confidenceCap,
        );
        // Item 8 — a figure the platform cannot verify does not get relied on
        // quietly. Where a serious finding rests on one, it goes to a person to
        // confirm against the page rather than being carried as established.
        // Deferring on 15% beats being confidently wrong on 5%, because the 5%
        // is invisible until it is too late.
        const unconfirmed = amountCheck.needsConfirmation;
        const needsEyes =
          kind === 'exception' &&
          unconfirmed.length > 0 &&
          (severity === 'Critical' || severity === 'High');

        const status: FindingStatus =
          kind === 'exception' && (confidence < REVIEW_CONFIDENCE_THRESHOLD || needsEyes)
            ? 'escalated'
            : 'open';

        const title = String(f.title ?? '');
        const location = (f.location ?? null) as FindingLocation | null;

        toStore.push({
          kind,
          defectKind,
          severity,
          category: categoryFor(stageKey, (f.category_override ?? null) as Category | null),
          title,
          // Recognisable as the same problem in the next run, even though codes
          // are per-run and the wording will differ.
          lineageKey: lineageKey({ stageKey, defectKind, location, title }),
          whatIsWrong: String(f.what_is_wrong ?? ''),
          whyItMatters: f.why_it_matters == null ? null : String(f.why_it_matters),
          location,
          fix: (f.fix ?? null) as never,
          authorityStatus: authority.status,
          authorityCitation: authority.citation,
          authoritySourceSpan: authority.sourceSpan,
          claimedCitation: authority.claimedCitation,
          evidence: (Array.isArray(f.evidence) ? f.evidence : []) as never,
          amounts: amountCheck.accepted,
          owner: (f.owner ?? null) as Owner | null,
          status: kind === 'exception' ? status : 'closed',
          statusNote:
            status !== 'escalated'
              ? authority.demotedReason
              : confidence < REVIEW_CONFIDENCE_THRESHOLD
                ? `Confidence ${confidence.toFixed(2)} is below the ${REVIEW_CONFIDENCE_THRESHOLD} threshold — needs a reviewer.`
                : `${unconfirmed.map((a) => `${a.label} (${a.value})`).join(', ')} ` +
                  'could only be read off a page image, and nothing here can check it. ' +
                  'Confirm the figure against the source before relying on this.',
          confidence,
        });
      }

      const saved = toStore.length ? await store.insertFindings(runId, stageKey, toStore) : [];
      recorded += saved.length;

      for (const finding of saved) {
        await onEvent({
          type: 'finding',
          code: finding.finding_code,
          severity: finding.severity,
          title: finding.title,
        });
        // A Stage 0 Critical makes every later stage meaningless — reviewing
        // the balance sheet of a return that should not exist wastes the run.
        if (haltsRun(stageKey, finding.severity)) {
          haltReason = `critical_finding:${finding.finding_code}`;
        }
      }

      if (problems.length) {
        return (
          `${saved.length} finding${saved.length === 1 ? '' : 's'} recorded. ` +
          `${problems.length} rejected — correct these and record them again:\n${problems.join('\n')}`
        );
      }
      return `Recorded ${saved.length} finding${saved.length === 1 ? '' : 's'}.`;
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  await onEvent({ type: 'stage_started', stageKey, label: stageKey });

  try {
    const result = await (input.provider ?? getProvider()).streamChat({
      system: prompt.system,
      turns: prompt.turns,
      model,
      tools,
      runTool: handleTool,
      maxToolRounds: REVIEW_MAX_TOOL_ROUNDS,
      thinking: 'standard',
      signal: input.signal,
      onThinking: () => {},
    });

    await recordUsage({
      userId: actorId,
      purpose: `review:${stageKey}`,
      model: result.model,
      usage: result.usage,
      costMicros: result.costMicros,
    });

    /**
     * Rule 5 — every stage leaves at least one line.
     *
     * A stage that recorded nothing is indistinguishable, on the summary page,
     * from a section that was clean. Rather than retry the whole stage for
     * this, a coverage line is written saying plainly that the stage produced
     * nothing, and it is escalated so a person looks at it.
     */
    if (recorded === 0) {
      await store.insertFindings(runId, stageKey, [
        {
          kind: 'coverage',
          defectKind: null,
          severity: null,
          category: categoryFor(stageKey),
          title: `${stageKey} recorded no findings`,
          whatIsWrong:
            'This stage completed without recording anything, so it is not known whether ' +
            'the section is clean or was not examined. A reviewer should look at it directly.',
          status: 'escalated',
          owner: 'reviewer',
          confidence: 0,
        },
      ]);
      recorded = 1;
    }

    await store.completeStage(stageId, {
      model: result.model,
      rawOutput: result.text.slice(0, 40_000),
      usage: result.usage,
      costMicros: result.costMicros,
    });

    if (haltReason) {
      await onEvent({ type: 'halted', message: haltReason });
      return { status: 'halted', findings: recorded, halted: haltReason };
    }

    await onEvent({ type: 'stage_complete', stageKey, note: `${recorded} recorded` });
    return { status: 'complete', findings: recorded };
  } catch (err) {
    const message = (err as Error).message;
    await store.failStage(stageId, message);
    await onEvent({ type: 'error', message });
    return { status: 'failed', findings: recorded, error: message };
  }
}
