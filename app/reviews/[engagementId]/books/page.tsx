import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { getEngagement } from '@/lib/review-engine/store';
import { BooksPanel } from '@/components/reviews/BooksPanel';
import { BooksConnections } from '@/components/reviews/BooksConnections';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ engagementId: string }> };

export default async function BooksPage({ params }: Ctx) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const { engagementId } = await params;
  const engagement = await getEngagement(engagementId);
  if (!engagement) redirect('/reviews');

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-6">
      <Link
        href={`/reviews/${engagementId}`}
        className="text-[12.5px] text-ink-dim no-underline hover:text-accent"
      >
        ← {engagement.entity_name || engagement.client_label}
      </Link>

      <header className="mt-3 mb-6">
        <h1 className="text-[21px] font-semibold tracking-tight">The books</h1>
        <p className="mt-1 max-w-[620px] text-[13px] text-ink-dim">
          The trial balance, normalised into the firm&apos;s chart of accounts, so a books check
          written once reads the same whether the ledger says &ldquo;Sundry Debtors&rdquo;,
          &ldquo;Accounts Receivable&rdquo; or just 1200.
        </p>
      </header>

      {/*
        Connections first, then the upload.
        Pulling the books is better than being sent them — the figures are
        hard-checked rather than read — so the connected route is offered
        before the manual one rather than beneath it.
      */}
      <BooksConnections engagementId={engagementId} isAdmin={user.role === 'admin'} />

      <BooksPanel engagementId={engagementId} />
    </div>
  );
}
