import 'server-only';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { ROOT } from '@/lib/config';
import { one } from '@/lib/db';
import { installSkill, type SkillRow } from '@/lib/skills';
import type { UserRow } from '@/lib/types';

/**
 * Where the review engine gets its domain content.
 *
 * The stage prompts do not restate what to check — that is written down, and
 * firm-reviewed, in the tax-return-review skill: which accounts to sweep, which
 * ratios matter, which facts pull in a 5471. The engine reads those files and
 * follows them, so correcting the review means editing markdown rather than
 * editing code.
 *
 * Two sources, in order:
 *
 *   1. The agent_skills tables. A partner can correct a stage reference through
 *      the Skills screen and the next run picks it up, with no deploy — which
 *      is the whole reason skills live in the database rather than the repo.
 *
 *   2. The copy bundled in the repo, as a fallback. Without this a fresh deploy
 *      has no skills at all and every review would fail on content that is
 *      sitting right there in the source tree.
 */

export const SKILL_NAME = 'tax-return-review';
export const REPO_SKILL_DIR = path.join(ROOT, 'Skills', 'Tax-Review-Skills', 'tax-return-review');

/** The installed firm copy, if there is one. */
const firmSkill = (): Promise<SkillRow | null> =>
  one<SkillRow>(
    `SELECT * FROM agent_skills WHERE name = ? AND scope = 'firm' AND enabled = 1`,
    SKILL_NAME,
  );

function repoFile(relPath: string): string | null {
  // Reject anything that climbs out of the skill folder before touching disk.
  const resolved = path.resolve(REPO_SKILL_DIR, relPath);
  if (!resolved.startsWith(path.resolve(REPO_SKILL_DIR))) return null;
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * One reference file — `references/stage-1-books-and-gaap.md` and the like.
 *
 * Returns null rather than throwing when a file is genuinely absent; the caller
 * decides whether that stage can proceed without it, which is not a decision
 * this function has the context to make.
 */
export async function skillReference(relPath: string): Promise<string | null> {
  const skill = await firmSkill();
  if (skill) {
    const row = await one<{ content: string }>(
      `SELECT content FROM agent_skill_files WHERE skill_id = ? AND path = ?`,
      skill.id,
      relPath,
    );
    if (row) return row.content;
  }
  return repoFile(relPath);
}

/** The body of SKILL.md — the sequence, the three hard rules, the severity table. */
export async function skillBody(): Promise<string | null> {
  const skill = await firmSkill();
  if (skill) return skill.body;

  const raw = repoFile('SKILL.md');
  if (!raw) return null;
  // Strip the frontmatter: it is the trigger for chat, not content for a stage
  // that has already decided to run.
  return raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * A hash of the content a run will read, folded into its corpus hash.
 *
 * Without it, correcting a stage reference and re-running would produce a
 * different register under a hash claiming both runs saw the same world.
 */
export async function skillContentHash(relPaths: string[]): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update((await skillBody()) ?? '');
  for (const relPath of [...relPaths].sort()) {
    hash.update(relPath);
    hash.update((await skillReference(relPath)) ?? '');
  }
  return hash.digest('hex');
}

/** Every file under the repo skill folder, with paths relative to it. */
function walk(dir: string, base = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: rel, content: readFileSync(full, 'utf8') });
  }
  return out;
}

export interface SeedResult {
  installed: boolean;
  reason: string;
  name?: string;
  files?: number;
}

/**
 * Installs the bundled skill folder if the firm does not already have it.
 *
 * Idempotent, and deliberately not an overwrite: once a firm copy exists it is
 * the source of truth, and a deploy quietly reverting a partner's correction
 * would be a bad surprise. Re-installing on purpose is what the Skills screen
 * is for.
 */
export async function seedSkills(user: UserRow, opts: { force?: boolean } = {}): Promise<SeedResult> {
  const existing = await firmSkill();
  if (existing && !opts.force) {
    return { installed: false, reason: 'A firm copy is already installed', name: existing.name };
  }
  if (!existsSync(REPO_SKILL_DIR)) {
    return { installed: false, reason: `No skill folder bundled at ${REPO_SKILL_DIR}` };
  }

  const files = walk(REPO_SKILL_DIR);
  if (!files.some((f) => f.path.toLowerCase() === 'skill.md')) {
    return { installed: false, reason: 'The bundled folder has no SKILL.md at its root' };
  }

  const skill = await installSkill({
    files,
    scope: 'firm',
    user,
    folder: 'Tax-Review-Skills/tax-return-review',
  });

  return {
    installed: true,
    reason: existing ? 'Replaced the firm copy on request' : 'Installed from the bundled folder',
    name: skill.name,
    files: files.length,
  };
}
