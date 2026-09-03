import { currentUser, unauthorized, forbidden, audit } from '@/lib/auth';
import { BASE_PROMPT, getCustomPrompt, setCustomPrompt, estimateTokens } from '@/lib/prompt';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const custom = await getCustomPrompt();
  return Response.json({
    basePrompt: BASE_PROMPT,
    customPrompt: custom,
    tokenEstimate: estimateTokens(BASE_PROMPT) + estimateTokens(custom),
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { customPrompt } = await req.json().catch(() => ({}));
  const text = String(customPrompt ?? '');
  if (text.length > 100_000) {
    return Response.json({ error: 'That is too long to send on every message.' }, { status: 400 });
  }

  await setCustomPrompt(text);
  await audit(user.id, 'prompt.update', 'settings', 'system_prompt', {
    length: text.trim().length,
  });

  return Response.json({ ok: true });
}
