import { currentUser, unauthorized } from '@/lib/auth';
import { getPrefs, listStyles, savePrefs } from '@/lib/prefs';
import { CHAT_MODELS, STYLE_PRESETS, THINKING_LEVELS } from '@/lib/models';
import { MODELS } from '@/lib/config';

/** Everything the settings screen and the composer pickers need, in one call. */
export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();

  const [prefs, custom] = await Promise.all([getPrefs(user.id), listStyles(user.id)]);

  return Response.json({
    instructions: prefs.instructions,
    model: prefs.model,
    style: prefs.style,
    thinking: prefs.thinking,
    memoryEnabled: prefs.memory_enabled === 1,
    defaults: { model: MODELS.chat, thinking: 'standard', style: 'normal' },
    models: CHAT_MODELS,
    thinkingLevels: THINKING_LEVELS,
    styles: [
      ...STYLE_PRESETS.map((s) => ({ id: s.id, name: s.label, blurb: s.blurb, builtIn: true })),
      ...custom.map((s) => ({
        id: s.id,
        name: s.name,
        blurb: s.instructions.slice(0, 80),
        builtIn: false,
      })),
    ],
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const saved = await savePrefs(user.id, {
    instructions: body.instructions === undefined ? undefined : String(body.instructions),
    model: body.model === undefined ? undefined : body.model ? String(body.model) : null,
    style: body.style === undefined ? undefined : body.style ? String(body.style) : null,
    thinking: body.thinking === undefined ? undefined : body.thinking ? String(body.thinking) : null,
    memoryEnabled: body.memoryEnabled === undefined ? undefined : Boolean(body.memoryEnabled),
  });

  return Response.json({
    instructions: saved.instructions,
    model: saved.model,
    style: saved.style,
    thinking: saved.thinking,
    memoryEnabled: saved.memory_enabled === 1,
  });
}
