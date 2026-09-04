import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { NewReviewWizard } from '@/components/reviews/NewReviewWizard';

export const dynamic = 'force-dynamic';

export default async function NewReviewPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <NewReviewWizard />;
}
