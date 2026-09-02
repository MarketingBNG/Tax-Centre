import { currentUser, unauthorized, forbidden, audit } from '@/lib/auth';
import { setSetting, getSetting } from '@/lib/db';
import { RETENTION_ORIGINALS_DAYS, PII_MODE } from '@/lib/config';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  return Response.json({
    monthlyCapUsd: Number(await getSetting('monthly_cap_usd', '200')),
    // These two come from .env rather than the database, so they are shown
    // read-only here — changing them is a deliberate config edit and restart.
    retentionDays: RETENTION_ORIGINALS_DAYS,
    piiMode: PII_MODE,
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const body = await req.json().catch(() => ({}));

  if (body.monthlyCapUsd !== undefined) {
    await setSetting('monthly_cap_usd', Number(body.monthlyCapUsd) || 0);
    await audit(user.id, 'settings.update', 'settings', 'monthly_cap_usd', {
      value: body.monthlyCapUsd,
    });
  }

  return Response.json({ ok: true });
}
