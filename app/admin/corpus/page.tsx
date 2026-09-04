import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { CorpusPanel } from '@/components/reviews/CorpusPanel';

export const dynamic = 'force-dynamic';

export default async function CorpusPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');
  return <CorpusPanel />;
}
