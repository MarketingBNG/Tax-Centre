import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { getRunByNumber } from '@/lib/review-engine/store';
import { RunView } from '@/components/reviews/RunView';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ engagementId: string; runNo: string }> };

/**
 * A run has a durable URL of its own.
 *
 * An approval refers to the exact register version somebody saw, and a preparer
 * has to be able to open the run a reviewer is talking about — neither works if
 * a run is only reachable as transient state inside another screen.
 */
export default async function RunPage({ params }: Ctx) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { engagementId, runNo } = await params;
  const run = await getRunByNumber(engagementId, Number(runNo));
  if (!run) redirect(`/reviews/${engagementId}`);

  return <RunView runId={run.id} />;
}
