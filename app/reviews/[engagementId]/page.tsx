import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { getEngagement, listRuns, listCurrentFactRows } from '@/lib/review-engine/store';
import { planStages } from '@/lib/review-engine/stage-defs';
import { VERDICT_WORD } from '@/components/reviews/chips';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ engagementId: string }> };

const STATUS_LABEL: Record<string, string> = {
  blocked_inputs: 'Waiting for documents',
  pending: 'Not started',
  running: 'Running',
  halted: 'Stopped early',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * The engagement, and the runs against it.
 *
 * The run page itself — the one-page audit summary — arrives with the stage
 * runner, since there is nothing to summarise until a run can actually
 * execute. Until then this shows what was set up and what the plan would be,
 * which is the honest thing to render rather than an empty summary implying a
 * review happened.
 */
export default async function EngagementPage({ params }: Ctx) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { engagementId } = await params;
  const engagement = await getEngagement(engagementId);
  if (!engagement) redirect('/reviews');

  const [runs, factRows] = await Promise.all([
    listRuns(engagementId),
    listCurrentFactRows(engagementId),
  ]);

  const facts: Record<string, unknown> = {};
  for (const row of factRows) {
    if (row.key in facts) continue;
    try {
      facts[row.key] = JSON.parse(row.value);
    } catch {
      facts[row.key] = row.value;
    }
  }

  const plan = planStages({ returnType: engagement.return_type, facts });

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <Link href="/reviews" className="text-[12.5px] text-ink-dim no-underline hover:text-accent">
        ← All reviews
      </Link>

      <header className="mt-3 mb-6">
        <h1 className="text-[21px] font-semibold tracking-tight">
          {engagement.entity_name || engagement.client_label}
        </h1>
        <div className="mt-1 text-[12.5px] text-ink-faint">
          {[
            engagement.return_type,
            engagement.tax_year ? `TY ${engagement.tax_year}` : null,
            engagement.ein,
            engagement.period_start && engagement.period_end
              ? `${engagement.period_start} to ${engagement.period_end}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </header>

      <section className="mb-6 rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-3 text-[14px] font-medium">Runs</h2>
        {runs.length === 0 ? (
          <div className="text-[13px] text-ink-faint">No runs yet.</div>
        ) : (
          <ul className="space-y-1.5">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex items-center justify-between rounded-lg border border-line-soft px-3 py-2"
              >
                <div>
                  <div className="text-[13px]">
                    Run {run.run_number}
                    <span className="ml-2 text-[11.5px] text-ink-faint">
                      {STATUS_LABEL[run.status] ?? run.status}
                    </span>
                  </div>
                  {run.halt_reason && (
                    <div className="mt-0.5 text-[11.5px] text-sev-high">{run.halt_reason}</div>
                  )}
                </div>
                <div className="text-[12px] text-ink-dim">
                  {run.verdict ? VERDICT_WORD[run.verdict] : '—'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-line-soft bg-panel p-4">
        <h2 className="mb-1 text-[14px] font-medium">What this review will check</h2>
        <p className="mb-3 text-[12px] text-ink-faint">
          Fixed order — the books are read before the return, because most return errors are book
          errors that were copied across correctly.
        </p>
        <ol className="space-y-1">
          {plan.map((stage) => (
            <li key={stage.stageKey} className="flex items-baseline gap-2 text-[13px]">
              <span className="w-16 shrink-0 font-mono text-[11px] text-ink-faint">
                {stage.stageKey}
              </span>
              <span className={stage.status === 'pending' ? 'text-ink' : 'text-ink-faint'}>
                {stage.status === 'pending' ? 'Will run' : 'Not applicable'}
                {stage.reason && (
                  <span className="text-ink-faint"> — {stage.reason}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
