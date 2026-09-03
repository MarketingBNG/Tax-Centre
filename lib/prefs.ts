import 'server-only';
import crypto from 'node:crypto';
import { all, one, run } from './db';
import { MEMORY_LIMIT, MODELS } from './config';
import {
  DEFAULT_STYLE_ID,
  isKnownModel,
  isThinkingLevel,
  STYLE_PRESETS,
  stylePreset,
  type ThinkingLevel,
} from './models';
import type { MemoryRow, ProjectRow, StyleRow, UserPrefsRow } from './types';

/* ------------------------------------------------------------ preferences */

const defaults = (userId: string): UserPrefsRow => ({
  user_id: userId,
  instructions: '',
  model: null,
  style: null,
  thinking: null,
  memory_enabled: 1,
  updated_at: 0,
});

/** Never null: someone who has never opened settings gets the defaults. */
export async function getPrefs(userId: string): Promise<UserPrefsRow> {
  const row = await one<UserPrefsRow>(`SELECT * FROM user_prefs WHERE user_id = ?`, userId);
  return row ?? defaults(userId);
}

export interface PrefsPatch {
  instructions?: string;
  model?: string | null;
  style?: string | null;
  thinking?: string | null;
  memoryEnabled?: boolean;
}

export async function savePrefs(userId: string, patch: PrefsPatch): Promise<UserPrefsRow> {
  const current = await getPrefs(userId);

  const next: UserPrefsRow = {
    ...current,
    instructions:
      patch.instructions === undefined
        ? current.instructions
        : String(patch.instructions).slice(0, 20_000),
    model:
      patch.model === undefined
        ? current.model
        : patch.model && isKnownModel(patch.model)
          ? patch.model
          : null,
    style: patch.style === undefined ? current.style : (patch.style || null),
    thinking:
      patch.thinking === undefined
        ? current.thinking
        : patch.thinking && isThinkingLevel(patch.thinking)
          ? patch.thinking
          : null,
    memory_enabled:
      patch.memoryEnabled === undefined ? current.memory_enabled : patch.memoryEnabled ? 1 : 0,
    updated_at: Date.now(),
  };

  await run(
    `INSERT INTO user_prefs (user_id, instructions, model, style, thinking, memory_enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       instructions   = EXCLUDED.instructions,
       model          = EXCLUDED.model,
       style          = EXCLUDED.style,
       thinking       = EXCLUDED.thinking,
       memory_enabled = EXCLUDED.memory_enabled,
       updated_at     = EXCLUDED.updated_at`,
    next.user_id,
    next.instructions,
    next.model,
    next.style,
    next.thinking,
    next.memory_enabled,
    next.updated_at,
  );

  return next;
}

/* ---------------------------------------------------------------- choices */

/**
 * What this turn actually runs with. A conversation's own setting wins, then
 * the person's default, then the deployment's — so changing your default does
 * not retroactively change a thread you already steered.
 */
export function resolveModel(conversation: string | null, prefs: UserPrefsRow): string {
  for (const candidate of [conversation, prefs.model]) {
    if (candidate && isKnownModel(candidate)) return candidate;
  }
  return MODELS.chat;
}

export function resolveThinking(
  conversation: string | null,
  prefs: UserPrefsRow,
): ThinkingLevel {
  for (const candidate of [conversation, prefs.thinking]) {
    if (candidate && isThinkingLevel(candidate)) return candidate;
  }
  return 'standard';
}

/* ----------------------------------------------------------------- styles */

export const listStyles = (userId: string): Promise<StyleRow[]> =>
  all<StyleRow>(`SELECT * FROM styles WHERE user_id = ? ORDER BY created_at`, userId);

export async function createStyle(
  userId: string,
  name: string,
  instructions: string,
): Promise<StyleRow> {
  const row: StyleRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    name: name.trim().slice(0, 60) || 'Untitled style',
    instructions: instructions.trim().slice(0, 20_000),
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO styles (id, user_id, name, instructions, created_at) VALUES (?, ?, ?, ?, ?)`,
    row.id,
    row.user_id,
    row.name,
    row.instructions,
    row.created_at,
  );
  return row;
}

export async function updateStyle(
  userId: string,
  id: string,
  name: string,
  instructions: string,
): Promise<void> {
  await run(
    `UPDATE styles SET name = ?, instructions = ? WHERE id = ? AND user_id = ?`,
    name.trim().slice(0, 60) || 'Untitled style',
    instructions.trim().slice(0, 20_000),
    id,
    userId,
  );
}

export const deleteStyle = (userId: string, id: string): Promise<void> =>
  run(`DELETE FROM styles WHERE id = ? AND user_id = ?`, id, userId);

export interface ResolvedStyle {
  id: string;
  label: string;
  instructions: string;
}

/** A built-in id, a custom style's id, or the default when neither matches. */
export async function resolveStyle(
  userId: string,
  conversation: string | null,
  prefs: UserPrefsRow,
): Promise<ResolvedStyle> {
  const wanted = conversation ?? prefs.style ?? DEFAULT_STYLE_ID;

  const builtIn = stylePreset(wanted);
  if (builtIn) {
    return { id: builtIn.id, label: builtIn.label, instructions: builtIn.instructions };
  }

  const custom = await one<StyleRow>(
    `SELECT * FROM styles WHERE id = ? AND user_id = ?`,
    wanted,
    userId,
  );
  if (custom) {
    return { id: custom.id, label: custom.name, instructions: custom.instructions };
  }

  const fallback = STYLE_PRESETS[0];
  return { id: fallback.id, label: fallback.label, instructions: fallback.instructions };
}

/* --------------------------------------------------------------- memories */

export const listMemories = (userId: string, limit = MEMORY_LIMIT): Promise<MemoryRow[]> =>
  all<MemoryRow>(
    `SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    limit,
  );

export async function addMemory(
  userId: string,
  text: string,
  conversationId: string | null,
): Promise<MemoryRow> {
  const row: MemoryRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    text: text.trim().slice(0, 600),
    source_conversation_id: conversationId,
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO memories (id, user_id, text, source_conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    row.id,
    row.user_id,
    row.text,
    row.source_conversation_id,
    row.created_at,
  );
  return row;
}

export const deleteMemory = (userId: string, id: string): Promise<void> =>
  run(`DELETE FROM memories WHERE id = ? AND user_id = ?`, id, userId);

export const clearMemories = (userId: string): Promise<void> =>
  run(`DELETE FROM memories WHERE user_id = ?`, userId);

/* --------------------------------------------------------------- projects */

export const listProjects = (userId: string): Promise<ProjectRow[]> =>
  all<ProjectRow>(`SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC`, userId);

export const getProject = (userId: string, id: string): Promise<ProjectRow | null> =>
  one<ProjectRow>(`SELECT * FROM projects WHERE id = ? AND user_id = ?`, id, userId);

export async function createProject(userId: string, name: string): Promise<ProjectRow> {
  const now = Date.now();
  const row: ProjectRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    name: name.trim().slice(0, 80) || 'Untitled project',
    instructions: '',
    created_at: now,
    updated_at: now,
  };
  await run(
    `INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    row.id,
    row.user_id,
    row.name,
    row.instructions,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export async function updateProject(
  userId: string,
  id: string,
  patch: { name?: string; instructions?: string },
): Promise<void> {
  const project = await getProject(userId, id);
  if (!project) return;
  await run(
    `UPDATE projects SET name = ?, instructions = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    patch.name === undefined ? project.name : patch.name.trim().slice(0, 80) || project.name,
    patch.instructions === undefined
      ? project.instructions
      : patch.instructions.slice(0, 50_000),
    Date.now(),
    id,
    userId,
  );
}

/**
 * Deleting a project keeps its conversations — they move back to the top level
 * rather than vanishing with the folder. Its shelf of documents is soft-deleted
 * the same way an unattached upload is.
 */
export async function deleteProject(userId: string, id: string): Promise<void> {
  if (!(await getProject(userId, id))) return;
  await run(`UPDATE conversations SET project_id = NULL WHERE project_id = ? AND user_id = ?`, id, userId);
  await run(
    `UPDATE files SET deleted_at = ? WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL`,
    Date.now(),
    id,
    userId,
  );
  await run(`DELETE FROM projects WHERE id = ? AND user_id = ?`, id, userId);
}
