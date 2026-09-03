import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { hasApiKey, getProvider } from '@/lib/providers';
import { DISABLE_AUTH } from '@/lib/config';
import { Chat } from '@/components/Chat';

export const dynamic = 'force-dynamic';


export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <Chat
      me={{
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.display_name,
        apiKeyConfigured: hasApiKey(),
        authDisabled: DISABLE_AUTH,
        provider: getProvider().id,
        model: getProvider().chatModel(),
      }}
    />
  );
}
