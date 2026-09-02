import { currentUser, unauthorized, forbidden, audit } from '@/lib/auth';
import { one } from '@/lib/db';
import { sweepExpiredOriginals } from '@/lib/retention';
import { RETENTION_ORIGINALS_DAYS } from '@/lib/config';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const cutoff = Date.now() - RETENTION_ORIGINALS_DAYS * 86_400_000;

  const live = await one<{ n: number; bytes: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
     FROM files WHERE deleted_at IS NULL`,
  );
  const due = await one<{ n: number; bytes: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
     FROM files WHERE deleted_at IS NULL AND created_at < ?`,
    cutoff,
  );
  const purged = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NOT NULL`);

  return Response.json({
    retentionDays: RETENTION_ORIGINALS_DAYS,
    liveFiles: live?.n ?? 0,
    liveBytes: live?.bytes ?? 0,
    dueFiles: due?.n ?? 0,
    dueBytes: due?.bytes ?? 0,
    purgedFiles: purged?.n ?? 0,
  });
}

export async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const result = await sweepExpiredOriginals();
  await audit(user.id, 'retention.sweep', 'files', null, result);

  return Response.json(result);
}
