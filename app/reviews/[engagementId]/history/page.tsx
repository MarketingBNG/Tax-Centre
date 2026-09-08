import { page } from '@/components/ui-classes';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { getEngagement } from '@/lib/review-engine/store';
import { RecurrencePanel } from '@/components/reviews/RecurrencePanel';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ engagementId: string }> };

export default async function HistoryPage({ params }: Ctx) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { engagementId } = await params;
  const engagement = await getEngagement(engagementId);
  if (!engagement) redirect('/reviews');

  return (
    <div className={page.wide}>
      <Link
        href={`/reviews/${engagementId}`}
        className="text-[13px] text-ink-dim no-underline hover:text-accent"
      >
        ← {engagement.entity_name || engagement.client_label}
      </Link>

      <header className="mt-3 mb-6">
        <h1 className="text-[21px] font-semibold tracking-tight">Year on year</h1>
        <p className="mt-1 max-w-[640px] text-[13px] text-ink-dim">
          The earlier tax years for this client, and what has been raised in more than one of them.
          Comparing runs answers whether a fix worked; this answers whether the same thing has been
          going wrong every season.
        </p>
      </header>

      <RecurrencePanel engagementId={engagementId} />
    </div>
  );
}
