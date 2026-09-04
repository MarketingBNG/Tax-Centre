import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { ReviewsHome } from '@/components/reviews/ReviewsHome';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <ReviewsHome />;
}
