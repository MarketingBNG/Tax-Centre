import { currentUser, unauthorized, badRequest } from '@/lib/auth';
import { createStyle, listStyles } from '@/lib/prefs';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(await listStyles(user.id));
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const instructions = String(body.instructions ?? '').trim();
  if (!name) return badRequest('A style needs a name');
  if (!instructions) return badRequest('A style needs instructions');

  return Response.json(await createStyle(user.id, name, instructions));
}
