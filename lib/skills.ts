import 'server-only';
import crypto from 'node:crypto';
import { all, one, run } from './db';
import type { UserRow } from './types';
import type { ToolSpec } from './providers/types';

/**
 * Skills: a folder of instructions the model reaches for when it applies.
 *
 * The point of the arrangement is that a large body of procedure costs almost
 * nothing until it is needed. Only the name and description of each skill go
 * into the prompt on every message — a few hundred tokens for a folder that
 * might be a hundred kilobytes — and the model pulls the rest through a tool
 * once it has decided the skill is relevant.
 */

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  scope: 'firm' | 'personal';
  user_id: string | null;
  enabled: number;
  folder: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillFileRow {
  skill_id: string;
  path: string;
  content: string;
  bytes: number;
}

/** Total characters one skill may occupy, across SKILL.md and every reference. */
const MAX_SKILL_BYTES = 2_000_000;
/** Largest single reference file handed back to the model in one call. */
const MAX_FILE_CHARS = 60_000;

/* ------------------------------------------------------------ frontmatter */

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Reads the `name` and `description` out of a SKILL.md.
 *
 * A deliberately small YAML subset rather than a parser dependency: the format
 * is two keys, and the values are frequently a single very long line. Quoted,
 * unquoted and folded (`>-`) values all appear in the wild, so all three work.
 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    throw new Error('SKILL.md has no --- frontmatter block at the top.');
  }

  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!key) continue;

    let value = key[2].trim();

    // A folded or literal block: everything indented under it belongs to it.
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const collected: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        collected.push(lines[++i].trim());
      }
      value = collected.join(value.startsWith('|') ? '\n' : ' ');
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    fields[key[1].toLowerCase()] = value;
  }

  const name = (fields.name ?? '').trim();
  const description = (fields.description ?? '').trim();
  if (!name) throw new Error('SKILL.md frontmatter has no `name`.');
  if (!description) {
    throw new Error(
      'SKILL.md frontmatter has no `description`. That field is what decides when ' +
        'the skill fires, so a skill without one can never trigger.',
    );
  }

  return { name, description, body: text.slice(match[0].length).trim() };
}

/* ------------------------------------------------------------------ store */

/** Firm skills plus this person's own. Ordered so firm ones come first. */
export const listSkills = (userId: string): Promise<SkillRow[]> =>
  all<SkillRow>(
    `SELECT * FROM agent_skills
      WHERE scope = 'firm' OR (scope = 'personal' AND user_id = ?)
      ORDER BY scope DESC, name`,
    userId,
  );

/** Only the ones actually in play: enabled, and visible to this person. */
export const activeSkills = (userId: string): Promise<SkillRow[]> =>
  all<SkillRow>(
    `SELECT * FROM agent_skills
      WHERE enabled = 1 AND (scope = 'firm' OR (scope = 'personal' AND user_id = ?))
      ORDER BY scope DESC, name`,
    userId,
  );

/**
 * One skill, if this person is allowed to see it. Ownership is in the
 * predicate: a personal skill belonging to somebody else matches nothing.
 */
export const getSkill = (id: string, userId: string): Promise<SkillRow | null> =>
  one<SkillRow>(
    `SELECT * FROM agent_skills
      WHERE id = ? AND (scope = 'firm' OR (scope = 'personal' AND user_id = ?))`,
    id,
    userId,
  );

export const skillFiles = (skillId: string): Promise<SkillFileRow[]> =>
  all<SkillFileRow>(
    `SELECT skill_id, path, bytes, '' AS content FROM agent_skill_files
      WHERE skill_id = ? ORDER BY path`,
    skillId,
  );

export const skillFile = (skillId: string, path: string): Promise<SkillFileRow | null> =>
  one<SkillFileRow>(
    `SELECT * FROM agent_skill_files WHERE skill_id = ? AND path = ?`,
    skillId,
    path,
  );

export interface UploadedFile {
  /** Path relative to the skill folder, e.g. references/stage-3-1065.md. */
  path: string;
  content: string;
}

/**
 * Installs a skill from the files of one folder.
 *
 * The folder must contain exactly one SKILL.md at its root; everything else is
 * kept beside it, addressed by the same relative path the SKILL.md refers to.
 * Replacing a skill of the same name and scope is an update rather than a
 * second copy, so re-uploading a corrected folder does the obvious thing.
 */
export async function installSkill(input: {
  files: UploadedFile[];
  scope: 'firm' | 'personal';
  user: UserRow;
  folder?: string;
}): Promise<SkillRow> {
  const { files, scope, user } = input;

  const root = files.find((f) => f.path.toLowerCase() === 'skill.md');
  if (!root) {
    throw new Error(
      'No SKILL.md at the top of that folder. Select the folder that contains ' +
        'SKILL.md itself, not the one above it.',
    );
  }

  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total > MAX_SKILL_BYTES) {
    throw new Error(
      `That skill is ${(total / 1_000_000).toFixed(1)} MB of text, over the ` +
        `${MAX_SKILL_BYTES / 1_000_000} MB limit.`,
    );
  }

  const parsed = parseSkillMarkdown(root.content);
  const now = Date.now();

  const existing = await one<SkillRow>(
    `SELECT * FROM agent_skills
      WHERE name = ? AND scope = ?
        AND (user_id IS NOT DISTINCT FROM ?)`,
    parsed.name,
    scope,
    scope === 'personal' ? user.id : null,
  );

  const id = existing?.id ?? crypto.randomUUID();

  if (existing) {
    await run(
      `UPDATE agent_skills SET description = ?, body = ?, folder = ?, updated_at = ? WHERE id = ?`,
      parsed.description,
      parsed.body,
      input.folder ?? existing.folder,
      now,
      id,
    );
    // Replace the files wholesale: a reference deleted from the folder must not
    // survive in the database and keep being readable.
    await run(`DELETE FROM agent_skill_files WHERE skill_id = ?`, id);
  } else {
    await run(
      `INSERT INTO agent_skills
         (id, name, description, body, scope, user_id, enabled, folder,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      parsed.name,
      parsed.description,
      parsed.body,
      scope,
      scope === 'personal' ? user.id : null,
      input.folder ?? null,
      user.id,
      now,
      now,
    );
  }

  for (const file of files) {
    if (file.path.toLowerCase() === 'skill.md') continue;
    await run(
      `INSERT INTO agent_skill_files (skill_id, path, content, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT (skill_id, path) DO UPDATE SET content = EXCLUDED.content, bytes = EXCLUDED.bytes`,
      id,
      file.path,
      file.content,
      file.content.length,
    );
  }

  return (await one<SkillRow>(`SELECT * FROM agent_skills WHERE id = ?`, id))!;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  await run(
    `UPDATE agent_skills SET enabled = ?, updated_at = ? WHERE id = ?`,
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
}

export const deleteSkill = (id: string): Promise<void> =>
  run(`DELETE FROM agent_skills WHERE id = ?`, id);

/* ------------------------------------------------- exposing to the model */

/**
 * The catalogue that rides in every prompt.
 *
 * Name and description only. This is the entire trigger mechanism, which is
 * why a skill with a vague description never fires however good its body is.
 */
export function skillCatalogue(skills: SkillRow[]): string {
  if (!skills.length) return '';

  const lines = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join('\n\n');

  return (
    `Skills available to you. Each is a procedure written down by the firm. The ` +
    `description says when it applies — read them as triggers, not as a menu to ` +
    `browse. When one matches what is being asked, call load_skill with its name ` +
    `before answering, and then follow it. Do not paraphrase a skill from its ` +
    `description alone; the description exists to tell you to load the real ` +
    `thing.\n\n${lines}`
  );
}

export const LOAD_SKILL_TOOL: ToolSpec = {
  name: 'load_skill',
  description:
    'Load the full instructions for one of the skills listed in your prompt. Call ' +
    'this as soon as a skill looks relevant, before you start answering — the ' +
    'description in the list is only a trigger, and the skill itself contains the ' +
    'procedure, the order it runs in, and the format of the output. Loading a ' +
    'skill that turns out not to apply costs nothing; guessing at one you did not ' +
    'load is the failure this exists to prevent.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, exactly as listed.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const READ_SKILL_FILE_TOOL: ToolSpec = {
  name: 'read_skill_file',
  description:
    'Read one of the supporting files a loaded skill refers to — a reference ' +
    'module, a template, a checklist. The skill lists its own files and says when ' +
    'each one is needed; read them as you reach the step that calls for them ' +
    'rather than all at once.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'The skill name.' },
      path: {
        type: 'string',
        description: 'The path inside the skill folder, e.g. references/stage-3-1065.md',
      },
    },
    required: ['skill', 'path'],
    additionalProperties: false,
  },
};

/** A directory listing appended to a loaded skill, so it knows what it has. */
function fileIndex(files: SkillFileRow[]): string {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path} (${f.bytes.toLocaleString()} chars)`).join('\n');
  return `\n\n---\n\nFiles in this skill, readable with read_skill_file:\n\n${lines}`;
}

export async function loadSkillByName(
  userId: string,
  name: string,
): Promise<{ skill: SkillRow; text: string } | null> {
  const skills = await activeSkills(userId);
  const wanted = name.trim().toLowerCase();
  const skill =
    skills.find((s) => s.name.toLowerCase() === wanted) ??
    skills.find((s) => s.name.toLowerCase().includes(wanted));
  if (!skill) return null;

  const files = await skillFiles(skill.id);
  return { skill, text: `# Skill: ${skill.name}\n\n${skill.body}${fileIndex(files)}` };
}

export async function runSkillTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'load_skill') {
    const wanted = String(args.name ?? '').trim();
    if (!wanted) throw new Error('No skill name was given.');

    const found = await loadSkillByName(userId, wanted);
    if (!found) {
      const available = (await activeSkills(userId)).map((s) => s.name).join(', ');
      throw new Error(
        `No skill called "${wanted}". Available: ${available || 'none'}.`,
      );
    }
    return found.text;
  }

  if (name === 'read_skill_file') {
    const found = await loadSkillByName(userId, String(args.skill ?? ''));
    if (!found) throw new Error(`No skill called "${String(args.skill ?? '')}".`);

    const path = String(args.path ?? '').trim().replace(/^\.?\//, '');
    const file = await skillFile(found.skill.id, path);
    if (!file) {
      const available = (await skillFiles(found.skill.id)).map((f) => f.path).join(', ');
      throw new Error(`"${path}" is not in this skill. It has: ${available || 'no files'}.`);
    }

    const content =
      file.content.length > MAX_FILE_CHARS
        ? `${file.content.slice(0, MAX_FILE_CHARS)}\n\n…[truncated at ${MAX_FILE_CHARS} characters]`
        : file.content;

    return `<skill_file skill="${found.skill.name}" path="${file.path}">\n${content}\n</skill_file>`;
  }

  throw new Error(`Unknown skill tool: ${name}`);
}

/**
 * Skills pinned to a conversation, loaded in full.
 *
 * Pinning is the manual override for the automatic route: instead of hoping the
 * description matches, the person says "use this one", and the whole skill is
 * in the prompt before the first word is written.
 */
export async function pinnedSkillBlocks(
  userId: string,
  selected: string | null,
): Promise<string[]> {
  if (!selected) return [];

  let ids: string[] = [];
  try {
    const parsed = JSON.parse(selected);
    if (Array.isArray(parsed)) ids = parsed.map(String);
  } catch {
    return [];
  }
  if (!ids.length) return [];

  const skills = (await activeSkills(userId)).filter((s) => ids.includes(s.id));
  const blocks: string[] = [];

  for (const skill of skills) {
    const files = await skillFiles(skill.id);
    blocks.push(
      `The person asked for this skill specifically, so it applies to this ` +
        `conversation whether or not it looks relevant to any single message. ` +
        `Follow it.\n\n# Skill: ${skill.name}\n\n${skill.body}${fileIndex(files)}`,
    );
  }

  return blocks;
}

export const parseSelectedSkills = (selected: string | null): string[] => {
  if (!selected) return [];
  try {
    const parsed = JSON.parse(selected);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};
