import { currentUser, unauthorized } from '@/lib/auth';
import { hasApiKey, getProvider } from '@/lib/providers';
import { PII_MODE, DISABLE_AUTH } from '@/lib/config';
import { SEVERITY_LABELS } from '@/lib/review';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  return Response.json({
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.display_name,
    apiKeyConfigured: hasApiKey(),
    authDisabled: DISABLE_AUTH,
    provider: getProvider().id,
    citationsSupported: getProvider().capabilities().citations,
    model: getProvider().reviewModel(),
    piiMode: PII_MODE,
    severityLabels: SEVERITY_LABELS,
  });
}
