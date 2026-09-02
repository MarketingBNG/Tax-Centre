import { currentUser, unauthorized, forbidden, badRequest, audit } from '@/lib/auth';
import { listSkills, createSkill, buildSkillBundle } from '@/lib/skills';
import { ingestFile } from '@/lib/ingest';

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  return Response.json({
    skills: await listSkills(),
    bundleTokens: (await buildSkillBundle()).tokenEstimate,
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest('Expected a multipart form');

  let body = ((form.get('body') as string) ?? '').trim();
  let sourceFilename: string | null = null;

  const upload = form.get('file');
  if (upload instanceof File && upload.size > 0) {
    try {
      const stored = await ingestFile({
        userId: user.id,
        conversationId: null,
        filename: upload.name,
        buffer: Buffer.from(await upload.arrayBuffer()),
      });

      if (!stored.extracted_text?.trim()) {
        return badRequest(
          `Could not read text out of "${upload.name}". Skill documents must be DOCX, ` +
            `XLSX, CSV or TXT — a scanned PDF has no text layer to extract. Paste the text instead.`,
        );
      }
      body = stored.extracted_text.trim();
      sourceFilename = stored.filename;
    } catch (err) {
      return badRequest((err as Error).message);
    }
  }

  if (!body) return badRequest('Provide skill text or upload a document.');

  const skill = await createSkill({
    title: ((form.get('title') as string) ?? sourceFilename ?? 'Untitled skill').trim(),
    description: (form.get('description') as string) ?? '',
    jurisdiction: (form.get('jurisdiction') as string) ?? 'generic',
    body,
    sourceFilename,
    createdBy: user.id,
  });

  await audit(user.id, 'skill.create', 'skill', skill.id, { title: skill.title });
  return Response.json(skill);
}
