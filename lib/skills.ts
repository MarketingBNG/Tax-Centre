import 'server-only';
import crypto from 'node:crypto';
import { one, all, run } from './db';
import type { SkillRow } from './types';

/** Rough estimate — good enough for a size warning, not for billing. */
export const estimateTokens = (text: string): number => Math.ceil((text || '').length / 3.7);

export function listSkills(opts: { enabledOnly?: boolean } = {}): SkillRow[] {
  return all<SkillRow>(
    opts.enabledOnly
      ? `SELECT * FROM skills WHERE enabled = 1 ORDER BY sort_order, title`
      : `SELECT * FROM skills ORDER BY sort_order, title`,
  );
}

export const getSkill = (id: string) => one<SkillRow>(`SELECT * FROM skills WHERE id = ?`, id);

export function createSkill(input: {
  title: string;
  description?: string;
  jurisdiction?: string;
  body: string;
  sourceFilename?: string | null;
  createdBy: string;
}): SkillRow {
  const id = crypto.randomUUID();
  const now = Date.now();
  run(
    `INSERT INTO skills
       (id, title, description, jurisdiction, body, source_filename, version,
        enabled, sort_order, token_estimate, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 100, ?, ?, ?, ?)`,
    id,
    input.title,
    input.description ?? '',
    input.jurisdiction ?? 'generic',
    input.body,
    input.sourceFilename ?? null,
    estimateTokens(input.body),
    input.createdBy,
    now,
    now,
  );
  return getSkill(id)!;
}

/** Editing bumps the version so a review can name the exact text it used. */
export function updateSkill(
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    jurisdiction: string;
    body: string;
    enabled: boolean;
    sort_order: number;
  }>,
): SkillRow | null {
  const current = getSkill(id);
  if (!current) return null;

  const body = patch.body ?? current.body;
  const version = body !== current.body ? current.version + 1 : current.version;

  run(
    `UPDATE skills SET title = ?, description = ?, jurisdiction = ?, body = ?,
       enabled = ?, sort_order = ?, version = ?, token_estimate = ?, updated_at = ?
     WHERE id = ?`,
    patch.title ?? current.title,
    patch.description ?? current.description,
    patch.jurisdiction ?? current.jurisdiction,
    body,
    patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
    patch.sort_order ?? current.sort_order,
    version,
    estimateTokens(body),
    Date.now(),
    id,
  );
  return getSkill(id);
}

export const deleteSkill = (id: string) => run(`DELETE FROM skills WHERE id = ?`, id);

export interface SkillBundle {
  text: string;
  skills: { id: string; title: string; version: number }[];
  tokenEstimate: number;
}

/**
 * Assemble enabled skills into one deterministic block. Ordering is fixed
 * (sort_order, then title) because any reordering changes the bytes and
 * silently destroys the prompt cache for every review in the firm.
 */
export function buildSkillBundle(): SkillBundle {
  const skills = listSkills({ enabledOnly: true });

  if (!skills.length) {
    return {
      text:
        'No firm review skills have been published yet. Apply general professional ' +
        'tax review judgement.',
      skills: [],
      tokenEstimate: 0,
    };
  }

  const parts = ['# Firm review methodology', ''];
  for (const s of skills) {
    parts.push(`## ${s.title}  (v${s.version}, ${s.jurisdiction})`);
    if (s.description) parts.push(`_${s.description}_`);
    parts.push('', s.body.trim(), '');
  }

  const text = parts.join('\n');
  return {
    text,
    skills: skills.map((s) => ({ id: s.id, title: s.title, version: s.version })),
    tokenEstimate: estimateTokens(text),
  };
}
