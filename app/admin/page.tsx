import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { AdminPanel } from '@/components/AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');
  return <AdminPanel />;
}
