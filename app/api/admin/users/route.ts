import { currentUser, unauthorized, forbidden, badRequest, createUser, getUserByEmail, audit } from '@/lib/auth';
import { all } from '@/lib/db';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  return Response.json(
    await all(`SELECT id, email, role, display_name, is_active, created_at FROM users ORDER BY created_at`),
  );
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { email, role, displayName } = await req.json().catch(() => ({}));

  if (!email) return badRequest('Email is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return badRequest('Enter a valid email');
  if (!['admin', 'reviewer'].includes(role)) return badRequest('Bad role');
  if (await getUserByEmail(email)) {
    return Response.json({ error: 'That email already exists' }, { status: 409 });
  }
  // No password: adding someone here just puts their Google address on the
  // allowlist. They sign in with Google whenever they like.
  const created = await createUser({ email, role, displayName: displayName || email });
  await audit(user.id, 'user.create', 'user', created.id, { email: created.email, role });

  return Response.json({ id: created.id, email: created.email, role: created.role });
}
