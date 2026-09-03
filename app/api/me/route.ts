import { currentUser, unauthorized } from '@/lib/auth';
import { hasApiKey, getProvider } from '@/lib/providers';
import { PII_MODE, DISABLE_AUTH, TOOLS_ENABLED } from '@/lib/config';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const provider = getProvider();
  return Response.json({
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.display_name,
    apiKeyConfigured: hasApiKey(),
    authDisabled: DISABLE_AUTH,
    provider: provider.id,
    model: provider.chatModel(),
    piiMode: PII_MODE,
    toolsEnabled: TOOLS_ENABLED && provider.capabilities().tools,
    thinkingSupported: provider.capabilities().thinking,
  });
}
