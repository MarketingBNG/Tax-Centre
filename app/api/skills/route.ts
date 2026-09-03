import { currentUser, unauthorized, forbidden, badRequest, audit } from '@/lib/auth';
import { installSkill, listSkills, skillFiles, type UploadedFile } from '@/lib/skills';

export const maxDuration = 60;

/** A skill is prose and references; anything else does not belong in one. */
const TEXTUAL = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?)$/i;
const MAX_FILES = 200;

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const skills = await listSkills(user.id);
  const withCounts = await Promise.all(
    skills.map(async (s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      scope: s.scope,
      enabled: s.enabled === 1,
      folder: s.folder,
      updatedAt: Number(s.updated_at),
      mine: s.scope === 'personal',
      files: (await skillFiles(s.id)).map((f) => ({ path: f.path, bytes: Number(f.bytes) })),
      bodyChars: s.body.length,
    })),
  );

  return Response.json({ skills: withCounts, isAdmin: user.role === 'admin' });
}

/**
 * Install a skill from the files of one folder.
 *
 * The browser sends every file in the folder along with a matching array of
 * relative paths, because a File in a form does not carry the path it came
 * from and the paths are exactly what the SKILL.md refers to.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest('Expected a multipart upload');

  const scope = form.get('scope') === 'firm' ? 'firm' : 'personal';
  // A firm skill is prepended to everybody's conversations, which is the same
  // reach as the house instructions and belongs behind the same door.
  if (scope === 'firm' && user.role !== 'admin') return forbidden();

  let paths: string[] = [];
  try {
    paths = JSON.parse(String(form.get('paths') ?? '[]')) as string[];
  } catch {
    return badRequest('Could not read the file paths');
  }

  const uploads = form.getAll('files').filter((f): f is File => f instanceof File);
  if (!uploads.length) return badRequest('No files were uploaded');
  if (uploads.length > MAX_FILES) return badRequest(`At most ${MAX_FILES} files in one skill.`);
  if (paths.length !== uploads.length) return badRequest('The file list and path list disagree');

  const files: UploadedFile[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < uploads.length; i++) {
    // Strip the folder the picker prefixes, so paths are relative to the skill
    // itself and match what the SKILL.md writes.
    const raw = String(paths[i] ?? uploads[i].name).replace(/\\/g, '/');
    const parts = raw.split('/').filter((p) => p && p !== '.' && p !== '..');
    const path = parts.slice(1).join('/') || parts.join('/');

    if (!TEXTUAL.test(path)) {
      skipped.push(path);
      continue;
    }
    files.push({ path, content: await uploads[i].text() });
  }

  try {
    const skill = await installSkill({
      files,
      scope,
      user,
      folder: String(paths[0] ?? '').split('/')[0] || undefined,
    });
    await audit(user.id, 'skill.install', 'skill', skill.id, {
      name: skill.name,
      scope,
      files: files.length,
    });
    return Response.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      files: files.length,
      skipped,
    });
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
